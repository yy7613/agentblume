/**
 * 画面ID（route slug のもと）。
 *
 * ルーティング（routing.ts）・ナビゲーション context（navigation.tsx）・アプリ内ヘルプ（help-content.ts）が
 * 同じ集合を参照できるよう、依存を持たないこのモジュールに置く。
 */
export const SCREENS = ['Chat', 'Data', 'Tool', 'Skill', 'Agent', 'Harness', 'Factory', 'Inspect', 'Validation', 'Memory', 'MCP', 'Status', 'Settings'] as const;

export type ScreenName = (typeof SCREENS)[number];

/** hash が空・不正なときに開く画面。 */
export const DEFAULT_SCREEN: ScreenName = 'Chat';
