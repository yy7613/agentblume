import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalAccountCategoryDto, JournalAccountDto, JournalChartOfAccountsDto, JournalDimensionDto, JournalTaxCategoryDto, SaveJournalChartOfAccountsDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import type { TabFocus } from './JournalPage';
import { ACCOUNT_CATEGORIES, categoryLabel, chartValidation, decodeCsvText, moveAccount, newAccount, newTaxCategory, splitList, triggerDownload } from './journal-model';
import { FieldError, messageOf } from './journal-shared';

/**
 * 科目タブ。科目 / 税区分 / 補助軸をインライン編集し、マスタ全体を保存する。「標準に戻す」と CSV 取込 / 出力。
 * 削除は論理（enabled: false）だけ。ルール・仕訳からの参照が残るため、行を消す操作は置かない（docs/20 §5）。
 * `focus` は判定タブの「科目マスタを開く」（unknown-account の科目 id）。該当行があれば強調し、無ければ「その id で追加」を促す。
 */
export function ChartTab({ client, chart, onChartChanged, focus }: {
  readonly client: ToolApiClient; readonly chart: JournalChartOfAccountsDto | undefined; readonly onChartChanged: (chart: JournalChartOfAccountsDto) => void; readonly focus: TabFocus | undefined;
}) {
  const { text } = useI18n();
  const [editor, setEditor] = useState<SaveJournalChartOfAccountsDto>();
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: 'success' | 'error' | 'info'; readonly text: string }>();
  const [pendingReset, setPendingReset] = useState(false);
  const [csv, setCsv] = useState<string>();
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (chart !== undefined && !dirty) setEditor({ accounts: chart.accounts, dimensions: chart.dimensions, taxCategories: chart.taxCategories }); }, [chart, dirty]);
  useEffect(() => {
    if (focus === undefined) return;
    const element = document.getElementById(`journal-account-${focus.id}`);
    if (element !== null && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
  }, [focus, editor]);

  const issues = useMemo(() => (editor === undefined ? [] : chartValidation(editor)), [editor]);
  const issueOf = (path: string): string | undefined => {
    if (!submitted) return undefined;
    const issue = issues.find((item) => item.path === path);
    return issue === undefined ? undefined : text(issue.message[0], issue.message[1]);
  };
  const update = (patch: Partial<SaveJournalChartOfAccountsDto>) => { setDirty(true); setEditor((current) => (current === undefined ? current : { ...current, ...patch })); };
  const updateAccount = (index: number, patch: Partial<JournalAccountDto>) => { if (editor !== undefined) update({ accounts: editor.accounts.map((account, position) => (position === index ? { ...account, ...patch } : account)) }); };
  const updateTax = (index: number, patch: Partial<JournalTaxCategoryDto>) => { if (editor !== undefined) update({ taxCategories: editor.taxCategories.map((tax, position) => (position === index ? { ...tax, ...patch } : tax)) }); };
  const updateDimension = (index: number, patch: Partial<JournalDimensionDto>) => { if (editor !== undefined) update({ dimensions: editor.dimensions.map((dimension, position) => (position === index ? { ...dimension, ...patch } : dimension)) }); };

  const applySaved = (saved: JournalChartOfAccountsDto) => { setDirty(false); setEditor({ accounts: saved.accounts, dimensions: saved.dimensions, taxCategories: saved.taxCategories }); onChartChanged(saved); };

  const save = async () => {
    if (editor === undefined) return;
    setSubmitted(true);
    setFeedback(undefined);
    if (issues.length > 0) { setFeedback({ kind: 'error', text: text(`Fix ${issues.length} highlighted field(s) before saving.`, `赤く示した ${issues.length} 箇所を直してから保存してください`) }); return; }
    setSaving(true);
    try { applySaved(await client.saveJournalChart(scope, editor)); setFeedback({ kind: 'success', text: text('Chart saved.', '科目マスタを保存しました') }); }
    catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  const reset = async () => {
    setSaving(true);
    try { applySaved(await client.resetJournalChart(scope)); setPendingReset(false); setFeedback({ kind: 'success', text: text('Restored the standard chart.', '標準セットに戻しました') }); }
    catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  const exportCsv = async () => {
    setFeedback(undefined);
    setDownloadFailed(false);
    try {
      const content = await client.exportJournalChartCsv(scope);
      setCsv(content);
      if (!triggerDownload('chart-of-accounts.csv', content)) setDownloadFailed(true);
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
  };

  const importCsv = async (file: File | undefined) => {
    if (file === undefined) return;
    setFeedback(undefined);
    try {
      const { content } = decodeCsvText(new Uint8Array(await file.arrayBuffer()));
      applySaved(await client.importJournalChartCsv(scope, { content }));
      setFeedback({ kind: 'success', text: text(`Imported ${file.name}.`, `${file.name} を取り込みました`) });
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
  };

  if (editor === undefined) return <section className="workspace-card"><p className="empty-state">{text('Loading the chart of accounts…', '科目マスタを読み込み中…')}</p></section>;
  const sortedAccounts = [...editor.accounts].map((account, index) => ({ account, index })).sort((a, b) => a.account.sortOrder - b.account.sortOrder);
  const missingFocus = focus !== undefined && focus.id !== '' && !editor.accounts.some((account) => account.id === focus.id);

  return <div className="journal-chart">
    <section className="workspace-card" aria-labelledby="journal-accounts-heading">
      <div className="journal-toolbar">
        <h2 id="journal-accounts-heading">{text('Accounts', '勘定科目')} <small className="empty-state">({editor.accounts.length})</small></h2>
        <button type="button" className="secondary" onClick={() => update({ accounts: [...editor.accounts, newAccount(editor.accounts)] })}>{text('Add account', '科目を追加')}</button>
        <button type="button" className="secondary" onClick={() => setPendingReset(true)}>{text('Restore standard set', '標準に戻す')}</button>
        <button type="button" className="secondary" onClick={() => void exportCsv()}>{text('Export CSV', 'CSV 出力')}</button>
        <label className="journal-inline-file">{text('Import CSV', 'CSV 取込')}<input type="file" accept=".csv,text/csv" aria-label={text('Chart CSV file', '科目 CSV ファイル')} onChange={(event) => void importCsv(event.target.files?.[0])} /></label>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save chart', 'マスタを保存')}</button>
      </div>
      <p className="empty-state">{text('Accounts are referenced by id from rules and entries, so rename freely; disable instead of deleting.', '科目はルールと仕訳から id で参照されるため、名前は自由に変えられます。削除の代わりに無効化してください。')}</p>
      {missingFocus && <div className="notice-card" role="note"><strong>{text(`Account "${focus.id}" is not in the chart.`, `科目「${focus.id}」はマスタにありません。`)}</strong><p>{text('Next step: add it with the same id (so existing rules work again), or change the rule to another account.', '次の一手: 同じ id で追加する（既存ルールがそのまま動きます）か、ルールの科目を別のものに変えてください。')}</p><div className="run-failure-actions"><button type="button" className="secondary" onClick={() => update({ accounts: [...editor.accounts, { ...newAccount(editor.accounts), id: focus.id }] })}>{text(`Add account "${focus.id}"`, `科目「${focus.id}」を追加`)}</button></div></div>}
      {feedback !== undefined && <InlineFeedback kind={feedback.kind}>{feedback.text}</InlineFeedback>}
      {submitted && issues.length > 0 && <p className="api-error" role="alert">{text(`${issues.length} problem(s): `, `${issues.length} 件の問題: `)}{issues.slice(0, 3).map((issue) => text(issue.message[0], issue.message[1])).join(' / ')}{issues.length > 3 ? ' …' : ''}</p>}
      <div className="table-wrap"><table className="journal-table journal-editor-table" aria-label={text('Account list', '科目一覧')}>
        <thead><tr><th>{text('Order', '順')}</th><th>ID</th><th>{text('Code', 'コード')}</th><th>{text('Name', '名前')}</th><th>{text('Category', '区分')}</th><th>{text('Default tax', '既定税区分')}</th><th>{text('Aliases', '別名')}</th><th>{text('Enabled', '有効')}</th></tr></thead>
        <tbody>{sortedAccounts.map(({ account, index }) => <tr key={index} id={`journal-account-${account.id}`} className={focus?.id === account.id ? 'selected' : ''}>
          <td className="journal-order"><button type="button" className="secondary" aria-label={text(`Move ${account.name || account.id} up`, `${account.name || account.id} を上へ`)} onClick={() => update({ accounts: moveAccount(editor.accounts, account.id, 'up') })}>↑</button><button type="button" className="secondary" aria-label={text(`Move ${account.name || account.id} down`, `${account.name || account.id} を下へ`)} onClick={() => update({ accounts: moveAccount(editor.accounts, account.id, 'down') })}>↓</button></td>
          <td><input aria-label={text(`Account ${index + 1} id`, `科目 ${index + 1} ID`)} value={account.id} onChange={(event) => updateAccount(index, { id: event.target.value })} /><FieldError message={issueOf(`accounts.${index}.id`)} /></td>
          <td><input aria-label={text(`Account ${index + 1} code`, `科目 ${index + 1} コード`)} value={account.code ?? ''} onChange={(event) => updateAccount(index, { code: event.target.value })} /><FieldError message={issueOf(`accounts.${index}.code`)} /></td>
          <td><input aria-label={text(`Account ${index + 1} name`, `科目 ${index + 1} 名前`)} value={account.name} onChange={(event) => updateAccount(index, { name: event.target.value })} /><FieldError message={issueOf(`accounts.${index}.name`)} /></td>
          <td><select aria-label={text(`Account ${index + 1} category`, `科目 ${index + 1} 区分`)} value={account.category} onChange={(event) => updateAccount(index, { category: event.target.value as JournalAccountCategoryDto })}>{ACCOUNT_CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabel(category, text)}</option>)}</select></td>
          <td><select aria-label={text(`Account ${index + 1} default tax`, `科目 ${index + 1} 既定税区分`)} value={account.defaultTaxCode ?? ''} onChange={(event) => updateAccount(index, { defaultTaxCode: event.target.value === '' ? undefined : event.target.value })}><option value="">—</option>{editor.taxCategories.map((tax) => <option key={tax.code} value={tax.code}>{tax.name} ({tax.code})</option>)}</select><FieldError message={issueOf(`accounts.${index}.defaultTaxCode`)} /></td>
          <td><input aria-label={text(`Account ${index + 1} aliases`, `科目 ${index + 1} 別名`)} value={account.aliases.join(', ')} onChange={(event) => updateAccount(index, { aliases: splitList(event.target.value) })} /></td>
          <td><input type="checkbox" aria-label={text(`Account ${index + 1} enabled`, `科目 ${index + 1} 有効`)} checked={account.enabled} onChange={(event) => updateAccount(index, { enabled: event.target.checked })} /></td>
        </tr>)}</tbody>
      </table></div>
      {csv !== undefined && <div className="journal-csv-out">
        {downloadFailed && <p className="notice-card">{text('The browser did not start a download. Copy the CSV from the box below.', 'ブラウザがダウンロードを開始しませんでした。下の欄から CSV をコピーしてください。')}</p>}
        <label>{text('Chart CSV', '科目 CSV')}<textarea aria-label={text('Chart CSV', '科目 CSV')} readOnly rows={6} value={csv} /></label>
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => { if (!triggerDownload('chart-of-accounts.csv', csv)) setDownloadFailed(true); }}>{text('Download', 'ダウンロード')}</button></div>
      </div>}
    </section>

    <section className="workspace-card" aria-labelledby="journal-tax-heading">
      <div className="journal-toolbar">
        <h2 id="journal-tax-heading">{text('Tax categories', '税区分')} <small className="empty-state">({editor.taxCategories.length})</small></h2>
        <button type="button" className="secondary" onClick={() => update({ taxCategories: [...editor.taxCategories, newTaxCategory(editor.taxCategories)] })}>{text('Add tax category', '税区分を追加')}</button>
      </div>
      <div className="table-wrap"><table className="journal-table journal-editor-table" aria-label={text('Tax category list', '税区分一覧')}>
        <thead><tr><th>{text('Code', 'コード')}</th><th>{text('Name', '名前')}</th><th>{text('Side', '区分')}</th><th>{text('Rate %', '税率 %')}</th><th>{text('Deduction', '控除割合')}</th><th>{text('Enabled', '有効')}</th><th>{text('Yayoi', '弥生')}</th><th>freee</th><th>MF</th></tr></thead>
        <tbody>{editor.taxCategories.map((tax, index) => <tr key={index}>
          <td><input aria-label={text(`Tax ${index + 1} code`, `税区分 ${index + 1} コード`)} value={tax.code} onChange={(event) => updateTax(index, { code: event.target.value })} /><FieldError message={issueOf(`taxCategories.${index}.code`)} /></td>
          <td><input aria-label={text(`Tax ${index + 1} name`, `税区分 ${index + 1} 名前`)} value={tax.name} onChange={(event) => updateTax(index, { name: event.target.value })} /><FieldError message={issueOf(`taxCategories.${index}.name`)} /></td>
          <td><select aria-label={text(`Tax ${index + 1} side`, `税区分 ${index + 1} 区分`)} value={tax.side} onChange={(event) => updateTax(index, { side: event.target.value as JournalTaxCategoryDto['side'] })}><option value="in">{text('Purchase', '仕入')}</option><option value="out">{text('Sales', '売上')}</option><option value="none">{text('None', '対象外')}</option></select></td>
          <td><input aria-label={text(`Tax ${index + 1} rate`, `税区分 ${index + 1} 税率`)} value={tax.rate ?? ''} onChange={(event) => updateTax(index, { rate: event.target.value === '' ? undefined : Number(event.target.value) })} /><FieldError message={issueOf(`taxCategories.${index}.rate`)} /></td>
          <td><input aria-label={text(`Tax ${index + 1} deduction rate`, `税区分 ${index + 1} 控除割合`)} value={tax.deductionRate ?? ''} placeholder="0.8" onChange={(event) => updateTax(index, { deductionRate: event.target.value === '' ? undefined : Number(event.target.value) })} /><FieldError message={issueOf(`taxCategories.${index}.deductionRate`)} /></td>
          <td><input type="checkbox" aria-label={text(`Tax ${index + 1} enabled`, `税区分 ${index + 1} 有効`)} checked={tax.enabled} onChange={(event) => updateTax(index, { enabled: event.target.checked })} /></td>
          {(['yayoi', 'freee', 'mf'] as const).map((vendor) => <td key={vendor}><input aria-label={text(`Tax ${index + 1} ${vendor} name`, `税区分 ${index + 1} ${vendor} 表示名`)} value={tax.mapping?.[vendor] ?? ''} onChange={(event) => updateTax(index, { mapping: { ...tax.mapping, [vendor]: event.target.value } })} /></td>)}
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className="workspace-card" aria-labelledby="journal-dimensions-heading">
      <div className="journal-toolbar">
        <h2 id="journal-dimensions-heading">{text('Dimensions', '補助軸')} <small className="empty-state">({editor.dimensions.length})</small></h2>
        <button type="button" className="secondary" onClick={() => update({ dimensions: [...editor.dimensions, { id: `dim-${editor.dimensions.length + 1}`, name: '', values: [] }] })}>{text('Add dimension', '補助軸を追加')}</button>
      </div>
      {editor.dimensions.length === 0 && <p className="empty-state">{text('No dimensions (sub-account, department, project…). Add one to tag entry lines.', '補助軸（補助科目・部門・プロジェクトなど）はありません。追加すると仕訳行に付けられます。')}</p>}
      {editor.dimensions.map((dimension, index) => <div key={index} className="journal-dimension">
        <div className="journal-form-grid">
          <label>ID<input aria-label={text(`Dimension ${index + 1} id`, `補助軸 ${index + 1} ID`)} value={dimension.id} onChange={(event) => updateDimension(index, { id: event.target.value })} /><FieldError message={issueOf(`dimensions.${index}.id`)} /></label>
          <label>{text('Name', '名前')}<input aria-label={text(`Dimension ${index + 1} name`, `補助軸 ${index + 1} 名前`)} value={dimension.name} onChange={(event) => updateDimension(index, { name: event.target.value })} /><FieldError message={issueOf(`dimensions.${index}.name`)} /></label>
        </div>
        <ul className="journal-dimension-values">
          {dimension.values.map((value, valueIndex) => <li key={valueIndex}>
            <input aria-label={text(`${dimension.name || dimension.id} value ${valueIndex + 1} id`, `${dimension.name || dimension.id} 値 ${valueIndex + 1} ID`)} value={value.id} onChange={(event) => updateDimension(index, { values: dimension.values.map((item, position) => (position === valueIndex ? { ...item, id: event.target.value } : item)) })} />
            <input aria-label={text(`${dimension.name || dimension.id} value ${valueIndex + 1} name`, `${dimension.name || dimension.id} 値 ${valueIndex + 1} 名前`)} value={value.name} onChange={(event) => updateDimension(index, { values: dimension.values.map((item, position) => (position === valueIndex ? { ...item, name: event.target.value } : item)) })} />
            <label className="journal-checkbox"><input type="checkbox" checked={value.enabled} onChange={(event) => updateDimension(index, { values: dimension.values.map((item, position) => (position === valueIndex ? { ...item, enabled: event.target.checked } : item)) })} />{text('Enabled', '有効')}</label>
            <FieldError message={issueOf(`dimensions.${index}.values.${valueIndex}.id`) ?? issueOf(`dimensions.${index}.values.${valueIndex}.name`)} />
          </li>)}
        </ul>
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => updateDimension(index, { values: [...dimension.values, { id: `${dimension.id}-${dimension.values.length + 1}`, name: '', enabled: true }] })}>{text('Add value', '値を追加')}</button></div>
      </div>)}
    </section>
    <ConfirmDialog open={pendingReset} danger busy={saving} title={text('Restore the standard chart?', '標準セットに戻しますか？')}
      message={text('All accounts, tax categories, and dimensions are replaced by the standard set. Rules that refer to removed accounts will show "account missing" until fixed.', '科目・税区分・補助軸をすべて標準セットに置き換えます。消えた科目を参照するルールは、直すまで「科目がマスタに無い」になります。')}
      confirmLabel={text('Restore', '標準に戻す')} cancelLabel={text('Cancel', 'キャンセル')} onConfirm={() => void reset()} onCancel={() => setPendingReset(false)} />
  </div>;
}
