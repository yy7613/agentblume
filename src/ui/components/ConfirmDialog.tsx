import type { ReactNode } from 'react';

/**
 * 破壊的操作(削除・取消・承認/却下)の共通確認ダイアログ。
 * 文言は呼び出し側が text() で解決して渡す(このコンポーネントはi18n非依存)。
 */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onCancel }: {
  readonly open: boolean;
  readonly title: string;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  if (!open) return null;
  return <div className="confirm-backdrop" role="presentation" onClick={onCancel}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <h3>{title}</h3>
      <div className="confirm-message">{message}</div>
      <div className="confirm-actions">
        <button type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button type="button" className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </div>
  </div>;
}
