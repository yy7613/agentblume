import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EXPENSE_CAPABILITIES_DISABLED, expenseApi } from '../api/expense-api';
import { expenseInputApi } from '../api/expense-input-api';
import { expenseMoneyApi } from '../api/expense-money-api';
import { expensePeopleReadinessKnown } from '../api/expense-people-api';
import type { ExpenseCapabilitiesDto, ExpenseClaimSummaryDto, ExpensePolicyResultDto } from '../api/expense-types';
import type { JournalChartOfAccountsDto } from '../api/types';
import type { BusinessPageProps } from '../business/types';
import { BusinessStepper, type BusinessStep } from '../components/BusinessStepper';
import { useI18n } from '../i18n';
import { ScreenLink, usePendingOpen, type OpenTarget } from '../navigation';
import { scope } from '../scope';
import { ApproveTab } from './ApproveTab';
import { CheckTab } from './CheckTab';
import { IngestTab } from './IngestTab';
import { PolicyTab } from './PolicyTab';
import { SettleTab } from './SettleTab';
import { EXPENSE_LEDGER_TABS, focusSelectsClaim, parseExpenseTarget, readinessRows, type ExpenseLedgerTab, type ExpenseReadinessKey, type ExpenseStepTab, type ExpenseTab, type Translate } from './expense-model';
import { ExpenseSlotProvider, PracticalReadinessCard, messageOf, type ExpenseFocusRequest, type ExpenseSlotEnvironment } from './expense-shared';
import { EXPENSE_LEDGER_SLOTS } from './expense-slots';
import './expense.css';

/** 読み込みの失敗。404 は「起動中のサーバーが古い」ことがほとんどなので、次の一手を変えるため状態も持つ。 */
interface LoadFailure { readonly message: string; readonly status?: number }

function failureOf(cause: unknown): LoadFailure {
  const status = typeof cause === 'object' && cause !== null && typeof Reflect.get(cause, 'status') === 'number' ? Reflect.get(cause, 'status') as number : undefined;
  return { message: messageOf(cause), ...(status === undefined ? {} : { status }) };
}

function isLedgerTab(tab: ExpenseTab): tab is ExpenseLedgerTab {
  return (EXPENSE_LEDGER_TABS as readonly string[]).includes(tab);
}

function ledgerTabLabel(tab: ExpenseLedgerTab, text: Translate): string {
  switch (tab) {
    case 'employees': return text('Employees & organization', '従業員・組織');
    case 'advances': return text('Advances', '仮払金');
    case 'cards': return text('Card statements', 'カード明細');
    case 'fares': return text('Fare table', '運賃マスタ');
    case 'reports': return text('Reports', 'レポート');
  }
}

/**
 * 経費精算画面（docs/21-expense.md §11 / §20.10）。手順: 規程 → 申請取込 → チェック → 承認 → 精算出力。
 *
 * 規程・申請一覧・仕訳の科目マスタ・読取の可否はここで読み、各タブへ配る（件数バッジと、規程タブの科目の選択肢が同じデータを見るため）。
 * 理由カードの導線とディープリンクは同じ OpenTarget（`parseExpenseTarget`）で解釈し、タブの切り替えと対象の受け渡しをここで行う。
 * 最初に開くのは「申請取込」: 規程には初期テンプレートがあるので、いきなり設定表へ着地させない。
 *
 * マスタと台帳（従業員・仮払・カード・運賃・レポート）は手順ではないので、ステッパーに足さず 2 段目のタブ列に置く。
 * 系統の部品は `expense-slots.tsx` のスロットで差し込み、API の送信口は `ExpenseSlotProvider` で配る。
 */
export function ExpensePage({ client }: BusinessPageProps) {
  const { text } = useI18n();
  const api = useMemo(() => expenseApi(client), [client]);
  const [tab, setTab] = useState<ExpenseTab>('ingest');
  const [policy, setPolicy] = useState<ExpensePolicyResultDto>();
  const [policyError, setPolicyError] = useState<LoadFailure>();
  const [claims, setClaims] = useState<readonly ExpenseClaimSummaryDto[]>([]);
  const [claimsLoaded, setClaimsLoaded] = useState(false);
  const [claimsError, setClaimsError] = useState<LoadFailure>();
  const [chart, setChart] = useState<JournalChartOfAccountsDto>();
  const [chartError, setChartError] = useState<string>();
  const [capabilities, setCapabilities] = useState<ExpenseCapabilitiesDto>();
  const [selectedClaimId, setSelectedClaimId] = useState<string>();
  const [focus, setFocus] = useState<ExpenseFocusRequest>();
  const [readiness, setReadiness] = useState<Partial<Record<Exclude<ExpenseReadinessKey, 'approval'>, boolean>>>({});
  const seqRef = useRef(0);

  const reloadPolicy = useCallback(async () => {
    try { setPolicy(await api.getPolicy(scope)); setPolicyError(undefined); }
    catch (cause: unknown) { setPolicyError(failureOf(cause)); }
  }, [api]);
  const reloadClaims = useCallback(async () => {
    try { setClaims(await api.listClaims(scope)); setClaimsError(undefined); }
    catch (cause: unknown) { setClaimsError(failureOf(cause)); }
    finally { setClaimsLoaded(true); }
  }, [api]);
  // 科目マスタは仕訳の BC のデータ。読めなくても規程は編集できる（科目 id の直接入力に倒す）。
  const reloadChart = useCallback(async () => {
    try { setChart(await client.getJournalChart(scope)); setChartError(undefined); }
    catch (cause: unknown) { setChartError(messageOf(cause)); }
  }, [client]);

  useEffect(() => { void reloadPolicy(); void reloadClaims(); void reloadChart(); }, [reloadPolicy, reloadClaims, reloadChart]);
  /**
   * 「実用機能の準備」カードの状況（§20.10.1）を系統ごとの API から読む。読めなかったものは「分からない」= 未設定の表示のまま:
   * 準備状況は失敗の知らせではないので、読めなくても画面を赤くしない（loadFailures に入れない）。
   * 振込元は A（人と組織）と B（お金の流れ）の両方が返すが、振込元の設定を持つのは B なので、読めていれば B を優先する。
   */
  const reloadReadiness = useCallback(async () => {
    const [people, money, fares] = await Promise.allSettled([
      expensePeopleReadinessKnown(client, scope), expenseMoneyApi(client).readiness(scope), expenseInputApi(client).fareReadiness(scope),
    ]);
    setReadiness({
      ...(people.status === 'fulfilled' ? { employees: people.value.employees, payout: people.value.payout } : {}),
      ...(money.status === 'fulfilled' ? { cards: money.value.cards, payout: money.value.payout } : {}),
      ...(fares.status === 'fulfilled' ? { fares: fares.value } : {}),
    });
  }, [client]);
  // マスタは台帳タブで変わるので、カードのある規程タブを開くたびに読み直す。
  useEffect(() => { if (tab === 'policy') void reloadReadiness(); }, [tab, reloadReadiness]);
  // 読取の可否は起動時に 1 回だけ確認する。取得失敗は「使えない」に倒す。
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.capabilities())
      .then((next) => { if (active) setCapabilities(next); })
      .catch(() => { if (active) setCapabilities(EXPENSE_CAPABILITIES_DISABLED); });
    return () => { active = false; };
  }, [api]);

  const openTarget = useCallback((target: OpenTarget) => {
    const parsed = parseExpenseTarget(target);
    if (parsed === undefined) return;
    seqRef.current += 1;
    // 台帳の行 id・規程の id を「選んでいる申請」にしない。
    if (focusSelectsClaim(parsed)) setSelectedClaimId(parsed.id);
    setFocus({ ...parsed, seq: seqRef.current });
    setTab(parsed.tab);
  }, []);
  usePendingOpen('Expense', openTarget);

  const slotEnvironment = useMemo<ExpenseSlotEnvironment>(() => ({ transport: client, scope, capabilities }), [client, capabilities]);

  const count = (predicate: (claim: ExpenseClaimSummaryDto) => boolean) => claims.filter(predicate).length;
  const unchecked = count((claim) => claim.status === 'draft' || (claim.status === 'checked' && claim.stale));
  const needsReview = count((claim) => claim.status === 'checked' && claim.verdict === 'needs-review');
  const waiting = count((claim) => claim.status === 'checked' || claim.status === 'in-approval');
  const approved = count((claim) => claim.status === 'approved');
  const enabledCategories = policy?.policy.categories.filter((category) => category.enabled).length ?? 0;

  /** 件数は事実として出すだけ。「未保存」「0 件」は失敗ではないので、赤くする印は付けない（f86e90d の方針）。 */
  const steps: readonly BusinessStep<ExpenseStepTab>[] = [
    { id: 'policy', label: text('Policy', '規程'), caption: text('Decide categories and limits', '費目と上限を決める'),
      ...(policy === undefined ? {} : { badge: policy.saved ? text(`${enabledCategories} categories`, `${enabledCategories} 費目`) : text('initial template', '初期テンプレートのまま') }) },
    { id: 'ingest', label: text('Ingest', '申請取込'), caption: text('Add receipts, items, or CSV', '領収書・明細・CSV を取り込む'),
      ...(claimsLoaded ? { badge: text(`${claims.length} claims`, `${claims.length} 件`) } : {}) },
    { id: 'check', label: text('Check', 'チェック'), caption: text('Check claims against the policy', '規程でチェックする'),
      ...(claimsLoaded ? { badge: unchecked > 0 ? text(`${unchecked} unchecked`, `未チェック ${unchecked}`) : text(`${needsReview} to review`, `要確認 ${needsReview}`) } : {}) },
    { id: 'approve', label: text('Approve', '承認'), caption: text('Review, return, or approve', '確認・差し戻し・承認'),
      ...(claimsLoaded ? { badge: text(`${waiting} waiting`, `承認待ち ${waiting}`) } : {}) },
    { id: 'settle', label: text('Export', '精算出力'), caption: text('Export CSV and journal drafts', 'CSV と仕訳下書きに出す'),
      ...(claimsLoaded ? { badge: text(`${approved} approved`, `承認済み ${approved}`) } : {}) },
  ];

  // 未設定・0 件は失敗ではない。ここに並ぶのは「読みに行って駄目だった」ものだけ。
  const loadFailures = [
    ...(policyError === undefined ? [] : [{ key: 'policy', label: text('Could not load the expense policy', '規程を読み込めませんでした'), failure: policyError, retry: reloadPolicy }]),
    ...(claimsError === undefined ? [] : [{ key: 'claims', label: text('Could not load the claims', '申請一覧を読み込めませんでした'), failure: claimsError, retry: reloadClaims }]),
  ];
  const staleServer = loadFailures.some((entry) => entry.failure.status === 404);
  const navigation = { onOpen: openTarget, onTab: setTab };
  const tabFocus = focus?.tab === tab ? focus : undefined;

  const content = (() => {
    if (isLedgerTab(tab)) {
      const Ledger = EXPENSE_LEDGER_SLOTS[tab];
      return <Ledger transport={client} scope={scope} onOpen={openTarget} policy={policy} claims={claims} chart={chart} capabilities={capabilities}
        onClaimsChanged={reloadClaims} onReloadPolicy={reloadPolicy} onTab={setTab} focus={tabFocus} />;
    }
    switch (tab) {
      case 'policy': return <>
        <PracticalReadinessCard rows={readinessRows(policy?.policy, readiness)}onOpen={(target) => { if ('tab' in target) setTab(target.tab); else openTarget(target); }} />
        <PolicyTab api={api} result={policy} chart={chart} chartError={chartError} onReloadChart={reloadChart} onPolicyChanged={setPolicy} onReloadPolicy={reloadPolicy} focus={tabFocus} capabilities={capabilities} onOpen={openTarget} />
      </>;
      case 'ingest': return <IngestTab api={api} policy={policy?.policy} claims={claims} onClaimsChanged={reloadClaims} capabilities={capabilities} selectedClaimId={selectedClaimId} onSelectClaim={setSelectedClaimId} focus={tabFocus} {...navigation} />;
      case 'check': return <CheckTab api={api} policy={policy?.policy} claims={claims} onClaimsChanged={reloadClaims} selectedClaimId={selectedClaimId} onSelectClaim={setSelectedClaimId} focus={tabFocus} {...navigation} />;
      case 'approve': return <ApproveTab api={api} claims={claims} onClaimsChanged={reloadClaims} selectedClaimId={selectedClaimId} onSelectClaim={setSelectedClaimId} {...navigation} />;
      case 'settle': return <SettleTab api={api} claims={claims} onClaimsChanged={reloadClaims} {...navigation} />;
    }
  })();

  return <main className="workspace-page expense-page">
    {/* hash を直接書き換えず ScreenLink を使うのは、未保存確認を飛び越えないため。 */}
    <ScreenLink to="Templates" className="template-back">{text('← Business templates', '← 業務テンプレート')}</ScreenLink>
    <header className="workspace-header"><div>
      <span className="eyebrow">{text('Business templates', '業務テンプレート')}</span>
      <h1>{text('Expense claims', '経費精算')}</h1>
      <p>{text('Check reimbursement claims against your own policy, approve them, and export a payout CSV and journal drafts. Limits and categories are your data: edit them in the Policy step.', '立替経費の申請を自社の規程でチェックし、承認して、振込用 CSV と仕訳下書きに流します。上限額や費目は利用者が決めるデータで、「規程」ステップで編集できます。')}</p>
    </div></header>
    {loadFailures.length > 0 && <div className="notice-card" role="status">
      <strong>{text('Could not load part of this screen', 'この画面のデータを一部読み込めませんでした')}</strong>
      <ul>{loadFailures.map((entry) => <li key={entry.key}>{entry.label}{staleServer ? '' : `: ${entry.failure.message}`}</li>)}</ul>
      <p>{staleServer
        ? text('The API server has no expense endpoints. Restart the API server: a server started before the expense feature was added does not serve them.', '起動中の API サーバーに経費精算の API がありません。経費精算を追加する前に起動したサーバーには経路が無いので、API サーバーを再起動してください。')
        : text('Check that the API server is running, then retry.', 'API サーバーが動いているか確かめてから再試行してください。')}</p>
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => { for (const entry of loadFailures) void entry.retry(); }}>{text('Retry', '再試行')}</button>
      </div>
    </div>}
    <BusinessStepper steps={steps} active={tab as ExpenseStepTab} onSelect={setTab} label={text('Expense steps', '経費精算の手順')} />
    <div className="expense-ledger-tabs" role="tablist" aria-label={text('Ledgers and masters', '台帳とマスタ')}>
      <span className="expense-ledger-tabs-label" aria-hidden="true">{text('Ledgers and masters', '台帳とマスタ')}</span>
      {EXPENSE_LEDGER_TABS.map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{ledgerTabLabel(id, text)}</button>)}
    </div>
    <ExpenseSlotProvider value={slotEnvironment}>{content}</ExpenseSlotProvider>
  </main>;
}
