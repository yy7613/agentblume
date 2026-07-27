import { useCallback, useEffect, useState } from 'react';

/**
 * 依存を増やさない location.hash ベースの軽量ルーター。
 *
 * - 画面ID（App の Screen）をそのまま小文字にしたものを route slug とする（`#/agent`、`#/chat`）。
 * - hashchange / popstate に反応するので、ブラウザの戻る・進むとディープリンクが効く。
 * - 未知・空の hash は fallback 画面へ落とす（URLも正規化する）。
 */

/** 画面IDから route slug（`#/` の後ろ）を作る。 */
export function routeOf(screen: string): string {
  return screen.toLowerCase();
}

/** `#/agent?x=1` のような hash から slug 部分だけを取り出す。 */
export function slugFromHash(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = withoutHash.startsWith('/') ? withoutHash.slice(1) : withoutHash;
  return (path.split(/[?#]/)[0] ?? '').split('/')[0]?.toLowerCase() ?? '';
}

/** hash から画面を解決する。未知・空なら fallback。 */
export function screenFromHash<T extends string>(hash: string, screens: readonly T[], fallback: T): T {
  const slug = slugFromHash(hash);
  return screens.find((screen) => routeOf(screen) === slug) ?? fallback;
}

function currentHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

/**
 * hash と同期した画面state。返り値の navigate は履歴へ積む（戻るで前の画面へ戻れる）。
 * `screens` / `fallback` はモジュールスコープの定数を渡すこと（毎レンダー新しい配列を渡さない）。
 */
export function useHashScreen<T extends string>(screens: readonly T[], fallback: T): readonly [T, (next: T) => void] {
  const [screen, setScreen] = useState<T>(() => screenFromHash(currentHash(), screens, fallback));

  useEffect(() => {
    const sync = () => setScreen(screenFromHash(currentHash(), screens, fallback));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [screens, fallback]);

  // hashが空・不正なときはURLを表示中の画面へ揃える（履歴は積まない）。
  useEffect(() => {
    const target = `#/${routeOf(screen)}`;
    if (currentHash() !== target) window.history.replaceState(null, '', target);
  }, [screen]);

  const navigate = useCallback((next: T) => {
    setScreen(next);
    const target = `#/${routeOf(next)}`;
    if (currentHash() !== target) window.location.hash = target;
  }, []);

  return [screen, navigate];
}
