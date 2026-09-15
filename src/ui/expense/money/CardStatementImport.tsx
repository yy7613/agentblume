import { useState } from 'react';
import type { ExpenseMoneyApi } from '../../api/expense-money-api';
import type {
  ExpenseCardAmountSignDto, ExpenseCardColumnKeyDto, ExpenseCardImportResultDto, ExpenseCardMappingDto, ExpenseCardSettingsDto, ExpenseCardStatementPreviewDto,
} from '../../api/expense-money-types';
import type { TenantScopeDto } from '../../api/types';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { decodeCsvText, formatYen } from '../../journal/journal-model';
import type { OpenTarget } from '../../navigation';
import type { Translate } from '../expense-model';
import { MoneyErrorNotice, readMoneyError, type MoneyErrorInfo } from './money-shared';

export const CARD_COLUMN_KEYS: readonly ExpenseCardColumnKeyDto[] = ['usedOn', 'merchant', 'amount', 'postedOn', 'cardLast4', 'memo'];
const REQUIRED_COLUMNS: readonly ExpenseCardColumnKeyDto[] = ['usedOn', 'merchant', 'amount'];
const SKIP_LINES_MAX = 20;

export function cardColumnLabel(key: ExpenseCardColumnKeyDto, text: Translate): string {
  switch (key) {
    case 'usedOn': return text('Used on', '利用日');
    case 'merchant': return text('Merchant', '加盟店');
    case 'amount': return text('Amount', '金額');
    case 'postedOn': return text('Posted on', '計上日');
    case 'cardLast4': return text('Card last 4 digits', 'カード下 4 桁');
    case 'memo': return text('Memo', '備考');
  }
}

type Columns = Partial<Record<ExpenseCardColumnKeyDto, string>>;

/** 列の対応が揃っていれば取込の本文にする形、揃っていなければ undefined。 */
export function mappingFrom(columns: Columns, amountSign: ExpenseCardAmountSignDto, skipLinesBefore: number): ExpenseCardMappingDto | undefined {
  const usedOn = columns.usedOn;
  const merchant = columns.merchant;
  const amount = columns.amount;
  if (usedOn === undefined || merchant === undefined || amount === undefined) return undefined;
  return {
    columns: {
      usedOn, merchant, amount,
      ...(columns.postedOn === undefined ? {} : { postedOn: columns.postedOn }),
      ...(columns.cardLast4 === undefined ? {} : { cardLast4: columns.cardLast4 }),
      ...(columns.memo === undefined ? {} : { memo: columns.memo }),
    },
    amountSign, skipLinesBefore,
  };
}

/**
 * カード明細の取込: ファイル選択（Shift_JIS 自動判定）→ プレビュー → 列の対応・符号・前置き行数・カードを選ぶ →「このマッピングを保存」→ 取込。
 * 同じファイルの取込（409）は取込 id を出し、取込の一覧でその行を示せるようにする。
 */
export function CardStatementImport({ api, scope, settings, onOpen, onImported, onShowImport }: {
  readonly api: ExpenseMoneyApi;
  readonly scope: TenantScopeDto;
  readonly settings: ExpenseCardSettingsDto | undefined;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onImported: () => Promise<void>;
  readonly onShowImport: (importId: string) => void;
}) {
  const { text } = useI18n();
  const [file, setFile] = useState<{ readonly name: string; readonly content: string; readonly encoding: string }>();
  const [preview, setPreview] = useState<ExpenseCardStatementPreviewDto>();
  const [columns, setColumns] = useState<Columns>({});
  const [amountSign, setAmountSign] = useState<ExpenseCardAmountSignDto>('charge-positive');
  const [skipLines, setSkipLines] = useState(0);
  const [cardId, setCardId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [saveAs, setSaveAs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoneyErrorInfo>();
  const [result, setResult] = useState<ExpenseCardImportResultDto>();
  const cards = settings?.cards ?? [];
  const profiles = settings?.profiles ?? [];
  const mapping = mappingFrom(columns, amountSign, skipLines);

  const runPreview = async (content: string, withMapping: ExpenseCardMappingDto | undefined, chosenProfile: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.previewCardStatement(scope, {
        content,
        ...(withMapping === undefined ? {} : { mapping: withMapping }),
        ...(withMapping === undefined && chosenProfile !== '' ? { profileId: chosenProfile } : {}),
        ...(cardId === '' ? {} : { cardId }),
      });
      setPreview(next);
      if (withMapping === undefined) {
        // 初回: 見出しで見つかった保存済みの対応 → 選んだ対応 → 列名からの推測 の順で埋める。
        const profile = profiles.find((entry) => entry.id === (next.detectedProfileId ?? chosenProfile));
        if (profile !== undefined) {
          setColumns({ ...profile.columns });
          setAmountSign(profile.amountSign);
          setSkipLines(profile.skipLinesBefore);
          setProfileId(profile.id);
        } else {
          setColumns({ ...next.suggestedMapping });
        }
      }
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (picked: File | undefined) => {
    setResult(undefined);
    setPreview(undefined);
    setError(undefined);
    if (picked === undefined) { setFile(undefined); return; }
    const decoded = decodeCsvText(new Uint8Array(await picked.arrayBuffer()));
    setFile({ name: picked.name, content: decoded.content, encoding: decoded.encoding });
    await runPreview(decoded.content, undefined, profileId);
  };

  const chooseProfile = (id: string) => {
    setProfileId(id);
    const profile = profiles.find((entry) => entry.id === id);
    if (profile === undefined) return;
    setColumns({ ...profile.columns });
    setAmountSign(profile.amountSign);
    setSkipLines(profile.skipLinesBefore);
  };

  const importNow = async () => {
    if (file === undefined || mapping === undefined) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const next = await api.importCardStatement(scope, {
        content: file.content, fileName: file.name, mapping,
        ...(cardId === '' ? {} : { cardId }),
        ...(profileId === '' ? {} : { profileId }),
        ...(saveAs.trim() === '' ? {} : { saveProfileAs: saveAs.trim() }),
      });
      setResult(next);
      setSaveAs('');
      await onImported();
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = error?.code === 'EXPENSE_CARD_DUPLICATE_IMPORT';
  const headers = preview?.headers ?? [];

  return <section className="workspace-card" aria-labelledby="expense-money-card-import-heading">
    <h2 id="expense-money-card-import-heading">{text('Import a card statement', '明細の取込')}</h2>
    <p className="empty-state">{text('Import the statement CSV downloaded from the card company. Shift_JIS files are read as they are.', 'カード会社からダウンロードした明細 CSV を取り込みます。Shift_JIS のファイルもそのまま読めます。')}</p>
    <div className="expense-money-toolbar">
      <label>{text('Statement CSV', '明細 CSV')}<input type="file" accept=".csv,text/csv" aria-label={text('Statement CSV', '明細 CSV')} onChange={(event) => void pick(event.target.files?.[0])} /></label>
      {profiles.length > 0 && <label>{text('Saved mapping', '保存済みの対応')}
        <select value={profileId} onChange={(event) => chooseProfile(event.target.value)}>
          <option value="">{text('— none —', '— なし —')}</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>}
      <label>{text('Card', 'カード')}
        <select value={cardId} onChange={(event) => setCardId(event.target.value)}>
          <option value="">{text('Use the card number column', 'カード番号の列で判定')}</option>
          {cards.map((card) => <option key={card.id} value={card.id}>{card.label} ••{card.last4}</option>)}
        </select>
      </label>
    </div>

    {file !== undefined && <p className="empty-state">{text(`${file.name} (${file.encoding})`, `${file.name}（${file.encoding}）`)}</p>}

    {preview !== undefined && <>
      <h3>{text('Column mapping', '列の対応')}</h3>
      <div className="expense-money-mapping">
        {CARD_COLUMN_KEYS.map((key) => <label key={key} className={REQUIRED_COLUMNS.includes(key) ? 'expense-required' : ''}>{cardColumnLabel(key, text)}
          <select aria-label={text(`Column for ${cardColumnLabel(key, text)}`, `${cardColumnLabel(key, text)}の列`)} value={columns[key] ?? ''}
            onChange={(event) => setColumns((current) => {
              const { [key]: _drop, ...rest } = current;
              return event.target.value === '' ? rest : { ...rest, [key]: event.target.value };
            })}>
            <option value="">{text('— not used —', '— 使わない —')}</option>
            {columns[key] !== undefined && !headers.includes(columns[key] ?? '') && <option value={columns[key]}>{columns[key]}</option>}
            {headers.map((header) => <option key={header} value={header}>{header}</option>)}
          </select>
        </label>)}
        <label>{text('Amount sign', '金額の符号')}
          <select value={amountSign} onChange={(event) => setAmountSign(event.target.value as ExpenseCardAmountSignDto)}>
            <option value="charge-positive">{text('Charges are positive', '利用が正の数')}</option>
            <option value="charge-negative">{text('Charges are negative', '利用が負の数')}</option>
          </select>
        </label>
        <label>{text('Lines before the header', '見出しの前の行数')}
          <input type="number" min={0} max={SKIP_LINES_MAX} value={skipLines} onChange={(event) => setSkipLines(Math.min(SKIP_LINES_MAX, Math.max(0, Math.trunc(Number(event.target.value) || 0))))} />
        </label>
      </div>
      <div className="expense-actions">
        <button type="button" className="secondary" disabled={busy || file === undefined} onClick={() => { if (file !== undefined) void runPreview(file.content, mapping, profileId); }}>{text('Preview with this mapping', 'この対応でプレビュー')}</button>
        {mapping === undefined && <small className="expense-limit-hint">{text('Choose the columns for the date, merchant, and amount.', '利用日・加盟店・金額の列を選んでください。')}</small>}
      </div>

      {preview.problems.length > 0 && <div className="notice-card" role="note">
        <strong>{text('Check the mapping', '列の対応を確かめてください')}</strong>
        <ul>{preview.problems.map((problem, index) => <li key={`${problem.code}-${index}`}>{problem.row === undefined ? '' : text(`Row ${problem.row}: `, `${problem.row} 行目: `)}{problem.message}</li>)}</ul>
      </div>}
      <p className="empty-state">{text(`${preview.rowCount} rows${preview.periodFrom === undefined ? '' : ` · ${preview.periodFrom}〜${preview.periodTo ?? ''}`}`, `${preview.rowCount} 行${preview.periodFrom === undefined ? '' : ` · ${preview.periodFrom}〜${preview.periodTo ?? ''}`}`)}</p>
      {preview.rows.length > 0 && <div className="table-wrap"><table aria-label={text('Statement preview', '明細のプレビュー')}>
        <thead><tr><th>{text('Row', '行')}</th><th>{cardColumnLabel('usedOn', text)}</th><th>{cardColumnLabel('merchant', text)}</th><th>{cardColumnLabel('amount', text)}</th><th>{text('Card', 'カード')}</th></tr></thead>
        <tbody>{preview.rows.map((row) => <tr key={row.row}><td>{row.row}</td><td>{row.usedOn}</td><td>{row.merchantRaw}</td><td className="expense-money-amount">{formatYen(row.amount)}</td><td>{cards.find((card) => card.id === row.cardId)?.label ?? row.cardId}</td></tr>)}</tbody>
      </table></div>}
      <SkippedRows rows={preview.skippedRows} />

      <div className="expense-money-toolbar">
        <label>{text('Save this mapping as (optional)', 'このマッピングを保存（名前・任意）')}<input value={saveAs} maxLength={100} onChange={(event) => setSaveAs(event.target.value)} /></label>
        <button type="button" className="primary" disabled={busy || mapping === undefined || file === undefined} onClick={() => void importNow()}>{text('Import', '取り込む')}</button>
      </div>
    </>}

    {result !== undefined && <>
      <InlineFeedback kind="success">{text(`Imported ${result.imported} transactions (${result.periodFrom}〜${result.periodTo}). ${result.duplicates} duplicates were skipped.`, `${result.imported} 件を取り込みました（${result.periodFrom}〜${result.periodTo}）。重複 ${result.duplicates} 件は入れていません。`)}</InlineFeedback>
      {result.warnings.map((warning) => <p key={warning} className="notice-card">{warning}</p>)}
      <SkippedRows rows={result.skippedRows} />
    </>}

    <MoneyErrorNotice error={error} onOpen={onOpen}>
      {duplicate && <>
        <p>{text(`This file has already been imported (import ${error?.importId ?? ''}${error?.importedAt === undefined ? '' : `, ${error.importedAt.slice(0, 10)}`}). Delete that import first if you need to import it again.`, `同じファイルは取込済みです（取込 ${error?.importId ?? ''}${error?.importedAt === undefined ? '' : `・${error.importedAt.slice(0, 10)}`}）。取り込み直すなら、先にその取込を削除してください。`)}</p>
        {error?.importId !== undefined && <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => onShowImport(error.importId ?? '')}>{text('Show the import', '取込を表示')}</button></div>}
      </>}
      {error?.code === 'EXPENSE_CARD_IMPORT' && error.missingColumns.length > 0 && <p>{text(`Choose the columns for: ${error.missingColumns.join(', ')}`, `列を選んでください: ${error.missingColumns.join('、')}`)}</p>}
    </MoneyErrorNotice>
  </section>;
}

function SkippedRows({ rows }: { readonly rows: readonly { readonly row: number; readonly reason: string }[] }) {
  const { text } = useI18n();
  if (rows.length === 0) return null;
  return <div className="notice-card" role="note">
    <strong>{text(`${rows.length} rows were skipped`, `${rows.length} 行を取り込めませんでした`)}</strong>
    <ul>{rows.map((row) => <li key={`${row.row}-${row.reason}`}>{text(`Row ${row.row}: ${row.reason}`, `${row.row} 行目: ${row.reason}`)}</li>)}</ul>
  </div>;
}
