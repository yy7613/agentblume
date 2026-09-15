import { useCallback, useEffect, useState } from 'react';
import type { ContractApi } from '../api/contract-api';
import type { DeadlineKindDto, DeadlineStateDto, LedgerDto, SignedContractDto } from '../api/contract-types';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { contractStatusLabel, daysLeftLabel, deadlineKindLabel, deadlineStateLabel } from './contract-model';
import { ApiFailure, Field } from './contract-shared';

/**
 * 期限台帳（docs/23 §7.1）。期限の近い順に並べ、「通知済みにする」「契約を開く」「終了にする」を行から押せる。
 * 状態チップ（期限切れ / 期限が近い / 予定）は今日から計算した表示で、保存しない。
 */
export function LedgerStep({ api, focusContractId, onImport, onChanged }: {
  readonly api: ContractApi;
  readonly focusContractId?: string;
  readonly onImport: () => void;
  readonly onChanged: () => void;
}) {
  const { text } = useI18n();
  const [withinDays, setWithinDays] = useState<number | undefined>(90);
  const [kind, setKind] = useState<DeadlineKindDto | ''>('');
  const [state, setState] = useState<DeadlineStateDto | ''>('');
  const [ledger, setLedger] = useState<LedgerDto>();
  const [contract, setContract] = useState<SignedContractDto>();
  const [terminatedAt, setTerminatedAt] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();

  const reload = useCallback(async () => {
    try { setLedger(await api.listDeadlines(scope, { ...(withinDays === undefined ? {} : { withinDays }), includeOverdue: true, ...(kind === '' ? {} : { kind }) })); setError(undefined); }
    catch (cause) { setError(cause); }
  }, [api, withinDays, kind]);
  useEffect(() => { void reload(); }, [reload]);

  const openContract = useCallback(async (id: string) => {
    try { setContract(await api.getSigned(scope, id)); setError(undefined); } catch (cause) { setError(cause); }
  }, [api]);
  useEffect(() => { if (focusContractId !== undefined) void openContract(focusContractId); }, [focusContractId, openContract]);

  async function complete(contractId: string, deadlineId: string): Promise<void> {
    try { await api.completeDeadline(scope, contractId, deadlineId); setNotice(text('Marked as notified.', '通知済みにしました。')); await reload(); if (contract?.id === contractId) await openContract(contractId); }
    catch (cause) { setError(cause); }
  }

  async function terminate(): Promise<void> {
    if (contract === undefined || terminatedAt === '') return;
    try { setContract(await api.terminateSigned(scope, contract.id, terminatedAt, reason)); setNotice(text('The contract is terminated. Its open deadlines were closed.', '契約を終了にしました。未完了の期限は閉じました。')); await reload(); onChanged(); }
    catch (cause) { setError(cause); }
  }

  async function remove(): Promise<void> {
    if (contract === undefined) return;
    if (typeof window.confirm === 'function' && !window.confirm(text('Delete this signed contract from the ledger? The document goes back to before signing.', 'この締結済み契約を台帳から削除しますか？ 文書は締結登録の前の状態へ戻ります。'))) return;
    try { await api.deleteSigned(scope, contract.id); setContract(undefined); await reload(); onChanged(); } catch (cause) { setError(cause); }
  }

  const rows = (ledger?.rows ?? []).filter((row) => state === '' || row.state === state);

  return <section className="contract-step contract-ledger" aria-label={text('Deadline ledger', '期限台帳')}>
    {error !== undefined && <ApiFailure cause={error} />}
    {notice !== undefined && <p className="contract-saved" role="status">{notice}</p>}
    <div className="contract-toolbar">
      <Field label={text('Within', '期間')}><select value={withinDays === undefined ? '' : String(withinDays)} onChange={(event) => setWithinDays(event.target.value === '' ? undefined : Number(event.target.value))}>
        {[30, 60, 90].map((days) => <option key={days} value={days}>{text(`${days} days`, `${days} 日以内`)}</option>)}<option value="">{text('All', 'すべて')}</option>
      </select></Field>
      <Field label={text('Kind', '種類')}><select value={kind} onChange={(event) => setKind(event.target.value as DeadlineKindDto | '')}><option value="">{text('All', 'すべて')}</option>{(['renewal_notice', 'expiry', 'renewal', 'custom'] as const).map((entry) => <option key={entry} value={entry}>{deadlineKindLabel(entry, text)}</option>)}</select></Field>
      <Field label={text('State', '状態')}><select value={state} onChange={(event) => setState(event.target.value as DeadlineStateDto | '')}><option value="">{text('All', 'すべて')}</option>{(['overdue', 'due-soon', 'upcoming'] as const).map((entry) => <option key={entry} value={entry}>{deadlineStateLabel(entry, text)}</option>)}</select></Field>
      {ledger !== undefined && <small>{text(`Today: ${ledger.today}`, `今日: ${ledger.today}`)}</small>}
    </div>
    {ledger !== undefined && rows.length === 0 && <div className="empty-state">
      <p>{text('Deadlines of the contracts you register as signed appear here.', '締結登録した契約の期限がここに並びます。')}</p>
      <button type="button" className="secondary" onClick={onImport}>{text('Import a contract', '契約を取り込む')}</button>
    </div>}
    {rows.length > 0 && <div className="table-wrap"><table className="journal-table contract-ledger-table">
      <thead><tr><th>{text('Due', '期限日')}</th><th>{text('Days left', '残り')}</th><th>{text('Kind', '種類')}</th><th>{text('Contract', '契約')}</th><th>{text('Counterparty', '相手方')}</th><th>{text('Basis', '根拠')}</th><th>{text('State', '状態')}</th><th /></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.contractId}:${row.deadline.id}`}>
        <td>{row.deadline.dueDate}</td><td>{daysLeftLabel(row.daysLeft, text)}</td><td>{deadlineKindLabel(row.deadline.kind, text)}</td>
        <td>{row.title}</td><td>{row.counterpartyName}</td><td>{row.deadline.basis}</td>
        <td><span className={`judge-chip contract-state-${row.state}`}>{deadlineStateLabel(row.state, text)}</span></td>
        <td className="run-failure-actions">
          <button type="button" className="secondary" onClick={() => void complete(row.contractId, row.deadline.id)}>{text('Mark as notified', '通知済みにする')}</button>
          <button type="button" className="secondary" onClick={() => void openContract(row.contractId)}>{text('Open contract', '契約を開く')}</button>
        </td>
      </tr>)}</tbody>
    </table></div>}
    {contract !== undefined && <div className="workspace-card contract-signed-detail">
      <h3>{contract.title} <span className="judge-chip">{contractStatusLabel(contract.displayStatus ?? contract.status, text)}</span></h3>
      <p>{text(`${contract.counterpartyName} · signed ${contract.signedDate}`, `${contract.counterpartyName}・締結日 ${contract.signedDate}`)}</p>
      {contract.warnings.map((warning, index) => <p key={index} className="contract-note">{warning.message}</p>)}
      <table className="journal-table"><thead><tr><th>{text('Kind', '種類')}</th><th>{text('Due', '期限日')}</th><th>{text('Status', '状態')}</th><th>{text('Basis', '根拠')}</th></tr></thead>
        <tbody>{contract.deadlines.map((deadline) => <tr key={deadline.id}><td>{deadlineKindLabel(deadline.kind, text)}</td><td>{deadline.dueDate}</td><td>{deadline.status}</td><td>{deadline.basis}</td></tr>)}</tbody></table>
      <ul>{contract.clauses.map((clause) => <li key={clause.topicId}>{clause.topicLabel}: {clause.present ? (clause.articleRef ?? '') : text('not present', '条項なし')}</li>)}</ul>
      {contract.status !== 'terminated' && <div className="contract-form-row">
        <Field label={text('Terminated on', '終了日')}><input type="date" value={terminatedAt} onChange={(event) => setTerminatedAt(event.target.value)} /></Field>
        <Field label={text('Reason', '理由')}><input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <button type="button" className="secondary" disabled={terminatedAt === ''} onClick={() => void terminate()}>{text('Terminate', '終了にする')}</button>
      </div>}
      <button type="button" className="secondary danger" onClick={() => void remove()}>{text('Delete from the ledger', '台帳から削除')}</button>
    </div>}
  </section>;
}
