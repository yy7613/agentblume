import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
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

// ---------------------------------------------------------------------------
// 「その画面で特定の項目を開く」遷移
//
// エラーや診断結果から「このツールを開いて直す」へ一手で行けるようにする。画面遷移そのものは
// 上の NavigateScreen（未保存確認つき）に委ね、開く対象だけをここで受け渡す。
// 遷移先の画面は mount 時に `usePendingOpen` で対象を受け取り、既に表示中の画面は
// window イベントで受け取る（同じ画面内の別項目へ移る場合）。
// ---------------------------------------------------------------------------

/**
 * 開く対象。internalId は Tool / Agent / Skill 等の永続ID。
 * nodeId / section は「開いたうえで直す場所まで連れて行く」ための任意情報:
 * - nodeId: Tool Builder でそのノードを選択して設定パネルを開く（実行失敗・診断のノード特定から）
 * - section: 画面内の区画（例: Tool の 'agent-context' = エージェント向けコンテキスト、Agent の 'harness' / 'tools' / 'mcp'）
 */
export interface OpenTarget {
  readonly internalId: string;
  readonly version?: string;
  readonly nodeId?: string;
  readonly section?: string;
}

const OPEN_EVENT = 'agentblume:open-target';
const pendingOpen = new Map<ScreenName, OpenTarget>();

function notifyOpen(screen: ScreenName): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { screen } }));
}

/**
 * 遷移せずに「その画面で対象を開く」依頼だけを出す。画面が未表示なら mount 時に、表示中なら即座に届く。
 * React の外（テストの前準備・遷移を伴わない同一画面内の案内）から使う。通常の導線は useOpenInScreen。
 */
export function requestOpenInScreen(screen: ScreenName, target: OpenTarget): void {
  pendingOpen.set(screen, target);
  notifyOpen(screen);
}

/** 指定画面へ遷移し、その画面に対象を開くよう依頼する関数を返す。Provider の外では遷移だけが no-op。 */
export function useOpenInScreen(): (screen: ScreenName, target: OpenTarget) => void {
  const navigate = useNavigateScreen();
  return (screen, target) => {
    pendingOpen.set(screen, target);
    navigate(screen);
    notifyOpen(screen);
  };
}

/** テスト・画面側が明示的に取り出すための同期API。取り出すと消える（1回限り）。 */
export function consumePendingOpen(screen: ScreenName): OpenTarget | undefined {
  const target = pendingOpen.get(screen);
  pendingOpen.delete(screen);
  return target;
}

/**
 * 画面側フック: mount 時と、表示中に open 依頼が来たときに handler を呼ぶ。
 * handler は最新のクロージャを使えるよう ref 経由で参照する（依存配列に入れない）。
 */
export function usePendingOpen(screen: ScreenName, handler: (target: OpenTarget) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const deliver = () => {
      const target = consumePendingOpen(screen);
      if (target !== undefined) latest.current(target);
    };
    deliver();
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ screen?: ScreenName }>).detail;
      if (detail?.screen === screen) deliver();
    };
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
  }, [screen]);
}
