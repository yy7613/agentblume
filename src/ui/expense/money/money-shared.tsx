/**
 * 系統 B（お金の流れ）の部品が共有する小物: API の送信口、状態の文言、409 の読み方（次の一手・止める理由・導線）、理由の必須入力。
 * 文言は日英ペア。サーバーの `nextStep` と仕訳連携の `message` は日本語の 1 文なのでそのまま出す。
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { ApiTransport } from '../../api/business-api';
import { expenseMoneyApi, type ExpenseMoneyApi } from '../../api/expense-money-api';
import type { ExpenseAdvanceStatusDto, ExpenseCardTransactionStatusDto } from '../../api/expense-money-types';
import type { ExpenseBlockingReasonDto, ExpenseJournalLinkProblemDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import { useI18n } from '../../i18n';
import { formatYen } from '../../journal/journal-model';
import { useOpenInScreen, type OpenTarget } from '../../navigation';
import { detailArray, isBlockingReason, isJournalLinkProblem, isString, type ExpenseTab, type Translate } from '../expense-model';
import './money.css';

export function useMoneyApi(transport: ApiTransport): ExpenseMoneyApi {
  return useMemo(() => expenseMoneyApi(transport), [transport]);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 端末の今日（YYYY-MM-DD）。 */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 差額の符号つき表示（+¥1,000 / −¥1,000 / ¥0）。 */
export function signedYen(amount: number): string {
  if (amount > 0) return `+${formatYen(amount)}`;
  if (amount < 0) return `−${formatYen(-amount)}`;
  return formatYen(0);
}

export function advanceStatusLabel(status: ExpenseAdvanceStatusDto | string, text: Translate): string {
  switch (status) {
    case 'requested': return text('Requested', '申請中');
    case 'approved': return text('Approved', '承認済み');
    case 'paid': return text('Paid', '支払済み');
    case 'settling': return text('Settling', '精算中');
    case 'settled': return text('Settled', '精算済み');
    case 'cancelled': return text('Cancelled', '取消');
    default: return status;
  }
}

export function paymentMethodText(method: string, text: Translate): string {
  return method === 'cash' ? text('Cash', '現金') : method === 'transfer' ? text('Bank transfer', '振込') : method;
}

export function cardTransactionStatusLabel(status: ExpenseCardTransactionStatusDto | string, text: Translate): string {
  switch (status) {
    case 'unmatched': return text('Unmatched', '未照合');
    case 'matched': return text('Matched', '照合済み');
    case 'excluded': return text('Excluded', '対象外');
    default: return status;
  }
}

/* ---------------------------------------------------------------------------
 * 失敗の読み方
 * ------------------------------------------------------------------------- */

export interface MoneyErrorInfo {
  /** 見出し（`ApiError` は code ごとに平易にした文言）。 */
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  /** サーバーの元の文言（400 の入力の誤りの詳細）。見出しと同じなら無い。 */
  readonly detail?: string;
  readonly nextStep?: string;
  readonly reasons: readonly ExpenseBlockingReasonDto[];
  readonly problems: readonly ExpenseJournalLinkProblemDto[];
  readonly createdEntryIds: readonly string[];
  readonly importId?: string;
  readonly importedAt?: string;
  readonly missingColumns: readonly string[];
  readonly row?: number;
  readonly field?: string;
}

function detailString(details: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readMoneyError(cause: unknown): MoneyErrorInfo {
  if (!(cause instanceof ApiError)) {
    return { message: cause instanceof Error ? cause.message : String(cause), reasons: [], problems: [], createdEntryIds: [], missingColumns: [] };
  }
  const nextStep = detailString(cause.details, 'nextStep');
  const importId = detailString(cause.details, 'importId');
  const importedAt = detailString(cause.details, 'importedAt');
  const field = detailString(cause.details, 'field');
  return {
    message: cause.message,
    status: cause.status,
    code: cause.code,
    ...(cause.serverMessage !== '' && cause.serverMessage !== cause.message ? { detail: cause.serverMessage } : {}),
    ...(nextStep === undefined ? {} : { nextStep }),
    reasons: detailArray(cause.details, 'blockingReasons', isBlockingReason),
    problems: detailArray(cause.details, 'problems', isJournalLinkProblem),
    createdEntryIds: detailArray(cause.details, 'createdEntryIds', isString),
    ...(importId === undefined ? {} : { importId }),
    ...(importedAt === undefined ? {} : { importedAt }),
    missingColumns: detailArray(cause.details, 'missingColumns', isString),
    ...(cause.row === undefined ? {} : { row: cause.row }),
    ...(field === undefined ? {} : { field }),
  };
}

function param(reason: ExpenseBlockingReasonDto, key: string): string | undefined {
  const value = reason.params?.[key];
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** 止める理由 1 件の平易な文。 */
export function blockingReasonText(reason: ExpenseBlockingReasonDto, text: Translate): string {
  const status = param(reason, 'advanceStatus');
  switch (reason.code) {
    case 'advance-status': return text(`The advance is ${advanceStatusLabel(status ?? '', text)}, so this operation is not available.`, `仮払が「${advanceStatusLabel(status ?? '', text)}」なのでこの操作はできません。`);
    case 'approval-claimant-self': return text('The employee who receives the advance cannot approve it.', '仮払を受け取る本人は承認できません。');
    case 'advance-has-claims': return text(`Claims are linked to this advance (${param(reason, 'claimIds') ?? param(reason, 'count') ?? ''}).`, `この仮払に申請が紐付いています（${param(reason, 'claimIds') ?? param(reason, 'count') ?? ''}）。`);
    case 'advance-journal-drafted': return text('A payment journal draft has already been created.', '支払の仕訳下書きを作成済みです。');
    case 'advance-in-payout': return text(`The advance is in a payout file (${param(reason, 'batchId') ?? ''}).`, `振込データ（${param(reason, 'batchId') ?? ''}）に含まれています。`);
    case 'advance-not-paid': return text(`The advance has not been paid yet (${advanceStatusLabel(status ?? '', text)}).`, `仮払がまだ支払済みではありません（${advanceStatusLabel(status ?? '', text)}）。`);
    case 'advance-too-many-claims': return text(`${param(reason, 'count') ?? ''} claims are linked; at most ${param(reason, 'max') ?? ''} are allowed.`, `紐付く申請が ${param(reason, 'count') ?? ''} 件あります（最大 ${param(reason, 'max') ?? ''} 件）。`);
    case 'advance-claim-not-approved': return text(`Claim ${param(reason, 'claimId') ?? ''} is not approved yet.`, `申請 ${param(reason, 'claimId') ?? ''} がまだ承認されていません。`);
    case 'advance-employee-mismatch': return text(`The claimant is not the employee of the advance${param(reason, 'advanceEmployee') === undefined ? '' : ` (${param(reason, 'advanceEmployee') ?? ''})`}.`, `申請者と仮払の従業員${param(reason, 'advanceEmployee') === undefined ? '' : `（${param(reason, 'advanceEmployee') ?? ''}）`}が違います。`);
    case 'advance-already-settled': return text('The advance is already being settled.', '仮払は精算に入っています。');
    case 'card-transaction-matched': return text(`The card transaction is matched to claim ${param(reason, 'claimId') ?? ''}.`, `カードの利用が申請 ${param(reason, 'claimId') ?? ''} に照合済みです。`);
    case 'card-item-matched': return text('The item is already matched to another card transaction.', 'この明細は別のカードの利用に照合済みです。');
    default: return reason.code;
  }
}

export interface MoneyAction {
  readonly label: string;
  readonly onClick: () => void;
}

/** 止める理由 1 件 → 直す場所の OpenTarget（params の id から作る）。いま見ている仮払・利用は除く。 */
export function blockingReasonTargets(reason: ExpenseBlockingReasonDto, text: Translate, exclude: { readonly advanceId?: string; readonly cardTransactionId?: string } = {}): readonly { readonly label: string; readonly target: OpenTarget }[] {
  const claimId = param(reason, 'claimId');
  const itemId = param(reason, 'itemId') ?? reason.itemId;
  const advanceId = param(reason, 'advanceId');
  const cardTransactionId = param(reason, 'cardTransactionId');
  const employeeId = param(reason, 'employeeId');
  const targets: { label: string; target: OpenTarget }[] = [];
  if (claimId !== undefined && itemId !== undefined) targets.push({ label: text('Open the item', '明細を開く'), target: { internalId: claimId, section: `item:${itemId}` } });
  else if (claimId !== undefined) targets.push({ label: text('Open the claim', '申請を開く'), target: { internalId: claimId, section: 'claim' } });
  if (advanceId !== undefined && advanceId !== exclude.advanceId) targets.push({ label: text('Open the advance', '仮払を開く'), target: { internalId: advanceId, section: 'advance' } });
  if (cardTransactionId !== undefined && cardTransactionId !== exclude.cardTransactionId) targets.push({ label: text('Open the card transaction', 'カードの利用を開く'), target: { internalId: cardTransactionId, section: 'card' } });
  if (employeeId !== undefined) targets.push({ label: text('Open the employee', '従業員を開く'), target: { internalId: employeeId, section: 'employee' } });
  return targets;
}

/** 止める理由の並び（理由の文 + 直す場所のボタン）。 */
export function BlockingReasonList({ reasons, onOpen, exclude }: {
  readonly reasons: readonly ExpenseBlockingReasonDto[];
  readonly onOpen: (target: OpenTarget) => void;
  readonly exclude?: { readonly advanceId?: string; readonly cardTransactionId?: string };
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  if (reasons.length === 0) return null;
  return <ul className="expense-money-reasons">{reasons.map((reason, index) => {
    const entryId = param(reason, 'entryId');
    return <li key={`${reason.code}-${index}`}>
      <span>{blockingReasonText(reason, text)}</span>
      <span className="run-failure-actions">
        {blockingReasonTargets(reason, text, exclude).map((entry) => <button key={entry.label} type="button" className="secondary" onClick={() => onOpen(entry.target)}>{entry.label}</button>)}
        {entryId !== undefined && <button type="button" className="secondary" onClick={() => openInScreen('Journal', { internalId: entryId, section: 'entry' })}>{text('Open the journal draft', '仕訳下書きを開く')}</button>}
      </span>
    </li>;
  })}</ul>;
}

/**
 * 失敗の表示: 見出し → 次の一手 → 止める理由と導線 → 仕訳連携の問題。
 * 仕訳連携の `item` は申請の明細の仕訳が先に要るという意味なので、`onTab` があれば精算出力タブへの導線を出す。
 */
export function MoneyErrorNotice({ error, onOpen, onTab, exclude, children }: {
  readonly error: MoneyErrorInfo | undefined;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab?: (tab: ExpenseTab) => void;
  readonly exclude?: { readonly advanceId?: string; readonly cardTransactionId?: string };
  readonly children?: ReactNode;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  if (error === undefined) return null;
  const problemAction = (problem: ExpenseJournalLinkProblemDto): MoneyAction | undefined => {
    switch (problem.fixTarget) {
      case 'journal-chart': return { label: text('Open the journal chart of accounts', '仕訳の科目マスタを開く'), onClick: () => openInScreen('Journal', { internalId: problem.accountId ?? '', section: 'account' }) };
      case 'policy-category': return { label: text('Open the policy category', '規程の費目を開く'), onClick: () => onOpen({ internalId: problem.categoryId ?? '', section: 'category' }) };
      case 'policy-journal': return { label: text('Open the journal settings', '仕訳設定を開く'), onClick: () => onOpen({ internalId: '', section: 'journal' }) };
      default: return onTab === undefined ? undefined : { label: text('Open Settle', '精算出力を開く'), onClick: () => onTab('settle') };
    }
  };
  return <div className="notice-card expense-money-error" role="alert">
    <p className="api-error">{error.message}</p>
    {error.detail !== undefined && error.status === 400 && <p><small>{error.detail}</small></p>}
    {error.nextStep !== undefined && <p><strong>{text('Next step', '次の一手')}:</strong> {error.nextStep}</p>}
    <BlockingReasonList reasons={error.reasons} onOpen={onOpen} {...(exclude === undefined ? {} : { exclude })} />
    {error.problems.length > 0 && <ul className="expense-money-reasons" aria-label={text('Journal draft problems', '仕訳下書きの問題')}>{error.problems.map((problem, index) => {
      const action = problemAction(problem);
      return <li key={`${problem.code}-${index}`}>
        <span>{problem.message}</span>
        {action !== undefined && <span className="run-failure-actions"><button type="button" className="secondary" onClick={action.onClick}>{action.label}</button></span>}
      </li>;
    })}</ul>}
    {children}
  </div>;
}

/** 理由の必須入力（取消・支払取消・対象外）。空のままでは送れない。 */
export function NoteForm({ label, submitLabel, busy, danger = false, maxLength = 500, onSubmit, onCancel }: {
  readonly label: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly danger?: boolean;
  readonly maxLength?: number;
  readonly onSubmit: (note: string) => void;
  readonly onCancel: () => void;
}) {
  const { text } = useI18n();
  const [note, setNote] = useState('');
  const empty = note.trim() === '';
  return <form className="expense-money-inline-form" aria-label={label} onSubmit={(event) => { event.preventDefault(); if (!empty) onSubmit(note.trim()); }}>
    <label className="expense-required">{label}
      <textarea aria-label={label} value={note} maxLength={maxLength} onChange={(event) => setNote(event.target.value)} />
    </label>
    {empty && <small className="expense-limit-hint">{text('A reason is required.', '理由の入力が必要です。')}</small>}
    <div className="expense-actions">
      <button type="submit" className={danger ? 'danger' : 'primary'} disabled={busy || empty}>{submitLabel}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{text('Cancel', 'キャンセル')}</button>
    </div>
  </form>;
}

/** 支払日と方法（支払済みにする・追加支給）。 */
export function PaymentForm({ submitLabel, busy, onSubmit, onCancel }: {
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (payment: { readonly paidOn: string; readonly method: 'transfer' | 'cash' }) => void;
  readonly onCancel: () => void;
}) {
  const { text } = useI18n();
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<'transfer' | 'cash'>('transfer');
  return <form className="expense-money-inline-form" aria-label={submitLabel} onSubmit={(event) => { event.preventDefault(); if (paidOn !== '') onSubmit({ paidOn, method }); }}>
    <div className="expense-form">
      <label>{text('Paid on', '支払日')}<input type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} /></label>
      <label>{text('Method', '方法')}
        <select value={method} onChange={(event) => setMethod(event.target.value as 'transfer' | 'cash')}>
          <option value="transfer">{text('Bank transfer', '振込')}</option>
          <option value="cash">{text('Cash', '現金')}</option>
        </select>
      </label>
    </div>
    <div className="expense-actions">
      <button type="submit" className="primary" disabled={busy || paidOn === ''}>{submitLabel}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{text('Cancel', 'キャンセル')}</button>
    </div>
  </form>;
}
