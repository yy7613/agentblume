import { useEffect, useRef, useState } from 'react';
import type { ReceivablesApi } from '../api/receivables-api';
import type { CustomerDto, InvoiceCheckDto, InvoiceDto, ReceivablesSettingsDto } from '../api/receivables-types';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import {
  defaultDueDate, emptyLine, formatYen, formToInvoice, invoiceToForm, newInvoiceForm, parsePastedInvoice, type InvoiceForm, type IssueTarget, type LineForm,
} from './receivables-model';
import { ErrorNotice, IssueList } from './receivables-shared';
import type { SettingsSection } from './SettingsDialog';

/** 編集対象（新規なら id なし）。seq を変えて同じ請求書の再依頼も届くようにする。 */
export interface InvoiceEditing { readonly id?: string; readonly invoice?: InvoiceDto; readonly seq: number }

/**
 * 請求書作成ステップ（docs/22 §8）。取引先・日付・税抜 / 税込・明細、**税率別集計のライブ表示**（検査 API をデバウンス）、
 * 違反・警告の一覧（押すと該当欄へ）、JSON 貼付（ツールの `draft_json`）、取り込んだ税額を計算値で置き換える。
 */
export function InvoiceEditorStep({ api, customers, settings, editing, today, onSaved, onOpenSettings, onOpenCustomers }: {
  readonly api: ReceivablesApi; readonly customers: readonly CustomerDto[]; readonly settings: ReceivablesSettingsDto | undefined;
  readonly editing: InvoiceEditing | undefined; readonly today: string;
  readonly onSaved: (invoice: InvoiceDto) => void; readonly onOpenSettings: (section: SettingsSection) => void; readonly onOpenCustomers: () => void;
}) {
  const { text } = useI18n();
  const [form, setForm] = useState<InvoiceForm>(() => newInvoiceForm(today, settings?.rounding.defaultPricing ?? 'exclusive'));
  const [invoiceId, setInvoiceId] = useState<string>();
  const [check, setCheck] = useState<InvoiceCheckDto>();
  const [error, setError] = useState<unknown>();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const rootRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (editing === undefined) return;
    setInvoiceId(editing.id);
    setForm(editing.invoice === undefined ? newInvoiceForm(today, settings?.rounding.defaultPricing ?? 'exclusive') : invoiceToForm(editing.invoice));
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 入力のたびに検査 API を呼ぶと重いので、止まってから 400ms 後に 1 回だけ呼ぶ。
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api.checkInvoice(scope, formToInvoice(form)).then((next) => { if (active) setCheck(next); }).catch(() => { if (active) setCheck(undefined); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [api, form]);

  if (customers.length === 0) {
    return <section className="receivables-step"><p className="empty-state">{text('Register a customer first: invoices need a recipient.', '先に取引先を登録してください。請求書には宛名が要ります。')}</p>
      <button type="button" className="primary" onClick={onOpenCustomers}>{text('Go to Customers', '取引先へ')}</button></section>;
  }

  const setLine = (index: number, patch: Partial<LineForm>) => setForm({ ...form, lines: form.lines.map((line, position) => position === index ? { ...line, ...patch } : line) });
  const chooseCustomer = (customerId: string) => {
    const customer = customers.find((entry) => entry.id === customerId);
    setForm({ ...form, customerId, dueDate: form.dueDate === '' ? defaultDueDate(form.issueDate, customer) : form.dueDate });
  };
  const goTo = (target: IssueTarget) => {
    if (target.kind === 'settings') { onOpenSettings(target.section); return; }
    const selector = target.field === 'lines' && target.row !== undefined ? `[data-line="${target.row - 1}"] input` : `[data-field="${target.field}"]`;
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  };

  const save = async () => {
    setError(undefined);
    try {
      const result = await api.saveInvoice(scope, formToInvoice(form), invoiceId);
      setInvoiceId(result.invoice.id);
      setCheck(result.check);
      setSaved(text('Saved the draft.', '下書きを保存しました。'));
      onSaved(result.invoice);
    } catch (cause: unknown) { setError(cause); }
  };

  const applyPaste = () => {
    const parsed = parsePastedInvoice(paste);
    if (!parsed.ok) { setPasteError(parsed.reason === 'json' ? text('This is not valid JSON. Paste draft_json as it is.', 'JSON として読めません。draft_json をそのまま貼り付けてください。') : text('This JSON is not an invoice draft (pricing and lines are required).', '請求書案の JSON ではありません（pricing と lines が必要です）。')); return; }
    setForm(invoiceToForm(parsed.invoice));
    setInvoiceId(undefined);
    setPasteError(undefined);
    setPasteOpen(false);
  };

  const customerHint = form.customerNameHint !== undefined && form.customerId === '' ? form.customerNameHint : undefined;

  return <form ref={rootRef} className="receivables-step receivables-invoice-editor" aria-label={text('Invoice editor', '請求書の作成')} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="receivables-toolbar">
      <button type="button" className="secondary" onClick={() => { setInvoiceId(undefined); setForm(newInvoiceForm(today, settings?.rounding.defaultPricing ?? 'exclusive')); }}>{text('New invoice', '新しい請求書')}</button>
      <button type="button" className="secondary" onClick={() => setPasteOpen(!pasteOpen)}>{text('Paste JSON', 'JSON を貼り付け')}</button>
      {invoiceId !== undefined && <small>{text('Editing a saved draft', '保存済みの下書きを編集中')}</small>}
    </div>
    {pasteOpen && <div className="receivables-panel">
      <label>{text('draft_json from the receivables_invoice_draft tool', 'receivables_invoice_draft ツールの draft_json')}<textarea aria-label={text('Invoice JSON', '請求書 JSON')} rows={6} value={paste} onChange={(event) => setPaste(event.target.value)} /></label>
      {pasteError !== undefined && <p className="field-error" role="alert">{pasteError}</p>}
      <button type="button" className="primary" onClick={applyPaste}>{text('Load into the form', 'フォームに読み込む')}</button>
    </div>}
    <div className="receivables-grid">
      <label>{text('Customer', '取引先')}
        <select data-field="customerId" aria-label={text('Customer', '取引先')} value={form.customerId} onChange={(event) => chooseCustomer(event.target.value)}>
          <option value="">{text('— choose a customer —', '— 取引先を選択 —')}</option>
          {customers.filter((customer) => customer.enabled || customer.id === form.customerId).map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select>
      </label>
      {customerHint !== undefined && <p className="receivables-warning" role="status">{text(`The attachment names "${customerHint}", but no saved customer matches. Choose or register the customer.`, `読み取った宛先「${customerHint}」に一致する取引先がありません。取引先を選ぶか登録してください。`)}</p>}
      <label>{text('Issue date', '発行日')}<input data-field="issueDate" type="date" aria-label={text('Issue date', '発行日')} value={form.issueDate} onChange={(event) => setForm({ ...form, issueDate: event.target.value })} /></label>
      <label>{text('Transaction date', '取引日')}<input data-field="transactionDate" type="date" aria-label={text('Transaction date', '取引日')} value={form.transactionDate} onChange={(event) => setForm({ ...form, transactionDate: event.target.value })} /></label>
      <label>{text('Period from (optional)', '期間の開始（任意）')}<input type="date" value={form.periodFrom} onChange={(event) => setForm({ ...form, periodFrom: event.target.value })} /></label>
      <label>{text('Period to (optional)', '期間の末日（任意）')}<input type="date" value={form.periodTo} onChange={(event) => setForm({ ...form, periodTo: event.target.value })} /></label>
      <label>{text('Due date', '支払期日')}<input data-field="dueDate" type="date" aria-label={text('Due date', '支払期日')} value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></label>
      <label>{text('Line amounts are', '明細金額')}
        <select aria-label={text('Pricing', '税抜 / 税込')} value={form.pricing} onChange={(event) => setForm({ ...form, pricing: event.target.value as 'exclusive' | 'inclusive' })}>
          <option value="exclusive">{text('Tax exclusive', '税抜')}</option><option value="inclusive">{text('Tax inclusive', '税込')}</option>
        </select>
      </label>
    </div>
    <table className="receivables-table receivables-lines" aria-label={text('Lines', '明細')}>
      <thead><tr><th>{text('Description', '品名')}</th><th>{text('Qty', '数量')}</th><th>{text('Unit', '単位')}</th><th>{text('Unit price', '単価')}</th><th>{text('Amount', '金額')}</th><th>{text('Tax', '税率')}</th><th /></tr></thead>
      <tbody>{form.lines.map((line, index) => <tr key={index} data-line={index}>
        <td><input aria-label={text(`Line ${index + 1} description`, `${index + 1} 行目の品名`)} value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} /></td>
        <td><input inputMode="decimal" aria-label={text(`Line ${index + 1} quantity`, `${index + 1} 行目の数量`)} value={line.quantity} onChange={(event) => setLine(index, { quantity: event.target.value })} /></td>
        <td><input aria-label={text(`Line ${index + 1} unit`, `${index + 1} 行目の単位`)} value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value })} /></td>
        <td><input inputMode="decimal" aria-label={text(`Line ${index + 1} unit price`, `${index + 1} 行目の単価`)} value={line.unitPrice} onChange={(event) => setLine(index, { unitPrice: event.target.value })} /></td>
        <td><input inputMode="numeric" aria-label={text(`Line ${index + 1} amount`, `${index + 1} 行目の金額`)} value={line.amount} onChange={(event) => setLine(index, { amount: event.target.value })} /></td>
        <td><select aria-label={text(`Line ${index + 1} tax rate`, `${index + 1} 行目の税率`)} value={line.taxRate} onChange={(event) => setLine(index, { taxRate: event.target.value as LineForm['taxRate'] })}>
          <option value="">—</option><option value="10">10%</option><option value="8">8%※</option><option value="0">0%</option>
        </select>
        {line.taxRate === '0' && <select aria-label={text(`Line ${index + 1} zero-rate category`, `${index + 1} 行目の 0% の区分`)} value={line.zeroRateKind} onChange={(event) => setLine(index, { zeroRateKind: event.target.value as LineForm['zeroRateKind'] })}>
          <option value="">{text('— category —', '— 区分 —')}</option><option value="exempt">{text('Exempt', '非課税')}</option><option value="non-taxable">{text('Out of scope', '不課税')}</option><option value="export">{text('Export', '輸出')}</option>
        </select>}</td>
        <td><button type="button" className="secondary" onClick={() => setForm({ ...form, lines: form.lines.filter((_, position) => position !== index) })}>{text('Remove', '削除')}</button></td>
      </tr>)}</tbody>
    </table>
    <button type="button" className="secondary" onClick={() => setForm({ ...form, lines: [...form.lines, emptyLine(form.lines.at(-1)?.taxRate ?? '10')] })}>{text('Add a line', '明細を追加')}</button>

    <h4>{text('Totals by tax rate (rounded once per rate)', '税率別集計（税率ごとに 1 回の端数処理）')}</h4>
    <table className="receivables-table" aria-label={text('Totals by tax rate', '税率別集計')}>
      <thead><tr><th>{text('Rate', '税率')}</th><th>{text('Taxable (excl.)', '税抜対象額')}</th><th>{text('Tax', '消費税')}</th><th>{text('Incl. tax', '税込対象額')}</th></tr></thead>
      <tbody>{(check?.totals.byRate ?? []).map((entry) => <tr key={entry.rate}><td>{entry.rate}%{entry.rate === 8 ? '※' : ''}</td><td>{formatYen(entry.taxable)}</td><td>{formatYen(entry.tax)}</td><td>{formatYen(entry.inclusive)}</td></tr>)}</tbody>
      <tfoot><tr><th>{text('Total', '合計')}</th><td /><td>{formatYen(check?.totals.taxTotal)}</td><td data-testid="receivables-grand-total">{formatYen(check?.totals.grandTotal)}</td></tr></tfoot>
    </table>
    {check !== undefined && <IssueList violations={check.violations} warnings={check.warnings} onGo={goTo}
      {...(form.declared === undefined ? {} : { onReplaceDeclared: () => setForm({ ...form, declared: undefined }) })} />}
    <ErrorNotice error={error} />
    {saved !== undefined && <InlineFeedback kind="success" autoHideMs={3000} onDismiss={() => setSaved(undefined)}>{saved}</InlineFeedback>}
    <div className="receivables-toolbar"><button type="submit" className="primary">{text('Save draft', '下書きを保存')}</button></div>
  </form>;
}
