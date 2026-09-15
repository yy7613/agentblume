import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto } from '../api/types';
import type { ReceivablesApi } from '../api/receivables-api';
import type { InvoiceSummaryDto, ReceivablesSettingsDto, TransferAccountDto } from '../api/receivables-types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { roundingModeLabel } from './receivables-model';
import { ErrorNotice } from './receivables-shared';

export type SettingsSection = 'issuer' | 'rounding' | 'matching' | 'journal' | 'numbering';

/**
 * 設定ダイアログ（docs/22 §8）。手数料の範囲・端数処理・合算件数・仕訳の科目・番号書式は利用者が決めるデータ。
 * 科目と税区分は**仕訳の科目マスタから選ぶ**（名前を直書きしない）。発行済みの請求書と違う丸めモードへ変えるときは確認を出す。
 */
export function SettingsDialog({ api, client, initial, invoices, section, onClose, onSaved }: {
  readonly api: ReceivablesApi; readonly client: ToolApiClient; readonly initial: ReceivablesSettingsDto; readonly invoices: readonly InvoiceSummaryDto[];
  readonly section?: SettingsSection; readonly onClose: () => void; readonly onSaved: (settings: ReceivablesSettingsDto) => void;
}) {
  const { text } = useI18n();
  const dialogRef = useModalBehavior<HTMLDivElement>({ open: true, onClose });
  const [draft, setDraft] = useState<ReceivablesSettingsDto>(initial);
  const [chart, setChart] = useState<JournalChartOfAccountsDto>();
  const [error, setError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const [confirmRounding, setConfirmRounding] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => client.getJournalChart(scope)).then((next) => { if (active) setChart(next); }).catch(() => { if (active) setChart(undefined); });
    return () => { active = false; };
  }, [client]);
  useEffect(() => {
    if (section === undefined) return;
    document.getElementById(`receivables-settings-${section}`)?.scrollIntoView?.({ block: 'start' });
  }, [section]);

  const issuer = draft.issuer;
  const setIssuer = (patch: Partial<ReceivablesSettingsDto['issuer']>) => setDraft({ ...draft, issuer: { ...issuer, ...patch } });
  const setAccount = (index: number, patch: Partial<TransferAccountDto>) => setIssuer({ transferAccounts: issuer.transferAccounts.map((account, position) => position === index ? { ...account, ...patch } : account) });
  const number = (value: string) => Number(value);
  const differentRounding = invoices.some((invoice) => invoice.status !== 'draft' && invoice.roundingMode !== draft.rounding.mode);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try { onSaved(await api.saveSettings(scope, draft)); }
    catch (cause: unknown) { setError(cause); }
    finally { setSaving(false); setConfirmRounding(false); }
  };
  const requestSave = () => { if (differentRounding && draft.rounding.mode !== initial.rounding.mode) setConfirmRounding(true); else void save(); };

  const accountSelect = (label: string, value: string, onChange: (id: string) => void) => {
    const known = chart?.accounts.some((account) => account.id === value && account.enabled) ?? true;
    return <label className={known ? '' : 'receivables-invalid'}>{label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {!known && <option value={value}>{text(`${value} (missing or disabled in the chart)`, `${value}（科目マスタに無いか無効）`)}</option>}
        {(chart?.accounts ?? []).filter((account) => account.enabled).map((account) => <option key={account.id} value={account.id}>{account.name} ({account.id})</option>)}
        {chart === undefined && <option value={value}>{value}</option>}
      </select>
    </label>;
  };
  const taxSelect = (label: string, value: string, onChange: (code: string) => void) => {
    const known = chart?.taxCategories.some((tax) => tax.code === value && tax.enabled) ?? true;
    return <label className={known ? '' : 'receivables-invalid'}>{label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {!known && <option value={value}>{text(`${value} (missing or disabled in the chart)`, `${value}（科目マスタに無いか無効）`)}</option>}
        {(chart?.taxCategories ?? []).filter((tax) => tax.enabled).map((tax) => <option key={tax.code} value={tax.code}>{tax.name} ({tax.code})</option>)}
        {chart === undefined && <option value={value}>{value}</option>}
      </select>
    </label>;
  };
  const journal = draft.journal;
  const setJournal = (patch: Partial<ReceivablesSettingsDto['journal']>) => setDraft({ ...draft, journal: { ...journal, ...patch } });

  return <div className="confirm-backdrop" role="presentation">
    <div ref={dialogRef} tabIndex={-1} className="confirm-dialog receivables-settings" role="dialog" aria-modal="true" aria-label={text('Invoicing settings', '請求・入金消込の設定')}>
      <h3>{text('Invoicing settings', '請求・入金消込の設定')}</h3>
      <fieldset id="receivables-settings-issuer"><legend>{text('Issuer', '発行者')}</legend>
        <label>{text('Name', '名称')}<input aria-label={text('Issuer name', '発行者名')} value={issuer.name} onChange={(event) => setIssuer({ name: event.target.value })} /></label>
        <label className="receivables-inline"><input type="checkbox" checked={issuer.registered} onChange={(event) => setIssuer({ registered: event.target.checked })} />{text('Registered qualified invoice issuer', '適格請求書発行事業者として登録している')}</label>
        <label>{text('Registration number (T + 13 digits)', '登録番号（T + 13 桁）')}<input aria-label={text('Registration number', '登録番号')} value={issuer.registrationNumber ?? ''} disabled={!issuer.registered} onChange={(event) => setIssuer({ registrationNumber: event.target.value })} /></label>
        <label>{text('Address', '住所')}<input value={issuer.address ?? ''} onChange={(event) => setIssuer({ address: event.target.value })} /></label>
        <label>{text('Phone', '電話')}<input value={issuer.tel ?? ''} onChange={(event) => setIssuer({ tel: event.target.value })} /></label>
        {issuer.transferAccounts.map((account, index) => <div key={index} className="receivables-row">
          <input aria-label={text('Bank', '銀行')} placeholder={text('Bank', '銀行')} value={account.bankName} onChange={(event) => setAccount(index, { bankName: event.target.value })} />
          <input aria-label={text('Branch', '支店')} placeholder={text('Branch', '支店')} value={account.branchName} onChange={(event) => setAccount(index, { branchName: event.target.value })} />
          <input aria-label={text('Account type', '種別')} placeholder={text('Type', '種別')} value={account.accountType} onChange={(event) => setAccount(index, { accountType: event.target.value })} />
          <input aria-label={text('Account number', '口座番号')} placeholder={text('Number', '口座番号')} value={account.accountNumber} onChange={(event) => setAccount(index, { accountNumber: event.target.value })} />
          <input aria-label={text('Account holder (kana)', '名義（カナ）')} placeholder={text('Holder', '名義')} value={account.holderKana} onChange={(event) => setAccount(index, { holderKana: event.target.value })} />
          <button type="button" className="secondary" onClick={() => setIssuer({ transferAccounts: issuer.transferAccounts.filter((_, position) => position !== index) })}>{text('Remove', '削除')}</button>
        </div>)}
        {issuer.transferAccounts.length < 5 && <button type="button" className="secondary" onClick={() => setIssuer({ transferAccounts: [...issuer.transferAccounts, { bankName: '', branchName: '', accountType: '普通', accountNumber: '', holderKana: '' }] })}>{text('Add a transfer account', '振込先を追加')}</button>}
      </fieldset>
      <fieldset id="receivables-settings-rounding"><legend>{text('Rounding', '端数処理')}</legend>
        <label>{text('Consumption tax rounding', '消費税の端数処理')}
          <select aria-label={text('Rounding mode', '丸めモード')} value={draft.rounding.mode} onChange={(event) => setDraft({ ...draft, rounding: { ...draft.rounding, mode: event.target.value as ReceivablesSettingsDto['rounding']['mode'] } })}>
            {(['floor', 'round-half-up', 'ceil'] as const).map((mode) => <option key={mode} value={mode}>{roundingModeLabel(mode, text)}</option>)}
          </select>
        </label>
        <label>{text('Default line amounts', '明細金額の既定')}
          <select value={draft.rounding.defaultPricing} onChange={(event) => setDraft({ ...draft, rounding: { ...draft.rounding, defaultPricing: event.target.value as 'exclusive' | 'inclusive' } })}>
            <option value="exclusive">{text('Tax exclusive', '税抜')}</option><option value="inclusive">{text('Tax inclusive', '税込')}</option>
          </select>
        </label>
      </fieldset>
      <fieldset id="receivables-settings-matching"><legend>{text('Matching', '消込')}</legend>
        <label>{text('Fee tolerance min (yen)', '手数料の最小（円）')}<input type="number" aria-label={text('Fee minimum', '手数料の最小')} value={draft.matching.feeTolerance.min} onChange={(event) => setDraft({ ...draft, matching: { ...draft.matching, feeTolerance: { ...draft.matching.feeTolerance, min: number(event.target.value) } } })} /></label>
        <label>{text('Fee tolerance max (yen)', '手数料の最大（円）')}<input type="number" aria-label={text('Fee maximum', '手数料の最大')} value={draft.matching.feeTolerance.max} onChange={(event) => setDraft({ ...draft, matching: { ...draft.matching, feeTolerance: { ...draft.matching.feeTolerance, max: number(event.target.value) } } })} /></label>
        <label>{text('Invoices in a combined payment (2-5)', '合算で探す件数（2〜5）')}<input type="number" min={2} max={5} value={draft.matching.maxCombinationSize} onChange={(event) => setDraft({ ...draft, matching: { ...draft.matching, maxCombinationSize: number(event.target.value) } })} /></label>
        <label>{text('Minimum characters for a partial name match', '部分一致とみなす最小文字数')}<input type="number" min={1} value={draft.matching.partialNameMinLength} onChange={(event) => setDraft({ ...draft, matching: { ...draft.matching, partialNameMinLength: number(event.target.value) } })} /></label>
      </fieldset>
      <fieldset id="receivables-settings-journal"><legend>{text('Journal link', '仕訳連携')}</legend>
        <label className="receivables-inline"><input type="checkbox" checked={journal.enabled} onChange={(event) => setJournal({ enabled: event.target.checked })} />{text('Create draft journal entries on issue and on matching', '発行と消込の確定で仕訳の下書きを作る')}</label>
        {accountSelect(text('Sales account', '売上の科目'), journal.accounts.sales, (id) => setJournal({ accounts: { ...journal.accounts, sales: id } }))}
        {accountSelect(text('Receivables account', '売掛金の科目'), journal.accounts.receivable, (id) => setJournal({ accounts: { ...journal.accounts, receivable: id } }))}
        {accountSelect(text('Deposit account', '預金の科目'), journal.accounts.deposit, (id) => setJournal({ accounts: { ...journal.accounts, deposit: id } }))}
        {accountSelect(text('Fee account', '手数料の科目'), journal.accounts.fee, (id) => setJournal({ accounts: { ...journal.accounts, fee: id } }))}
        {(['10', '8', '0'] as const).map((rate) => <div key={rate}>{taxSelect(text(`Sales tax category ${rate}%`, `売上 ${rate}% の税区分`), journal.salesTaxCodes[rate], (code) => setJournal({ salesTaxCodes: { ...journal.salesTaxCodes, [rate]: code } }))}</div>)}
        {taxSelect(text('Fee tax category', '手数料の税区分'), journal.feeTaxCode, (code) => setJournal({ feeTaxCode: code }))}
        {taxSelect(text('Tax category for receivables and deposits', '売掛金・預金の税区分'), journal.nonTaxableTaxCode, (code) => setJournal({ nonTaxableTaxCode: code }))}
        <label>{text('Sales entry date', '売上仕訳の日付')}
          <select value={journal.salesEntryDate} onChange={(event) => setJournal({ salesEntryDate: event.target.value as 'transaction-date' | 'issue-date' })}>
            <option value="transaction-date">{text('Transaction date', '取引日')}</option><option value="issue-date">{text('Issue date', '発行日')}</option>
          </select>
        </label>
      </fieldset>
      <fieldset id="receivables-settings-numbering"><legend>{text('Invoice numbers', '請求書番号')}</legend>
        <label>{text('Format ({YYYY} {YY} {MM} {SEQ3}..{SEQ6})', '書式（{YYYY} {YY} {MM} {SEQ3}〜{SEQ6}）')}<input aria-label={text('Number format', '番号書式')} value={draft.numbering.format} onChange={(event) => setDraft({ ...draft, numbering: { format: event.target.value } })} /></label>
        <small>{text('Preview', 'プレビュー')}: {draft.numbering.format.replaceAll('{YYYY}', '2026').replaceAll('{YY}', '26').replaceAll('{MM}', '09').replace(/\{SEQ([3-6])\}/u, (_token, digits: string) => '1'.padStart(Number(digits), '0'))}</small>
      </fieldset>
      <ErrorNotice error={error} />
      <div className="confirm-actions">
        <button type="button" onClick={onClose} disabled={saving}>{text('Cancel', 'キャンセル')}</button>
        <button type="button" className="primary" onClick={requestSave} disabled={saving}>{text('Save settings', '設定を保存')}</button>
      </div>
      <ConfirmDialog open={confirmRounding} title={text('Change the rounding mode?', '端数処理を変えますか？')}
        message={text('Issued invoices keep their rounding, so invoices to the same customer will round differently from now on.', '発行済みの請求書は当時の端数処理のままなので、同じ取引先でも今後の請求書と丸め方が変わります。')}
        confirmLabel={text('Change and save', '変更して保存')} cancelLabel={text('Cancel', 'キャンセル')} busy={saving}
        onConfirm={() => { void save(); }} onCancel={() => setConfirmRounding(false)} />
    </div>
  </div>;
}
