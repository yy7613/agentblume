/**
 * application層: プロンプトの置き場所を読む Port（v48 実装契約 §4 / ADR-0052）。
 *
 * ## なぜ同期なのか
 *
 * プロンプトの組み立ては多くの純関数の中で行われる。ここを非同期にすると、文をファイルへ移すだけで
 * 呼び出し経路がすべて `await` に変わってしまう。起動時に全件読み終えているので `get` は同期で足りる
 * （実行中の再読込も、更新時刻を見て必要なときだけ読み直す同期処理）。
 *
 * ## なぜ `require` が要るのか
 *
 * 節が 1 つ欠けた上書きファイルを置かれても、モデルは**それらしい応答を返してしまう**。
 * 黙って別の指示で動くより、起動時に「どのファイルの何が無いか・どう直すか」を出して止める方が安い。
 * 各利用側は `export const XXX_PROMPT: PromptSpec = { id, sections }` を宣言し、
 * `composition/root.ts` がそれを 1 つの配列に集めて `require` する。
 *
 * 実装は `src/adapters/prompts/fs-prompt-catalog.ts`。
 */
import type { PromptTemplate } from './prompt-template';

/**
 * コードが要求するプロンプト 1 件（id と、コードが実際に描画する節）。
 *
 * ここに書いた節だけが「生きている文」である。宣言されていない節がファイルに残っていれば、
 * それは誰も送らない死んだ文なので `bundled-prompts.test.ts` が落とす。
 */
export interface PromptSpec {
  /** ファイルの相対パス（拡張子なし・`/` 区切り）。例 `tool/design-chat`。 */
  readonly id: string;
  /** コードが `render()` する節の名前。 */
  readonly sections: readonly string[];
}

export interface PromptCatalogPort {
  /**
   * 読み込み済みのプロンプトを返す。ファイルの更新時刻・サイズが変わっていれば読み直す
   * （壊れていれば直前の良い版を返して警告を残す）。id が無ければ `PromptNotFoundError`。
   */
  get(id: string): PromptTemplate;
  /** 起動時の検査。無い id / 無い節を、ファイルの置き場所と直し方つきで**一括で**投げる。 */
  require(specs: readonly PromptSpec[]): void;
}

/**
 * `get` した id が無い（か、そのファイルが読めない）。
 *
 * 起動時の `require` を通っていれば起きない。起きるとすれば「spec を宣言し忘れたまま `get` した」か、
 * 「起動後にファイルを消した」のどちらかなので、どちらも直せるように置き場所と理由を持たせる。
 */
export class PromptNotFoundError extends Error {
  readonly promptId: string;
  /** ファイルは在るが読めない場合の理由と直し方（無ければ空）。 */
  readonly problems: readonly string[];

  constructor(promptId: string, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = 'PromptNotFoundError';
    this.promptId = promptId;
    this.problems = problems;
  }
}

/**
 * 起動時の検査に落ちた。`problems` は 1 件 1 行で、どのファイルに何が無いかと直し方を含む。
 *
 * **1 件目で止めずに全部集める**のは、欠けた節が 5 つあるときに 5 回起動し直させないため
 * （`EnvironmentValidationError` と同じ考え方）。
 */
export class MissingPromptsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`プロンプトファイルの検査に失敗しました（${problems.length}件）:\n  - ${problems.join('\n  - ')}`);
    this.name = 'MissingPromptsError';
    this.problems = problems;
  }
}
