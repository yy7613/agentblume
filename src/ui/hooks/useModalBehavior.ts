import { useEffect, useRef } from 'react';

/**
 * モーダル（role="dialog" / "alertdialog"）のキーボード操作を1か所へ集約する共通フック。
 *
 * 提供する挙動:
 * - Escape で閉じる（onClose）。
 * - Tab / Shift+Tab をダイアログ内に閉じ込める（フォーカストラップ）。
 * - 開いたとき最初のフォーカス可能要素へフォーカスする。
 * - 閉じたとき、開く前にフォーカスしていた要素へ戻す。
 *
 * 返り値の ref をダイアログ本体（role を持つ要素）へ付ける。フォーカス可能要素が無い場合に備えて
 * ダイアログ本体には tabIndex={-1} を付けること。
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * ダイアログ内のフォーカス可能要素をDOM順で返す。
 * jsdom はレイアウトを持たず offsetParent が常に null になるため、可視性ではなく
 * hidden / aria-hidden / inert だけで除外する。
 */
export function focusableElements(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true' && !element.hasAttribute('inert'));
}

/** Tab 押下時に次にフォーカスすべき要素。トラップの端に居ない場合は undefined（ブラウザ既定に任せる）。 */
export function nextTrapTarget(items: readonly HTMLElement[], active: Element | null, shiftKey: boolean): HTMLElement | undefined {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const inside = active !== null && items.includes(active as HTMLElement);
  if (shiftKey) return !inside || active === first ? last : undefined;
  return !inside || active === last ? first : undefined;
}

export function useModalBehavior<T extends HTMLElement>(options: {
  /** 省略時は「常に開いている」（マウント＝表示のダイアログ向け）。 */
  readonly open?: boolean;
  readonly onClose: () => void;
}) {
  const { open = true, onClose } = options;
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreTo = useRef<Element | null>(null);

  // 初期フォーカスと、閉じたときの呼び出し元への復帰。
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    const container = ref.current;
    if (container !== null) (focusableElements(container)[0] ?? container).focus();
    return () => {
      const target = restoreTo.current;
      restoreTo.current = null;
      if (target instanceof HTMLElement && document.contains(target)) target.focus();
    };
  }, [open]);

  // Escape と Tab。capture で拾い、背後の画面のキー操作へ漏らさない。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = ref.current;
      if (container === null) return;
      const items = focusableElements(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const target = nextTrapTarget(items, document.activeElement, event.shiftKey);
      if (target === undefined) return;
      event.preventDefault();
      target.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  return ref;
}
