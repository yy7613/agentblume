/**
 * 画面ID（route slug のもと）。
 *
 * ルーティング（routing.ts）・ナビゲーション context（navigation.tsx）・アプリ内ヘルプ（help-content.ts）が
 * 同じ集合を参照できるよう、依存の少ないこのモジュールに置く（依存先は葉の `business/screen-ids.ts` だけ）。
 */
import { BUSINESS_SCREENS } from './business/screen-ids';

// Templates は業務テンプレートの入口（一覧）。Journal のような業務別の画面はここから入るが、
// 画面としては独立して登録したままにする（`#/journal` の直リンクと画面内からの遷移を保つため）。
// 業務の画面IDは `business/screen-ids.ts` が持つ（ADR-0039）。
export const SCREENS = ['Chat', 'Data', 'Tool', 'Skill', 'Agent', 'Harness', 'Factory', 'Templates', ...BUSINESS_SCREENS, 'Inspect', 'ToolCheck', 'Validation', 'Memory', 'MCP', 'Status', 'Settings'] as const;

export type ScreenName = (typeof SCREENS)[number];

/** hash が空・不正なときに開く画面。 */
export const DEFAULT_SCREEN: ScreenName = 'Chat';
