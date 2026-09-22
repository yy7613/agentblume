# v48: モデルへ送る指示文（プロンプト）を外部ファイルで持つ

- 決定の記録: [ADR-0052](../docs/adr/0052-prompt-files.md)
- 先例: [ADR-0049](../docs/adr/0049-tool-templates.md)（ツールテンプレートを外部ファイルで持ち、壊れたファイルは理由つきで読み飛ばす）

## 1. 問題

モデルへ送る指示文（system の規則・差し戻しの文・タスクの目的）が TypeScript の文字列配列としてコードの中に散っている（Factory の 5 ロールと 7 タスク、関数電卓・分析設定・AI 判定・設計アシスタント、検証のアンケート、記憶の振り返り、仕訳・経費・契約の読み取り、LLM 判定 … 約 25 か所）。

- 文を直すたびにビルドが要る。運用者が自分のモデル（12B / 27B / クラウド）に合わせて言い回しを調整できない。
- どこにどんな指示があるかを一覧できない。同じ規則（「数値はツールの行から引き写す」など）が複数のロールに別々の言い回しで書かれる。
- 文の版（`*_PROMPT_TEMPLATE_VERSION`）が定数として別に置かれ、文を変えても版を上げ忘れる。

## 2. 決定

1. **指示文は `prompts/**/*.md` に置く。** 1 ファイル 1 プロンプト（id は相対パス。`tool/design-chat`、`factory/planner` など）。ファイルは frontmatter（`id` / `version` / `description`）と、`## <section>` で区切った**節**からなる。節の本文は `{{name}}` の差し込みだけを持つプレーンテキスト。
2. **組み立てはコードに残す。** どの節をどの順に使うか、条件で入れ替える規則、untrusted data の隔離（`wrapUntrusted`）、JSON schema は従来どおりコード。ファイルには**文だけ**を置く。テンプレート言語（条件・繰り返し）は持たない — 条件分岐が要るなら節を分けてコードで選ぶ。
3. **読み込みは起動時に全件、以後は更新時刻で再読込。** 再起動は要らない。コードが要求する id と節が無ければ**起動時に止まる**（どのファイルの何が無いか、どう直すか）。実行中の再読込で壊れたファイルは直前の良い版を使い続け、警告を残す。
4. **運用者は別フォルダで上書きできる。** `AGENTCONTEXT_PROMPTS_DIR`（`;` / `:` 区切り、後勝ち）。上書きはファイル単位。必要な節を欠く上書きは起動時に止める（黙って挙動が変わるより止まる方がよい）。
5. **版はファイルの frontmatter が正。** 実行記録に残す版（`calculate-expression/v2` のような文字列）は `template.version` から取る。定数は消す。
6. **移すのは「実装がモデルへ送る指示文」。** 人が編集して保存する成果物の雛形（エージェントの system プロンプト生成、Skill の文、ペルソナの基底文、回答の規律ブロック）は**移さない**（それらは利用者の資産で、保存後に画面で直せる）。

## 3. ファイル形式

```markdown
---
id: tool/calculate-expression
version: calculate-expression/v2
description: 関数電卓ノードの式を提案させる
---

## system
You write one expression for a calculator node.
Rules:
- Reference columns with square brackets: [売上] / [数量].
- Use only the columns listed in the user message.
{{extraRules}}

## repair
Your previous expression was rejected: {{reason}}
Return a corrected expression for the same intent.
```

- frontmatter は `---` で囲む YAML の**この 3 キーだけ**（YAML パーサは使わず、`key: value` を行で読む）。`id` はファイルの相対パス（拡張子なし、`/` 区切り）と一致しなければならない。`version` は `^[a-z0-9-]+/v[0-9]+$`。
- 節は `## ` で始まる行で始まり、名前は `^[a-z][a-z0-9.-]*$`。同じ名前の節が 2 つあれば形式違反。本文の前後の空行は落とす。節の中の `##` は使えない（`###` は本文）。
- 差し込みは `{{name}}`（`^[a-zA-Z][a-zA-Z0-9]*$`）。値は文字列・数値・文字列の配列（改行で連結）。**未定義の名前は描画時に例外**（`PromptRenderError`: プロンプト id・節・名前）。値の中の `{{` は差し込まれた後に再解釈しない。
- 節を持たないファイル、frontmatter の欠落・不一致は形式違反。
- `_` で始まるファイルと `README.md` は読まない。

## 4. コードの契約

```ts
// application/prompt/prompt-template.ts（純関数）
export interface PromptTemplate {
  readonly id: string;
  readonly version: string;
  readonly sections: ReadonlyMap<string, string>;
  /** 節を差し込みつきで描画する。無い節・無い名前は PromptRenderError。 */
  render(section: string, vars?: Readonly<Record<string, string | number | readonly string[]>>): string;
}
export function parsePromptFile(id: string, text: string): { ok: true; template: PromptTemplate } | { ok: false; problems: string[] };

// application/prompt/prompt-catalog-port.ts
export interface PromptSpec { readonly id: string; readonly sections: readonly string[] }
export interface PromptCatalogPort {
  /** 同期。起動時に全件読み込み済み。ファイルの更新時刻が変わっていれば読み直す（壊れていれば直前の版を返し警告）。 */
  get(id: string): PromptTemplate;
  /** 起動時の検査。無い id / 節を、ファイルの置き場所と直し方つきで一括で投げる。 */
  require(specs: readonly PromptSpec[]): void;
}

// adapters/prompts/fs-prompt-catalog.ts
new FsPromptCatalog({ directories?: string[]; env?; cwd?; logger? })  // 既定: <cwd>/prompts + AGENTCONTEXT_PROMPTS_DIR
```

- 各利用側は `export const XXX_PROMPT: PromptSpec = { id, sections }` を宣言し、コンストラクタで `PromptCatalogPort` を受ける。`root.ts` は全 spec を 1 つの配列に集めて `require` する（起動時 fail-fast）。
- テスト用: `src/test-support/prompts.ts` に `bundledPrompts()`（`<repo>/prompts` を読む `FsPromptCatalog`）。既存のテストは**実ファイル**で動く（文を直せばテストがそれを見る）。
- `prompts/README.md`: 書き方、置き場所、上書き、`{{}}` の一覧の探し方（各ファイル冒頭の `description` と、コード側の `PromptSpec`）。
- `prompts/` 全体の検査テスト（`src/application/prompt/bundled-prompts.test.ts`）: 全ファイルが読める・id が一致・宣言された全 spec の節がある・**宣言されていないファイル / 節が無い**（死んだ文を残さない）。

## 5. 移行の対象と分担

| 領域 | ファイル（`prompts/` 配下） | 元のコード |
|---|---|---|
| Factory ロール | `factory/planner` `factory/tool-smith` `factory/skill-writer` `factory/assembler` `factory/analyst` | `src/application/factory/roles/*-role.ts` |
| Factory タスク | `factory/tasks/common`（`role-task.ts` の共通規則・差し戻し文）`factory/tasks/decide-join` `decide-filters` `decide-computations` `decide-output` `select-template` `fill-slots` | `src/application/factory/tasks/*.ts` |
| ツール系 | `tool/calculate-expression` `tool/analysis-config` `tool/ai-judge` `tool/design-chat` `tool-check/suggest-cases` | `src/application/tool/*`, `tool-check/*` |
| 検証・記憶 | `validation/pseudo-user`（出力規律・アンケート指示・向きの 1 文）`memory/reflect-run` `evaluation/judge` | `run-scenario.ts` `reflect-run.ts` `adapters/evaluation/structured-judge-evaluator.ts` |
| 業務 | `journal/extract` `journal/hearing` `expense/detail-read` `expense/policy-hearing` `contract/extract` `contract/review` `contract/transcribe` | `src/application/{journal,expense,contract}/**`、`domain/expense/*` の版定数 |

移行の規則:
- 文は**一字一句そのまま**移す（言い回しの改善は別の増分。移行で挙動を変えない）。差し込み（`${MAX_TOOL_CALLS}` など）は `{{}}` にする。条件で入る行（`supportsMultiValueFilterOps() ? A : B`）は節を分ける。
- 既存テストの `toContain('…')` はそのまま通る（文は同じ）。版定数を見ていたテストは `catalog.get(id).version` に置き換える。
- domain に置かれた版定数（`domain/expense/*`）は消し、application が `template.version` を渡す。domain の純粋性は保つ。
- 各ファイルの `description` は日本語で「誰が・いつ・何のために」を 1〜2 行。

## 6. 検証

- `prompt-template.test.ts`: 形式（frontmatter・節・差し込み・違反）。
- `fs-prompt-catalog.test.ts`: 読み込み・上書きの後勝ち・更新時刻の再読込・壊れた再読込で直前の版・`require` の失敗文（ファイルと直し方）。
- `bundled-prompts.test.ts`: 同梱ファイルと全 spec の突き合わせ。
- 各移行: 移行前後で組み立てた system 文が**完全一致**するテスト（移行の agent は、移行前の文を fixture に固定してから移す）。
- 起動: `npm run serve` が `AGENTCONTEXT_PROMPTS_DIR` に節の欠けた上書きを置くと、どのファイルの何が無いかを出して止まる（親が確認）。

## 7. 非スコープ

- 文の改善・統一（移行は等価変換のみ）。
- プロンプトの画面編集。多言語のプロンプト（英語のまま）。
- 人が編集する成果物の雛形（エージェント / Skill / ペルソナ / 回答の規律ブロック）。
