/**
 * application層: ツールテンプレートのカタログ Port（v43 実装契約 §1）。
 *
 * テンプレートは**外部ファイル**なので、読めるもの（`templates`）と読めなかったもの
 * （`invalid`）を必ず一緒に返す。壊れたファイルを黙って落とすと「足したのに出てこない」に
 * なり、利用者は何が悪いか分からない。`invalid` はそのまま Tool Builder の一覧の下と
 * `GET /tool-templates` に出す（理由と直し方つき）。
 */
import type { ToolTemplate } from '../../domain/tool-template/template';

/** 読み込めなかったファイル 1 件。 */
export interface InvalidToolTemplate {
  /** 置き場所からの相対ファイル名（人がその file を開けるだけの情報）。 */
  readonly file: string;
  /** 読めた範囲で分かった id（形式の検査に落ちていれば undefined）。 */
  readonly id?: string;
  /** 問題ごとに「何が悪いか」と「どう直すか」を 1 文で書いたもの。 */
  readonly problems: readonly string[];
}

export interface ToolTemplateCatalog {
  readonly templates: readonly ToolTemplate[];
  readonly invalid: readonly InvalidToolTemplate[];
}

/** テンプレートの置き場所を読む Port。実装は `src/adapters/templates/fs-tool-template-catalog.ts`。 */
export interface ToolTemplateCatalogPort {
  list(): Promise<ToolTemplateCatalog>;
}

/** 置き場所が 1 つも無い（機能が無効な）ときの空カタログ。 */
export const EMPTY_TOOL_TEMPLATE_CATALOG: ToolTemplateCatalog = { templates: [], invalid: [] };
