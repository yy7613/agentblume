import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalCapabilitiesDto, JournalChartOfAccountsDto, JournalDocumentSummaryDto, JournalRuleDto, SaveJournalRuleDto } from '../api/types';
import { useI18n } from '../i18n';
import { usePendingOpen } from '../navigation';
import { scope } from '../scope';
import { ChartTab } from './ChartTab';
import { ExportTab } from './ExportTab';
import { IngestTab } from './IngestTab';
import { JudgeTab } from './JudgeTab';
import { RulesTab } from './RulesTab';
import { newRuleFromDocument, openJournalTarget, type JournalAction, type JournalTab } from './journal-model';
import { messageOf } from './journal-shared';

/**
 * 読み込みに失敗したときの情報。文言だけでなく HTTP の状態も持つ。
 * 経路そのものが無い（404）のは「起動中の API サーバーが古い」ことがほとんどで、
 * 利用者に見せるべき次の一手が「再試行」ではなく「サーバーを再起動」になるため。
 */
interface LoadFailure { readonly message: string; readonly status?: number }

function failureOf(cause: unknown): LoadFailure {
  const status = typeof cause === 'object' && cause !== null && typeof Reflect.get(cause, 'status') === 'number'
    ? Reflect.get(cause, 'status') as number
    : undefined;
  return { message: messageOf(cause), ...(status === undefined ? {} : { status }) };
}

/** 「このタブでこの項目を開く」依頼。seq を変えて同じ id の再依頼も届くようにする。 */
export interface TabFocus { readonly id: string; readonly seq: number }

/**
 * 仕訳画面（docs/20 §10）。サブタブ: 取込 / 判定 / ルール / 科目 / 出力。
 *
 * 科目マスタ・ルール一覧・LLM 機能の可否はここで 1 回読み、各タブへ配る（判定タブの科目名、ルール編集の科目セレクト、
 * 取込タブの案内が同じマスタを見るため）。判定タブの「原因 → 次の一手 → ボタン」が要求する遷移（ルールを作る / ルールを開く /
 * 科目マスタを開く / 項目を編集 / 仕訳を開く）は `handleAction` でタブを切り替えて対象を渡す。
 * 他画面からのディープリンクは `usePendingOpen('Journal', …)`（section: document / rule / account / entry）。
 */
export function JournalPage({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [tab, setTab] = useState<JournalTab>('ingest');
  const [chart, setChart] = useState<JournalChartOfAccountsDto>();
  const [chartError, setChartError] = useState<LoadFailure>();
  const [rules, setRules] = useState<readonly JournalRuleDto[]>([]);
  const [rulesError, setRulesError] = useState<LoadFailure>();
  const [capabilities, setCapabilities] = useState<JournalCapabilitiesDto>();
  const [documentFocus, setDocumentFocus] = useState<TabFocus>();
  const [ruleFocus, setRuleFocus] = useState<TabFocus>();
  const [accountFocus, setAccountFocus] = useState<TabFocus>();
  const [entryFocus, setEntryFocus] = useState<TabFocus>();
  const [editDocument, setEditDocument] = useState<TabFocus>();
  const [ruleDraft, setRuleDraft] = useState<{ readonly rule: SaveJournalRuleDto; readonly seq: number }>();
  const seqRef = useRef(0);
  const nextSeq = () => { seqRef.current += 1; return seqRef.current; };

  const reloadChart = useCallback(async () => {
    try { setChart(await client.getJournalChart(scope)); setChartError(undefined); }
    catch (cause: unknown) { setChartError(failureOf(cause)); }
  }, [client]);
  const reloadRules = useCallback(async () => {
    try { setRules(await client.listJournalRules(scope)); setRulesError(undefined); }
    catch (cause: unknown) { setRulesError(failureOf(cause)); }
  }, [client]);

  useEffect(() => { void reloadChart(); void reloadRules(); }, [reloadChart, reloadRules]);
  // LLM 機能の可否は起動時に 1 回だけ確認する（設定を変えたらこの画面を開き直す）。取得失敗は「使えない」に倒す。
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => client.journalCapabilities())
      .then((next) => { if (active) setCapabilities(next); })
      .catch(() => { if (active) setCapabilities({ extraction: { enabled: false, vision: false }, hearing: { enabled: false } }); });
    return () => { active = false; };
  }, [client]);

  usePendingOpen('Journal', (target) => {
    const focus = openJournalTarget(target);
    if (focus === undefined) return;
    const next = nextSeq();
    setTab(focus.tab);
    if (focus.section === 'document') setDocumentFocus({ id: focus.id, seq: next });
    else if (focus.section === 'rule') setRuleFocus({ id: focus.id, seq: next });
    else if (focus.section === 'account') setAccountFocus({ id: focus.id, seq: next });
    else setEntryFocus({ id: focus.id, seq: next });
  });

  /** 判定タブのボタン → 対象タブへ。`answer` と `hearing` は判定タブ内で完結する。 */
  const handleAction = (action: JournalAction, document: JournalDocumentSummaryDto) => {
    const next = nextSeq();
    switch (action.kind) {
      case 'new-rule':
        if (chart !== undefined) setRuleDraft({ rule: newRuleFromDocument(document, chart), seq: next });
        setTab('rules');
        return;
      // ヒアリングの提案を、登録する前にルール編集フォームで直す（既存の事前入力の経路をそのまま使う）。
      case 'edit-rule-draft': setRuleDraft({ rule: action.rule, seq: next }); setTab('rules'); return;
      case 'open-rule': setRuleFocus({ id: action.ruleId, seq: next }); setTab('rules'); return;
      case 'open-chart': setAccountFocus({ id: action.accountIds[0] ?? '', seq: next }); setTab('chart'); return;
      case 'edit-facts': setEditDocument({ id: document.id, seq: next }); setTab('ingest'); return;
      case 'open-entry': setEntryFocus({ id: action.entryId ?? document.entryId ?? '', seq: next }); setTab('export'); return;
      default: return;
    }
  };

  /**
   * 画面の手順（docs/20 §10）。**設定する順**に並べる: 科目 → 取込 → 判定 → ルール → 出力。
   * 四角と矢印がそのままタブなので、順序を示すものと操作するものが二重にならない。
   * 読み上げ用の名前は素のラベル（aria-label）にして、番号と説明は見た目だけに留める。
   * 最初に開くのは「取込」のまま: 科目には既定値があるので、いきなり設定表へ着地させない。
   */
  const steps: readonly { readonly id: JournalTab; readonly label: string; readonly caption: string; readonly badge?: string }[] = [
    { id: 'chart', label: text('Chart', '科目'), caption: text('Define accounts and tax categories', '科目と税区分を決める'),
      ...(chart === undefined ? {} : { badge: text(`${chart.accounts.length} accounts`, `${chart.accounts.length} 科目`) }) },
    { id: 'ingest', label: text('Ingest', '取込'), caption: text('Bring in CSV, images, PDF, or text', 'CSV・画像・PDF・テキストを取り込む') },
    { id: 'judge', label: text('Judge', '判定'), caption: text('Judge the documents against your rules', 'ルールで判定する') },
    { id: 'rules', label: text('Rules', 'ルール'), caption: text('Turn undecided documents into rules', '決まらないものをルールにする'),
      badge: text(`${rules.length} rules`, `${rules.length} 件`) },
    { id: 'export', label: text('Export', '出力'), caption: text('Confirm the entries and export CSV', '確定して CSV に出す') },
  ];

  // 未設定は失敗ではない。ここに並ぶのは「読みに行って駄目だった」ものだけ。
  const loadFailures = [
    ...(chartError === undefined ? [] : [{ key: 'chart', label: text('Could not load the chart of accounts', '科目マスタを読み込めませんでした'), message: chartError.message, status: chartError.status, retry: reloadChart }]),
    ...(rulesError === undefined ? [] : [{ key: 'rules', label: text('Could not load the rules', 'ルールを読み込めませんでした'), message: rulesError.message, status: rulesError.status, retry: reloadRules }]),
  ];
  // 経路が無いなら生の "Route GET:... not found" は見せず、サーバーの再起動を案内する。
  const staleServer = loadFailures.some((failure) => failure.status === 404);

  return <main className="workspace-page journal-page">
    <header className="workspace-header"><div><span className="eyebrow">{text('Journal', '仕訳')}</span><h1>{text('Journal entries', '仕訳')}</h1><p>{text('Ingest receipts, invoices, and bank/card CSV rows, judge them against your own rules, and export the entries as a generic CSV. Accounts and tax categories are yours to define in the Chart tab.', 'レシート・請求書・銀行/カード明細を取り込み、自分で決めたルールで判定して仕訳を起こし、汎用 CSV に出力します。科目と税区分は「科目」タブで自由に定義できます。')}</p></div></header>
    {loadFailures.length > 0 && <div className="notice-card journal-load-notice" role="status">
      <strong>{text('Could not load part of this screen', 'この画面のデータを一部読み込めませんでした')}</strong>
      <ul>{loadFailures.map((failure) => <li key={failure.key}>{failure.label}{staleServer ? '' : `: ${failure.message}`}</li>)}</ul>
      <p>{staleServer
        ? text('The API server has no journal endpoints. Restart the API server: the journal screen is a recent addition, so a server started before it will not serve them.', '起動中の API サーバーに仕訳の API がありません。仕訳は後から追加した機能なので、それ以前に起動したサーバーには経路がありません。API サーバーを再起動してください。')
        : text('Check that the API server is running, then retry. The tabs below still work; only the saved chart and rules are missing.', 'API サーバーが動いているか確かめてから再試行してください。下のタブはそのまま使えます。読めていないのは保存済みの科目マスタとルールだけです。')}</p>
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => { for (const failure of loadFailures) void failure.retry(); }}>{text('Retry', '再試行')}</button>
      </div>
    </div>}
    <div className="journal-steps" role="tablist" aria-label={text('Journal steps', '仕訳の手順')}>
      {steps.map((step, index) => <Fragment key={step.id}>
        <button type="button" role="tab" aria-selected={tab === step.id} aria-label={step.label}
          className={`journal-step${tab === step.id ? ' active' : ''}`} onClick={() => setTab(step.id)}>
          <span className="journal-step-no" aria-hidden="true">{index + 1}</span>
          <span className="journal-step-head">
            <span className="journal-step-label">{step.label}</span>
            {step.badge !== undefined && <span className="journal-step-badge">{step.badge}</span>}
          </span>
          <span className="journal-step-caption">{step.caption}</span>
        </button>
        {index < steps.length - 1 && <span className="journal-step-arrow" aria-hidden="true">→</span>}
      </Fragment>)}
    </div>
    {tab === 'ingest' ? <IngestTab client={client} chart={chart} capabilities={capabilities} editDocument={editDocument} onSaved={() => { void reloadRules(); }} />
      : tab === 'judge' ? <JudgeTab client={client} chart={chart} rules={rules} capabilities={capabilities} focus={documentFocus} onAction={handleAction} reloadChart={reloadChart} reloadRules={reloadRules} />
      : tab === 'rules' ? <RulesTab client={client} chart={chart} rules={rules} reloadRules={reloadRules} focus={ruleFocus} draft={ruleDraft} />
      : tab === 'chart' ? <ChartTab client={client} chart={chart} onChartChanged={setChart} focus={accountFocus} />
      : <ExportTab client={client} chart={chart} focus={entryFocus} />}
  </main>;
}
