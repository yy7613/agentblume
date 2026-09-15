import { useEffect, useState } from 'react';
import { expenseInputApi } from '../../api/expense-input-api';
import type { ExtractExpenseDetailResultDto } from '../../api/expense-input-types';
import type { ExpenseCapabilitiesDto, ExpenseExtractionFlagDto, ExpenseItemDraftDto } from '../../api/expense-types';
import { isAbortError } from '../../api/tool-api';
import { useI18n } from '../../i18n';
import type { ExpenseDetailReadSlotProps } from '../expense-slots';
import { messageOf } from '../expense-shared';
import { ModelUnavailableNotice, isApiErrorCode, useOpenModelSettings } from './input-shared';
import './input.css';

export const DETAIL_READ_STORAGE_KEY = 'agentblume.expense.detailRead';

type Text = (english: string, japanese: string) => string;

export function detailReadAvailable(capabilities: ExpenseCapabilitiesDto | undefined): boolean {
  // 古いサーバーは detailExtraction を返さないので、無ければ使えない側へ倒す。
  return (capabilities?.detailExtraction as { readonly enabled?: boolean } | undefined)?.enabled === true;
}

function readStored(): boolean {
  try { return localStorage.getItem(DETAIL_READ_STORAGE_KEY) === 'true'; } catch { return false; }
}

function writeStored(value: boolean): void {
  try { localStorage.setItem(DETAIL_READ_STORAGE_KEY, value ? 'true' : 'false'); } catch { /* 端末に保存できない環境では記憶しない。 */ }
}

function unavailableCause(capabilities: ExpenseCapabilitiesDto | undefined, text: Text): string {
  return capabilities === undefined
    ? text('The server has not reported whether the additional reading is available yet.', 'サーバーから追加読取の可否がまだ取得できていません。')
    : text('The additional expense reading needs a main model with structured output and vision.', '経費の追加読取には、構造化出力と画像に対応した main モデルが必要です。');
}

const FIELD_LABELS: Record<ExtractExpenseDetailResultDto['disagreements'][number]['field'], readonly [string, string]> = {
  registrationNumber: ['Registration number', '登録番号'], transactionDate: ['Transaction date', '取引日'], issueDate: ['Issue date', '発行日'], payeeName: ['Payee', '支払先'],
};

export function flagMessage(flag: ExpenseExtractionFlagDto, draft: ExpenseItemDraftDto, text: Text): string | undefined {
  switch (flag) {
    case 'detail-read-failed': return text('The additional reading failed. The first reading can still be used as is.', '追加読取に失敗しました。最初の読取の結果はそのまま使えます。');
    case 'transaction-date-substituted': return text('No transaction date was printed, so the issue date is used. Check the date of use.', '取引日が印字されておらず、発行日で代用しています。利用日を確認してください。');
    case 'registration-number-rejected': return text(
      `The registration number was not used${draft.extraction.rejectedRegistrationNumber === undefined ? '' : ` (read: "${draft.extraction.rejectedRegistrationNumber}")`}. Compare it with the receipt and enter it.`,
      `登録番号は採用しませんでした${draft.extraction.rejectedRegistrationNumber === undefined ? '' : `（読んだ値: 「${draft.extraction.rejectedRegistrationNumber}」）`}。領収書と見比べて入力してください。`,
    );
    case 'attendees-read': return text('Attendees were filled from the additional reading (not confirmed).', '参加人数・氏名は追加読取の値です（未確認）。');
    case 'route-read': return text('The route was filled from the additional reading (not confirmed).', '区間は追加読取の値です（未確認）。');
    case 'payee-read': return text('The payee was filled from the additional reading (not confirmed).', '支払先は追加読取の値です（未確認）。');
    case 'purpose-read': return text('The purpose was chosen from the reading candidates (not confirmed).', '目的は読取の候補から入れました（未確認）。');
    case 'payee-from-report': return text('The document looks like an expense report, so its author was treated as the claimant.', '精算書として読んだため、作成者を申請者として扱いました。');
    case 'reads-disagree': return text('The two readings disagree. Compare them below.', '2 回の読取が食い違っています。下で見比べてください。');
  }
}

/** 画像読取の「経費の追加読取もする」切替と、下書きごとの「追加で読む」（§20.7.1, §20.3.6）。 */
export function DetailReadToggle(props: ExpenseDetailReadSlotProps) {
  return props.placement === 'reader' ? <ReaderToggle {...props} /> : <DraftDetailRead {...props} />;
}

function ReaderToggle(props: Extract<ExpenseDetailReadSlotProps, { readonly placement: 'reader' }>) {
  const { text } = useI18n();
  const available = detailReadAvailable(props.capabilities);

  // 端末に記憶した値を読んで反映する（可否が後から届くので、可否の変化でも読み直す）。使えないときは off。
  useEffect(() => {
    const next = available && readStored();
    if (next !== props.detail) props.onDetailChange(next);
  }, [available]);

  return <div className="expense-input-detail">
    <label><span>
      <input type="checkbox" checked={available && props.detail} disabled={!available}
        onChange={(event) => { writeStored(event.target.checked); props.onDetailChange(event.target.checked); }} />
      {' '}{text('Also run the additional expense reading (slow, off by default)', '経費の追加読取もする（遅い。既定 off）')}
    </span></label>
    {available
      ? <small className="expense-input-hint">{text('Reads attendees, purpose clues, and routes as well. It can take a few minutes per page with a small model.', '参加人数・目的の手がかり・区間も読みます。小さなモデルでは 1 枚に数分かかることがあります。')}</small>
      : <ModelUnavailableNotice title={text('The additional reading is not available', '経費の追加読取は使えません')} cause={unavailableCause(props.capabilities, text)} />}
  </div>;
}

function DraftDetailRead(props: Extract<ExpenseDetailReadSlotProps, { readonly placement: 'draft' }>) {
  const { text } = useI18n();
  const openSettings = useOpenModelSettings();
  const available = detailReadAvailable(props.capabilities);
  const [aborter, setAborter] = useState<AbortController>();
  const [result, setResult] = useState<ExtractExpenseDetailResultDto>();
  const [failure, setFailure] = useState<{ readonly kind: 'unavailable' | 'error'; readonly message: string }>();
  const [cancelled, setCancelled] = useState(false);
  const { draft } = props;

  const run = async () => {
    const controller = new AbortController();
    setAborter(controller);
    setFailure(undefined);
    setCancelled(false);
    try {
      const next = await expenseInputApi(props.transport).extractDetail(props.scope, { images: props.images, draft }, controller.signal);
      setResult(next);
      props.onDraftChange(next.draft);
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else setFailure({ kind: isApiErrorCode(cause, 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE') ? 'unavailable' : 'error', message: messageOf(cause) });
    } finally {
      setAborter(undefined);
    }
  };

  const flags = draft.extraction.flags ?? [];
  // 結果の食い違いが空なら、下書きに残る追加読取の記録の食い違いを出す（読取と同時に読んだ下書き・結果を捨てた後）。
  const disagreements = result !== undefined && result.disagreements.length > 0 ? result.disagreements : draft.extraction.detail?.disagreements ?? [];
  const clues = draft.extraction.detail?.raw.purposeClues ?? [];
  const flagLines = flags.filter((flag) => flag !== 'reads-disagree' || disagreements.length === 0).map((flag) => ({ flag, message: flagMessage(flag, draft, text) }));
  const usePurpose = (clue: string) => props.onDraftChange({
    ...draft, facts: { ...draft.facts, purpose: clue },
    extraction: { ...draft.extraction, flags: flags.includes('purpose-read') ? flags : [...flags, 'purpose-read'] },
  });

  return <div className="expense-input-detail">
    <div className="expense-input-chips">
      {aborter === undefined
        ? <button type="button" className="secondary" disabled={!available || props.images.length === 0} onClick={() => void run()}>{text('Read more details', '追加で読む')}</button>
        : <>
          <span role="status">{text('Reading details…', '追加で読んでいます…')}</span>
          <button type="button" className="secondary" onClick={() => aborter.abort()}>{text('Stop', '中断')}</button>
        </>}
      {!available && <>
        <small className="expense-input-hint">{unavailableCause(props.capabilities, text)}</small>
        <button type="button" className="screen-link" onClick={openSettings}>{text('Choose a model in Settings', '設定でモデルを選ぶ')}</button>
      </>}
    </div>
    {cancelled && <small className="expense-input-hint" role="status">{text('Stopped. The first reading is unchanged.', '中断しました。最初の読取の結果はそのままです。')}</small>}
    {failure?.kind === 'unavailable' && <ModelUnavailableNotice failed title={text('The additional reading is not available', '経費の追加読取は使えません')} cause={failure.message} />}
    {failure?.kind === 'error' && <div className="api-error" role="alert">
      <p>{text(`Could not read the details: ${failure.message}`, `追加で読めませんでした: ${failure.message}`)}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => void run()}>{text('Try again', 'もう一度試す')}</button></div>
    </div>}
    {result?.warnings.map((warning) => <small key={warning} className="expense-input-warn">{warning}</small>)}
    {flagLines.map(({ flag, message }) => <small key={flag} className="expense-input-warn">{message}</small>)}
    {disagreements.length > 0 && <div className="table-wrap"><table className="expense-input-table" aria-label={text('Where the two readings disagree', '2 回の読取の食い違い')}>
      <thead><tr><th>{text('Field', '欄')}</th><th>{text('Journal reading', '仕訳の読取')}</th><th>{text('Additional reading', '追加の読取')}</th></tr></thead>
      <tbody>{disagreements.map((entry) => <tr key={entry.field}>
        <td>{text(FIELD_LABELS[entry.field][0], FIELD_LABELS[entry.field][1])}</td><td>{entry.journalValue ?? '—'}</td><td>{entry.detailValue ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>}
    {clues.length > 0 && <div className="expense-input-chips" aria-label={text('Purpose candidates', '目的の候補')}>
      <small>{text('Purpose candidates (not filled automatically):', '目的の候補（自動では入れません）:')}</small>
      {clues.map((clue) => <button key={clue} type="button" aria-pressed={draft.facts.purpose === clue}
        className={`expense-chip-button ${draft.facts.purpose === clue ? 'expense-input-chip-selected' : ''}`} onClick={() => usePurpose(clue)}>{clue}</button>)}
    </div>}
  </div>;
}
