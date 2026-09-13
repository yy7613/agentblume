import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [chartError, setChartError] = useState<string>();
  const [rules, setRules] = useState<readonly JournalRuleDto[]>([]);
  const [rulesError, setRulesError] = useState<string>();
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
    catch (cause: unknown) { setChartError(messageOf(cause)); }
  }, [client]);
  const reloadRules = useCallback(async () => {
    try { setRules(await client.listJournalRules(scope)); setRulesError(undefined); }
    catch (cause: unknown) { setRulesError(messageOf(cause)); }
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

  /** 判定タブのボタン → 対象タブへ。`answer` は判定タブ内で完結し、`hearing` は Phase 1 では無効なので来ない。 */
  const handleAction = (action: JournalAction, document: JournalDocumentSummaryDto) => {
    const next = nextSeq();
    switch (action.kind) {
      case 'new-rule':
        if (chart !== undefined) setRuleDraft({ rule: newRuleFromDocument(document, chart), seq: next });
        setTab('rules');
        return;
      case 'open-rule': setRuleFocus({ id: action.ruleId, seq: next }); setTab('rules'); return;
      case 'open-chart': setAccountFocus({ id: action.accountIds[0] ?? '', seq: next }); setTab('chart'); return;
      case 'edit-facts': setEditDocument({ id: document.id, seq: next }); setTab('ingest'); return;
      case 'open-entry': setEntryFocus({ id: action.entryId ?? document.entryId ?? '', seq: next }); setTab('export'); return;
      default: return;
    }
  };

  const tabs: readonly { readonly id: JournalTab; readonly label: string }[] = [
    { id: 'ingest', label: text('Ingest', '取込') },
    { id: 'judge', label: text('Judge', '判定') },
    { id: 'rules', label: text('Rules', 'ルール') },
    { id: 'chart', label: text('Chart', '科目') },
    { id: 'export', label: text('Export', '出力') },
  ];

  return <main className="workspace-page journal-page">
    <header className="workspace-header"><div><span className="eyebrow">{text('Journal', '仕訳')}</span><h1>{text('Journal entries', '仕訳')}</h1><p>{text('Ingest receipts, invoices, and bank/card CSV rows, judge them against your own rules, and export the entries as a generic CSV. Accounts and tax categories are yours to define in the Chart tab.', 'レシート・請求書・銀行/カード明細を取り込み、自分で決めたルールで判定して仕訳を起こし、汎用 CSV に出力します。科目と税区分は「科目」タブで自由に定義できます。')}</p></div></header>
    {chartError !== undefined && <p className="api-error" role="alert">{text('Could not load the chart of accounts: ', '科目マスタを読み込めませんでした: ')}{chartError} <button type="button" className="secondary" onClick={() => void reloadChart()}>{text('Retry', '再試行')}</button></p>}
    {rulesError !== undefined && <p className="api-error" role="alert">{text('Could not load the rules: ', 'ルールを読み込めませんでした: ')}{rulesError} <button type="button" className="secondary" onClick={() => void reloadRules()}>{text('Retry', '再試行')}</button></p>}
    <div className="validation-tabs" role="tablist" aria-label={text('Journal tabs', '仕訳タブ')}>
      {tabs.map((item) => <button type="button" key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    {tab === 'ingest' ? <IngestTab client={client} chart={chart} capabilities={capabilities} editDocument={editDocument} onSaved={() => { void reloadRules(); }} />
      : tab === 'judge' ? <JudgeTab client={client} chart={chart} rules={rules} capabilities={capabilities} focus={documentFocus} onAction={handleAction} />
      : tab === 'rules' ? <RulesTab client={client} chart={chart} rules={rules} reloadRules={reloadRules} focus={ruleFocus} draft={ruleDraft} />
      : tab === 'chart' ? <ChartTab client={client} chart={chart} onChartChanged={setChart} focus={accountFocus} />
      : <ExportTab client={client} chart={chart} focus={entryFocus} />}
  </main>;
}
