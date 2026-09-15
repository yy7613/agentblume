import { useEffect, useMemo, useState } from 'react';
import type { ReceivablesApi } from '../api/receivables-api';
import type { BankTransactionDto, CustomerDto, InvoiceSummaryDto, JournalFollowUpDto, MatchCandidateDto, MatchingDto, ConfirmDecidedResultDto } from '../api/receivables-types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { scope } from '../scope';
import { allocationBalance, expectedOutstandingOf, formatYen, isOpenInvoice, stageLabel, summarizeMatch, type MatchAction } from './receivables-model';
import { codeOf, detailsOf, ErrorNotice, FollowUpNotice } from './receivables-shared';

type Filter = 'decided' | 'candidate' | 'unmatched' | 'ignored' | 'matched';

/**
 * 消込ステップ（docs/22 §4.5 / §8）。「消込を判定」→ 入金ごとのカード（判定・原因・次の一手・ボタン・候補）→ 確定 /
 * 確定して名義を覚える / 配分を編集 / 対象外。`decided` の一括確定、消込済みタブで取消。
 */
export function MatchingStep({ api, transactions, invoices, customers, focus, onChanged, onAction }: {
  readonly api: ReceivablesApi; readonly transactions: readonly BankTransactionDto[]; readonly invoices: readonly InvoiceSummaryDto[]; readonly customers: readonly CustomerDto[];
  readonly focus: { readonly id: string; readonly seq: number } | undefined;
  readonly onChanged: () => Promise<void> | void; readonly onAction: (action: MatchAction) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [filter, setFilter] = useState<Filter | 'all'>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [followUp, setFollowUp] = useState<JournalFollowUpDto>();
  const [done, setDone] = useState<string>();
  const [bulk, setBulk] = useState<ConfirmDecidedResultDto>();
  const [learn, setLearn] = useState<Readonly<Record<string, boolean>>>({});
  const [editing, setEditing] = useState<{ readonly transaction: BankTransactionDto; readonly allocations: Readonly<Record<string, number>>; readonly fee: number }>();
  const [matchings, setMatchings] = useState<readonly MatchingDto[]>([]);
  const [cancelling, setCancelling] = useState<MatchingDto>();
  const [removeAlias, setRemoveAlias] = useState(false);
  const [highlight, setHighlight] = useState<string>();

  useEffect(() => { if (focus !== undefined) setHighlight(focus.id); }, [focus]);
  useEffect(() => { void api.listMatchings(scope, { status: 'confirmed' }).then(setMatchings).catch(() => setMatchings([])); }, [api, transactions]);

  const customerName = useMemo(() => { const names = new Map(customers.map((customer) => [customer.id, customer.name])); return (id: string) => names.get(id) ?? id; }, [customers]);
  const invoiceById = useMemo(() => new Map(invoices.map((invoice) => [invoice.id, invoice])), [invoices]);
  const invoiceNumber = (id: string) => invoiceById.get(id)?.number ?? id;
  const openInvoices = invoices.filter(isOpenInvoice);

  const stateOf = (transaction: BankTransactionDto): Filter => transaction.status === 'ignored' ? 'ignored' : transaction.status === 'matched' ? 'matched' : (transaction.judgment?.stage ?? 'unmatched');
  const visible = transactions.filter((transaction) => filter === 'all' ? transaction.status !== 'matched' : stateOf(transaction) === filter);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(undefined); setFollowUp(undefined);
    try { await work(); await onChanged(); }
    catch (cause: unknown) { setError(cause); }
    finally { setBusy(false); }
  };

  const judge = () => run(async () => {
    const result = await api.judge(scope);
    setDone(text(`Judged: ${result.counts.decided} decided, ${result.counts.candidate} candidates, ${result.counts.unmatched} pending.`, `判定しました: 決定 ${result.counts.decided} ・ 候補 ${result.counts.candidate} ・ 保留 ${result.counts.unmatched}`));
  });

  const confirm = (transaction: BankTransactionDto, candidate: MatchCandidateDto, learnAlias: boolean) => run(async () => {
    const result = await api.confirmMatching(scope, { transactionId: transaction.id, allocations: candidate.allocations, feeAmount: candidate.feeAmount, expectedOutstanding: expectedOutstandingOf(candidate), ...(learnAlias ? { learnAlias: { customerId: candidate.customerId } } : {}) });
    setFollowUp(result.journalFollowUp);
    setDone(text('Confirmed the matching.', '消込を確定しました。'));
  });

  const confirmEdited = () => {
    if (editing === undefined) return;
    const allocations = Object.entries(editing.allocations).filter(([, amount]) => amount > 0).map(([invoiceId, amount]) => ({ invoiceId, amount }));
    const expectedOutstanding = Object.fromEntries(allocations.map((allocation) => [allocation.invoiceId, invoiceById.get(allocation.invoiceId)?.outstanding ?? 0]));
    void run(async () => {
      const result = await api.confirmMatching(scope, { transactionId: editing.transaction.id, allocations, feeAmount: editing.fee, expectedOutstanding });
      setFollowUp(result.journalFollowUp);
      setEditing(undefined);
      setDone(text('Confirmed the matching.', '消込を確定しました。'));
    });
  };

  const act = (transaction: BankTransactionDto, action: MatchAction) => {
    const candidate = transaction.judgment?.candidates[0];
    if (action.kind === 'confirm' && candidate !== undefined) { void confirm(transaction, candidate, learn[transaction.id] ?? action.learnAlias); return; }
    if (action.kind === 'edit-allocation') { setEditing({ transaction, allocations: Object.fromEntries((candidate?.allocations ?? []).map((allocation) => [allocation.invoiceId, allocation.amount])), fee: candidate?.feeAmount ?? 0 }); return; }
    if (action.kind === 'ignore') { void run(async () => { await api.ignoreTransaction(scope, transaction.id); }); return; }
    if (action.kind === 'rejudge') { void judge(); return; }
    if (action.kind === 'open-journal') { openInScreen('Journal', { internalId: '', section: 'entry' }); return; }
    onAction(action);
  };

  const balance = editing === undefined ? 0 : allocationBalance(editing.transaction.amount, Object.values(editing.allocations).map((amount) => ({ amount })), editing.fee);
  const outstandingChanged = codeOf(error) === 'RECEIVABLES_STATE' && detailsOf(error)?.['reason'] === 'invoice-outstanding-changed';
  const decidedCount = transactions.filter((transaction) => transaction.status === 'unmatched' && transaction.judgment?.stage === 'decided' && (transaction.judgment.contendedBy ?? []).length === 0).length;

  return <section className="receivables-step" aria-label={text('Matching', '消込')}>
    <div className="receivables-toolbar">
      <button type="button" className="primary" disabled={busy} onClick={() => { void judge(); }}>{text('Judge deposits', '消込を判定')}</button>
      <button type="button" className="secondary" disabled={busy || decidedCount === 0} onClick={() => { void run(async () => { setBulk(await api.confirmDecided(scope)); }); }}>{text(`Confirm all decided (${decidedCount})`, `決定を一括確定（${decidedCount}）`)}</button>
      <label>{text('Show', '表示')}<select aria-label={text('Filter', '状態フィルタ')} value={filter} onChange={(event) => setFilter(event.target.value as Filter | 'all')}>
        <option value="all">{text('Not reconciled', '未消込すべて')}</option><option value="decided">{stageLabel('decided', text)}</option><option value="candidate">{stageLabel('candidate', text)}</option>
        <option value="unmatched">{stageLabel('unmatched', text)}</option><option value="ignored">{text('Ignored', '対象外')}</option><option value="matched">{text('Reconciled', '消込済み')}</option>
      </select></label>
    </div>
    <ErrorNotice error={error}>{outstandingChanged && <button type="button" className="secondary" onClick={() => { void judge(); }}>{text('Judge again', '再判定')}</button>}</ErrorNotice>
    <FollowUpNotice followUp={followUp} />
    {done !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={() => setDone(undefined)}>{done}</InlineFeedback>}
    {bulk !== undefined && <div className="receivables-panel" role="status">
      <p>{text(`Confirmed ${bulk.confirmed.length}, failed ${bulk.failed.length}.`, `確定 ${bulk.confirmed.length} 件 ・ 失敗 ${bulk.failed.length} 件`)}</p>
      {bulk.failed.length > 0 && <ul>{bulk.failed.map((failure) => <li key={failure.transactionId}>{failure.transactionId}: {failure.reason ?? failure.code} — {text('judge again and confirm it individually.', '再判定して個別に確定してください。')}</li>)}</ul>}
    </div>}
    {transactions.filter((transaction) => transaction.status === 'unmatched').length === 0 && filter !== 'matched' && filter !== 'ignored'
      ? <p className="empty-state">{text('No deposits to reconcile.', '消し込む入金はありません。')} <button type="button" className="secondary" onClick={() => onAction({ kind: 'new-invoice' })}>{text('Go to Bank import', '明細取込へ')}</button></p>
      : openInvoices.length === 0 && filter === 'all' && <p className="empty-state">{text('There are no unpaid invoices.', '未入金の請求がありません。')}</p>}

    {filter === 'matched'
      ? <table className="receivables-table" aria-label={text('Reconciled', '消込済み')}><thead><tr><th>{text('Deposit', '入金')}</th><th>{text('Invoices', '請求')}</th><th>{text('Fee', '手数料')}</th><th /></tr></thead>
        <tbody>{matchings.map((matching) => <tr key={matching.id}>
          <td>{formatYen(matching.transactionAmount)}</td><td>{matching.allocations.map((allocation) => `${invoiceNumber(allocation.invoiceId)} ${formatYen(allocation.amount)}`).join(', ')}</td><td>{formatYen(matching.feeAmount)}</td>
          <td><button type="button" className="secondary" onClick={() => { setCancelling(matching); setRemoveAlias(matching.learnedAlias !== undefined); }}>{text('Cancel matching', '消込を取り消す')}</button></td>
        </tr>)}</tbody></table>
      : visible.map((transaction) => {
        const judgment = transaction.judgment;
        const summary = judgment === undefined ? undefined : summarizeMatch(transaction, judgment, { customerName, invoiceNumber }, text);
        const learnDefault = judgment?.reason === 'amount-only' || judgment?.reason === 'name-partial';
        return <article key={transaction.id} className={`receivables-card${highlight === transaction.id ? ' selected' : ''}`} aria-label={text(`Deposit ${transaction.payerName} ${transaction.amount}`, `入金 ${transaction.payerName} ${transaction.amount}`)}>
          <header><strong>{transaction.date}</strong> <span>{formatYen(transaction.amount)}</span> <span>{transaction.payerName || transaction.description}</span>
            <span className={`judge-chip receivables-stage-${stateOf(transaction)}`}>{transaction.status === 'ignored' ? text('Ignored', '対象外') : judgment === undefined ? text('Not judged', '未判定') : stageLabel(judgment.stage, text)}</span></header>
          {transaction.status === 'ignored' && <p>{transaction.ignoredNote} <button type="button" className="secondary" onClick={() => { void run(async () => { await api.unignoreTransaction(scope, transaction.id); }); }}>{text('Restore', '戻す')}</button></p>}
          {summary !== undefined && transaction.status === 'unmatched' && <>
            <p>{summary.cause}</p>
            <p className="receivables-next">{text('Next step: ', '次の一手: ')}{summary.next}</p>
            {(judgment?.contendedBy ?? []).length > 0 && <p className="receivables-warning">{text('Another deposit points at the same invoice. Check both before confirming.', '同じ請求を推す入金が他にもあります。両方を確かめてから確定してください。')}</p>}
            {judgment!.candidates.length > 0 && <table className="receivables-table"><thead><tr><th>#</th><th>{text('Invoices', '請求')}</th><th>{text('Customer', '取引先')}</th><th>{text('Balance', '残高')}</th><th>{text('Difference', '差額')}</th><th>{text('Name', '名義一致')}</th></tr></thead>
              <tbody>{judgment!.candidates.map((candidate) => <tr key={candidate.rank}><td>{candidate.rank}</td><td>{candidate.invoiceIds.map(invoiceNumber).join(', ')}</td><td>{customerName(candidate.customerId)}</td><td>{formatYen(candidate.candidateTotal)}</td><td>{formatYen(candidate.difference)}</td><td>{candidate.nameMatch}</td></tr>)}</tbody></table>}
            {learnDefault && <label className="receivables-inline"><input type="checkbox" checked={learn[transaction.id] ?? true} onChange={(event) => setLearn({ ...learn, [transaction.id]: event.target.checked })} />{text('Remember this payer name for the customer', 'この名義を取引先の別名として覚える')}</label>}
            <div className="run-failure-actions">{summary.buttons.map((button, index) => <button key={index} type="button" className={button.primary === true ? 'primary' : 'secondary'} disabled={busy} onClick={() => act(transaction, button.action)}>{button.label}</button>)}</div>
          </>}
          {judgment === undefined && transaction.status === 'unmatched' && <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => act(transaction, { kind: 'edit-allocation' })}>{text('Allocate manually', '手動で配分')}</button></div>}
        </article>;
      })}

    {editing !== undefined && <div className="receivables-panel" role="dialog" aria-label={text('Edit allocation', '配分を編集')}>
      <h4>{text(`Allocate ${formatYen(editing.transaction.amount)}`, `${formatYen(editing.transaction.amount)} を配分`)}</h4>
      <table className="receivables-table"><thead><tr><th>{text('Invoice', '請求')}</th><th>{text('Balance', '残高')}</th><th>{text('Allocate', '配分額')}</th></tr></thead>
        <tbody>{openInvoices.map((invoice) => <tr key={invoice.id}><td>{invoice.number} {invoice.customerName}</td><td>{formatYen(invoice.outstanding)}</td>
          <td><input type="number" min={0} aria-label={text(`Allocate to ${invoice.number}`, `${invoice.number} への配分`)} value={editing.allocations[invoice.id] ?? ''} onChange={(event) => setEditing({ ...editing, allocations: { ...editing.allocations, [invoice.id]: Number(event.target.value) } })} /></td></tr>)}</tbody></table>
      <label>{text('Transfer fee (yen)', '振込手数料（円）')}<input type="number" min={0} aria-label={text('Fee', '手数料')} value={editing.fee} onChange={(event) => setEditing({ ...editing, fee: Number(event.target.value) })} /></label>
      <p role="status">{balance === 0 ? text('Allocations minus the fee equal the deposit.', '配分合計 − 手数料 が入金額と一致しています。') : text(`Off by ${formatYen(balance)}.`, `差額 ${formatYen(balance)} があります。`)}</p>
      <div className="receivables-toolbar">
        <button type="button" className="primary" disabled={balance !== 0 || busy} onClick={confirmEdited}>{text('Confirm allocation', '配分で確定')}</button>
        <button type="button" className="secondary" onClick={() => setEditing(undefined)}>{text('Close', '閉じる')}</button>
      </div>
    </div>}
    <ConfirmDialog open={cancelling !== undefined} danger busy={busy} title={text('Cancel this matching?', 'この消込を取り消しますか？')}
      message={<>{text('The deposit returns to not reconciled, the invoice balance is restored, and the draft receipt entry is deleted.', '入金は未消込に戻り、請求の残高が戻り、入金仕訳の下書きは消えます。')}
        {cancelling?.learnedAlias !== undefined && <label className="receivables-inline"><input type="checkbox" checked={removeAlias} onChange={(event) => setRemoveAlias(event.target.checked)} />{text('Also remove the payer name learned by this matching', 'この消込で覚えた名義も消す')}</label>}</>}
      confirmLabel={text('Cancel matching', '取り消す')} cancelLabel={text('Keep', 'やめる')}
      onConfirm={() => { const target = cancelling; if (target === undefined) return; void run(async () => { const result = await api.cancelMatching(scope, target.id, removeAlias); setFollowUp(result.journalFollowUp); setCancelling(undefined); }); }}
      onCancel={() => setCancelling(undefined)} />
  </section>;
}
