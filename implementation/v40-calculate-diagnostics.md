# v40 実装契約: 関数電卓の式の診断（エラー種別・判定・結果の取得）

- 前提: [v39 実装契約](./v39-calculate-node.md) / [ADR-0045](../docs/adr/0045-calculator-node.md)
- 目的: **式の設定を LLM に任せる機能（次の増分）の土台**。提案が正しいか判定し、誤りを直せる形で差し戻し、何を出すか確かめる、の 3 つを機械可読にする。
- 非目的: LLM 呼び出しそのもの、プロンプト、UI の変更。この契約は **domain 層だけ**で完結する。

## 1. なぜ要るか（設計の前提）

いまの式の失敗は「日本語の文言 + 位置」しか返らない。人には読めるが、次の 3 つができない。

1. **差し戻しの自動化**: LLM に直させるには「何が起きたか」を文言ではなく種別で渡す必要がある。文言は改訂で変わるが種別は変わらない。
2. **提案の判定**: 式がスキーマに対して妥当か（列があるか・型が合うか）を 1 か所で判定する入口が無く、`inferSchema` の中に埋まっている。
3. **結果の確認**: 提案が実際に何を出すかを、ノードを実行せずに確かめる手段が無い。

あわせて、打ち間違いに **近い候補を返す**（`sqr` → `sqrt`、`[kingaku]` → `[金額]`）ことで、人にも LLM にも直し方が伝わる。

## 2. 失敗の種別（`calculate-expression.ts` を拡張）

### 2.1 種別コード

```ts
export const EXPRESSION_ERROR_CODES = [
  'empty',                  // 式が空・空白だけ
  'too-long',               // MAX_EXPRESSION_LENGTH 超過
  'too-many-tokens',        // MAX_EXPRESSION_TOKENS 超過
  'too-deep',               // MAX_EXPRESSION_DEPTH 超過
  'illegal-character',      // 式では使えない文字
  'invalid-number',         // 小数点のあとに数字がない
  'unclosed-bracket',       // [ を閉じていない
  'unexpected-bracket',     // 対応する [ がない ]
  'empty-column-name',      // []
  'unknown-function',       // 知らない関数
  'function-needs-parens',  // 関数名を括弧なしで書いた
  'unknown-name',           // 知らない裸の識別子
  'wrong-argument-count',   // 引数の数が合わない
  'missing-argument',       // , のあとに引数がない
  'misplaced-comma',        // , をここで使えない
  'unclosed-paren',         // 閉じ括弧がない
  'unexpected-paren',       // 対応する ( がない )
  'missing-operand',        // 演算子の右に値がない
  'unexpected-end',         // 式が途中で終わっている
  'trailing-input',         // 余分な入力
  'unreadable',             // 上のどれでもない（保険）
] as const;
export type ExpressionErrorCode = (typeof EXPRESSION_ERROR_CODES)[number];
```

### 2.2 失敗の戻り値を広げる（既存の形は壊さない）

```ts
export type ParseExpressionResult =
  | { readonly ok: true; readonly ast: ExpressionAst; readonly references: readonly string[] }
  | {
      readonly ok: false;
      readonly code: ExpressionErrorCode;
      readonly message: string;      // 既存のまま（人が読む文言）
      readonly position: number;     // 既存のまま（0 起点）
      /** 近い候補。`unknown-function` / `unknown-name` のときだけ入ることがある。 */
      readonly suggestion?: string;
    };
```

**既存の `message` / `position` は一字も変えない**（現在のテストが通り続けること）。§2.1 のコードを、いまの 23 か所の失敗すべてに割り当てる。対応は文言から明らか。`message: '式を読めません'` の 2 か所は `unreadable`。

### 2.3 打ち間違いの候補

```ts
/** 打ち間違いの近さ（Damerau-Levenshtein 距離）。同じなら 0。 */
export function nameDistance(left: string, right: string): number;

/**
 * 候補のうち最も近いものを 1 つ返す。遠すぎるものは返さない（見当違いの候補は害）。
 * しきい値: 入力が 4 文字以下なら距離 1 まで、5 文字以上なら距離 2 まで。
 * 同じ距離が複数あれば `candidates` の順で先のものを返す（決定的であること）。
 * 比較は大文字小文字を区別しない。
 */
export function suggestName(input: string, candidates: readonly string[]): string | undefined;
```

`parseExpression` は次のときに `suggestion` を入れる。

| 種別 | 候補 |
|---|---|
| `unknown-function` | 関数名 30 個 |
| `unknown-name` | `knownColumns` + 関数名 + 定数名（この順で連結。列を優先する） |

**編集距離で届く範囲（実装後の実測）**: 漢字 1 文字の打ち間違い（`金学` → `金額`、`数料` → `数量`、`単科` → `単価`）と、英字の打ち間違い（`amont` → `amount`、`lgo10` → `log10`、`sqr` → `sqrt`）は候補が出る。**届かないのは表記体系をまたぐ対**（`kingaku` と `金額` は距離 7）で、これは編集距離では原理的に扱えない。上の例示を `[kingaku]` → `[金額]` と書いたのは誤りだった。読み仮名での照合が要るなら別の手段（辞書・LLM 側での候補提示）になる。

## 3. 判定（新設 `src/domain/etl/nodes/calculate-diagnostics.ts`）

```ts
export const EXPRESSION_DIAGNOSTIC_CODES = [
  ...EXPRESSION_ERROR_CODES,
  'unknown-column',     // [..] で書いたが入力に無い（構文は正しい）
  'type-coerced',       // number 以外だが数値へ寄せられる（string / unknown / null）
  'type-not-numeric',   // 数値にできない型（boolean / date）
] as const;
export type ExpressionDiagnosticCode = (typeof EXPRESSION_DIAGNOSTIC_CODES)[number];

export interface ExpressionDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: ExpressionDiagnosticCode;
  readonly message: string;
  /** 式の中の位置（0 起点）。列の問題など位置を特定できないものには入らない。 */
  readonly position?: number;
  readonly column?: string;
  readonly suggestion?: string;
}

export interface ExpressionValidation {
  /** error が 1 つも無い。warning はあってもよい。 */
  readonly ok: boolean;
  readonly diagnostics: readonly ExpressionDiagnostic[];
  /** 参照した列（重複なし・出現順）。読めなかったときは空。 */
  readonly references: readonly string[];
  /** 入力に無い参照列（重複なし・出現順）。 */
  readonly unknownColumns: readonly string[];
}

/** 式をスキーマに対して判定する。実行はしない。**投げない**。 */
export function validateExpression(expression: string, schema: Schema): ExpressionValidation;
```

規則:

- 空の式 → `error` / `empty` / 「式を入力してください」。
- 読めない式 → `error` + `parseExpression` の code / message / position / suggestion をそのまま写す。以降の列の検査はしない。
- 読めた式:
  - 参照列が入力に無い → `error` / `unknown-column` / 「式が参照する列がありません: {列}」 / `column` に列名 / 近い候補があれば `suggestion`（候補は入力の列名）。
  - `string` / `unknown` / `null` 型 → `warning` / `type-coerced`。
  - `boolean` / `date` 型 → `warning` / `type-not-numeric`。
  - `number` 型 → 何も出さない。
- 同じ列を 2 回参照していても診断は 1 回だけ（`references` が重複を除いているので自然にそうなる）。

**`calculate.ts` の `inferSchema` はこの関数に委ねる**（判定の規則を 2 か所に置かない）。`ExpressionDiagnostic` → `SchemaIssue` は severity / message / column を写すだけ。**いまの文言と state は変えない**（既存テストが通り続けること）。

## 4. 結果の取得（同じファイル）

```ts
export interface ExpressionPreviewRow {
  readonly index: number;                        // 0 起点
  readonly value: number | null;
  /** value が null のときだけ。 */
  readonly reason?: CalculateFailureReason;
}

export interface ExpressionPreview {
  /** 式が読めてスキーマに対して妥当（= validation.ok）。false なら rows は空。 */
  readonly ok: boolean;
  readonly validation: ExpressionValidation;
  readonly rows: readonly ExpressionPreviewRow[];
  readonly evaluated: number;                    // 値が出た行数
  readonly failed: number;                       // null になった行数
  /** 理由ごとの件数。0 件の理由はキーごと入れない。 */
  readonly failureCounts: Readonly<Partial<Record<CalculateFailureReason, number>>>;
  /** 最初に失敗した行。差し戻しと画面の案内に使う。失敗が無ければ入らない。 */
  readonly firstFailure?: ExpressionPreviewRow;
}

export interface ExpressionPreviewOptions {
  /** 見る行数の上限。既定 100、上限 1000。超える入力は先頭から切る。 */
  readonly limit?: number;
  /** ノードと同じ丸め。0..15 の整数。 */
  readonly precision?: number;
}

/**
 * 式を実際の行へ当てて結果を返す。**保存も変更もしない**。**投げない**。
 * 値の計算はノードと同じ規則（数値への寄せ・丸め・非有限は null）。
 */
export function previewExpression(
  expression: string,
  schema: Schema,
  rows: readonly Row[],
  options?: ExpressionPreviewOptions,
): ExpressionPreview;
```

規則:

- `validateExpression` が `ok: false` なら、行は評価せず `rows: []` / `evaluated: 0` / `failed: 0` / `failureCounts: {}` を返す（読めない式で全行 null の表を作らない）。
- セルを数値へ寄せる規則はノードと**同一**にする（number はそのまま、数値文字列は通す、それ以外は null）。ノード側と規則が分かれないよう、寄せる関数は `calculate-diagnostics.ts` に置いて `calculate.ts` がそれを使う形にしてよい（どちらに置くかは実装者の判断。**2 つ書かないこと**）。
- `precision` が範囲外なら丸めは行わず、その行は `null` / `reason: 'invalid-argument'`。
- `limit` が 0 以下・整数でない場合は既定（100）として扱う。

## 5. 再公開（`src/domain/etl/nodes/index.ts`）

次を re-export する。**他の行は変えない。**

- `EXPRESSION_ERROR_CODES`, `type ExpressionErrorCode`, `nameDistance`, `suggestName`（`calculate-expression` から）
- `validateExpression`, `previewExpression`, `EXPRESSION_DIAGNOSTIC_CODES`, `type ExpressionDiagnosticCode`, `type ExpressionDiagnostic`, `type ExpressionValidation`, `type ExpressionPreview`, `type ExpressionPreviewRow`, `type ExpressionPreviewOptions`（`calculate-diagnostics` から）

## 6. テスト観点（正常 / 異常 / 境界 / 例外を必ず含める）

### `calculate-expression.test.ts`（既存に追記）

- 正常: `EXPRESSION_ERROR_CODES` は重複なし。
- 異常: §2.1 の**全 21 種別**が、それぞれ少なくとも 1 つの式で出ること（種別ごとに式を 1 本ずつ書く。網羅の表になる）。
- 正常: `unknown-function` に候補が付く（`sqr` → `sqrt`、`lgo10` → `log10`）。
- 正常: `unknown-name` の候補は列を優先する（列 `金額` と関数 `min` があるとき `kingaku` の候補は列側）。
- 境界: しきい値。4 文字以下は距離 1 まで（`abs` に対する `ab` は候補、`xyz` は候補なし）。5 文字以上は距離 2 まで。
- 異常: 遠すぎる打ち間違いには候補を付けない（見当違いの候補を出さない）。
- 例外: `suggestName` は候補が空でも投げず undefined。同じ距離が複数あるとき返り値が決定的。
- 例外: 既存の `message` / `position` が変わっていないこと（今回の追加で文言を壊していない）。

### `calculate-diagnostics.test.ts`（新設）

**validateExpression**

- 正常: 妥当な式は `ok: true` / 診断 0 件 / `references` が出現順。
- 正常: `number` 以外の型は warning で、`ok` は true のまま（実行できるため）。
- 異常: 空の式・読めない式は error で、`position` と `code` が入る。読めない式では列の検査をしない。
- 異常: 入力に無い列は `unknown-column` の error で、`column` と近い候補が入る。
- 境界: 同じ列を 2 回参照しても診断は 1 件。
- 境界: 列が 0 個のスキーマ。
- 例外: 投げない（壊れたスキーマ・異常な入力でも）。

**previewExpression**

- 正常: 値が行ごとに出て、`evaluated` / `failed` が合う。
- 正常: `precision` がノードと同じ丸めになる。
- 異常: 読めない式では行を評価せず、`ok: false` で `rows` が空。
- 異常: 0 除算・欠損・定義域の外が `reason` ごとに数えられ、`firstFailure` が最初の失敗を指す。
- 境界: `limit` の既定・上限・0 以下・整数でない値。行が 0 件。
- 例外: 投げない。入力の行を書き換えない（元の配列・オブジェクトが不変）。

### `calculate.test.ts`（既存に追記）

- 例外: `inferSchema` の issue が `validateExpression` と一致する（判定の規則が 2 か所に分かれていない）。

## 7. 担当への注意

- **git 操作（stash / commit / checkout / reset / clean）は絶対にしない。**
- 触ってよいのは `calculate-expression.ts` / `calculate-expression.test.ts` / `calculate-diagnostics.ts`（新設）/ `calculate-diagnostics.test.ts`（新設）/ `calculate.ts` / `calculate.test.ts` / `index.ts`（re-export 追加のみ）。**UI（`src/ui/**`）には触れない。**
- **全体スイートは回さない**（`npm test` / `npm run test:cov` 禁止）。自分のテストファイルだけを `npx vitest run <file>` で回す。
- 既存テスト（`calculate-expression.patterns.test.ts` / `.typos.test.ts` / `.engineering.test.ts` / `src/application/etl/calculate.e2e.test.ts`）は**壊さない**。それらも回して緑を保つこと。
- 日本語のコメントで「なぜ」を書く。何をしているかはコードで分かるので書かない。
