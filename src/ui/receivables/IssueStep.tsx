import { useEffect, useState } from 'react';
import type { ReceivablesApi } from '../api/receivables-api';
import type { InvoiceDto, InvoiceIssueDto, InvoiceSummaryDto, JournalFollowUpDto } from '../api/receivables-types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { InvoicePrintView } from './InvoicePrintView';
import { formatYen, invoiceStatusLabel, type IssueTarget } from './receivables-model';
import { detailsOf, ErrorNotice, FollowUpNotice, IssueList } from './receivables-shared';
import type { SettingsSection } from './SettingsDialog';

/**
 * 発行ステップ（docs/22 §8）。下書き一覧（違反があれば発行ボタンを押せず理由を出す）→ 発行、
 * 発行済み一覧（番号・期日・入金状況・期日超過日数）→ 印刷プレビュー / 取消 / 複製。
 */
export function IssueStep({ api, invoices, focus, onChanged, onEdit, onOpenSettings, onGoToEditor }: {
  readonly api: ReceivablesApi; readonly invoices: readonly InvoiceSummaryDto[]; readonly focus: { readonly id: string; readonly seq: number } | undefined;
  readonly onChanged: () => Promise<void> | void; readonly onEdit: (invoice: InvoiceDto) => void;
  readonly onOpenSettings: (section: SettingsSection) => void; readonly onGoToEditor: () => void;
}) {
  const { text } = useI18n();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [violations, setViolations] = useState<readonly InvoiceIssueDto[]>([]);
  const [followUp, setFollowUp] = useState<JournalFollowUpDto>();
  const [printing, setPrinting] = useState<InvoiceDto>();
  const [voiding, setVoiding] = useState<InvoiceSummaryDto>();
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string>();
  const [highlight, setHighlight] = useState<string>();

  useEffect(() => { if (focus !== undefined) setHighlight(focus.id); }, [focus]);

  const drafts = invoices.filter((invoice) => invoice.status === 'draft');
  const issued = invoices.filter((invoice) => invoice.status !== 'draft');

  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id); setError(undefined); setViolations([]); setFollowUp(undefined);
    try { await work(); await onChanged(); }
    catch (cause: unknown) {
      setError(cause);
      const details = detailsOf(cause);
      if (Array.isArray(details?.['violations'])) setViolations(details['violations'] as InvoiceIssueDto[]);
    } finally { setBusy(undefined); }
  };

  const issue = (invoice: InvoiceSummaryDto) => run(invoice.id, async () => {
    const result = await api.issueInvoice(scope, invoice.id);
    setFollowUp(result.journalFollowUp);
    setDone(text(`Issued ${result.invoice.number}.`, `${result.invoice.number} を発行しました。`));
  });
  const confirmVoid = () => {
    if (voiding === undefined) return;
    const target = voiding;
    void run(target.id, async () => {
      const result = await api.voidInvoice(scope, target.id, reason);
      setFollowUp(result.journalFollowUp);
      setVoiding(undefined); setReason('');
      setDone(text(`Voided ${target.number}. The number stays unused.`, `${target.number} を取り消しました（番号は欠番のまま残ります）。`));
    });
  };
  const duplicate = (invoice: InvoiceSummaryDto) => run(invoice.id, async () => {
    const result = await api.duplicateInvoice(scope, invoice.id);
    onEdit(result.invoice);
  });
  const goTo = (target: IssueTarget) => { if (target.kind === 'settings') onOpenSettings(target.section); else onGoToEditor(); };

  return <section className="receivables-step" aria-label={text('Issue', '発行')}>
    <ErrorNotice error={error} />
    {violations.length > 0 && <IssueList violations={violations} warnings={[]} onGo={goTo} />}
    <FollowUpNotice followUp={followUp} />
    {done !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={() => setDone(undefined)}>{done}</InlineFeedback>}
    <h3>{text('Drafts', '下書き')}</h3>
    {drafts.length === 0
      ? <p className="empty-state">{text('No drafts to issue.', '発行できる下書きがありません。')} <button type="button" className="secondary" onClick={onGoToEditor}>{text('Create an invoice', '請求書を作る')}</button></p>
      : <table className="receivables-table" aria-label={text('Draft invoices', '下書きの請求書')}><thead><tr><th>{text('Customer', '取引先')}</th><th>{text('Issue date', '発行日')}</th><th>{text('Total', '請求額')}</th><th>{text('Check', '検査')}</th><th /></tr></thead>
        <tbody>{drafts.map((invoice) => <tr key={invoice.id} className={highlight === invoice.id ? 'selected' : ''}>
          <td>{invoice.customerName ?? text('(no customer)', '（取引先なし）')}</td><td>{invoice.issueDate ?? '—'}</td><td>{formatYen(invoice.totals.grandTotal)}</td>
          <td>{invoice.violationCount === 0 ? text('Ready', '発行可') : text(`${invoice.violationCount} to fix`, `要修正 ${invoice.violationCount} 件`)}</td>
          <td className="receivables-actions">
            <button type="button" className="primary" disabled={invoice.violationCount > 0 || busy !== undefined} title={invoice.violationCount > 0 ? text('Fix the listed items in the editor first.', '先に作成画面で要修正の項目を直してください。') : undefined} onClick={() => { void issue(invoice); }}>{text('Issue', '発行')}</button>
            <button type="button" className="secondary" onClick={() => onEdit(invoice)}>{text('Edit', '編集')}</button>
            <button type="button" className="secondary" onClick={() => { void run(invoice.id, () => api.deleteInvoice(scope, invoice.id)); }}>{text('Delete', '削除')}</button>
          </td>
        </tr>)}</tbody></table>}
    <h3>{text('Issued', '発行済み')}</h3>
    {issued.length === 0
      ? <p className="empty-state">{text('No issued invoices yet.', 'まだ発行した請求書はありません。')}</p>
      : <table className="receivables-table" aria-label={text('Issued invoices', '発行済みの請求書')}><thead><tr><th>{text('Number', '番号')}</th><th>{text('Customer', '取引先')}</th><th>{text('Due', '期日')}</th><th>{text('Status', '状態')}</th><th>{text('Unpaid', '未入金')}</th><th>{text('Overdue', '超過')}</th><th /></tr></thead>
        <tbody>{issued.map((invoice) => <tr key={invoice.id} className={highlight === invoice.id ? 'selected' : ''}>
          <td>{invoice.number}</td><td>{invoice.customerName}</td><td>{invoice.dueDate ?? '—'}</td><td>{invoiceStatusLabel(invoice.status, text)}</td>
          <td>{formatYen(invoice.outstanding)}</td><td>{invoice.daysOverdue > 0 ? text(`${invoice.daysOverdue} days`, `${invoice.daysOverdue} 日`) : '—'}</td>
          <td className="receivables-actions">
            <button type="button" className="secondary" onClick={() => setPrinting(invoice)}>{text('Print preview', '印刷プレビュー')}</button>
            {(invoice.status === 'issued' || invoice.status === 'partially_paid') && <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => setVoiding(invoice)}>{text('Void', '取消')}</button>}
            <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => { void duplicate(invoice); }}>{text('Duplicate', '複製')}</button>
          </td>
        </tr>)}</tbody></table>}
    {printing !== undefined && <InvoicePrintView invoice={printing} onClose={() => setPrinting(undefined)} />}
    <ConfirmDialog open={voiding !== undefined} danger busy={busy !== undefined} title={text('Void this invoice?', 'この請求書を取り消しますか？')}
      message={<label>{text(`Voiding ${voiding?.number ?? ''} leaves its number unused. Reason (required):`, `${voiding?.number ?? ''} を取り消すと番号は欠番のまま残ります。理由（必須）:`)}<input aria-label={text('Void reason', '取消の理由')} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
      confirmLabel={text('Void', '取り消す')} cancelLabel={text('Cancel', 'キャンセル')}
      onConfirm={() => { if (reason.trim() !== '') confirmVoid(); }} onCancel={() => { setVoiding(undefined); setReason(''); }} />
  </section>;
}
