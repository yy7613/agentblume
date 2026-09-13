import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError, type ToolApiClient } from '../api/tool-api';
import type { ExtractJournalDocumentResultDto, ImportJournalCsvResultDto, JournalCapabilitiesDto, JournalChartOfAccountsDto, JournalCsvPresetDto, JournalDocumentDto, JournalDocumentKindDto, JournalDocumentSourceDto, JournalExtractionDto, SaveJournalDocumentDto } from '../api/types';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { ImageIngest } from './ImageIngest';
import type { TabFocus } from './JournalPage';
import {
  DOCUMENT_KINDS, EMPTY_FACTS_LINE, EMPTY_FACTS_TOTAL, PAYMENT_METHODS, decodeCsvText, detectCsvPreset, draftFromFacts, emptyFactsDraft, factsFromDraft, formatYen, kindLabel,
  lowConfidenceFields, paymentMethodLabel, previewRows, validateFactsJson, type FactsDraft,
} from './journal-model';
import { CapabilityNotice, ExtractionUnavailableNotice, FieldError, messageOf } from './journal-shared';

/** AI 読取の結果（保存前）。事実フォームへ載せ、利用者が直してから保存する。 */
interface ExtractedDocument {
  readonly result: ExtractJournalDocumentResultDto;
  readonly source: JournalDocumentSourceDto;
  /** 同じ内容を再度受け取っても反映されるよう連番を持つ。 */
  readonly seq: number;
}

type Source = 'csv' | 'form' | 'json' | 'text' | 'image';

/**
 * 取込タブ。5 系統: CSV（銀行 / カード明細、プリセット自動判定）/ 事実フォーム（手入力）/ JSON 貼り付け / テキスト保存 / 画像・PDF（Phase 2）。
 * `editDocument` は判定タブの「項目を編集」から来る文書 id。読み込んでフォームに展開し、保存は同じ id へ PUT する。
 */
export function IngestTab({ client, chart, capabilities, editDocument, onSaved }: {
  readonly client: ToolApiClient; readonly chart: JournalChartOfAccountsDto | undefined; readonly capabilities: JournalCapabilitiesDto | undefined;
  readonly editDocument: TabFocus | undefined; readonly onSaved?: (document: JournalDocumentDto) => void;
}) {
  const { text } = useI18n();
  const [source, setSource] = useState<Source>(editDocument === undefined ? 'csv' : 'form');
  const [extracted, setExtracted] = useState<ExtractedDocument>();
  const seqRef = useRef(0);
  /** 読み取れたら事実フォームへ切り替えて中身を載せる（保存は利用者が確認してから）。 */
  const receiveExtraction = (result: ExtractJournalDocumentResultDto, documentSource: JournalDocumentSourceDto) => {
    seqRef.current += 1;
    setExtracted({ result, source: documentSource, seq: seqRef.current });
    setSource('form');
  };
  const sources: readonly { readonly id: Source; readonly label: string }[] = [
    { id: 'csv', label: text('CSV (bank / card)', 'CSV（銀行 / カード）') },
    { id: 'form', label: text('Facts form', '事実フォーム') },
    { id: 'json', label: text('Paste JSON', 'JSON を貼り付け') },
    { id: 'text', label: text('Text', 'テキスト') },
    { id: 'image', label: text('Image / PDF', '画像 / PDF') },
  ];
  useEffect(() => { if (editDocument !== undefined) setSource('form'); }, [editDocument]);
  return <div className="journal-ingest">
    <div className="journal-source-switch" role="group" aria-label={text('Ingest source', '取込方法')}>
      {sources.map((item) => <button type="button" key={item.id} className={source === item.id ? 'active' : ''} aria-pressed={source === item.id} onClick={() => setSource(item.id)}>{item.label}</button>)}
    </div>
    {source === 'csv' ? <CsvIngest client={client} />
      : source === 'form' ? <FactsFormIngest client={client} editDocument={editDocument} extracted={extracted} onSaved={onSaved} />
      : source === 'json' ? <JsonIngest client={client} onSaved={onSaved} />
      : source === 'text' ? <TextIngest client={client} capabilities={capabilities} onExtracted={receiveExtraction} onSaved={onSaved} />
      : <ImageIngest client={client} capabilities={capabilities} onExtracted={receiveExtraction} />}
    {chart !== undefined && chart.accounts.filter((account) => account.enabled).length === 0 && <p className="notice-card">{text('The chart of accounts has no enabled accounts. Rules cannot be created until you add some in the Chart tab.', '科目マスタに有効な科目がありません。「科目」タブで追加するまでルールを作れません。')}</p>}
  </div>;
}

/* ---------------------------------------------------------------------------
 * CSV
 * ------------------------------------------------------------------------- */

function CsvIngest({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [presets, setPresets] = useState<readonly JournalCsvPresetDto[]>([]);
  const [presetsError, setPresetsError] = useState<string>();
  const [file, setFile] = useState<{ readonly name: string; readonly content: string; readonly encoding: 'utf-8' | 'shift_jis' }>();
  const [presetId, setPresetId] = useState('');
  const [accountHint, setAccountHint] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportJournalCsvResultDto>();
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();

  useEffect(() => {
    let active = true;
    void client.listJournalCsvPresets().then((all) => { if (active) { setPresets(all); setPresetsError(undefined); } }).catch((cause: unknown) => { if (active) setPresetsError(messageOf(cause)); });
    return () => { active = false; };
  }, [client]);

  const preview = useMemo(() => (file === undefined ? undefined : previewRows(file.content, 5)), [file]);
  const detected = useMemo(() => (preview === undefined ? undefined : detectCsvPreset(preview.headers, presets)), [preview, presets]);
  useEffect(() => { setPresetId(detected?.id ?? ''); }, [detected]);

  const readFile = async (picked: File | undefined) => {
    setResult(undefined);
    setError(undefined);
    setReadError(undefined);
    if (picked === undefined) { setFile(undefined); return; }
    try {
      const decoded = decodeCsvText(new Uint8Array(await picked.arrayBuffer()));
      setFile({ name: picked.name, ...decoded });
    } catch (cause: unknown) { setFile(undefined); setReadError(messageOf(cause)); }
  };

  const run = async () => {
    if (file === undefined) return;
    setImporting(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await client.importJournalCsv(scope, { content: file.content, fileName: file.name, ...(presetId === '' ? {} : { preset: presetId }), ...(accountHint.trim() === '' ? {} : { accountHint: accountHint.trim() }) }));
    } catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setImporting(false); }
  };

  return <section className="workspace-card journal-ingest-section" aria-labelledby="journal-csv-heading">
    <h2 id="journal-csv-heading">{text('Import a bank / card CSV', '銀行 / カード明細 CSV を取り込む')}</h2>
    <p className="empty-state">{text('One row becomes one document. The preset is detected from the header row (UTF-8 or Shift_JIS).', '1 行が 1 帳票になります。プリセットはヘッダー行から自動判定します（UTF-8 / Shift_JIS）。')}</p>
    {presetsError !== undefined && <p className="api-error" role="alert">{text('Could not load CSV presets: ', 'CSV プリセットを読み込めませんでした: ')}{presetsError}</p>}
    <div className="journal-file-row">
      <label>{text('CSV file', 'CSV ファイル')}<input type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event.target.files?.[0])} /></label>
      <label>{text('Account name (bank / card)', '口座名（銀行 / カード）')}<input value={accountHint} onChange={(event) => setAccountHint(event.target.value)} placeholder={text('e.g. main bank account', '例: 楽天銀行 普通')} /></label>
      <label>{text('Preset', 'プリセット')}
        <select aria-label={text('CSV preset', 'CSV プリセット')} value={presetId} onChange={(event) => setPresetId(event.target.value)}>
          <option value="">{text('— auto / column mapping on the server —', '— 自動 / サーバー側で列判定 —')}</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
      </label>
    </div>
    {readError !== undefined && <p className="api-error" role="alert">{text('Could not read the file: ', 'ファイルを読めませんでした: ')}{readError}</p>}
    {file !== undefined && preview !== undefined && <>
      <p className="journal-detected" role="status">
        {detected === undefined
          ? text(`No preset matched the header (${preview.headers.join(', ')}). Choose one manually, or export the CSV with the columns of the generic preset.`, `ヘッダー（${preview.headers.join(', ')}）に一致するプリセットがありません。手動で選ぶか、汎用プリセットの列で CSV を出力し直してください。`)
          : text(`Detected preset: ${detected.name}`, `検出したプリセット: ${detected.name}`)}
        {' · '}{file.encoding === 'shift_jis' ? text('decoded as Shift_JIS', 'Shift_JIS として読み込み') : 'UTF-8'}{' · '}{text(`${preview.totalRows} rows`, `${preview.totalRows} 行`)}
      </p>
      <div className="table-wrap"><table className="journal-table" aria-label={text('CSV preview', 'CSV プレビュー')}>
        <thead><tr>{preview.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead>
        <tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{preview.headers.map((_header, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ''}</td>)}</tr>)}</tbody>
      </table></div>
      <div className="run-failure-actions"><button type="button" className="primary" disabled={importing} onClick={() => void run()}>{importing ? text('Importing…', '取込中…') : text('Import', '取り込む')}</button></div>
    </>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
    {result !== undefined && <div className="journal-import-result" role="status">
      <InlineFeedback kind="success">{text(`Imported ${result.imported.length} documents (preset: ${result.preset}). Next: open the Judge tab and run "Judge pending".`, `${result.imported.length} 件の帳票を取り込みました（プリセット: ${result.preset}）。次は「判定」タブで「未判定を判定」を押してください。`)}</InlineFeedback>
      {result.warnings.map((warning, index) => <p key={index} className="notice-card">{warning}</p>)}
      {result.skippedRows.length > 0 && <div className="table-wrap"><table className="journal-table" aria-label={text('Skipped rows', '取り込めなかった行')}>
        <thead><tr><th>{text('Row', '行')}</th><th>{text('Reason', '理由')}</th></tr></thead>
        <tbody>{result.skippedRows.map((row) => <tr key={row.row}><td>{row.row}</td><td>{row.reason}</td></tr>)}</tbody>
      </table></div>}
    </div>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * 事実フォーム
 * ------------------------------------------------------------------------- */

function FactsFormIngest({ client, editDocument, extracted, onSaved }: {
  readonly client: ToolApiClient; readonly editDocument: TabFocus | undefined; readonly extracted: ExtractedDocument | undefined;
  readonly onSaved?: (document: JournalDocumentDto) => void;
}) {
  const { text } = useI18n();
  const [draft, setDraft] = useState<FactsDraft>(emptyFactsDraft);
  const [kind, setKind] = useState<JournalDocumentKindDto>('receipt');
  const [existing, setExisting] = useState<JournalDocumentDto>();
  /** AI 読取の結果。保存時は extraction をそのまま持ち越す（誰がどう読んだかの記録を書き換えない）。 */
  const [pending, setPending] = useState<{ readonly extraction: JournalExtractionDto; readonly source: JournalDocumentSourceDto }>();
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: 'success' | 'error'; readonly text: string }>();
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (editDocument === undefined) return;
    let active = true;
    setLoadError(undefined);
    void client.getJournalDocument(editDocument.id, scope)
      .then((document) => { if (!active) return; setExisting(document); setKind(document.kind); setDraft(draftFromFacts(document.facts)); setFeedback(undefined); setSubmitted(false); })
      .catch((cause: unknown) => { if (active) setLoadError(messageOf(cause)); });
    return () => { active = false; };
  }, [client, editDocument]);

  // AI 読取の結果を欄へ展開する。新規扱い（既存 id には上書きしない）。
  useEffect(() => {
    if (extracted === undefined) return;
    setExisting(undefined);
    setKind(extracted.result.kind);
    setDraft(draftFromFacts(extracted.result.facts));
    setPending({ extraction: extracted.result.extraction, source: extracted.source });
    setFeedback(undefined);
    setSubmitted(false);
  }, [extracted]);

  const { facts, errors } = useMemo(() => factsFromDraft(draft), [draft]);
  const fieldError = (path: string): string | undefined => { const issue = submitted ? errors[path] : undefined; return issue === undefined ? undefined : text(issue[0], issue[1]); };
  const update = (patch: Partial<FactsDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const extraction = pending?.extraction ?? existing?.extraction;
  /** 信頼度が閾値未満の項目。利用者が最初に確かめるべき欄を示す。 */
  const uncertain = useMemo(() => lowConfidenceFields(extraction), [extraction]);
  /** 低信頼の欄に付ける輪郭と、根拠（原文の断片）の title。 */
  const mark = (path: string): { className?: string; title?: string } => {
    const evidence = uncertain[path];
    if (evidence === undefined) return {};
    const percent = Math.round(evidence.confidence * 100);
    const quoted = evidence.sourceText === undefined || evidence.sourceText === '' ? '' : text(`: "${evidence.sourceText}"`, `: 「${evidence.sourceText}」`);
    return { className: 'journal-uncertain', title: text(`Read with low confidence (${percent}%)${quoted}. Check this one first.`, `信頼度が低い読み取りです（${percent}%）${quoted}。先に確認してください。`) };
  };
  const chip = (path: string) => (uncertain[path] === undefined ? null : <span className="journal-uncertain-chip">{text('check', '要確認')}</span>);

  const save = async () => {
    setSubmitted(true);
    setFeedback(undefined);
    if (Object.keys(errors).length > 0) { setFeedback({ kind: 'error', text: text('Fix the highlighted fields before saving.', '赤く示した欄を直してから保存してください') }); return; }
    setSaving(true);
    try {
      const source: JournalDocumentSourceDto = pending?.source ?? existing?.source ?? { type: 'structured' };
      const payload: SaveJournalDocumentDto = { ...(existing === undefined ? {} : { id: existing.id }), kind, source, facts, extraction: extraction ?? { method: 'manual', warnings: [] } };
      const saved = await client.saveJournalDocument(scope, payload);
      setExisting(saved);
      setFeedback({ kind: 'success', text: existing === undefined ? text('Saved. Next: open the Judge tab and judge it.', '保存しました。次は「判定」タブで判定してください。') : text('Updated. Judge the document again from the Judge tab.', '更新しました。「判定」タブでもう一度判定してください。') });
      onSaved?.(saved);
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  const startNew = () => { setExisting(undefined); setPending(undefined); setDraft(emptyFactsDraft()); setKind('receipt'); setFeedback(undefined); setSubmitted(false); };

  return <section className="workspace-card journal-ingest-section" aria-labelledby="journal-form-heading">
    <h2 id="journal-form-heading">{existing === undefined ? text('Enter the facts of a document', '帳票の事実を入力する') : text(`Edit facts of document ${existing.id}`, `帳票 ${existing.id} の項目を編集`)}</h2>
    {loadError !== undefined && <p className="api-error" role="alert">{text('Could not load the document: ', '帳票を読み込めませんでした: ')}{loadError}</p>}
    {pending !== undefined && <InlineFeedback kind="info">{text(
      'Read by the model. Check the values — especially the ones marked "check" — then save. Nothing is stored until you press Save.',
      'モデルが読み取りました。値（特に「要確認」の印が付いた欄）を確かめてから保存してください。保存を押すまで何も記録されません。',
    )}</InlineFeedback>}
    {extraction !== undefined && extraction.warnings.length > 0 && <ul className="journal-warnings" aria-label={text('Notes about this reading', '読み取りへの注意')}>
      {extraction.warnings.map((warning, index) => <li key={index} className="notice-card">{warning}</li>)}
    </ul>}
    {existing !== undefined && <div className="run-failure-actions"><button type="button" className="secondary" onClick={startNew}>{text('New document', '新しい帳票')}</button></div>}
    <div className="journal-form-grid">
      <label>{text('Kind', '種別')}<select aria-label={text('Document kind', '帳票種別')} value={kind} onChange={(event) => setKind(event.target.value as JournalDocumentKindDto)}>{DOCUMENT_KINDS.map((item) => <option key={item} value={item}>{kindLabel(item, text)}</option>)}</select></label>
      <label {...mark('direction')}>{text('Direction', '方向')}{chip('direction')}<select aria-label={text('Direction', '方向')} value={draft.direction} onChange={(event) => update({ direction: event.target.value as FactsDraft['direction'] })}><option value="">—</option><option value="out">{text('Expense', '支出')}</option><option value="in">{text('Income', '収入')}</option></select></label>
      <label {...mark('transactionDate')}>{text('Transaction date', '取引日')}{chip('transactionDate')}<input aria-label={text('Transaction date', '取引日')} value={draft.transactionDate} placeholder="YYYY-MM-DD" onChange={(event) => update({ transactionDate: event.target.value })} /><FieldError message={fieldError('transactionDate')} /></label>
      <label {...mark('grandTotal')}>{text('Grand total (yen, tax included)', '合計（税込・円）')}{chip('grandTotal')}<input aria-label={text('Grand total', '合計金額')} value={draft.grandTotal} inputMode="numeric" onChange={(event) => update({ grandTotal: event.target.value })} /><FieldError message={fieldError('grandTotal')} /></label>
      <label {...mark('issuerName')}>{text('Issuer', '発行者')}{chip('issuerName')}<input aria-label={text('Issuer name', '発行者')} value={draft.issuerName} onChange={(event) => update({ issuerName: event.target.value })} /></label>
      <label {...mark('recipientName')}>{text('Recipient', '宛名')}{chip('recipientName')}<input aria-label={text('Recipient name', '宛名')} value={draft.recipientName} onChange={(event) => update({ recipientName: event.target.value })} /></label>
      <label {...mark('registrationNumber')}>{text('Registration number (T + 13 digits)', '登録番号（T + 13 桁）')}{chip('registrationNumber')}<input aria-label={text('Registration number', '登録番号')} value={draft.registrationNumber} onChange={(event) => update({ registrationNumber: event.target.value })} /><FieldError message={fieldError('registrationNumber')} /></label>
      <label {...mark('paymentMethod')}>{text('Payment method', '支払方法')}{chip('paymentMethod')}<select aria-label={text('Payment method', '支払方法')} value={draft.paymentMethod} onChange={(event) => update({ paymentMethod: event.target.value as FactsDraft['paymentMethod'] })}><option value="">—</option>{PAYMENT_METHODS.map((method) => <option key={method} value={method}>{paymentMethodLabel(method, text)}</option>)}</select></label>
      <label {...mark('issueDate')}>{text('Issue date', '発行日')}{chip('issueDate')}<input aria-label={text('Issue date', '発行日')} value={draft.issueDate} placeholder="YYYY-MM-DD" onChange={(event) => update({ issueDate: event.target.value })} /><FieldError message={fieldError('issueDate')} /></label>
      <label {...mark('dueDate')}>{text('Due date', '支払期限')}{chip('dueDate')}<input aria-label={text('Due date', '支払期限')} value={draft.dueDate} placeholder="YYYY-MM-DD" onChange={(event) => update({ dueDate: event.target.value })} /><FieldError message={fieldError('dueDate')} /></label>
      <label {...mark('accountHint')}>{text('Account hint (bank / card)', '口座名（銀行 / カード）')}{chip('accountHint')}<input aria-label={text('Account hint', '口座名')} value={draft.accountHint} onChange={(event) => update({ accountHint: event.target.value })} /></label>
      <label {...mark('counterpartyHint')}>{text('Counterparty hint', '相手先')}{chip('counterpartyHint')}<input aria-label={text('Counterparty hint', '相手先')} value={draft.counterpartyHint} onChange={(event) => update({ counterpartyHint: event.target.value })} /></label>
      <label className={uncertain['description'] === undefined ? 'journal-span' : 'journal-span journal-uncertain'} {...(mark('description').title === undefined ? {} : { title: mark('description').title })}>{text('Description', '摘要')}{chip('description')}<input aria-label={text('Description', '摘要')} value={draft.description} onChange={(event) => update({ description: event.target.value })} /></label>
    </div>

    <h3>{text('Lines', '明細')}</h3>
    {draft.lines.length > 0 && <div className="table-wrap"><table className="journal-table journal-editor-table" aria-label={text('Fact lines', '明細行')}>
      <thead><tr><th>{text('Description', '品名')}</th><th>{text('Qty', '数量')}</th><th>{text('Unit price', '単価')}</th><th>{text('Amount', '金額')}</th><th>{text('Rate', '税率')}</th><th /></tr></thead>
      <tbody>{draft.lines.map((line, index) => {
        const set = (patch: Partial<typeof line>) => update({ lines: draft.lines.map((item, position) => (position === index ? { ...item, ...patch } : item)) });
        return <tr key={index}>
          <td><input aria-label={text(`Line ${index + 1} description`, `明細 ${index + 1} 品名`)} value={line.description} onChange={(event) => set({ description: event.target.value })} /><FieldError message={fieldError(`lines.${index}.description`)} /></td>
          <td><input aria-label={text(`Line ${index + 1} quantity`, `明細 ${index + 1} 数量`)} value={line.quantity} onChange={(event) => set({ quantity: event.target.value })} /></td>
          <td><input aria-label={text(`Line ${index + 1} unit price`, `明細 ${index + 1} 単価`)} value={line.unitPrice} onChange={(event) => set({ unitPrice: event.target.value })} /></td>
          <td><input aria-label={text(`Line ${index + 1} amount`, `明細 ${index + 1} 金額`)} value={line.amount} onChange={(event) => set({ amount: event.target.value })} /><FieldError message={fieldError(`lines.${index}.amount`)} /></td>
          <td><select aria-label={text(`Line ${index + 1} tax rate`, `明細 ${index + 1} 税率`)} value={line.taxRate} onChange={(event) => set({ taxRate: event.target.value as typeof line.taxRate })}><option value="">—</option><option value="10">10%</option><option value="8">8%</option><option value="0">0%</option></select></td>
          <td><button type="button" className="secondary danger" onClick={() => update({ lines: draft.lines.filter((_item, position) => position !== index) })}>{text('Remove', '削除')}</button></td>
        </tr>;
      })}</tbody>
    </table></div>}
    <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => update({ lines: [...draft.lines, EMPTY_FACTS_LINE] })}>{text('Add line', '明細を追加')}</button></div>

    <h3>{text('Totals by tax rate', '税率別集計')}</h3>
    {draft.totals.length > 0 && <div className="table-wrap"><table className="journal-table journal-editor-table" aria-label={text('Totals by rate', '税率別集計')}>
      <thead><tr><th>{text('Rate', '税率')}</th><th>{text('Taxable amount', '対象額')}</th><th>{text('Tax amount', '税額')}</th><th>{text('Includes tax', '税込')}</th><th /></tr></thead>
      <tbody>{draft.totals.map((total, index) => {
        const set = (patch: Partial<typeof total>) => update({ totals: draft.totals.map((item, position) => (position === index ? { ...item, ...patch } : item)) });
        return <tr key={index}>
          <td><select aria-label={text(`Total ${index + 1} rate`, `集計 ${index + 1} 税率`)} value={total.rate} onChange={(event) => set({ rate: event.target.value as typeof total.rate })}><option value="10">10%</option><option value="8">8%</option><option value="0">0%</option></select></td>
          <td><input aria-label={text(`Total ${index + 1} taxable amount`, `集計 ${index + 1} 対象額`)} value={total.taxableAmount} onChange={(event) => set({ taxableAmount: event.target.value })} /><FieldError message={fieldError(`totals.${index}.taxableAmount`)} /></td>
          <td><input aria-label={text(`Total ${index + 1} tax amount`, `集計 ${index + 1} 税額`)} value={total.taxAmount} onChange={(event) => set({ taxAmount: event.target.value })} /></td>
          <td><input type="checkbox" aria-label={text(`Total ${index + 1} includes tax`, `集計 ${index + 1} 税込`)} checked={total.amountIncludesTax} onChange={(event) => set({ amountIncludesTax: event.target.checked })} /></td>
          <td><button type="button" className="secondary danger" onClick={() => update({ totals: draft.totals.filter((_item, position) => position !== index) })}>{text('Remove', '削除')}</button></td>
        </tr>;
      })}</tbody>
    </table></div>}
    <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => update({ totals: [...draft.totals, EMPTY_FACTS_TOTAL] })}>{text('Add rate total', '集計を追加')}</button></div>

    <label>{text('Extra (JSON object; hearing answers go here)', '追加項目（JSON オブジェクト。ヒアリングの回答もここに入ります）')}<textarea aria-label={text('Extra facts JSON', '追加項目 JSON')} rows={3} value={draft.extra} onChange={(event) => update({ extra: event.target.value })} /><FieldError message={fieldError('extra')} /></label>

    <div className="run-failure-actions">
      <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : existing === undefined ? text('Save document', '帳票を保存') : text('Update document', '帳票を更新')}</button>
      <span className="empty-state">{text('Total', '合計')}: {formatYen(facts.grandTotal)}</span>
    </div>
    {feedback !== undefined && <InlineFeedback kind={feedback.kind}>{feedback.text}</InlineFeedback>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * JSON 貼り付け
 * ------------------------------------------------------------------------- */

function JsonIngest({ client, onSaved }: { readonly client: ToolApiClient; readonly onSaved?: (document: JournalDocumentDto) => void }) {
  const { text } = useI18n();
  const [raw, setRaw] = useState('');
  const [kind, setKind] = useState<JournalDocumentKindDto>('invoice');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: 'success' | 'error'; readonly text: string }>();
  const validation = useMemo(() => (raw.trim() === '' ? undefined : validateFactsJson(raw)), [raw]);

  const save = async () => {
    if (validation?.facts === undefined) { setFeedback({ kind: 'error', text: text('Fix the JSON errors listed below before saving.', '下に示した JSON の問題を直してから保存してください') }); return; }
    setSaving(true);
    setFeedback(undefined);
    try {
      const saved = await client.saveJournalDocument(scope, { kind, source: { type: 'structured' }, facts: validation.facts, extraction: { method: 'structured', warnings: [] } });
      setFeedback({ kind: 'success', text: text(`Saved document ${saved.id}. Next: judge it in the Judge tab.`, `帳票 ${saved.id} を保存しました。次は「判定」タブで判定してください。`) });
      setRaw('');
      onSaved?.(saved);
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  return <section className="workspace-card journal-ingest-section" aria-labelledby="journal-json-heading">
    <h2 id="journal-json-heading">{text('Paste facts as JSON', '事実を JSON で貼り付ける')}</h2>
    <p className="empty-state">{text('The shape is DocumentFacts (docs/20 §2.2): direction, issuerName, transactionDate, grandTotal, lines[], totalsByRate[], extra{}…', '形は DocumentFacts（docs/20 §2.2）: direction, issuerName, transactionDate, grandTotal, lines[], totalsByRate[], extra{} など')}</p>
    <label>{text('Kind', '種別')}<select aria-label={text('Document kind', '帳票種別')} value={kind} onChange={(event) => setKind(event.target.value as JournalDocumentKindDto)}>{DOCUMENT_KINDS.map((item) => <option key={item} value={item}>{kindLabel(item, text)}</option>)}</select></label>
    <label>{text('Facts JSON', '事実 JSON')}<textarea aria-label={text('Facts JSON', '事実 JSON')} rows={10} value={raw} onChange={(event) => setRaw(event.target.value)} placeholder='{ "direction": "out", "transactionDate": "2026-04-01", "grandTotal": 1100 }' /></label>
    {validation?.errors !== undefined && <ul className="journal-json-errors" role="alert">{validation.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    {validation?.facts !== undefined && <p className="inline-feedback info" role="status">{text('Valid facts.', '事実として読めます。')} {text('Total', '合計')}: {formatYen(validation.facts.grandTotal)}</p>}
    <div className="run-failure-actions"><button type="button" className="primary" disabled={saving || raw.trim() === ''} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save document', '帳票を保存')}</button></div>
    {feedback !== undefined && <InlineFeedback kind={feedback.kind}>{feedback.text}</InlineFeedback>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * テキスト
 * ------------------------------------------------------------------------- */

function TextIngest({ client, capabilities, onExtracted, onSaved }: {
  readonly client: ToolApiClient; readonly capabilities: JournalCapabilitiesDto | undefined;
  readonly onExtracted: (result: ExtractJournalDocumentResultDto, source: JournalDocumentSourceDto) => void;
  readonly onSaved?: (document: JournalDocumentDto) => void;
}) {
  const { text } = useI18n();
  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: 'success' | 'error'; readonly text: string }>();
  const [aborter, setAborter] = useState<AbortController>();
  const [cancelled, setCancelled] = useState(false);
  /** 409（モデルが構造化出力に非対応）。ただのエラーではなく設定への導線を出す。 */
  const [unavailable, setUnavailable] = useState<string>();
  const elapsedSeconds = useElapsedSeconds(aborter !== undefined);
  const extracting = aborter !== undefined;
  const extractionReady = capabilities?.extraction.enabled === true;

  const extract = async () => {
    const trimmed = raw.trim();
    if (trimmed === '') { setFeedback({ kind: 'error', text: text('Paste the text first.', '先にテキストを貼り付けてください') }); return; }
    const controller = new AbortController();
    setAborter(controller);
    setFeedback(undefined);
    setUnavailable(undefined);
    setCancelled(false);
    try {
      const result = await client.extractJournalDocument(scope, { text: trimmed }, controller.signal);
      onExtracted(result, { type: 'text', text: trimmed });
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else if (cause instanceof ApiError && cause.code === 'JOURNAL_EXTRACTION_UNAVAILABLE') setUnavailable(messageOf(cause));
      else setFeedback({ kind: 'error', text: messageOf(cause) });
    } finally {
      setAborter(undefined);
    }
  };

  const save = async () => {
    const trimmed = raw.trim();
    if (trimmed === '') { setFeedback({ kind: 'error', text: text('Paste the text first.', '先にテキストを貼り付けてください') }); return; }
    setSaving(true);
    setFeedback(undefined);
    try {
      const saved = await client.saveJournalDocument(scope, { kind: 'unknown', source: { type: 'text', text: trimmed }, facts: { description: trimmed.split('\n')[0]?.trim() ?? trimmed }, extraction: { method: 'manual', warnings: [] } });
      setFeedback({ kind: 'success', text: text(`Saved as document ${saved.id}. Fill its facts from the Judge tab ("Edit facts") or wait for AI extraction.`, `帳票 ${saved.id} として保存しました。「判定」タブの「項目を編集」で事実を入れるか、AI 抽出が使えるようになるまで待ってください。`) });
      setRaw('');
      onSaved?.(saved);
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  return <section className="workspace-card journal-ingest-section" aria-labelledby="journal-text-heading">
    <h2 id="journal-text-heading">{text('Text (email body, memo)', 'テキスト（メール本文・メモ）')}</h2>
    <label>{text('Text', 'テキスト')}<textarea aria-label={text('Source text', '原文テキスト')} rows={8} value={raw} disabled={extracting} onChange={(event) => setRaw(event.target.value)} /></label>
    <div className="run-failure-actions">
      <button type="button" className="secondary" disabled={saving || extracting} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Store the text now', 'テキストを保存する')}</button>
      <button type="button" className="primary" disabled={!extractionReady || extracting || saving} title={extractionReady ? undefined : text('LLM extraction is not available', 'LLM 抽出が使えません')} onClick={() => void extract()}>
        {extracting ? text(`Reading… ${elapsedSeconds}s`, `読み取り中… ${elapsedSeconds}秒`) : text('Read with AI', 'AI で読み取る')}
      </button>
      {extracting && <button type="button" className="secondary" onClick={() => aborter?.abort()}>{text('Cancel', '中断')}</button>}
    </div>
    <CapabilityNotice capabilities={capabilities} feature="extraction" />
    {extracting && <p role="status" className="empty-state">{text('The model is reading the text.', 'モデルがテキストを読んでいます。')}</p>}
    {cancelled && <InlineFeedback kind="info">{text('Cancelled. Nothing was read and nothing was saved.', '中断しました。読み取りも保存も行っていません。')}</InlineFeedback>}
    {unavailable !== undefined && <ExtractionUnavailableNotice message={unavailable} />}
    {feedback !== undefined && <InlineFeedback kind={feedback.kind}>{feedback.text}</InlineFeedback>}
  </section>;
}
