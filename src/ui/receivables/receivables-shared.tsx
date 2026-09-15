import type { ReactNode } from 'react';
import type { InvoiceIssueDto, JournalFollowUpDto } from '../api/receivables-types';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { formatYen, invoiceIssueMessage, type IssueTarget } from './receivables-model';

/** 入金消込のステップ共通の小さな部品。 */

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** ApiError の本文の追加項目（violations / reason / missing）を読む。 */
export function detailsOf(cause: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof cause === 'object' && cause !== null && typeof Reflect.get(cause, 'details') === 'object' ? Reflect.get(cause, 'details') as Readonly<Record<string, unknown>> : undefined;
}

export function codeOf(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && typeof Reflect.get(cause, 'code') === 'string' ? Reflect.get(cause, 'code') as string : undefined;
}

/** 操作の失敗。見出し（ApiError が code から日本語化済み）→ 次の一手のボタン。 */
export function ErrorNotice({ error, children }: { readonly error: unknown; readonly children?: ReactNode }) {
  const { text } = useI18n();
  if (error === undefined) return null;
  const openInScreen = useOpenInScreen();
  const missing = codeOf(error) === 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING';
  return <div className="notice-card receivables-error" role="alert">
    <p>{messageOf(error)}</p>
    <div className="run-failure-actions">
      {children}
      {missing && <button type="button" className="secondary" onClick={() => openInScreen('Journal', { internalId: '', section: 'account' })}>{text('Open Journal › Chart', '仕訳 › 科目を開く')}</button>}
    </div>
  </div>;
}

/** 確定済みの仕訳を変えなかったときの案内（原因 → 次の一手 → 仕訳を開く）。 */
export function FollowUpNotice({ followUp }: { readonly followUp: JournalFollowUpDto | undefined }) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  if (followUp === undefined) return null;
  return <div className="notice-card receivables-follow-up" role="status">
    <strong>{text('The journal entry was not changed', '仕訳は変更していません')}</strong>
    <p>{followUp.action === 'reverse'
      ? text('The journal entry is already confirmed or exported, so it was kept. Create a reversing entry in the Journal.', '仕訳が確定・出力済みのため残しました。仕訳画面で取消の仕訳を作ってください。')
      : text('The journal entry is already confirmed or exported, so it was not overwritten. Review it in the Journal.', '仕訳は確定済みのため変更していません。仕訳画面で確認してください。')}</p>
    <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={() => openInScreen('Journal', { internalId: followUp.entryId, section: 'entry' })}>{text('Open the journal entry', '仕訳を開く')}</button>
    </div>
  </div>;
}

/** 違反・警告の一覧。行を押すと直す場所（フォームの欄・設定ダイアログ）へ連れて行く。 */
export function IssueList({ violations, warnings, onGo, onReplaceDeclared }: {
  readonly violations: readonly InvoiceIssueDto[]; readonly warnings: readonly InvoiceIssueDto[];
  readonly onGo: (target: IssueTarget) => void; readonly onReplaceDeclared?: () => void;
}) {
  const { text } = useI18n();
  if (violations.length === 0 && warnings.length === 0) return <p className="receivables-ok" role="status">{text('All invoice requirements are met.', '記載事項はそろっています。')}</p>;
  const item = (issue: InvoiceIssueDto, kind: 'violation' | 'warning', index: number) => {
    const message = invoiceIssueMessage(issue, text);
    return <li key={`${kind}-${issue.code}-${index}`} className={`receivables-issue receivables-issue-${kind}`}>
      <span className="receivables-issue-kind">{kind === 'violation' ? text('Must fix', '要修正') : text('Check', '確認')}</span>
      <span>{message.cause} {message.fix}</span>
      <span className="receivables-issue-actions">
        <button type="button" className="secondary" onClick={() => onGo(message.target)}>{message.target.kind === 'settings' ? text('Open Settings', '設定を開く') : text('Go to the field', '該当欄へ')}</button>
        {message.replaceDeclared === true && onReplaceDeclared !== undefined && <button type="button" className="secondary" onClick={onReplaceDeclared}>{text('Replace with the computed value', '計算値で置き換える')}</button>}
      </span>
    </li>;
  };
  return <ul className="receivables-issues" aria-label={text('Invoice check', '記載事項の検査')}>
    {violations.map((issue, index) => item(issue, 'violation', index))}
    {warnings.map((issue, index) => item(issue, 'warning', index))}
  </ul>;
}

export function Yen({ value }: { readonly value: number | undefined }) {
  return <span className="receivables-yen">{formatYen(value)}</span>;
}
