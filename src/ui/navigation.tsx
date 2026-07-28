import { createContext, useContext, type ReactNode } from 'react';
import type { ScreenName } from './screens';

/**
 * 画面遷移を子コンポーネントへ配る仕組み。
 *
 * ルーティング自体は App の `useHashScreen` が持つが、これまで遷移の手段が左ナビのクリックしか無く、
 * 「先にエージェント画面で保存してください」のような空状態の案内から**その画面へ行けなかった**。
 * ここで App の `requestScreen`（未保存の確認を挟む唯一の経路）を context として配ることで、
 * どの画面からでも同じ安全な経路で遷移できるようにする。
 *
 * Provider の外（単体テストで画面だけを描画したときなど）では遷移は no-op になる。
 */

export type NavigateScreen = (next: ScreenName) => void;

const NavigationContext = createContext<NavigateScreen>(() => { /* Provider の外では遷移しない。 */ });

export function NavigationProvider({ navigate, children }: { readonly navigate: NavigateScreen; readonly children: ReactNode }) {
  return <NavigationContext.Provider value={navigate}>{children}</NavigationContext.Provider>;
}

/** 画面から遷移を要求する。未保存の編集があれば App が確認ダイアログを挟む。 */
export function useNavigateScreen(): NavigateScreen {
  return useContext(NavigationContext);
}

/**
 * 空状態の案内から関連画面へ飛ぶボタン。
 *
 * `<a href="#/agent">` ではなく button にしているのは、hash を直接書き換えると
 * App の未保存確認（`requestScreen`）を飛び越えて編集中の画面がリセットされてしまうため。
 */
export function ScreenLink({ to, children, className = 'screen-link' }: {
  readonly to: ScreenName;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const navigate = useNavigateScreen();
  return <button type="button" className={className} onClick={() => navigate(to)}>{children}</button>;
}
