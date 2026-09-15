import { useEffect, useState } from 'react';
import type { ReceivablesApi } from '../api/receivables-api';
import type { AliasConflictDto, CustomerDto, SaveCustomerDto } from '../api/receivables-types';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { previewPayerName } from './receivables-model';
import { ErrorNotice, Yen } from './receivables-shared';

interface AliasRow { readonly id?: string; readonly text: string; readonly normalized?: string; readonly origin?: string; readonly lastMatchedAt?: string }

const emptyForm = { name: '', honorific: '御中' as const, kana: '', registrationNumber: '', paymentTermDays: '', address: '', note: '', enabled: true };

/**
 * 取引先ステップ（docs/22 §8）。一覧 → 編集パネル（敬称・支払条件・登録番号・振込名義カナ・**別名の表**）。
 * 別名は利用者が編集・削除でき、入力中に照合で使う形を目安として見せる（正本は保存後のサーバーの値）。
 */
export function CustomersStep({ api, customers, focus, onChanged, onOpenSettings, settingsSaved }: {
  readonly api: ReceivablesApi; readonly customers: readonly CustomerDto[]; readonly focus: { readonly id: string; readonly section: string; readonly seq: number } | undefined;
  readonly onChanged: () => Promise<void> | void; readonly onOpenSettings: () => void; readonly settingsSaved: boolean | undefined;
}) {
  const { text } = useI18n();
  const [selectedId, setSelectedId] = useState<string | 'new'>();
  const [form, setForm] = useState<{ name: string; honorific: '御中' | '様'; kana: string; registrationNumber: string; paymentTermDays: string; address: string; note: string; enabled: boolean }>(emptyForm);
  const [aliases, setAliases] = useState<readonly AliasRow[]>([]);
  const [newAlias, setNewAlias] = useState('');
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();
  const [warnings, setWarnings] = useState<readonly AliasConflictDto[]>([]);

  /** 利用者が別の取引先（または新規）を選んだ。前の保存の警告はここでだけ消す（保存直後の id の切替では消さない）。 */
  const select = (id: string | 'new') => { setWarnings([]); setSelectedId(id); };

  useEffect(() => { if (focus !== undefined && focus.id !== '') select(focus.id); }, [focus]);
  useEffect(() => {
    if (selectedId === undefined) return;
    const customer = customers.find((entry) => entry.id === selectedId);
    setError(undefined); setNewAlias('');
    if (customer === undefined) { setForm(emptyForm); setAliases([]); return; }
    setForm({ name: customer.name, honorific: customer.honorific, kana: customer.kana ?? '', registrationNumber: customer.registrationNumber ?? '', paymentTermDays: customer.paymentTermDays === undefined ? '' : String(customer.paymentTermDays), address: customer.address ?? '', note: customer.note ?? '', enabled: customer.enabled });
    setAliases(customer.payerAliases.map((alias) => ({ id: alias.id, text: alias.text, normalized: alias.normalized, origin: alias.origin, ...(alias.lastMatchedAt === undefined ? {} : { lastMatchedAt: alias.lastMatchedAt }) })));
  }, [selectedId, customers]);

  const save = async () => {
    setError(undefined);
    const body: SaveCustomerDto = {
      name: form.name, honorific: form.honorific, enabled: form.enabled,
      ...(form.kana.trim() === '' ? {} : { kana: form.kana }),
      ...(form.registrationNumber.trim() === '' ? {} : { registrationNumber: form.registrationNumber }),
      ...(form.paymentTermDays.trim() === '' ? {} : { paymentTermDays: Number(form.paymentTermDays) }),
      ...(form.address.trim() === '' ? {} : { address: form.address }),
      ...(form.note.trim() === '' ? {} : { note: form.note }),
      payerAliases: [...aliases, ...(newAlias.trim() === '' ? [] : [{ text: newAlias }])].map((alias) => ({ ...(alias.id === undefined ? {} : { id: alias.id }), text: alias.text })),
    };
    try {
      const result = await api.saveCustomer(scope, body, selectedId === 'new' ? undefined : selectedId);
      setWarnings(result.warnings);
      setSaved(text('Saved the customer.', '取引先を保存しました。'));
      setSelectedId(result.customer.id);
      await onChanged();
    } catch (cause: unknown) { setError(cause); }
  };

  const remove = async () => {
    if (selectedId === undefined || selectedId === 'new') return;
    try { await api.deleteCustomer(scope, selectedId); setSelectedId(undefined); await onChanged(); }
    catch (cause: unknown) { setError(cause); }
  };

  return <section className="receivables-step" aria-label={text('Customers', '取引先')}>
    {settingsSaved === false && <div className="notice-card" role="note">
      <strong>{text('Settings are not saved yet', '設定がまだ保存されていません')}</strong>
      <p>{text('Enter the issuer name and registration number first: they are required on every invoice.', '先に発行者名と登録番号を設定してください。請求書の記載事項です。')}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={onOpenSettings}>{text('Open Settings', '設定を開く')}</button></div>
    </div>}
    <div className="receivables-split">
      <div>
        <div className="receivables-toolbar"><button type="button" className="primary" onClick={() => select('new')}>{text('Add a customer', '取引先を追加')}</button></div>
        {customers.length === 0
          ? <p className="empty-state">{text('No customers yet. Add the customers you invoice (the recipients). Sample data is in samples/receivables/customers.json.', '取引先がありません。請求書の宛名になる取引先を追加してください。サンプルは samples/receivables/customers.json にあります。')}</p>
          : <table className="receivables-table"><thead><tr><th>{text('Name', '名称')}</th><th>{text('Payer kana', '振込名義カナ')}</th><th>{text('Aliases', '別名')}</th><th>{text('Unpaid', '未入金')}</th></tr></thead>
            <tbody>{customers.map((customer) => <tr key={customer.id} className={customer.id === selectedId ? 'selected' : ''} onClick={() => select(customer.id)}>
              <td><button type="button" className="link-button" onClick={() => select(customer.id)}>{customer.name}</button>{!customer.enabled && <small> {text('(disabled)', '（無効）')}</small>}</td>
              <td>{customer.kana ?? '—'}</td><td>{customer.payerAliases.length}</td><td><Yen value={customer.outstanding} /></td>
            </tr>)}</tbody></table>}
      </div>
      {selectedId !== undefined && <form className="receivables-panel" aria-label={text('Customer editor', '取引先の編集')} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{text('Name', '名称')}<input aria-label={text('Customer name', '取引先名')} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>{text('Honorific', '敬称')}<select value={form.honorific} onChange={(event) => setForm({ ...form, honorific: event.target.value as '御中' | '様' })}><option value="御中">御中</option><option value="様">様</option></select></label>
        <label>{text('Payer name in kana (as it appears on bank statements)', '振込名義カナ（銀行明細に出る名義）')}<input aria-label={text('Payer kana', '振込名義カナ')} value={form.kana} onChange={(event) => setForm({ ...form, kana: event.target.value })} /></label>
        <label>{text('Payment terms (days after issue)', '支払条件（発行日から何日）')}<input type="number" min={0} max={365} aria-label={text('Payment terms', '支払条件')} value={form.paymentTermDays} onChange={(event) => setForm({ ...form, paymentTermDays: event.target.value })} /></label>
        <label>{text('Registration number', '登録番号')}<input value={form.registrationNumber} onChange={(event) => setForm({ ...form, registrationNumber: event.target.value })} /></label>
        <label>{text('Address', '住所')}<input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
        <label className="receivables-inline"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />{text('Enabled', '有効')}</label>
        <h4 id="receivables-customer-aliases">{text('Payer name aliases', '振込名義の別名')}</h4>
        <table className="receivables-table" aria-label={text('Aliases', '別名')}><thead><tr><th>{text('Name as deposited', '生の名義')}</th><th>{text('Matched as', '正規化後')}</th><th>{text('Origin', '出所')}</th><th>{text('Last match', '最終一致日')}</th><th /></tr></thead>
          <tbody>{aliases.map((alias, index) => <tr key={alias.id ?? `new-${index}`}>
            <td><input aria-label={text(`Alias ${index + 1}`, `別名 ${index + 1}`)} value={alias.text} onChange={(event) => setAliases(aliases.map((entry, position) => position === index ? { ...entry, text: event.target.value, normalized: undefined } : entry))} /></td>
            <td>{alias.normalized ?? previewPayerName(alias.text)}</td>
            <td>{alias.origin === 'learned' ? text('Learned', '学習') : text('Manual', '手動')}</td>
            <td>{alias.lastMatchedAt?.slice(0, 10) ?? '—'}</td>
            <td><button type="button" className="secondary" onClick={() => setAliases(aliases.filter((_, position) => position !== index))}>{text('Delete', '削除')}</button></td>
          </tr>)}</tbody></table>
        <label>{text('Add an alias', '別名を追加')}<input aria-label={text('New alias', '新しい別名')} value={newAlias} onChange={(event) => setNewAlias(event.target.value)} /></label>
        {newAlias.trim() !== '' && <small>{text('Matched as', '照合に使う形')}: {previewPayerName(newAlias)}</small>}
        {warnings.map((warning) => <p key={`${warning.otherCustomerId}-${warning.normalized}`} className="receivables-warning" role="status">
          {text(`"${warning.normalized}" is also registered for ${warning.otherCustomerName}. Deposits with this name will stay pending until one of them is removed.`, `「${warning.normalized}」は ${warning.otherCustomerName} にも登録されています。どちらかから消すまで、この名義の入金は保留になります。`)}
          <button type="button" className="secondary" onClick={() => select(warning.otherCustomerId)}>{text(`Open ${warning.otherCustomerName}`, `${warning.otherCustomerName} を開く`)}</button>
        </p>)}
        <ErrorNotice error={error} />
        {saved !== undefined && <InlineFeedback kind="success" autoHideMs={3000} onDismiss={() => setSaved(undefined)}>{saved}</InlineFeedback>}
        <div className="receivables-toolbar">
          <button type="submit" className="primary">{text('Save customer', '取引先を保存')}</button>
          {selectedId !== 'new' && <button type="button" className="secondary" onClick={() => { void remove(); }}>{text('Delete customer', '取引先を削除')}</button>}
        </div>
      </form>}
    </div>
  </section>;
}
