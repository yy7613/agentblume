import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto, JournalEntryDto, JournalEntryLineDto, JournalExportResultDto, JournalInvoiceStatusDto, SaveJournalEntryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import type { TabFocus } from './JournalPage';
import { csvDownloadName, entryBalance, formatYen, triggerDownload } from './journal-model';
import { AccountSelect, FieldError, TaxSelect, messageOf } from './journal-shared';

type EntryStatus = '' | JournalEntryDto['status'];
type Format = JournalExportResultDto['format'];
interface ManualLine { readonly side: 'debit' | 'credit'; readonly accountId: string; readonly taxCode: string; readonly amount: string }

/**
 * 出力タブ。仕訳一覧（状態・期間で絞り込み、行を開くと仕訳行）→ 確定 / 削除 → 手入力仕訳 → CSV 出力（Blob でダウンロード、textarea フォールバック）。
 * 形式は Phase 1 では generic だけ。弥生 / freee / MF は選択肢として見せるが無効（近日）。
 */
export function ExportTab({ client, chart, focus }: { readonly client: ToolApiClient; readonly chart: JournalChartOfAccountsDto | undefined; readonly focus: TabFocus | undefined }) {
  const { text } = useI18n();
  const [entries, setEntries] = useState<readonly JournalEntryDto[]>();
  const [listError, setListError] = useState<string>();
  const [status, setStatus] = useState<EntryStatus>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<JournalEntryDto>();
  const [format, setFormat] = useState<Format>('generic');
  const [markExported, setMarkExported] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<JournalExportResultDto>();
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [manual, setManual] = useState<{ readonly date: string; readonly description: string; readonly invoiceStatus: JournalInvoiceStatusDto; readonly lines: readonly ManualLine[] }>({ date: '', description: '', invoiceStatus: 'not_required', lines: [{ side: 'debit', accountId: '', taxCode: '', amount: '' }, { side: 'credit', accountId: '', taxCode: '', amount: '' }] });
  const [manualSubmitted, setManualSubmitted] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualFeedback, setManualFeedback] = useState<{ readonly kind: 'success' | 'error'; readonly text: string }>();

  const reload = useCallback(async () => {
    try { setEntries(await client.listJournalEntries(scope, { status, from, to })); setListError(undefined); }
    catch (cause: unknown) { setEntries([]); setListError(messageOf(cause)); }
  }, [client, status, from, to]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (focus !== undefined && focus.id !== '') setExpanded(focus.id); }, [focus]);

  const confirm = async (entry: JournalEntryDto) => {
    setBusyId(entry.id);
    setError(undefined);
    try { await client.confirmJournalEntry(entry.id, scope); await reload(); }
    catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setBusyId(undefined); }
  };
  const remove = async () => {
    if (pendingDelete === undefined) return;
    setBusyId(pendingDelete.id);
    try { await client.deleteJournalEntry(pendingDelete.id, scope); setPendingDelete(undefined); await reload(); }
    catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setBusyId(undefined); }
  };

  const runExport = async () => {
    setExporting(true);
    setError(undefined);
    setResult(undefined);
    setDownloadFailed(false);
    try {
      const exported = await client.exportJournalEntries(scope, { format, status, from, to, markExported });
      setResult(exported);
      if (!triggerDownload(csvDownloadName(exported), exported.content)) setDownloadFailed(true);
      if (markExported) await reload();
    } catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setExporting(false); }
  };

  // 手入力仕訳の検証: 日付・科目・税区分・金額（正の整数）・貸借一致。
  const manualIssues = useMemo(() => {
    const issues: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manual.date)) issues['date'] = text('Use YYYY-MM-DD', 'YYYY-MM-DD 形式で入力してください');
    manual.lines.forEach((line, index) => {
      if (line.accountId === '') issues[`lines.${index}.accountId`] = text('Choose an account', '科目を選んでください');
      if (line.taxCode === '') issues[`lines.${index}.taxCode`] = text('Choose a tax category', '税区分を選んでください');
      const amount = Number(line.amount);
      if (line.amount.trim() === '' || !Number.isInteger(amount) || amount <= 0) issues[`lines.${index}.amount`] = text('Enter a positive integer amount', '正の整数で入力してください');
    });
    const balance = entryBalance(manual.lines.map((line) => ({ side: line.side, amount: Number(line.amount) || 0 })));
    if (!balance.balanced) issues['balance'] = text(`Debit ${formatYen(balance.debit)} and credit ${formatYen(balance.credit)} differ. Adjust the amounts so both sides match.`, `借方 ${formatYen(balance.debit)} と貸方 ${formatYen(balance.credit)} が一致しません。両側が同じになるよう金額を直してください。`);
    return issues;
  }, [manual, text]);
  const manualIssue = (path: string) => (manualSubmitted ? manualIssues[path] : undefined);
  const updateManualLine = (index: number, patch: Partial<ManualLine>) => setManual((current) => ({ ...current, lines: current.lines.map((line, position) => (position === index ? { ...line, ...patch } : line)) }));

  const saveManual = async () => {
    setManualSubmitted(true);
    setManualFeedback(undefined);
    if (Object.keys(manualIssues).length > 0) { setManualFeedback({ kind: 'error', text: manualIssues['balance'] ?? text('Fix the highlighted fields before saving.', '赤く示した欄を直してから保存してください') }); return; }
    setManualSaving(true);
    try {
      const lines: JournalEntryLineDto[] = manual.lines.map((line) => ({ side: line.side, accountId: line.accountId, accountName: chart?.accounts.find((account) => account.id === line.accountId)?.name ?? line.accountId, taxCode: line.taxCode, amount: Number(line.amount) }));
      const payload: SaveJournalEntryDto = { date: manual.date, description: manual.description.trim(), invoiceStatus: manual.invoiceStatus, lines, decidedBy: 'manual' };
      const saved = await client.saveJournalEntry(scope, payload);
      setManualFeedback({ kind: 'success', text: text(`Saved entry ${saved.id} as a draft. Confirm it in the list above.`, `仕訳 ${saved.id} をドラフトとして保存しました。上の一覧で確定してください。`) });
      setManual({ date: manual.date, description: '', invoiceStatus: manual.invoiceStatus, lines: [{ side: 'debit', accountId: '', taxCode: '', amount: '' }, { side: 'credit', accountId: '', taxCode: '', amount: '' }] });
      setManualSubmitted(false);
      await reload();
    } catch (cause: unknown) { setManualFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setManualSaving(false); }
  };

  const emptyChart = { accounts: [], taxCategories: [] };
  const chartOrEmpty = chart ?? emptyChart;
  const accountName = (line: JournalEntryLineDto) => chart?.accounts.find((account) => account.id === line.accountId)?.name ?? line.accountName;

  return <div className="journal-export">
    <section className="workspace-card" aria-labelledby="journal-entries-heading">
      <div className="journal-toolbar">
        <h2 id="journal-entries-heading">{text('Entries', '仕訳')}</h2>
        <label>{text('Status', '状態')}<select aria-label={text('Entry status filter', '仕訳の状態で絞り込む')} value={status} onChange={(event) => setStatus(event.target.value as EntryStatus)}><option value="">{text('All', 'すべて')}</option><option value="draft">{text('Draft', 'ドラフト')}</option><option value="confirmed">{text('Confirmed', '確定')}</option><option value="exported">{text('Exported', '出力済')}</option></select></label>
        <label>{text('From', '開始日')}<input aria-label={text('From date', '開始日')} value={from} placeholder="YYYY-MM-DD" onChange={(event) => setFrom(event.target.value)} /></label>
        <label>{text('To', '終了日')}<input aria-label={text('To date', '終了日')} value={to} placeholder="YYYY-MM-DD" onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      {listError !== undefined && <p className="api-error" role="alert">{listError} <button type="button" className="secondary" onClick={() => void reload()}>{text('Retry', '再試行')}</button></p>}
      {error !== undefined && <p className="api-error" role="alert">{error}</p>}
      {entries === undefined ? <p className="empty-state">{text('Loading…', '読み込み中…')}</p>
        : entries.length === 0 ? <p className="empty-state">{text('No entries. Judge documents in the Judge tab, or add a manual entry below.', '仕訳がありません。「判定」タブで帳票を判定するか、下の手入力で追加してください。')}</p>
          : <div className="table-wrap"><table className="journal-table" aria-label={text('Entry list', '仕訳一覧')}>
            <thead><tr><th>{text('Date', '日付')}</th><th>{text('Description', '摘要')}</th><th>{text('Debit total', '借方合計')}</th><th>{text('Status', '状態')}</th><th>{text('Decided by', '決定')}</th><th /></tr></thead>
            <tbody>{entries.map((entry) => {
              const balance = entryBalance(entry.lines);
              const open = expanded === entry.id;
              return [
                <tr key={entry.id} className={open ? 'selected' : ''}>
                  <td>{entry.date}</td>
                  <td><button type="button" className="screen-link" aria-expanded={open} onClick={() => setExpanded(open ? undefined : entry.id)}>{entry.description === '' ? entry.id : entry.description}</button></td>
                  <td className="journal-amount">{formatYen(balance.debit)}{balance.balanced ? '' : <small className="field-error"> {text('unbalanced', '貸借不一致')}</small>}</td>
                  <td><span className={`judge-chip journal-entry-${entry.status}`}>{entry.status === 'draft' ? text('Draft', 'ドラフト') : entry.status === 'confirmed' ? text('Confirmed', '確定') : text('Exported', '出力済')}</span></td>
                  <td>{entry.decidedBy}</td>
                  <td className="journal-row-actions">
                    {entry.status === 'draft' && <button type="button" className="secondary" disabled={busyId !== undefined} onClick={() => void confirm(entry)}>{busyId === entry.id ? '…' : text('Confirm', '確定')}</button>}
                    {entry.status !== 'exported' && <button type="button" className="secondary danger" disabled={busyId !== undefined} onClick={() => setPendingDelete(entry)}>{text('Delete', '削除')}</button>}
                  </td>
                </tr>,
                open ? <tr key={`${entry.id}-lines`} className="journal-entry-detail"><td colSpan={6}>
                  <table className="journal-table" aria-label={text(`Lines of ${entry.id}`, `${entry.id} の仕訳行`)}>
                    <thead><tr><th>{text('Side', '貸借')}</th><th>{text('Account', '科目')}</th><th>{text('Tax', '税区分')}</th><th>{text('Amount', '金額')}</th><th>{text('Partner', '取引先')}</th></tr></thead>
                    <tbody>{entry.lines.map((line, index) => <tr key={index}><td>{line.side === 'debit' ? text('Debit', '借方') : text('Credit', '貸方')}</td><td>{accountName(line)}</td><td>{line.taxCode}</td><td className="journal-amount">{formatYen(line.amount)}</td><td>{line.partner ?? ''}</td></tr>)}</tbody>
                  </table>
                  <small className="empty-state">{entry.invoiceStatus}{entry.registrationNumber === undefined ? '' : ` · ${entry.registrationNumber}`}{entry.documentId === undefined ? '' : ` · ${text('document', '帳票')} ${entry.documentId}`}{entry.ruleId === undefined ? '' : ` · ${text('rule', 'ルール')} ${entry.ruleId}`}</small>
                </td></tr> : null,
              ];
            })}</tbody>
          </table></div>}
    </section>

    <section className="workspace-card" aria-labelledby="journal-manual-heading">
      <h2 id="journal-manual-heading">{text('Manual entry', '手入力の仕訳')}</h2>
      <div className="journal-form-grid">
        <label>{text('Date', '日付')}<input aria-label={text('Entry date', '仕訳日付')} value={manual.date} placeholder="YYYY-MM-DD" onChange={(event) => setManual({ ...manual, date: event.target.value })} /><FieldError message={manualIssue('date')} /></label>
        <label>{text('Invoice status', 'インボイス区分')}<select aria-label={text('Manual invoice status', '手入力のインボイス区分')} value={manual.invoiceStatus} onChange={(event) => setManual({ ...manual, invoiceStatus: event.target.value as JournalInvoiceStatusDto })}><option value="not_required">{text('not required', '不要')}</option><option value="qualified">{text('qualified', '適格')}</option><option value="transitional">{text('transitional', '経過措置')}</option><option value="none">{text('none', '控除なし')}</option></select></label>
        <label className="journal-span">{text('Description', '摘要')}<input aria-label={text('Entry description', '仕訳摘要')} value={manual.description} onChange={(event) => setManual({ ...manual, description: event.target.value })} /></label>
      </div>
      {manual.lines.map((line, index) => <div key={index} className="journal-line-row">
        <select aria-label={text(`Manual line ${index + 1} side`, `手入力行 ${index + 1} 貸借`)} value={line.side} onChange={(event) => updateManualLine(index, { side: event.target.value as 'debit' | 'credit' })}><option value="debit">{text('Debit', '借方')}</option><option value="credit">{text('Credit', '貸方')}</option></select>
        <div><AccountSelect chart={chartOrEmpty} value={line.accountId} label={text(`Manual line ${index + 1} account`, `手入力行 ${index + 1} 科目`)} onChange={(accountId) => { const account = chartOrEmpty.accounts.find((item) => item.id === accountId); updateManualLine(index, { accountId, ...(line.taxCode === '' && account?.defaultTaxCode !== undefined ? { taxCode: account.defaultTaxCode } : {}) }); }} /><FieldError message={manualIssue(`lines.${index}.accountId`)} /></div>
        <div><TaxSelect chart={chartOrEmpty} value={line.taxCode} label={text(`Manual line ${index + 1} tax`, `手入力行 ${index + 1} 税区分`)} onChange={(taxCode) => updateManualLine(index, { taxCode })} /><FieldError message={manualIssue(`lines.${index}.taxCode`)} /></div>
        <div><input aria-label={text(`Manual line ${index + 1} amount`, `手入力行 ${index + 1} 金額`)} value={line.amount} inputMode="numeric" onChange={(event) => updateManualLine(index, { amount: event.target.value })} /><FieldError message={manualIssue(`lines.${index}.amount`)} /></div>
        <button type="button" className="secondary danger" disabled={manual.lines.length <= 2} onClick={() => setManual({ ...manual, lines: manual.lines.filter((_item, position) => position !== index) })}>{text('Remove', '削除')}</button>
      </div>)}
      <FieldError message={manualIssue('balance')} />
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => setManual({ ...manual, lines: [...manual.lines, { side: 'credit', accountId: '', taxCode: '', amount: '' }] })}>{text('Add line', '行を追加')}</button>
        <button type="button" className="primary" disabled={manualSaving} onClick={() => void saveManual()}>{manualSaving ? text('Saving…', '保存中…') : text('Save entry', '仕訳を保存')}</button>
      </div>
      {manualFeedback !== undefined && <InlineFeedback kind={manualFeedback.kind}>{manualFeedback.text}</InlineFeedback>}
    </section>

    <section className="workspace-card" aria-labelledby="journal-export-heading">
      <h2 id="journal-export-heading">{text('Export CSV', 'CSV 出力')}</h2>
      <p className="empty-state">{text('Uses the status and date filters above. Generic CSV is UTF-8 with BOM, CRLF, one row per entry line (docs/20 §8).', '上の状態・期間の絞り込みを使います。汎用 CSV は UTF-8 BOM・CRLF・1 行 = 1 仕訳行です（docs/20 §8）。')}</p>
      <div className="journal-toolbar">
        <label>{text('Format', '形式')}<select aria-label={text('Export format', '出力形式')} value={format} onChange={(event) => setFormat(event.target.value as Format)}>
          <option value="generic">{text('Generic CSV', '汎用 CSV')}</option>
          <option value="yayoi" disabled>{text('Yayoi (coming soon)', '弥生（近日）')}</option>
          <option value="freee" disabled>{text('freee (coming soon)', 'freee（近日）')}</option>
          <option value="mf" disabled>{text('Money Forward (coming soon)', 'マネーフォワード（近日）')}</option>
        </select></label>
        <label className="journal-checkbox"><input type="checkbox" checked={markExported} onChange={(event) => setMarkExported(event.target.checked)} />{text('Mark exported entries as "exported"', '出力した仕訳を「出力済」にする')}</label>
        <button type="button" className="primary" disabled={exporting} onClick={() => void runExport()}>{exporting ? text('Exporting…', '出力中…') : text('Export', '出力する')}</button>
      </div>
      {result !== undefined && <div className="journal-export-result" role="status">
        <InlineFeedback kind="success">{text(`${result.fileName} · ${result.entryCount} entries`, `${result.fileName} · ${result.entryCount} 件の仕訳`)}</InlineFeedback>
        {downloadFailed && <p className="notice-card">{text('The browser did not start a download. Use the button below, or copy the CSV from the box.', 'ブラウザがダウンロードを開始しませんでした。下のボタンを押すか、欄から CSV をコピーしてください。')}</p>}
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => { if (!triggerDownload(csvDownloadName(result), result.content)) setDownloadFailed(true); }}>{text('Download again', 'もう一度ダウンロード')}</button></div>
        <label>{text('CSV content', 'CSV の内容')}<textarea aria-label={text('Exported CSV', '出力した CSV')} readOnly rows={8} value={result.content} /></label>
      </div>}
    </section>
    <ConfirmDialog open={pendingDelete !== undefined} danger busy={busyId !== undefined} title={text('Delete this entry?', 'この仕訳を削除しますか？')}
      message={pendingDelete === undefined ? '' : text(`Entry "${pendingDelete.description || pendingDelete.id}" (${pendingDelete.date}) will be removed. The source document stays and can be judged again.`, `仕訳「${pendingDelete.description || pendingDelete.id}」（${pendingDelete.date}）を削除します。元の帳票は残り、再判定できます。`)}
      confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} onConfirm={() => void remove()} onCancel={() => setPendingDelete(undefined)} />
  </div>;
}
