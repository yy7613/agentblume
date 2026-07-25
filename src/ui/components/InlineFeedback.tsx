import { useEffect, type ReactNode } from 'react';

/**
 * 操作の近傍に置く共通フィードバック表示。成功/情報は role="status"、エラーは role="alert"。
 * autoHideMs と onDismiss を渡すと自動で消える(成功トースト相当)。
 */
export function InlineFeedback({ kind, children, autoHideMs, onDismiss }: {
  readonly kind: 'success' | 'info' | 'error';
  readonly children: ReactNode;
  readonly autoHideMs?: number;
  readonly onDismiss?: () => void;
}) {
  useEffect(() => {
    if (autoHideMs === undefined || onDismiss === undefined) return;
    const timer = setTimeout(onDismiss, autoHideMs);
    return () => clearTimeout(timer);
  }, [autoHideMs, onDismiss]);
  return <p className={`inline-feedback ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</p>;
}
