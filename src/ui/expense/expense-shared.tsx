import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ApiTransport } from '../api/business-api';
import type { ExpenseApi } from '../api/expense-api';
import type {
  ExpenseCapabilitiesDto, ExpenseCheckReasonDto, ExpenseClaimDto, ExpenseClaimStatusDto, ExpenseReceiptFactsDto, ExpenseVerdictDto,
} from '../api/expense-types';
import type { TenantScopeDto } from '../api/types';
import { useI18n } from '../i18n';
import { useOpenInScreen, type OpenTarget } from '../navigation';
import { scope } from '../scope';
import {
  claimStatusLabel, fixTargetLabel, openTargetForFix, readinessLabel, searchKeysOf, summarizeCheck, verdictLabel,
  type ExpenseFocus, type ExpenseReadinessRow, type ExpenseTab,
} from './expense-model';

/** 経費タブ共通の小さな部品。文言は日英ペア、規程の値（上限・費目名）はすべて受け取ったデータから出す。 */

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 系統のスロット（`expense-slots.tsx`）へ渡す API の送信口・スコープ・読取の可否。
 * タブの props に足さず文脈で配るのは、タブ単体のテストと既存の props の形を変えずにスロットを差し込むため。
 * `ExpensePage` の外（タブ単体のテスト）では送信口が「使えない」を返すので、系統の部品は失敗の表示に倒れる。
 */
export interface ExpenseSlotEnvironment {
  readonly transport: ApiTransport;
  readonly scope: TenantScopeDto;
  readonly capabilities: ExpenseCapabilitiesDto | undefined;
}

const DETACHED_TRANSPORT: ApiTransport = {
  request: () => Promise.reject(new Error('This expense component is shown outside the expense screen, so it has no API connection.')),
};

const ExpenseSlotContext = createContext<ExpenseSlotEnvironment>({ transport: DETACHED_TRANSPORT, scope, capabilities: undefined });

export const ExpenseSlotProvider = ExpenseSlotContext.Provider;

export function useExpenseSlotEnvironment(): ExpenseSlotEnvironment {
  return useContext(ExpenseSlotContext);
}

/**
 * 規程タブ先頭の「実用機能の準備」（§20.10.1）。未設定は失敗ではなく「使うときに設定」なので、赤くせず（role も alert にしない）、
 * すべて未設定なら MVP の機能がそのまま使えることを先に言う。
 */
export function PracticalReadinessCard({ rows, onOpen }: { readonly rows: readonly ExpenseReadinessRow[]; readonly onOpen: (target: ExpenseReadinessRow['target']) => void }) {
  const { text } = useI18n();
  const noneConfigured = rows.every((row) => !row.configured);
  return <section className="workspace-card expense-readiness" aria-labelledby="expense-readiness-heading">
    <h2 id="expense-readiness-heading">{text('Practical features', '実用機能の準備')}</h2>
    <p className="empty-state">{noneConfigured
      ? text('You can claim, check, approve, and export CSV without setting these up.', '設定しなくても申請・チェック・承認・CSV 出力は使えます。')
      : text('Set up the rest when you need them.', '残りは使うときに設定してください。')}</p>
    <ul className="expense-readiness-list">{rows.map((row) => {
      const label = readinessLabel(row.key, text);
      return <li key={row.key} className={`expense-readiness-row ${row.configured ? 'expense-readiness-set' : 'expense-readiness-unset'}`}>
        <span className="expense-readiness-mark" aria-hidden="true">{row.configured ? '✓' : '–'}</span>
        <span className="expense-readiness-body">
          <strong>{label.title}</strong> <span className="expense-readiness-state">{row.configured ? text('Set up', '設定済み') : text('Not set up', '未設定')}</span>
          <small>{label.unlocks}</small>
        </span>
        <button type="button" className="secondary" aria-label={text(`Open ${label.title}`, `${label.title}を開く`)} onClick={() => onOpen(row.target)}>{text('Open', '開く')}</button>
      </li>;
    })}</ul>
  </section>;
}

/** タブへ渡す「この対象を開く」依頼。seq を変えて同じ対象の再依頼も届くようにする。 */
export type ExpenseFocusRequest = ExpenseFocus & { readonly seq: number };

export interface ExpenseNavigation {
  /** 経費画面の中の対象を開く（理由カードの導線・承認できない理由の導線）。 */
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab: (tab: ExpenseTab) => void;
}

export function FieldError({ message }: { readonly message: string | undefined }) {
  return message === undefined ? null : <small className="field-error" role="alert">{message}</small>;
}

export function VerdictChip({ verdict, stale = false }: { readonly verdict: ExpenseVerdictDto | undefined; readonly stale?: boolean }) {
  const { text } = useI18n();
  return <span className={`judge-chip expense-verdict expense-verdict-${verdict ?? 'none'}${stale ? ' expense-stale' : ''}`}>
    {verdictLabel(verdict, text)}{stale ? text(' (outdated)', '（古い）') : ''}
  </span>;
}

export function StatusChip({ status }: { readonly status: ExpenseClaimStatusDto }) {
  const { text } = useI18n();
  return <span className={`judge-chip expense-status expense-status-${status}`}>{claimStatusLabel(status, text)}</span>;
}

/** 原因 → 次の一手 → 導線ボタン。重さで色を分ける（差し戻しだけ赤系、要確認は黄系）。 */
export function ReasonCard({ title, cause, fix, severity, actions, children }: {
  readonly title: string; readonly cause: string; readonly fix: string; readonly severity: 'review' | 'return' | 'info';
  readonly actions: readonly { readonly label: string; readonly onClick: () => void }[]; readonly children?: ReactNode;
}) {
  const { text } = useI18n();
  return <article className={`expense-reason expense-reason-${severity}`} aria-label={title}>
    <p className="expense-reason-title"><strong>{title}</strong></p>
    <p><strong>{text('Cause', '原因')}:</strong> {cause}</p>
    <p><strong>{text('Next step', '次の一手')}:</strong> {fix}</p>
    {actions.length > 0 && <div className="run-failure-actions">
      {actions.map((action) => <button key={action.label} type="button" className="secondary" onClick={action.onClick}>{action.label}</button>)}
    </div>}
    {children}
  </article>;
}

/** 判定の理由 1 件のカード（§4 の文言と導線）。 */
export function CheckReasonCard({ reason, claim, onOpen, children }: {
  readonly reason: ExpenseCheckReasonDto; readonly claim: Pick<ExpenseClaimDto, 'id' | 'items'>; readonly onOpen: (target: OpenTarget) => void; readonly children?: ReactNode;
}) {
  const { text } = useI18n();
  const summary = summarizeCheck(reason, text);
  const item = claim.items.find((candidate) => candidate.id === reason.itemId);
  const severityText = reason.severity === 'return' ? text('Return', '差し戻し') : text('Needs review', '要確認');
  return <ReasonCard title={`${severityText}: ${summary.title}`} cause={summary.cause} fix={summary.fix} severity={reason.severity}
    actions={summary.fixTargets
      // 領収書の無い明細に「領収書を見る」を出しても開けないので出さない。
      .filter((target) => target !== 'receipt' || item?.hasReceipt === true)
      .map((target) => ({
        label: fixTargetLabel(target, reason.code, text),
        onClick: () => onOpen(openTargetForFix(target, {
          claimId: claim.id, code: reason.code, params: reason.params,
          ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }),
          ...(item?.categoryId === undefined ? {} : { categoryId: item.categoryId }),
        })),
      }))}>{children}</ReasonCard>;
}

/** 電帳法の検索要件 3 点の表示（MVP は揃っているかの確認だけ）。 */
export function SearchKeys({ facts }: { readonly facts: ExpenseReceiptFactsDto }) {
  const { text } = useI18n();
  const keys = searchKeysOf(facts);
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  return <span className="expense-search-keys" aria-label={text('E-bookkeeping search keys', '電帳法の検索要件')}>
    <span className={keys.date ? 'ok' : 'missing'}>{text('Date', '日付')} {mark(keys.date)}</span>
    <span className={keys.amount ? 'ok' : 'missing'}>{text('Amount', '金額')} {mark(keys.amount)}</span>
    <span className={keys.payee ? 'ok' : 'missing'}>{text('Payee', '取引先')} {mark(keys.payee)}</span>
  </span>;
}

/**
 * 読み取りを試したら 409（JOURNAL_EXTRACTION_UNAVAILABLE）で断られたときの案内。
 * 原因（サーバーの文言）→ 次の一手 → 設定画面の main モデルスロット。
 */
export function ExtractionUnavailableNotice({ message }: { readonly message: string }) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  return <div className="notice-card expense-capability" role="alert">
    <strong>{text('AI reading is not available', 'AI 読み取りが使えません')}</strong>
    <p>{message}</p>
    <p>{text('Next step: choose a vision-capable main model in Settings, then read the receipt again. You can also enter the item by hand.', '次の一手: 設定画面で vision 対応の main モデルを選んでから、もう一度読み取ってください。手入力で明細を足すこともできます。')}</p>
    <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Set the main model in Settings', '設定で main モデルを設定')}</button>
    </div>
  </div>;
}

/** 起動時の可否で読取が使えないと分かっているときの案内。使えるなら何も描かない。 */
export function ExtractionCapabilityNotice({ capabilities }: { readonly capabilities: ExpenseCapabilitiesDto | undefined }) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  if (capabilities?.extraction.enabled === true && capabilities.extraction.vision) return null;
  const cause = capabilities === undefined
    ? text('The server has not reported whether AI reading is available yet.', 'サーバーから AI 読み取りの可否がまだ取得できていません。')
    : capabilities.extraction.enabled
      ? text('The configured main model does not accept images, so receipts cannot be read from images or PDFs.', '設定中の main モデルは画像を受け付けないため、画像 / PDF から領収書を読み取れません。')
      : text('AI reading is not enabled on this server. It needs a main model with structured output and vision.', 'このサーバーでは AI 読み取りが有効になっていません。構造化出力と vision に対応した main モデルが必要です。');
  return <div className="notice-card expense-capability" role="note">
    <strong>{text('AI reading is not available yet', 'AI 読み取りはまだ使えません')}</strong>
    <p>{cause}</p>
    <p>{text('Next step: choose a vision-capable main model in Settings, then reopen this screen. Manual entry and CSV import work without a model.', '次の一手: 設定画面で vision 対応の main モデルを選び、この画面を開き直してください。手入力と CSV 取込はモデルなしで使えます。')}</p>
    <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Set the main model in Settings', '設定で main モデルを設定')}</button>
    </div>
  </div>;
}

/** 領収書ビューア。画像本体は申請の応答に含まれないので、開いたときに読みに行く。 */
export function ReceiptViewer({ api, claimId, itemId, onClose }: { readonly api: ExpenseApi; readonly claimId: string; readonly itemId: string; readonly onClose: () => void }) {
  const { text } = useI18n();
  const [receipt, setReceipt] = useState<{ readonly dataUrl: string; readonly fileName?: string; readonly text?: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setReceipt(undefined);
    setError(undefined);
    api.getReceipt(scope, claimId, itemId)
      .then((next) => { if (active) setReceipt(next); })
      .catch((cause: unknown) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; };
  }, [api, claimId, itemId]);
  return <section className="workspace-card expense-receipt" aria-label={text('Receipt', '領収書')}>
    <div className="expense-row-between">
      <h3>{text('Receipt', '領収書')}{receipt?.fileName === undefined ? '' : ` · ${receipt.fileName}`}</h3>
      <button type="button" className="secondary" onClick={onClose}>{text('Close', '閉じる')}</button>
    </div>
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
    {receipt === undefined && error === undefined && <p className="empty-state" role="status">{text('Loading the receipt…', '領収書を読み込み中…')}</p>}
    {receipt !== undefined && receipt.dataUrl !== '' && <img className="expense-receipt-image" src={receipt.dataUrl} alt={receipt.fileName ?? text('Receipt image', '領収書の画像')} />}
    {receipt?.text !== undefined && receipt.text !== '' && <details><summary>{text('PDF text layer', 'PDF のテキスト層')}</summary><pre className="expense-pre">{receipt.text}</pre></details>}
  </section>;
}

/** 空状態の案内 + 前のステップへのボタン。 */
export function EmptyStep({ message, actionLabel, onAction }: { readonly message: string; readonly actionLabel: string; readonly onAction: () => void }) {
  return <div className="expense-empty">
    <p className="empty-state">{message}</p>
    <button type="button" className="secondary" onClick={onAction}>{actionLabel}</button>
  </div>;
}

/** 文字列をクリップボードへ。使えない環境（http・古いブラウザ）では false を返し、画面は手でコピーする案内を出す。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
