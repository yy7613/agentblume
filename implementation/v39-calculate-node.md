# v39 実装契約: 関数電卓ノード（`calculate`）

- 決定: [ADR-0045](../docs/adr/0045-calculator-node.md)
- 利用者向け説明: [docs/06-etl-tool-builder.md §3.14](../docs/06-etl-tool-builder.md)
- 担当の分け方: **domain（解釈器 + ノード + 登録）** と **UI（部品一覧 + 設定画面 + ピン留め）** を別担当が並行して実装する。両者はこの契約の名前と振る舞いだけを頼りにし、相手のファイルには触れない。

## 1. スコープ

- 入力 1 つの行それぞれについて、数式を 1 回評価し、結果を 1 列として足す（同名列は置き換え）。
- 数式は **数値・列参照・算術演算子・括弧・固定の関数・定数** のみ。比較・条件・文字列・代入・利用者定義関数は**受け付けない**（`ConfigError` / inferSchema error）。
- `eval` / `new Function` / 外部の式ライブラリは**使わない**。

## 2. ドメイン契約

### 2.1 `src/domain/etl/nodes/calculate-expression.ts`（解釈器）

```ts
export const MAX_EXPRESSION_LENGTH = 1000;   // 文字
export const MAX_EXPRESSION_DEPTH = 64;      // 括弧・関数呼び出しの入れ子
export const MAX_EXPRESSION_TOKENS = 500;

export type CalculateFunctionGroup = 'basic' | 'rounding' | 'exponential' | 'trigonometric';

export interface CalculateFunction {
  readonly name: string;                 // 小文字。式中では大文字小文字を区別しない
  readonly group: CalculateFunctionGroup;
  /** 引数の数。`{ min, max }`。可変長は max を undefined にする。 */
  readonly arity: { readonly min: number; readonly max: number | undefined };
}

/** 正典。UI は表示用の写しを持ち、テストでここと一致をピン留めする。順序も固定（UI の並び順に使う）。 */
export const CALCULATE_FUNCTIONS: readonly CalculateFunction[] = [
  // basic
  { name: 'abs',   group: 'basic', arity: { min: 1, max: 1 } },
  { name: 'sign',  group: 'basic', arity: { min: 1, max: 1 } },
  { name: 'sqrt',  group: 'basic', arity: { min: 1, max: 1 } },
  { name: 'cbrt',  group: 'basic', arity: { min: 1, max: 1 } },
  { name: 'pow',   group: 'basic', arity: { min: 2, max: 2 } },
  { name: 'mod',   group: 'basic', arity: { min: 2, max: 2 } },
  { name: 'min',   group: 'basic', arity: { min: 1, max: undefined } },
  { name: 'max',   group: 'basic', arity: { min: 1, max: undefined } },
  { name: 'hypot', group: 'basic', arity: { min: 2, max: 2 } },
  // rounding
  { name: 'round', group: 'rounding', arity: { min: 1, max: 2 } },   // round(x[, n]) 小数第 n 位、四捨五入（0 から遠ざかる）
  { name: 'floor', group: 'rounding', arity: { min: 1, max: 1 } },
  { name: 'ceil',  group: 'rounding', arity: { min: 1, max: 1 } },
  { name: 'trunc', group: 'rounding', arity: { min: 1, max: 1 } },
  // exponential
  { name: 'exp',   group: 'exponential', arity: { min: 1, max: 1 } },
  { name: 'ln',    group: 'exponential', arity: { min: 1, max: 1 } },
  { name: 'log10', group: 'exponential', arity: { min: 1, max: 1 } },
  { name: 'log2',  group: 'exponential', arity: { min: 1, max: 1 } },
  { name: 'log',   group: 'exponential', arity: { min: 2, max: 2 } },   // log(x, base)
  // trigonometric（ラジアン）
  { name: 'sin',   group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'cos',   group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'tan',   group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'asin',  group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'acos',  group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'atan',  group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'atan2', group: 'trigonometric', arity: { min: 2, max: 2 } },  // atan2(y, x)
  { name: 'sinh',  group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'cosh',  group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'tanh',  group: 'trigonometric', arity: { min: 1, max: 1 } },
  { name: 'deg',   group: 'trigonometric', arity: { min: 1, max: 1 } },  // ラジアン → 度
  { name: 'rad',   group: 'trigonometric', arity: { min: 1, max: 1 } },  // 度 → ラジアン
];

/** 定数。式中では小文字で書く（`pi`, `e`）。 */
export const CALCULATE_CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

export type ExpressionAst = /* 実装者が定義。外部へは opaque でよい */ unknown;

export type ParseExpressionResult =
  | { readonly ok: true; readonly ast: ExpressionAst; readonly references: readonly string[] }   // references: 参照した列名（重複なし、出現順）
  | { readonly ok: false; readonly message: string; readonly position: number };                 // position: 0 起点の文字位置

/**
 * 式を読む。`knownColumns` は裸の識別子を列として扱うかの判定にだけ使う（`[..]` は常に列）。
 * 文法エラー・未知の名前・引数の数の不一致・上限超過はすべて ok:false（投げない）。
 */
export function parseExpression(text: string, knownColumns: readonly string[]): ParseExpressionResult;

/**
 * 評価する。`lookup` は列名 → セル値。参照列が null なら結果は null。
 * 非数（数値でない文字列・boolean・Date）は null と同じ扱い（呼び出し側が型の寄せを済ませてから渡す）。
 * 結果が有限でなければ null。**投げない**。
 */
export function evaluateExpression(ast: ExpressionAst, lookup: (column: string) => number | null): number | null;
```

文法（EBNF 風）:

```
expression := term (('+' | '-') term)*
term       := factor (('*' | '/' | '%') factor)*
factor     := unary ('^' factor)?                 // ^ は右結合
unary      := ('+' | '-') unary | primary
primary    := number | column | constant | function '(' args ')' | '(' expression ')'
column     := '[' <']' 以外の 1 文字以上> ']' | identifier   // identifier は knownColumns にあり、関数・定数名でないとき
number     := 数字列 ('.' 数字列)? (('e'|'E') ('+'|'-')? 数字列)? | '.' 数字列
identifier := [A-Za-z_][A-Za-z0-9_]*
```

- 関数名・定数名は大文字小文字を区別しない。列名（`[..]` 内と裸）は区別する。
- `%` は剰余（`a - b * trunc(a / b)`。JavaScript の `%` と同じ符号規則）。
- 空白は無視する。全角の数字・演算子・括弧は NFKC で半角へ寄せてから読む（`１０÷２` も通す）。`×` `÷` は `*` `/` として読む。

### 2.2 `src/domain/etl/nodes/calculate.ts`（ノード）

```ts
export const CALCULATE_TYPE = 'calculate';

export interface CalculateConfig {
  readonly outputColumn: string;          // 1 文字以上
  readonly expression: string;            // 空文字は ConfigError ではなく inferSchema error（設定途中でプレビューが落ちないように）
  readonly onError?: 'null' | 'fail';     // 既定 'null'
  readonly precision?: number;            // 0..15 の整数。省略で丸めない
}

export const calculateNode: EtlNode<CalculateConfig>;   // type 'calculate' / kind 'transform' / inputArity 1
```

- `validateConfig`: zod。`outputColumn` は `min(1)`。`expression` は `string`（長さ上限は parse 側で issue にする）。未知キーは黙って落とす（他ノードと同じ）。object でないもの・型違いは `ConfigError`。
- `inferSchema(inputs, config)`:
  - 入力が 1 つでなければ `SchemaError`（他の arity 1 ノードと同じ）。
  - `expression` が空 → error issue「式を入力してください」、state `mismatch`、出力スキーマは入力そのまま + 出力列（nullable number）。
  - `parseExpression(expression, 入力列名)` が ok:false → error issue（`message` に position を含めた文。列名があれば `column` に入れなくてよい）。
  - 参照列が入力に無い → error issue（`column` にその列名）。
  - 参照列の型が `number` 以外 → warning issue（`string`/`unknown`/`null` は「数値へ寄せます」、`boolean`/`date` は「null になります」）。
  - 出力スキーマ: 入力列の並びを保ち、`outputColumn` と同名の列があれば**その位置で** `{ type: 'number', nullable: true }` に置き換え、無ければ末尾に追加。
  - error issue が 1 つでもあれば state `mismatch`、無ければ `confirmed`。
- `execute(inputs, config)`:
  - parse に失敗する式でここまで来た場合（保存済み Tool のスキーマ点検を通っていない経路）は `ConfigError`。
  - 各行: 参照列の値を数値へ寄せる（number はそのまま、数値文字列は `Number()`、その他は null）→ `evaluateExpression` → `precision` があれば四捨五入（0 から遠ざかる。`Math.round(Math.abs(x) * 10^n) / 10^n * sign`）→ 出力列へ。
  - 結果が null のとき `onError === 'fail'` なら `SchemaError`（「行 12: 式 `[金額] / [数量]` を評価できません（0 除算または欠損）」の形。行番号は 1 起点）。`'null'` なら null を入れて続ける。
  - 出力の `schema` は `inferSchema` と同じ規則で作る。

### 2.3 登録（`src/domain/etl/nodes/index.ts`）

- `castNode` の直後に `registry.register(calculateNode)`。
- re-export: `calculateNode`, `CALCULATE_TYPE`, `type CalculateConfig`, `CALCULATE_FUNCTIONS`, `CALCULATE_CONSTANTS`, `MAX_EXPRESSION_LENGTH`, `MAX_EXPRESSION_DEPTH`, `MAX_EXPRESSION_TOKENS`, `parseExpression`, `evaluateExpression`, `type CalculateFunction`, `type CalculateFunctionGroup`.

## 3. UI 契約

### 3.1 `src/ui/tool-builder/node-catalog.ts`

- `NODE_TYPES` に `'calculate'` を追加（`'cast'` の直後）。
- `NODE_CATALOG` に追加:
  `{ type: 'calculate', label: 'Calculator', labelJa: '関数電卓', kind: 'transform', inputArity: 1, description: 'Compute a new column from a formula over the input columns.', descriptionJa: '入力列を使った数式で新しい列を計算します。', defaultConfig: { outputColumn: 'result', expression: '', onError: 'null' } }`

### 3.2 表示用の写し（`src/ui/tool-builder/calculator-keys.ts` 新設）

UI は domain を import しない。次を持ち、テストで domain の正典とピン留めする。

```ts
export type CalculatorFunctionGroup = 'basic' | 'rounding' | 'exponential' | 'trigonometric';
export interface CalculatorFunctionKey { readonly name: string; readonly group: CalculatorFunctionGroup; readonly minArgs: number; readonly maxArgs: number | undefined; readonly hint: string; readonly hintJa: string }
export const CALCULATOR_FUNCTION_KEYS: readonly CalculatorFunctionKey[];   // 名前・群・引数数・並びが domain の CALCULATE_FUNCTIONS と一致
export const CALCULATOR_CONSTANT_KEYS: readonly { readonly name: string; readonly glyph: string }[];   // pi → 'π', e → 'e'
export const CALCULATOR_GROUP_LABELS: Readonly<Record<CalculatorFunctionGroup, { readonly en: string; readonly ja: string }>>;
/** 挿入用: 表示記号 → 式に書く記号（× → *, ÷ → /）。 */
export const CALCULATOR_OPERATOR_KEYS: readonly { readonly glyph: string; readonly insert: string }[];
/** 括弧の対応だけを見る簡易検査（打っている途中の手掛かり用。妥当性の正典は inferSchema）。 */
export function parenthesisBalance(expression: string): { readonly balanced: boolean; readonly open: number };
/** 表示用の式（`*` → `×`, `/` → `÷`）。保存する値は変えない。 */
export function displayExpression(expression: string): string;
/** カーソル位置へ挿入し、新しい式とカーソル位置を返す。 */
export function insertAt(expression: string, caret: number, text: string): { readonly expression: string; readonly caret: number };
```

### 3.3 `src/ui/tool-builder/NodeInspector.tsx`

- インライン（一覧側）: `type === 'calculate'` で `CalculateSummary`（`result = <displayExpression(式)>` の 1 行。式が空なら「式を入力してください」）。
- ダイアログ: `type === 'calculate'` で `CalculateFields({ config, setConfig, columns })`。中身:
  - 出力列名（`input`、aria-label `Output column`）。
  - 式の表示欄（`textarea` 1〜3 行、aria-label `Expression`。直接編集可。カーソル位置を保持し、キー押下はそこへ挿入）。
  - キーパッド（`role="group"`、aria-label `Keypad`）: `7 8 9 ÷` / `4 5 6 ×` / `1 2 3 −` / `0 . ( ) +` / `^ % π e` / `←`（backspace）`C`（clear）。ボタンのアクセシブル名は表示記号そのもの。
  - 関数群（`role="group"`、aria-label は群の表示名。4 群を横並びのタブか縦の見出しで）: 各関数はボタンで、押すと `name(` を挿入し、引数が複数なら `name(` のまま（区切りは利用者が打つ）。ボタンには hint を `title` に。
  - 列チップ（`role="group"`、aria-label `Columns`）: 入力列ごとにボタン。押すと `[列名]` を挿入。`number` 型を先に、他の型は末尾に `class="calc-column-dim"` で薄く出し、`title` に「実行時に数値へ寄せます / null になります」。列が無ければ「上流を接続すると列が出ます」。
  - 評価不能時（`select`、aria-label `On error`）: `null`（既定）/ `fail`。
  - 小数桁（`input type=number`、aria-label `Precision`、空で「丸めない」）。
  - 括弧の対応が取れていなければ `field-error` で「開き括弧が n 個多い / 閉じ括弧が多い」。妥当性の本体は inferSchema の issue 表示に任せる。
- `NodeConfigDialog` の分岐に `calculate` を足す。

### 3.4 `src/ui/styles.css`

`.calc-*` の接頭で、キーパッドは 4 列グリッド、関数ボタンは群ごとに折り返し、列チップは丸みのあるボタン。既存の `node-config-dialog` の幅に収める。

## 4. テスト観点（正常 / 異常 / 境界 / 例外を必ず含める）

### domain（`calculate-expression.test.ts`）

- 正常: 四則演算の優先順位、`^` の右結合、単項マイナス、括弧、関数の入れ子、`[列名]` と裸の列名、定数、大文字の関数名、全角の数字と `×` `÷`、`1e3` / `.5`。
- 異常: 未知の関数、未知の裸識別子（列に無い）、引数の数の不一致、閉じ括弧不足・過多、演算子の連続、空の式、`[` の閉じ忘れ。すべて ok:false で position を持つ。
- 境界: `MAX_EXPRESSION_LENGTH` ちょうどと +1、`MAX_EXPRESSION_DEPTH` ちょうどと +1、`MAX_EXPRESSION_TOKENS` +1、`round(x, 0)` と `round(x, 15)`、`min(1)`（可変長の最小）。
- 例外: 0 除算・`sqrt(-1)`・`ln(0)`・`0^-1` は null、参照列 null は null、`evaluateExpression` は投げない、`%` の負数の符号規則。

### domain（`calculate.test.ts`）

- メタデータ、`validateConfig`（正常 / 未知キーの黙殺 / 型違い / `precision` 範囲外）、`inferSchema`（出力列の追加と同名置換の位置、warning の型ごとの出方、参照列不在の error と state、空式の error、arity 違反の SchemaError）、`execute`（値、`precision` の丸め、`onError` の両方、数値文字列の寄せ、null 伝播、parse 不能式の ConfigError）。

### UI（`NodeInspector.calculate.test.tsx` 新設、`calculator-keys.test.ts` 新設）

- ピン留め: `CALCULATOR_FUNCTION_KEYS` の name / group / minArgs / maxArgs / 並びが domain の `CALCULATE_FUNCTIONS` と一致。定数も一致。
- 正常: キーパッドで `7 × [金額]` を組むと config の `expression` が `7 * [金額]` になる。列チップで `[列名]` が入る。関数ボタンで `sqrt(` が入る。出力列名・onError・precision の変更が config に入る。
- 境界: カーソルが途中のときその位置へ挿入される。`←` で 1 文字消える。`C` で空になる。列が無いときの案内。
- 異常: 括弧が合わないときの表示。
- 例外: `displayExpression` は保存値を変えない（往復で同じ）。`parenthesisBalance` は `[..]` 内の括弧を数えない。

### 部品一覧（`node-catalog.test.ts` 既存）

- 既存の「全 type が catalog から引けて表示文言を持つ」に自動で乗る。`calculate` の `defaultConfig` を 1 本固定する。

## 5. 非スコープ

- エージェント引数（`agent-input`）の値を式で参照する束縛。
- 比較・条件・文字列・日付演算。
- UI での式の即時評価（プレビューパネルが担う）。
- 集計（`group-by` が担う）。

## 6. 担当への注意（共通）

- **git 操作（stash / commit / checkout / reset / clean）は絶対にしない。**
- 自分の担当ファイル以外は編集しない。共有の `nodes/index.ts`（domain 担当）と `NodeInspector.tsx` / `node-catalog.ts` / `styles.css`（UI 担当）は担当が分かれている。
- vitest は `E:\vscode\AgentContext` から、自分のテストファイルだけを指定して回す。**全体スイートは回さない**（統合は依頼側が行う）。
- 型検査は `npm run typecheck` を回してよいが、相手の担当が未完成のあいだは相手側の型エラーが出うる。自分の担当ファイルに起因するエラーだけを直す。
- 日本語のコメントで「なぜ」を書く（何をしているかはコードで分かる）。
