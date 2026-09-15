import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExpenseMoneyApi } from '../../api/expense-money-api';
import type {
  ExpenseAdvanceDetailDto, ExpenseAdvanceDto, ExpenseAdvanceJournalStageDto, ExpenseAdvanceSettlementPreviewDto, ExpenseAdvanceStatusDto, SaveExpenseAdvanceDto,
} from '../../api/expense-money-types';
import { scopeQuery } from '../../api/business-api';
import type { TenantScopeDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { formatYen } from '../../journal/journal-model';
import { useOpenInScreen, type OpenTarget } from '../../navigation';
import { claimStatusLabel, type ExpenseTab } from '../expense-model';
import { FieldError, StatusChip } from '../expense-shared';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import {
  BlockingReasonList, MoneyErrorNotice, NoteForm, PaymentForm, advanceStatusLabel, paymentMethodText, readMoneyError, signedYen, todayIso, useMoneyApi,
  type MoneyErrorInfo,
} from './money-shared';

const ADVANCE_STATUSES: readonly ExpenseAdvanceStatusDto[] = ['requested', 'approved', 'paid', 'settling', 'settled', 'cancelled'];
const ADVANCE_AMOUNT_MAX = 10_000_000;

interface EmployeeOption { readonly id: string; readonly name: string; readonly code?: string; readonly departmentName?: string }

/** 仮払の差額（精算済みなら確定値、紐付く申請があれば見込み、無ければ undefined）。 */
export function advanceDifference(advance: Pick<ExpenseAdvanceDto, 'settlement' | 'linkedClaimCount' | 'linkedClaimTotal' | 'amount'>): number | undefined {
  if (advance.settlement !== undefined) return advance.settlement.difference;
  return advance.linkedClaimCount > 0 ? advance.linkedClaimTotal - advance.amount : undefined;
}

function DifferenceCell({ amount }: { readonly amount: number | undefined }) {
  if (amount === undefined) return <span>—</span>;
  return <span className={amount > 0 ? 'expense-money-plus' : amount < 0 ? 'expense-money-minus' : ''}>{signedYen(amount)}</span>;
}

/**
 * 台帳「仮払金」（docs/21 §20.10.1）。一覧（状態・期限切れ・紐付く申請・差額）と、申請 → 承認 → 支払済み → 精算の事前計算と精算 → 返金の受領 / 追加支給 → 仕訳下書き。
 * 承認・支払・精算は人がボタンで押す。取消と支払取消は理由を必須にする。
 */
export function AdvancesLedger({ transport, scope, onOpen, onClaimsChanged, onTab, focus }: ExpenseLedgerSlotProps) {
  const { text } = useI18n();
  const api = useMoneyApi(transport);
  const [statusFilter, setStatusFilter] = useState<ExpenseAdvanceStatusDto | ''>('');
  const [advances, setAdvances] = useState<readonly ExpenseAdvanceDto[]>();
  const [loadError, setLoadError] = useState<MoneyErrorInfo>();
  const [selectedId, setSelectedId] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<MoneyErrorInfo>();
  const [busy, setBusy] = useState(false);
  const [employees, setEmployees] = useState<readonly EmployeeOption[]>();
  const [employeesFailed, setEmployeesFailed] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.listAdvances(scope, statusFilter === '' ? {} : { status: statusFilter });
      setAdvances(next);
      setLoadError(undefined);
    } catch (cause: unknown) {
      setLoadError(readMoneyError(cause));
    }
  }, [api, scope, statusFilter]);

  useEffect(() => { void reload(); }, [reload]);

  // 従業員の選択肢（読めなければ id の手入力に倒す。失敗は赤くしない）。
  useEffect(() => {
    let active = true;
    const query = scopeQuery(scope);
    query.set('enabled', 'true');
    transport.request<{ employees?: readonly EmployeeOption[] }>(`/expense/employees?${query.toString()}`)
      .then((result) => { if (active) { setEmployees(result.employees ?? []); setEmployeesFailed(false); } })
      .catch(() => { if (active) setEmployeesFailed(true); });
    return () => { active = false; };
  }, [transport, scope]);

  // 導線 `advance`（id = 仮払 id）: 絞り込みを外して該当行を選び、強調する。
  useEffect(() => {
    if (focus === undefined || focus.section !== 'advance') return;
    if (focus.id === '') { listRef.current?.scrollIntoView?.({ block: 'start' }); return; }
    setStatusFilter('');
    setSelectedId(focus.id);
    setFocusedId(focus.id);
  }, [focus]);

  const create = async (input: SaveExpenseAdvanceDto & { readonly employeeId: string }) => {
    setBusy(true);
    setCreateError(undefined);
    try {
      const created = await api.createAdvance(scope, input);
      setCreating(false);
      setFeedback(text(`Requested an advance of ${formatYen(created.amount)} for ${created.employeeSnapshot.name}.`, `${created.employeeSnapshot.name} の仮払 ${formatYen(created.amount)} を申請しました。`));
      setSelectedId(created.id);
      await reload();
    } catch (cause: unknown) {
      setCreateError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const changed = async () => {
    await reload();
    await onClaimsChanged();
  };

  const list = advances ?? [];
  return <div className="expense-money">
    <section className="workspace-card" aria-labelledby="expense-money-advances-heading">
      <div className="expense-row-between">
        <h2 id="expense-money-advances-heading">{text('Advances', '仮払金')}</h2>
        <button type="button" className="primary" onClick={() => { setCreating(true); setCreateError(undefined); }}>{text('Request an advance', '仮払を申請')}</button>
      </div>
      {creating && <AdvanceForm mode="new" employees={employees} employeesFailed={employeesFailed} busy={busy} onSubmit={(input) => void create(input)} onCancel={() => setCreating(false)} />}
      <MoneyErrorNotice error={createError} onOpen={onOpen} onTab={onTab} />
      {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}

      <div className="expense-money-toolbar" ref={listRef}>
        <label>{text('Status', '状態')}
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ExpenseAdvanceStatusDto | '')}>
            <option value="">{text('All', 'すべて')}</option>
            {ADVANCE_STATUSES.map((status) => <option key={status} value={status}>{advanceStatusLabel(status, text)}</option>)}
          </select>
        </label>
      </div>
      <MoneyErrorNotice error={loadError} onOpen={onOpen}>
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => void reload()}>{text('Reload', '読み込み直す')}</button></div>
      </MoneyErrorNotice>
      {advances === undefined && loadError === undefined && <p className="empty-state" role="status">{text('Loading advances…', '仮払を読み込み中…')}</p>}
      {advances !== undefined && list.length === 0 && (statusFilter === ''
        ? <div className="expense-empty">
          <p className="empty-state">{text('There are no advances.', '仮払はありません')}</p>
          {!creating && <button type="button" className="secondary" onClick={() => setCreating(true)}>{text('Request an advance', '仮払を申請')}</button>}
        </div>
        : <div className="expense-empty">
          <p className="empty-state">{text('There are no advances in this status.', 'この状態の仮払はありません')}</p>
          <button type="button" className="secondary" onClick={() => setStatusFilter('')}>{text('Show all statuses', 'すべての状態を表示')}</button>
        </div>)}
      {list.length > 0 && <div className="table-wrap"><table>
        <thead><tr>
          <th>{text('Employee', '従業員')}</th><th>{text('Purpose', '目的')}</th><th>{text('Amount', '金額')}</th><th>{text('Needed on', '必要日')}</th>
          <th>{text('Settle by', '精算予定日')}</th><th>{text('Status', '状態')}</th><th>{text('Linked claims', '紐付く申請')}</th><th>{text('Difference', '差額')}</th><th />
        </tr></thead>
        <tbody>{list.map((advance) => <tr key={advance.id}
          className={`${advance.id === selectedId ? 'expense-money-row-selected' : ''} ${advance.id === focusedId ? 'expense-focused' : ''}`.trim()}
          aria-current={advance.id === selectedId ? 'true' : undefined}>
          <td>{advance.employeeSnapshot.name}{advance.department === undefined ? '' : <small> · {advance.department}</small>}</td>
          <td>{advance.purpose}</td>
          <td className="expense-money-amount">{formatYen(advance.amount)}</td>
          <td>{advance.neededOn}</td>
          <td>{advance.plannedSettleBy}{advance.overdue && <> <span className="expense-money-chip expense-money-chip-overdue">{text('Overdue', '期限切れ')}</span></>}</td>
          <td><span className="expense-money-chip">{advanceStatusLabel(advance.status, text)}</span></td>
          <td>{advance.linkedClaimCount === 0 ? '—' : text(`${advance.linkedClaimCount} · ${formatYen(advance.linkedClaimTotal)}`, `${advance.linkedClaimCount} 件 · ${formatYen(advance.linkedClaimTotal)}`)}</td>
          <td className="expense-money-amount"><DifferenceCell amount={advanceDifference(advance)} /></td>
          <td><button type="button" className="secondary" aria-label={text(`Open the advance of ${advance.employeeSnapshot.name}: ${advance.purpose}`, `${advance.employeeSnapshot.name} の仮払「${advance.purpose}」を開く`)} onClick={() => { setSelectedId(advance.id); setFeedback(undefined); }}>{text('Open', '開く')}</button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    {selectedId !== undefined && <AdvanceDetail key={selectedId} api={api} scope={scope} advanceId={selectedId} onOpen={onOpen} onTab={onTab}
      onChanged={changed} onClose={() => { setSelectedId(undefined); setFocusedId(undefined); }} />}
  </div>;
}

/** 仮払の申請・編集フォーム（従業員は新規のときだけ選ぶ）。 */
function AdvanceForm({ mode, initial, employees, employeesFailed, busy, onSubmit, onCancel }: {
  readonly mode: 'new' | 'edit';
  readonly initial?: ExpenseAdvanceDto;
  readonly employees?: readonly EmployeeOption[] | undefined;
  readonly employeesFailed?: boolean;
  readonly busy: boolean;
  readonly onSubmit: (input: SaveExpenseAdvanceDto & { readonly employeeId: string }) => void;
  readonly onCancel: () => void;
}) {
  const { text } = useI18n();
  const [employeeId, setEmployeeId] = useState(initial?.employeeId ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [amount, setAmount] = useState(initial === undefined ? '' : String(initial.amount));
  const [neededOn, setNeededOn] = useState(initial?.neededOn ?? todayIso());
  const [plannedSettleBy, setPlannedSettleBy] = useState(initial?.plannedSettleBy ?? '');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const listId = `expense-money-employees-${mode}`;
  const known = employees?.find((employee) => employee.id === employeeId.trim());

  const submit = () => {
    const next: Record<string, string> = {};
    const value = Number(amount);
    if (mode === 'new' && employeeId.trim() === '') next['employeeId'] = text('Choose the employee who receives the advance.', '仮払を受け取る従業員を選んでください。');
    if (purpose.trim() === '') next['purpose'] = text('Enter the purpose.', '目的を入力してください。');
    if (amount.trim() === '' || !Number.isInteger(value) || value < 1 || value > ADVANCE_AMOUNT_MAX) next['amount'] = text(`Enter a whole yen amount from 1 to ${ADVANCE_AMOUNT_MAX.toLocaleString('en-US')}.`, `1〜${ADVANCE_AMOUNT_MAX.toLocaleString('en-US')} 円の整数で入力してください。`);
    if (neededOn === '') next['neededOn'] = text('Enter the date the money is needed.', '必要日を入力してください。');
    if (plannedSettleBy === '') next['plannedSettleBy'] = text('Enter the planned settlement date.', '精算予定日を入力してください。');
    else if (neededOn !== '' && plannedSettleBy < neededOn) next['plannedSettleBy'] = text('The planned settlement date must not be before the needed date.', '精算予定日は必要日より前にできません。');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit({ employeeId: employeeId.trim(), purpose: purpose.trim(), amount: value, neededOn, plannedSettleBy });
  };

  return <form className="expense-money-inline-form" aria-label={mode === 'new' ? text('Request an advance', '仮払を申請') : text('Edit the advance', '仮払を編集')}
    onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <div className="expense-form">
      {mode === 'new' && <label className="expense-required">{text('Employee ID', '従業員 ID')}
        <input aria-label={text('Employee ID', '従業員 ID')} list={employees === undefined ? undefined : listId} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} />
        {employees !== undefined && <datalist id={listId}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.departmentName === undefined ? '' : ` · ${employee.departmentName}`}</option>)}</datalist>}
        {known !== undefined && <small className="expense-limit-hint">{known.name}</small>}
        {employeesFailed === true && <small className="expense-limit-hint">{text('The employee list could not be loaded. Enter the employee ID from the employee master.', '従業員の一覧を読めませんでした。従業員マスタの ID を入力してください。')}</small>}
        <FieldError message={errors['employeeId']} />
      </label>}
      <label className="expense-required expense-wide">{text('Purpose', '目的')}
        <input aria-label={text('Purpose', '目的')} value={purpose} maxLength={500} onChange={(event) => setPurpose(event.target.value)} />
        <FieldError message={errors['purpose']} />
      </label>
      <label className="expense-required">{text('Amount (yen)', '金額（円）')}
        <input aria-label={text('Amount (yen)', '金額（円）')} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[,\s]/g, ''))} />
        <FieldError message={errors['amount']} />
      </label>
      <label className="expense-required">{text('Needed on', '必要日')}
        <input aria-label={text('Needed on', '必要日')} type="date" value={neededOn} onChange={(event) => setNeededOn(event.target.value)} />
        <FieldError message={errors['neededOn']} />
      </label>
      <label className="expense-required">{text('Planned settlement date', '精算予定日')}
        <input aria-label={text('Planned settlement date', '精算予定日')} type="date" value={plannedSettleBy} onChange={(event) => setPlannedSettleBy(event.target.value)} />
        <FieldError message={errors['plannedSettleBy']} />
      </label>
    </div>
    <div className="expense-actions">
      <button type="submit" className="primary" disabled={busy}>{mode === 'new' ? text('Submit the request', '申請する') : text('Save changes', '変更を保存')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{text('Cancel', 'キャンセル')}</button>
    </div>
  </form>;
}

type AdvanceMode = 'approve' | 'edit' | 'cancel' | 'pay' | 'unpay' | 'refund' | 'additional';

interface JournalOutcome {
  readonly stage: ExpenseAdvanceJournalStageDto;
  readonly entryIds?: readonly string[];
  readonly warnings?: readonly string[];
}

/** 仮払 1 件の詳細と、状態ごとの操作。 */
function AdvanceDetail({ api, scope, advanceId, onOpen, onTab, onChanged, onClose }: {
  readonly api: ExpenseMoneyApi;
  readonly scope: TenantScopeDto;
  readonly advanceId: string;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab: (tab: ExpenseTab) => void;
  readonly onChanged: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [detail, setDetail] = useState<ExpenseAdvanceDetailDto>();
  const [loadError, setLoadError] = useState<MoneyErrorInfo>();
  const [mode, setMode] = useState<AdvanceMode>();
  const [comment, setComment] = useState('');
  const [refundOn, setRefundOn] = useState(todayIso());
  const [preview, setPreview] = useState<ExpenseAdvanceSettlementPreviewDto>();
  const [confirmSettle, setConfirmSettle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoneyErrorInfo>();
  const [feedback, setFeedback] = useState<string>();
  const [journal, setJournal] = useState<JournalOutcome>();

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await api.getAdvance(scope, advanceId));
      setLoadError(undefined);
    } catch (cause: unknown) {
      setLoadError(readMoneyError(cause));
    }
  }, [api, scope, advanceId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  /** 操作を送り、成功したら文言を出して詳細・一覧・申請を読み直す。 */
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    setJournal(undefined);
    try {
      await action();
      setMode(undefined);
      setPreview(undefined);
      setFeedback(success);
      await loadDetail();
      await onChanged();
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
      setConfirmSettle(false);
    }
  };

  const calculate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await api.settlementPreview(scope, advanceId));
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const draftJournal = async (stage: ExpenseAdvanceJournalStageDto) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    setJournal(undefined);
    try {
      const result = await api.createAdvanceJournalDraft(scope, advanceId, stage);
      setJournal({ stage, entryIds: result.entryIds, warnings: result.warnings });
      await loadDetail();
      await onChanged();
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (loadError !== undefined) {
    return <section className="workspace-card expense-money-detail" aria-label={text('Advance', '仮払')}>
      <MoneyErrorNotice error={loadError} onOpen={onOpen} />
      <button type="button" className="secondary" onClick={onClose}>{text('Close', '閉じる')}</button>
    </section>;
  }
  if (detail === undefined) return <section className="workspace-card expense-money-detail" aria-label={text('Advance', '仮払')}><p className="empty-state" role="status">{text('Loading the advance…', '仮払を読み込み中…')}</p></section>;

  const { advance, claims } = detail;
  const settlement = advance.settlement;
  const refundPending = advance.status === 'settling' && settlement?.refund !== undefined && settlement.refund.receivedOn === undefined;
  const additionalPending = advance.status === 'settling' && settlement?.additionalPayment !== undefined && settlement.additionalPayment.status !== 'paid';
  const canDraftPayment = (advance.status === 'paid' || advance.status === 'settling' || advance.status === 'settled') && advance.journalLink?.paymentEntryId === undefined;
  const canDraftSettlement = advance.status === 'settled' && advance.journalLink?.settlementEntryId === undefined;
  const exclude = { advanceId: advance.id };
  const title = text(`Advance: ${advance.employeeSnapshot.name} · ${advance.purpose}`, `仮払: ${advance.employeeSnapshot.name} · ${advance.purpose}`);

  return <section className="workspace-card expense-money-detail" aria-label={title}>
    <div className="expense-row-between">
      <h3>{title}</h3>
      <button type="button" className="secondary" onClick={onClose}>{text('Close', '閉じる')}</button>
    </div>
    <dl>
      <dt>{text('Status', '状態')}</dt><dd><span className="expense-money-chip">{advanceStatusLabel(advance.status, text)}</span>{advance.overdue && <> <span className="expense-money-chip expense-money-chip-overdue">{text('Overdue', '期限切れ')}</span></>}</dd>
      <dt>{text('Amount', '金額')}</dt><dd>{formatYen(advance.amount)}</dd>
      <dt>{text('Needed on / settle by', '必要日 / 精算予定日')}</dt><dd>{advance.neededOn} / {advance.plannedSettleBy}</dd>
      {advance.approval !== undefined && <><dt>{text('Approved', '承認')}</dt><dd>{advance.approval.by} · {advance.approval.at.slice(0, 10)}{advance.approval.proxy ? text(' (proxy)', '（代理）') : ''}{advance.approval.comment === undefined ? '' : ` · ${advance.approval.comment}`}</dd></>}
      {advance.payment !== undefined && <><dt>{text('Paid', '支払')}</dt><dd>{advance.payment.paidOn} · {paymentMethodText(advance.payment.method, text)}</dd></>}
      {settlement !== undefined && <><dt>{text('Settlement', '精算')}</dt><dd>
        {text(`Claims ${formatYen(settlement.claimsTotal)} · difference ${signedYen(settlement.difference)}`, `申請 ${formatYen(settlement.claimsTotal)} · 差額 ${signedYen(settlement.difference)}`)}
        {settlement.refund !== undefined && <> · {settlement.refund.receivedOn === undefined ? text(`refund ${formatYen(settlement.refund.amount)} not received yet`, `返金 ${formatYen(settlement.refund.amount)} は未受領`) : text(`refund received on ${settlement.refund.receivedOn}`, `返金を ${settlement.refund.receivedOn} に受領`)}</>}
        {settlement.additionalPayment !== undefined && <> · {settlement.additionalPayment.status === 'paid' ? text(`additional payment paid on ${settlement.additionalPayment.paidOn ?? ''}`, `追加支給を ${settlement.additionalPayment.paidOn ?? ''} に支払済み`) : text(`additional payment ${formatYen(settlement.additionalPayment.amount)} not paid yet`, `追加支給 ${formatYen(settlement.additionalPayment.amount)} は未払い`)}</>}
        {settlement.settledOn !== undefined && <> · {text(`settled on ${settlement.settledOn}`, `${settlement.settledOn} に精算済み`)}</>}
      </dd></>}
      {advance.cancel !== undefined && <><dt>{text('Cancelled', '取消')}</dt><dd>{advance.cancel.at.slice(0, 10)} · {advance.cancel.note}</dd></>}
      {advance.journalLink?.paymentEntryId !== undefined && <><dt>{text('Payment journal draft', '支払の仕訳下書き')}</dt><dd><button type="button" className="screen-link" onClick={() => openInScreen('Journal', { internalId: advance.journalLink?.paymentEntryId ?? '', section: 'entry' })}>{advance.journalLink.paymentEntryId}</button></dd></>}
      {advance.journalLink?.settlementEntryId !== undefined && <><dt>{text('Settlement journal draft', '精算の仕訳下書き')}</dt><dd><button type="button" className="screen-link" onClick={() => openInScreen('Journal', { internalId: advance.journalLink?.settlementEntryId ?? '', section: 'entry' })}>{advance.journalLink.settlementEntryId}</button></dd></>}
    </dl>

    <h4>{text('Linked claims', '紐付く申請')}</h4>
    {claims.length === 0
      ? <p className="empty-state">{text('No claims are linked yet. Link this advance from the claim ("Advance link" in Ingest).', 'まだ申請が紐付いていません。申請取込の申請で「仮払の紐付け」から選びます。')}</p>
      : <div className="table-wrap"><table>
        <thead><tr><th>{text('Claimant', '申請者')}</th><th>{text('Period', '期間')}</th><th>{text('Status', '状態')}</th><th>{text('Amount', '金額')}</th><th /></tr></thead>
        <tbody>{claims.map((claim) => <tr key={claim.id}>
          <td>{claim.claimant.name}</td><td>{claim.period.from}〜{claim.period.to}</td><td><StatusChip status={claim.status} /></td>
          <td className="expense-money-amount">{formatYen(claim.totalAmount)}</td>
          <td><button type="button" className="secondary" onClick={() => onOpen({ internalId: claim.id, section: 'claim' })}>{text('Open the claim', '申請を開く')}</button></td>
        </tr>)}</tbody>
      </table></div>}

    <div className="expense-actions" aria-label={text('Advance operations', '仮払の操作')}>
      {advance.status === 'requested' && <>
        <button type="button" className="primary" disabled={busy} onClick={() => setMode('approve')}>{text('Approve', '承認')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode('edit')}>{text('Edit', '編集')}</button>
      </>}
      {advance.status === 'approved' && <button type="button" className="primary" disabled={busy} onClick={() => setMode('pay')}>{text('Mark as paid', '支払済みにする')}</button>}
      {(advance.status === 'requested' || advance.status === 'approved') && <button type="button" className="secondary danger" disabled={busy} onClick={() => setMode('cancel')}>{text('Cancel the advance', '取消')}</button>}
      {advance.status === 'paid' && <>
        <button type="button" className="primary" disabled={busy} onClick={() => void calculate()}>{text('Calculate the settlement', '精算を計算')}</button>
        <button type="button" className="secondary danger" disabled={busy} onClick={() => setMode('unpay')}>{text('Undo the payment', '支払取消')}</button>
      </>}
      {refundPending && <button type="button" className="primary" disabled={busy} onClick={() => setMode('refund')}>{text('Refund received', '返金を受け取った')}</button>}
      {additionalPending && <button type="button" className="primary" disabled={busy} onClick={() => setMode('additional')}>{text('Additional payment paid', '追加支給を支払済み')}</button>}
      {canDraftPayment && <button type="button" className="secondary" disabled={busy} onClick={() => void draftJournal('payment')}>{text('Create the payment journal draft', '支払の仕訳下書きを作成')}</button>}
      {canDraftSettlement && <button type="button" className="secondary" disabled={busy} onClick={() => void draftJournal('settlement')}>{text('Create the settlement journal draft', '精算の仕訳下書きを作成')}</button>}
    </div>
    {additionalPending && settlement?.additionalPayment?.status === 'exported' && <p className="empty-state">{text('The additional payment is in a payout file. Mark it as paid after the transfer is done.', '追加支給は振込データに含まれています。振込が済んでから支払済みにしてください。')}</p>}

    {mode === 'approve' && <form className="expense-money-inline-form" aria-label={text('Approve the advance', '仮払を承認')} onSubmit={(event) => { event.preventDefault(); void run(() => api.approveAdvance(scope, advanceId, comment.trim()), text('Approved the advance.', '仮払を承認しました。')); }}>
      <label>{text('Comment (optional)', 'コメント（任意）')}<input value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} /></label>
      <div className="expense-actions">
        <button type="submit" className="primary" disabled={busy}>{text('Approve this advance', 'この仮払を承認')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode(undefined)}>{text('Cancel', 'キャンセル')}</button>
      </div>
    </form>}
    {mode === 'edit' && <AdvanceForm mode="edit" initial={advance} busy={busy} onCancel={() => setMode(undefined)}
      onSubmit={(input) => void run(() => api.updateAdvance(scope, advanceId, { purpose: input.purpose, amount: input.amount, neededOn: input.neededOn, plannedSettleBy: input.plannedSettleBy }), text('Saved the advance.', '仮払を保存しました。'))} />}
    {mode === 'cancel' && <NoteForm label={text('Reason for cancelling', '取消の理由')} submitLabel={text('Cancel the advance', '取消')} danger busy={busy} onCancel={() => setMode(undefined)}
      onSubmit={(note) => void run(() => api.cancelAdvance(scope, advanceId, note), text('Cancelled the advance.', '仮払を取り消しました。'))} />}
    {mode === 'unpay' && <NoteForm label={text('Reason for undoing the payment', '支払取消の理由')} submitLabel={text('Undo the payment', '支払取消')} danger busy={busy} onCancel={() => setMode(undefined)}
      onSubmit={(note) => void run(() => api.unpayAdvance(scope, advanceId, note), text('Undid the payment. The advance is approved again.', '支払を取り消しました。仮払は承認済みに戻りました。'))} />}
    {mode === 'pay' && <PaymentForm submitLabel={text('Mark as paid', '支払済みにする')} busy={busy} onCancel={() => setMode(undefined)}
      onSubmit={(payment) => void run(() => api.markAdvancePaid(scope, advanceId, payment), text('Marked the advance as paid.', '仮払を支払済みにしました。'))} />}
    {mode === 'additional' && <PaymentForm submitLabel={text('Additional payment paid', '追加支給を支払済み')} busy={busy} onCancel={() => setMode(undefined)}
      onSubmit={(payment) => void run(() => api.additionalPaid(scope, advanceId, payment), text('Recorded the additional payment. The advance is settled.', '追加支給を記録しました。仮払は精算済みです。'))} />}
    {mode === 'refund' && <form className="expense-money-inline-form" aria-label={text('Refund received', '返金を受け取った')} onSubmit={(event) => { event.preventDefault(); if (refundOn !== '') void run(() => api.refundReceived(scope, advanceId, refundOn), text('Recorded the refund. The advance is settled.', '返金を記録しました。仮払は精算済みです。')); }}>
      <label>{text('Received on', '受領日')}<input type="date" value={refundOn} onChange={(event) => setRefundOn(event.target.value)} /></label>
      <div className="expense-actions">
        <button type="submit" className="primary" disabled={busy || refundOn === ''}>{text('Record the refund', '返金を記録')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode(undefined)}>{text('Cancel', 'キャンセル')}</button>
      </div>
    </form>}

    {preview !== undefined && <SettlementPreview advance={advance} preview={preview} busy={busy} onOpen={onOpen} onSettle={() => setConfirmSettle(true)} onClose={() => setPreview(undefined)} />}

    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    {journal !== undefined && (journal.entryIds?.length ?? 0) > 0 && <div className="expense-journal-outcome">
      <InlineFeedback kind="success">{text(`Created ${journal.entryIds?.length ?? 0} journal draft(s).`, `${journal.entryIds?.length ?? 0} 件の仕訳下書きを作成しました。`)}</InlineFeedback>
      {(journal.warnings ?? []).map((warning) => <p key={warning} className="notice-card">{warning}</p>)}
      <button type="button" className="secondary" onClick={() => openInScreen('Journal', { internalId: journal.entryIds?.[0] ?? '', section: 'entry' })}>{text('Confirm them in the journal screen', '仕訳画面で確定する')}</button>
    </div>}
    <MoneyErrorNotice error={error} onOpen={onOpen} onTab={onTab} exclude={exclude} />

    <details>
      <summary>{text('History', '履歴')}</summary>
      <ul>{advance.history.map((event, index) => <li key={`${event.at}-${index}`}>{event.at.slice(0, 16).replace('T', ' ')} · {event.type}{event.by === undefined ? '' : ` · ${event.by}`}{event.note === undefined ? '' : ` · ${event.note}`}</li>)}</ul>
    </details>

    <ConfirmDialog open={confirmSettle} busy={busy}
      title={text('Settle this advance?', 'この仮払を精算しますか？')}
      message={<>
        <p>{text('The linked claims become settled.', '紐付く申請は精算済みになります。')}</p>
        {preview !== undefined && <p className="expense-total">{directionText(preview, text)}</p>}
      </>}
      confirmLabel={text('Settle', '精算する')} cancelLabel={text('Cancel', 'キャンセル')}
      onConfirm={() => void run(() => api.settleAdvance(scope, advanceId), text('Settled the advance. The linked claims are settled.', '仮払を精算しました。紐付く申請は精算済みになりました。'))}
      onCancel={() => setConfirmSettle(false)} />
  </section>;
}

function directionText(preview: Pick<ExpenseAdvanceSettlementPreviewDto, 'direction' | 'difference'>, text: (en: string, ja: string) => string): string {
  switch (preview.direction) {
    case 'additional': return text(`Additional payment of ${formatYen(preview.difference)} to the employee`, `追加支給 ${formatYen(preview.difference)}（会社 → 従業員）`);
    case 'refund': return text(`Refund of ${formatYen(-preview.difference)} from the employee`, `返金 ${formatYen(-preview.difference)}（従業員 → 会社）`);
    default: return text('No difference. The advance is settled as it is.', '差額なし。そのまま精算済みになります。');
  }
}

function SettlementPreview({ advance, preview, busy, onOpen, onSettle, onClose }: {
  readonly advance: ExpenseAdvanceDto;
  readonly preview: ExpenseAdvanceSettlementPreviewDto;
  readonly busy: boolean;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onSettle: () => void;
  readonly onClose: () => void;
}) {
  const { text } = useI18n();
  const blocked = preview.blockers.length > 0;
  return <section className="expense-money-preview" aria-label={text('Settlement preview', '精算の事前計算')}>
    <p>{text(`Advance ${formatYen(advance.amount)} · claims ${formatYen(preview.claimsTotal)} · difference ${signedYen(preview.difference)}`, `仮払 ${formatYen(advance.amount)} · 申請 ${formatYen(preview.claimsTotal)} · 差額 ${signedYen(preview.difference)}`)}</p>
    <p className="expense-money-direction">{directionText(preview, text)}</p>
    {preview.claims.length === 0 && <p>{text('No claims are linked, so the whole advance would be refunded.', '紐付く申請が無いので、仮払の全額が返金になります。')}</p>}
    {preview.claims.length > 0 && <ul>{preview.claims.map((claim) => <li key={claim.id}>
      {claim.claimantName ?? claim.id} · {claimStatusLabel(claim.status, text)} · {formatYen(claim.reimbursableAmount)}{' '}
      <button type="button" className="screen-link" onClick={() => onOpen({ internalId: claim.id, section: 'claim' })}>{text('Open', '開く')}</button>
    </li>)}</ul>}
    {blocked && <div role="note">
      <p><strong>{text('It cannot be settled yet', 'まだ精算できません')}</strong></p>
      <BlockingReasonList reasons={preview.blockers} onOpen={onOpen} exclude={{ advanceId: advance.id }} />
    </div>}
    <div className="expense-actions">
      <button type="button" className="primary" disabled={busy || blocked} onClick={onSettle}>{text('Settle', '精算する')}</button>
      <button type="button" className="secondary" onClick={onClose}>{text('Close', '閉じる')}</button>
    </div>
  </section>;
}
