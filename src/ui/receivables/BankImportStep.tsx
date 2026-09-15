import { useEffect, useState } from 'react';
import type { ReceivablesApi } from '../api/receivables-api';
import type { BankCsvImportResultDto, BankCsvPreviewDto, BankCsvProfileDto, ColumnMappingDto, CsvEncodingHintDto } from '../api/receivables-types';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { csvWarningMessage, fileToBase64, formatYen, mappingProblemLabel } from './receivables-model';
import { ErrorNotice } from './receivables-shared';

const MAPPING_KEYS = ['date', 'description', 'deposit', 'withdrawal', 'amount', 'balance', 'payerName'] as const;
type MappingKey = (typeof MAPPING_KEYS)[number];

/**
 * 明細取込ステップ（docs/22 §5 / §8）。ファイル → プレビュー（文字コード切替・ヘッダ行・プロファイル）→ 列マッピング
 * （必須の充足表示・保存）→ 取込結果（入金 / 出金スキップ / 重複（選んで取り込む）/ 読めない行）。
 */
export function BankImportStep({ api, onImported }: { readonly api: ReceivablesApi; readonly onImported: () => Promise<void> | void }) {
  const { text } = useI18n();
  const [file, setFile] = useState<{ readonly name: string; readonly content: string }>();
  const [encoding, setEncoding] = useState<CsvEncodingHintDto>('auto');
  const [accountKey, setAccountKey] = useState('');
  const [preview, setPreview] = useState<BankCsvPreviewDto>();
  const [mapping, setMapping] = useState<Partial<Record<MappingKey, string>>>({});
  const [headerRow, setHeaderRow] = useState<number>();
  const [profileName, setProfileName] = useState('');
  const [profiles, setProfiles] = useState<readonly BankCsvProfileDto[]>([]);
  const [result, setResult] = useState<BankCsvImportResultDto>();
  const [forceRows, setForceRows] = useState<readonly number[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.listProfiles(scope).then(setProfiles).catch(() => setProfiles([])); }, [api]);

  const readInput = (next: { encoding?: CsvEncodingHintDto; headerRow?: number | undefined; useMapping?: boolean } = {}) => ({
    contentBase64: file!.content, fileName: file!.name, encoding: next.encoding ?? encoding,
    ...(accountKey.trim() === '' ? {} : { accountKey: accountKey.trim() }),
    ...(next.useMapping === true ? { mapping: mapping as ColumnMappingDto, ...((next.headerRow ?? headerRow) === undefined ? {} : { headerRow: next.headerRow ?? headerRow }) } : {}),
  });

  const loadPreview = async (content: { name: string; content: string }, nextEncoding = encoding) => {
    setBusy(true); setError(undefined); setResult(undefined);
    try {
      const next = await api.previewCsv(scope, { contentBase64: content.content, fileName: content.name, encoding: nextEncoding });
      setPreview(next);
      setHeaderRow(next.headerRow);
      setMapping(next.mapping ?? {});
      if (next.profile?.accountKey !== undefined && accountKey === '') setAccountKey(next.profile.accountKey);
    } catch (cause: unknown) { setError(cause); setPreview(undefined); }
    finally { setBusy(false); }
  };

  const chooseFile = async (selected: File | undefined) => {
    if (selected === undefined) return;
    const content = { name: selected.name, content: await fileToBase64(selected) };
    setFile(content);
    await loadPreview(content);
  };

  const missing = [...(mapping.date === undefined || mapping.date === '' ? ['date'] : []), ...((mapping.deposit ?? '') === '' && (mapping.amount ?? '') === '' ? ['deposit-or-amount'] : [])];
  const needsMapping = preview !== undefined && (preview.mappingRequired || preview.profile === undefined);

  const saveProfile = async () => {
    if (preview === undefined || missing.length > 0) return;
    try {
      await api.saveProfile(scope, { name: profileName.trim() === '' ? file?.name ?? 'CSV' : profileName, mapping: mapping as ColumnMappingDto, headerSignature: preview.headers.filter((header) => header.trim() !== ''), ...(headerRow === undefined ? {} : { headerRow }), ...(accountKey.trim() === '' ? {} : { accountKey: accountKey.trim() }) });
      setProfiles(await api.listProfiles(scope));
      await loadPreview(file!);
    } catch (cause: unknown) { setError(cause); }
  };

  const runImport = async (rows: readonly number[] = []) => {
    if (file === undefined) return;
    setBusy(true); setError(undefined);
    try {
      const imported = await api.importCsv(scope, { ...readInput({ useMapping: needsMapping }), ...(rows.length === 0 ? {} : { forceRows: rows }) });
      setResult(imported);
      setForceRows([]);
      await onImported();
    } catch (cause: unknown) { setError(cause); }
    finally { setBusy(false); }
  };

  return <section className="receivables-step" aria-label={text('Bank import', '明細取込')}>
    <p className="notice-card" role="note">{text('Deposits confirmed here become draft receipt entries in the Journal. Do not import the same statement into the Journal ingest tab as well, or deposits will be booked twice.', 'この明細の入金は消込の確定で入金仕訳の下書きになります。仕訳の取込タブには入れないでください（二重計上になります）。')}</p>
    <div className="receivables-grid">
      <label>{text('Account key', '口座')}<input aria-label={text('Account key', '口座')} placeholder="default" value={accountKey} onChange={(event) => setAccountKey(event.target.value)} /></label>
      <label>{text('Bank statement CSV', '銀行明細 CSV')}<input type="file" accept=".csv,text/csv" aria-label={text('CSV file', 'CSV ファイル')} onChange={(event) => { void chooseFile(event.target.files?.[0]); }} /></label>
      {preview !== undefined && <label>{text('Character encoding', '文字コード')}
        <select aria-label={text('Character encoding', '文字コード')} value={encoding} onChange={(event) => { const next = event.target.value as CsvEncodingHintDto; setEncoding(next); if (file !== undefined) void loadPreview(file, next); }}>
          <option value="auto">{text('Auto', '自動')}</option><option value="utf-8">UTF-8</option><option value="shift_jis">Shift_JIS</option>
        </select></label>}
    </div>
    {file === undefined && <p className="empty-state">{text('Choose the deposit/withdrawal CSV downloaded from your bank (UTF-8 or Shift_JIS). Samples are in samples/receivables/.', '銀行のサイトからダウンロードした入出金明細 CSV を選んでください（UTF-8 / Shift_JIS）。サンプルは samples/receivables/ にあります。')}</p>}
    <ErrorNotice error={error} />
    {preview !== undefined && <div className="receivables-panel" aria-label={text('Preview', 'プレビュー')}>
      <p>{text(`Encoding: ${preview.encoding} · header row ${preview.headerRow} · ${preview.dataRowCount} data rows`, `文字コード: ${preview.encoding} ・ ヘッダ行 ${preview.headerRow} 行目 ・ データ ${preview.dataRowCount} 行`)}{preview.profile !== undefined && ` · ${preview.profile.name}`}</p>
      {preview.warnings.map((warning, index) => <p key={index} className="receivables-warning">{csvWarningMessage(warning, text)}</p>)}
      <div className="receivables-scroll"><table className="receivables-table"><thead><tr>{preview.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead>
        <tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody></table></div>
      {needsMapping && <fieldset className="receivables-mapping"><legend>{text('Column mapping', '列マッピング')}</legend>
        <label>{text('Header row', 'ヘッダ行')}<input type="number" min={1} max={21} aria-label={text('Header row', 'ヘッダ行')} value={headerRow ?? ''} onChange={(event) => setHeaderRow(event.target.value === '' ? undefined : Number(event.target.value))} /></label>
        {MAPPING_KEYS.map((key) => <label key={key}>{mappingLabel(key, text)}
          <select aria-label={mappingLabel(key, text)} value={mapping[key] ?? ''} onChange={(event) => setMapping({ ...mapping, [key]: event.target.value === '' ? undefined : event.target.value })}>
            <option value="">—</option>{preview.headers.filter((header) => header.trim() !== '').map((header) => <option key={header} value={header}>{header}</option>)}
          </select></label>)}
        {missing.length > 0 && <p className="field-error" role="alert">{text('Missing: ', '足りない項目: ')}{missing.map((problem) => mappingProblemLabel(problem, text)).join(' / ')}</p>}
        <label>{text('Profile name', 'プロファイル名')}<input aria-label={text('Profile name', 'プロファイル名')} value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
        <button type="button" className="secondary" disabled={missing.length > 0} onClick={() => { void saveProfile(); }}>{text('Save this mapping', 'このマッピングを保存')}</button>
      </fieldset>}
      <button type="button" className="primary" disabled={busy || (needsMapping && missing.length > 0)} onClick={() => { void runImport(); }}>{text('Import deposits', '入金を取り込む')}</button>
    </div>}
    {result !== undefined && <div className="receivables-panel" role="status" aria-label={text('Import result', '取込結果')}>
      <p>{text(`Imported ${result.imported.length} deposits · skipped ${result.skippedWithdrawals} withdrawals · ${result.duplicates.length} duplicates · ${result.skippedRows.length} unreadable rows`, `入金 ${result.imported.length} 件 ・ 出金スキップ ${result.skippedWithdrawals} 件 ・ 重複 ${result.duplicates.length} 件 ・ 読めない行 ${result.skippedRows.length} 件`)}</p>
      {result.warnings.map((warning, index) => <p key={index} className="receivables-warning">{csvWarningMessage(warning, text)}</p>)}
      {result.skippedRows.length > 0 && <ul>{result.skippedRows.map((row) => <li key={row.row}>{text(`Row ${row.row}: ${row.reason}`, `${row.row} 行目: ${row.reason}`)}</li>)}</ul>}
      {result.duplicates.length > 0 && <>
        <table className="receivables-table" aria-label={text('Duplicates', '重複')}><thead><tr><th /><th>{text('Row', '行')}</th><th>{text('Date', '日付')}</th><th>{text('Amount', '金額')}</th><th>{text('Payer', '名義')}</th></tr></thead>
          <tbody>{result.duplicates.map((duplicate) => <tr key={duplicate.row}>
            <td><input type="checkbox" aria-label={text(`Import row ${duplicate.row} anyway`, `${duplicate.row} 行目を取り込む`)} checked={forceRows.includes(duplicate.row)} onChange={(event) => setForceRows(event.target.checked ? [...forceRows, duplicate.row] : forceRows.filter((row) => row !== duplicate.row))} /></td>
            <td>{duplicate.row}</td><td>{duplicate.date}</td><td>{formatYen(duplicate.amount)}</td><td>{duplicate.payerName}</td>
          </tr>)}</tbody></table>
        <button type="button" className="secondary" disabled={forceRows.length === 0 || busy} onClick={() => { void runImport(forceRows); }}>{text('Import the selected rows', '選んだ行を取り込む')}</button>
      </>}
    </div>}
    {profiles.some((profile) => profile.origin === 'user') && <details><summary>{text('Saved profiles', '保存したプロファイル')}</summary>
      <ul>{profiles.filter((profile) => profile.origin === 'user').map((profile) => <li key={profile.id}>{profile.name} <button type="button" className="secondary" onClick={() => { void api.deleteProfile(scope, profile.id).then(async () => setProfiles(await api.listProfiles(scope))).catch(setError); }}>{text('Delete', '削除')}</button></li>)}</ul>
    </details>}
  </section>;
}

function mappingLabel(key: MappingKey, text: (en: string, ja: string) => string): string {
  switch (key) {
    case 'date': return text('Date (required)', '日付（必須）');
    case 'description': return text('Description', '摘要');
    case 'deposit': return text('Deposit', '入金');
    case 'withdrawal': return text('Withdrawal', '出金');
    case 'amount': return text('Signed amount', '符号付き金額');
    case 'balance': return text('Balance', '残高');
    case 'payerName': return text('Payer name', '振込依頼人名');
  }
}
