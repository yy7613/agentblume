# v42 実装契約: 段階的ツール生成（小さな目的別タスク + 決定的コンパイラ）

- 関連: [ADR-0048](../docs/adr/0048-staged-tool-generation.md)（決定の理由）/ [ADR-0047](../docs/adr/0047-factory-lessons-from-estat.md)（実測）/ [docs/16](../docs/16-agent-factory.md) Stage 2 / [v41](./v41-calculate-expression-assistant.md)（式の提案）
- この文書は**契約の正本**。実装担当が複数いても、型名・フィールド名・タスク名・イベントの書式はここに合わせる。

## 0. なぜ変えるか（実測）

ToolSmith は 1 回のプロンプトで **グラフ全体の JSON**（ノード・エッジ・各 config・引数宣言・説明文）を書く。ローカル 12B では試行のたびに別の機械的な書き間違いが出た（`toInput` 欠落、`parse_period`、`sample` の位置、`dataSourceId: null`、日付引数の string 宣言、`keys` を文字列配列、agent-input 忘れ、`value` と `values` の重複）。正規化（`normalizeProposedGraph`）で吸収してきたが、これは**書かせる範囲が広すぎる**ことへの対症療法である。さらに計算列（`calculate`）は許可リストに無く、式は Factory から一切作れない（計算がエージェントの暗算になっている）。

人がサブエージェントへ仕事を出すときの原則を、Factory の内部にも適用する:

1. **1 タスク 1 目的**。入力は必要な分だけ、出力は小さな構造化 JSON。
2. **選択肢を閉じる**。列名・データソース・粒度・カテゴリ値は、プロファイルから作った `enum` の中から選ばせる。自由記述は「意図の文」と「名前」だけ。
3. **組み立ては決定的**。ノード・エッジ・ポート・束縛・引数宣言・説明文はコンパイラが作る。モデルはグラフの JSON を書かない。
4. **検証は決定的で、差し戻しは担当タスクへ**。失敗した検査から「どの決定が悪いか」を引き、そのタスクだけを理由つきで 1 回やり直す。
5. **専門の仕事は専門のプロンプトへ**。式は v41 の式提案（文法・関数表・検証・修復・標本試算つき）へ別タスクで投げる。
6. **記録**。各タスクの開始・結果・やり直し理由をイベントに残す。

## 1. 全体の流れ（Stage 2 の新規作成 Tool 1 本ぶん）

```
FactoryToolPlan + DataProfile[]
  └─ T1 decide-filters       （LLM・小）  何で絞るか / どの引数にするか
  └─ T2 decide-computations  （LLM・小）  計算列が要るか / 何を計算したいか（意図だけ）
  └─ T3 decide-output        （LLM・小）  返す列 / 並び / 件数
       ↓  ToolSpec（宣言的な仕様。グラフではない）
  compileToolSpec(spec, plan, profiles)   （決定的）→ ToolGraph + inputSchema + description
       ↓  calculate ノードは式が空のまま置かれる
  T4 write-expression × 計算列の数  （LLM・専用プロンプト = v41 の式提案を再利用）
       ↓
  既存の検査（構造・意味・引数なし溢れ・保存）  ※ normalizeProposedGraph は通さない（コンパイラ出力は正規形）
       ↓ 失敗したら
  違反 → 担当タスクへ差し戻し（1 タスク 1 回まで）→ 再コンパイル
       ↓ それでも駄目なら
  従来の一括 ToolSmith + 修復ループへフォールバック（理由をイベントに記録。§7）
```

結合（`additionalDataSourceIds` あり）のときだけ T0 `decide-join` を先頭に足す。

## 2. ToolSpec（宣言的な仕様）— `src/domain/factory/tool-spec.ts`

```ts
export const TOOL_SPEC_VERSION = 1;

export interface ToolSpec {
  readonly version: 1;
  /** 結合（plan.additionalDataSourceIds があるときだけ）。無ければ undefined。 */
  readonly join?: ToolSpecJoin;
  /** 期間の扱い（主ソースに期間ラベル列があるときだけ）。 */
  readonly period?: ToolSpecPeriod;
  /** カテゴリ列での絞り込み（0..3）。 */
  readonly categoryFilters: readonly ToolSpecCategoryFilter[];
  /** 計算列（0..3）。式は T4 が埋める。 */
  readonly computations: readonly ToolSpecComputation[];
  /** 返す列・並び・件数。 */
  readonly output: ToolSpecOutput;
}

export interface ToolSpecJoin {
  /** 全ソース共通の結合キー（profile.joinCandidates の keys から選ぶ。1..4）。 */
  readonly keys: readonly string[];
  readonly mode: 'inner' | 'left';
}

export interface ToolSpecPeriod {
  /** 期間ラベル列（profile.periodColumns[].column のどれか）。 */
  readonly column: string;
  /**
   * 粒度の決め方。'argument' は**必須**引数 `granularity`（string・nullable:false、eq 束縛）を宣言する
   * （省略できると月次と年次が混ざるため）。固定なら PeriodGranularity の値。
   */
  readonly granularity: PeriodGranularity | 'argument';
  /** granularity === 'argument' のときの設計時サンプル兼「迷ったらこれ」（データに存在する粒度から選ぶ）。 */
  readonly defaultGranularity?: PeriodGranularity;
  /** 期間の範囲引数（`period_from` / `period_to`、date・nullable）を宣言するか。 */
  readonly range: boolean;
}

export interface ToolSpecCategoryFilter {
  /** profile.categoricalColumns[].column のどれか。 */
  readonly column: string;
  /** 引数名（snake_case、`^[a-z][a-z0-9_]{0,39}$`）。 */
  readonly argument: string;
  /** true = `in`（カンマ区切りで複数）/ false = `eq`（1 値）。 */
  readonly multi: boolean;
}

export interface ToolSpecComputation {
  /** 足す列名（既存列と衝突しない）。 */
  readonly outputColumn: string;
  /** 何を計算したいか（自然文。式ではない）。T4 へそのまま渡す。 */
  readonly intent: string;
}

export interface ToolSpecOutput {
  /** 返す列（結合後・計算後の表の列名。空なら全列）。期間ラベル列と値の列はコンパイラが必ず残す。 */
  readonly columns: readonly string[];
  readonly sort: 'latest-first' | 'oldest-first' | 'none';
  /** 1..100。agent-output の maxRows と limit に使う。 */
  readonly limit: number;
}
```

`validateToolSpec(spec, context)`（同ファイル・純関数）: 列名・キー・粒度がプロファイルに実在するか、引数名の形と重複（予約名 `granularity` / `period_from` / `period_to` と衝突しない）、件数上限、`defaultGranularity` がデータに存在する粒度か、`computations[].outputColumn` の衝突。違反は `ToolSpecIssue { task: ToolSpecTaskName; message: string }[]` で返す（**どのタスクの決定が悪いか**を必ず付ける）。

```ts
export type ToolSpecTaskName = 'decide-join' | 'decide-filters' | 'decide-computations' | 'decide-output' | 'write-expression';
```

## 3. コンパイラ — `src/application/factory/compile-tool-spec.ts`（純関数・LLM なし）

```ts
export interface CompiledTool {
  readonly graph: ToolGraph;
  readonly inputSchema?: Schema;            // 引数が 1 つも無ければ undefined
  readonly agentTool: { readonly name: string; readonly description: string };
  /** 計算列ごとの calculate ノード id（T4 が式を入れる場所）。spec.computations と同じ順。 */
  readonly calculateNodeIds: readonly string[];
}
export function compileToolSpec(spec: ToolSpec, plan: FactoryToolPlan, profiles: readonly DataProfile[]): CompiledTool;
```

生成するグラフの正規形（ノード id は決定的: `src_1` `sel_1` `join_1` `period` `f_granularity` `f_category` `f_range` `calc_1` `sort` `limit` `select` `out` `args`）:

1. 各ソース `csv-source`/`json-source`（`profile.format`）。結合時は各枝で `select`（結合キー + そのソースの値列 + 主ソースだけ注記列）してから `join` を左から順に連ねる（`toInput` 0/1 明示、`rightSuffix` は `_2` `_3`、キーは省略記法を使わず `{left,right}`）。
2. `parse-period`（**結合の後に 1 回だけ**）→ 粒度 `filter`（`periodGranularity eq`）。固定粒度ならその値を書く。`granularity: 'argument'` のときは引数 `granularity` を **必須引数（string・`nullable: false`）** として宣言して eq に束縛し、設計時サンプルは `defaultGranularity` にする。省略できる引数にすると、省略時に条件が無効化されて月次と年次が混ざるため、必須にして混在を構造的に防ぐ（説明文に選べる値と「迷ったら既定」を書く）。
3. カテゴリ `filter`（`in` か `eq`、`valueBinding`、`caseInsensitive: true`、設計時サンプルはプロファイルの実在値の先頭 1〜2 件）。
4. 範囲 `filter`（`periodStart gte period_from` / `lte period_to`、date 型・nullable、設計時サンプルは `minStart`/`maxStart`）。
5. `calculate` × n（`expression: ''` で置く。T4 が埋める。`onError: 'null'`）。
6. `sort`（`latest-first` = `periodStart desc`、期間が無ければ sort なし）→ `limit` → `select`（期間ラベル列・値列・計算列・カテゴリ列・注記列を必ず含める）→ `agent-output`（`shape: rows`、`maxRows: limit`、`overflow: 'error'`）。
7. 未接続の `agent-input`（引数が 1 つ以上あるとき）。
8. `agentTool.description` は決定的に合成: 目的（plan.purpose）、各引数の意味と形式（カテゴリは実在値の例と「カンマ区切り」「省略で全件」、日付は ISO と「期間の開始日」、粒度は選べる値と既定）、データの範囲（`minStart`〜`maxStart`）、返す列。言語は `goal.language`。

コンパイラの出力は、既存の `describeGraphShapeViolations` / `describeToolSemanticViolations` を**必ず通る**こと（単体テストで固定。通らない組み合わせは `validateToolSpec` が先に弾く）。

## 4. タスクランナー — `src/application/factory/tasks/role-task.ts`

```ts
export interface RoleTask<Input, Output> {
  readonly name: ToolSpecTaskName;
  /** 1 文の目的（system プロンプトの先頭に入る）。 */
  readonly goal: string;
  /** 規則（短い箇条書き。5〜8 行まで）。 */
  readonly rules: readonly string[];
  /** 入力ごとに enum を埋めた厳格スキーマ。 */
  schema(input: Input): JsonSchemaObject;
  /** untrusted data として渡す最小の材料（プロファイル全体は渡さない）。 */
  payload(input: Input): unknown;
  /** 構造を検証して Output へ。違反は文言の配列で返す。 */
  parse(content: string | null, input: Input): { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: readonly string[] };
}
export interface RoleTaskResult<Output> { readonly value: Output; readonly attempts: number; readonly repaired: boolean }
export async function runRoleTask<I, O>(model: ModelProviderPort, task: RoleTask<I, O>, input: I, options?: { readonly feedback?: string; readonly signal?: AbortSignal; readonly onCall?: () => void }): Promise<RoleTaskResult<O>>;
```

- temperature 0、`responseFormat.strict: true`、材料は `wrapUntrusted`（既存ヘルパー）で user message 側へ。
- `parse` が落ちたら、前回の応答と違反文言を添えて **1 回だけ**やり直す。2 回目も落ちたら `FactoryValidationError`（タスク名つき）。
- `options.feedback`（差し戻し理由）があれば最初から payload に `revisionFeedback` として入れる。
- `onCall` はモデル呼び出しごとに 1 回呼ぶ（Run の `maxRoleCalls` 会計用）。

### タスク定義 — `src/application/factory/tasks/tool-design-tasks.ts`

| タスク | 入力（payload に入れるもの） | 出力 | enum で閉じるもの |
|---|---|---|---|
| `decide-join` | plan.purpose、このツールに関係する `joinCandidates`、各ソース名 | `{ keys, mode }` | keys ← 候補の keys、mode |
| `decide-filters` | plan.purpose / argumentSummary、goal、`periodColumns`（粒度別件数・範囲）、`categoricalColumns`（列名・件数・値の例 8 件）、`MAX_TOOL_CALLS` | `{ period?, categoryFilters }` | period.column、granularity（データにある粒度 + 'argument'）、defaultGranularity、categoryFilters[].column |
| `decide-computations` | plan.purpose、goal、数値列の一覧（名前・単位が分かる列名そのまま） | `{ computations }`（0 件可） | なし（outputColumn と intent は自由記述。0 件を明示的に許す） |
| `decide-output` | plan.purpose、結合・計算後の列一覧（コンパイラの途中結果から導く）、行数の目安 | `{ columns, sort, limit }` | columns ← 列一覧、sort |

規則の要点（各タスクの `rules` に入れる）:
- decide-filters: 粒度が混在（`mixed`）なら固定か引数のどちらかで必ず絞る。目標が月次と年次の両方に触れるなら `'argument'`。範囲・最新・推移に触れるなら `range: true`。比較・複数に触れるカテゴリは `multi: true`。絞り込みを増やしすぎない（最大 3）。
- decide-computations: **式は書かない**。差・比・率・一人当たり・前年比のような「表の列どうしの算術」だけ。条件分岐・文字列・集計・前の行との比較は表せないので出さない（v41 の限界）。不要なら空配列。
- decide-output: 期間ラベル・値・計算列は落とさない。`limit` は既定の呼び出しが溢れない値。

## 5. T4 式の作成 — 既存 `SuggestCalculateExpressionUseCase` を再利用

コンパイル済みグラフと `calculateNodeIds[i]`、`spec.computations[i].intent` を渡して `execute({ graph, nodeId, intent })` を呼ぶ（データソース解決済みのグラフを渡すこと。上流スキーマと標本行はユースケースが自分で得る）。返った `config.expression` を該当ノードへ入れる。辞退（空の式）・検証失敗は `ToolSpecIssue { task: 'write-expression' }` として扱い、**その計算列を落として**続行する（ツール全体は落とさない。`tool_generated` の message に `dropped computation: <列> (<理由>)` を残す）。`available()` が偽なら計算列は全て落とす。

計算列は**段階的経路だけの機能**とする。従来の一括 ToolSmith（フォールバック経路）では `calculate` を許可しない（式をグラフのプロンプトに混ぜないという目的に反するため）。

## 6. 差し戻しの対応表 — `src/application/factory/staged-tool-generation.ts`

```ts
export class StagedToolGeneration {
  constructor(model: ModelProviderPort, engine: EtlEngine, suggestExpression: SuggestCalculateExpressionUseCase | undefined, resolveDataSources: ResolveDataSourceGraphUseCase | undefined);
  async generate(input: { plan: FactoryToolPlan; profiles: readonly DataProfile[]; goal: FactoryGoalInput; scope: TenantScope; signal?: AbortSignal; onRoleCall: () => void; onEvent: (note: string) => void }): Promise<StagedToolResult>;
}
export type StagedToolResult =
  | { readonly ok: true; readonly compiled: CompiledTool; readonly spec: ToolSpec; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly spec?: ToolSpec };
```

検査の違反 → 担当タスク:

| 違反（既存検査の文言の種類） | 差し戻すタスク |
|---|---|
| 引数なし呼び出しが `maxRows` を超える | `decide-output`（limit）→ それでも超えるなら `decide-filters` |
| 期間ラベル列・値列が出力に無い | コンパイラのバグ（差し戻さず失敗。テストで防ぐ） |
| 結合で行が増える / キーが無い・型が違う | `decide-join` |
| `validateToolSpec` の issue | issue.task |
| 式の検証失敗・辞退 | `write-expression`（1 回）→ 駄目ならその計算列を落とす |

1 タスクにつき差し戻しは 1 回まで。全体で `maxRepairAttempts + 1` 回のコンパイルを超えたら `ok: false`。

## 7. 組み込み — `generate-agent-assets.ts`

新規作成の Tool 計画ごとに、まず `StagedToolGeneration.generate` を試す。`ok: true` なら以降（保存・イベント・`toolKeyToToolName`）は従来どおり。`ok: false` または例外（中断を除く）なら、理由を `tool_repair_attempted` の message（`staged generation failed: <reason>; falling back to one-shot ToolSmith`）に残して**従来の一括 ToolSmith + 修復ループ**へ進む。`FactoryOptions.toolGeneration?: 'staged' | 'one-shot'`（既定 `'staged'`。API スキーマ・DTO・UI の詳細設定にも通す）で切り替えられる。

イベント（新しい `FactoryEventKind` は足さない。既存 kind の message で表す）:
- `tool_generated` の message: `<key> (staged: decide-filters, decide-computations, decide-output, write-expression×1; repaired: decide-output)`。

## 8. テスト観点（担当ごと）

- tool-spec: 検証の全分岐（task 名つき issue）、予約引数名、件数上限、存在しない粒度。
- compile: e-Stat 風の実 CSV（単一 / 多地域 / 3 ソース結合）で、コンパイル結果が**実エンジンで動き**、既存の構造検査・意味検査・引数なし溢れガードを通る。`granularity: 'argument'` で月次と年次を引き分けられる。説明文に範囲・例・既定が入る。決定性（同じ入力 → 同じグラフ）。
- role-task: スキーマが strict、enum が入力から作られる、材料が untrusted 側、やり直しに前回応答と違反文言、2 回目失敗で task 名つきエラー、`onCall` の回数、feedback の受け渡し。
- tasks: 各タスクの payload が最小（プロファイル全体を渡していない）、enum、0 件の計算列、規則文。
- staged: 正常（式 1 本つき）、式の辞退で計算列だけ落とす、式提案が使えない、溢れ → decide-output へ差し戻し → 通る、差し戻し上限、結合、中断の伝播。
- 組み込み: staged 成功で ToolSmith を呼ばない、失敗でフォールバックし理由が残る、`toolGeneration: 'one-shot'` で従来どおり、役割呼び出しの会計。

## 9. 非スコープ

- Analyst の `add-tool` 提案経路の段階化（従来の一括 ToolSmith のまま）。
- 集計ノード（`summary-statistics` / `group-by`）を ToolSpec で表すこと。
- フォールバック経路での `calculate`。
- Planner / SkillWriter / Assembler の段階化（タスクランナーは再利用できる形にするが、移行は別増分）。

## 10. 実装時の確定事項（2026-09-20・実装後に追記）

契約に対して**変えた点・契約が決めていなかった点**を、実装した側から確定させる。各ブロックの担当が報告した分も併記する。

### 10.1 ToolSpec / 検証（`tool-spec.ts`）

- **左の枝は列を削らない**。契約 §3-1 は「結合時は各枝で `select`（結合キー + そのソースの値列 + 主ソースだけ注記列）」と書いていたが、左（主ソース）の枝は右から来る列としか衝突しないため削る理由が無い。左を削ると、結合キーにしなかった地域名のような「答えに要る列」が黙って消える。**絞るのは右の枝だけ**にした（`primaryBranchColumnsOf` は全列を返す）。
- **`multi: false` は `in` があるビルドでは弾く**。`describeToolSemanticViolations` は「カテゴリ列を `eq` で絞るTool」を必ず差し戻す（1回の呼び出しで1値しか頼めないと比較の質問がツール呼び出し上限で落ちるため）。コンパイラの出力は既存の検査を必ず通らなければならないので、`validateToolSpec` が先に `decide-filters` の issue として弾く。
- **期間列・カテゴリ列は主ソースのものだけ**。`parse-period` は結合の後に1回だけ主ソースの列へ掛けるので、追加ソース固有の列を選ばせるとコンパイル前の検証で必ず差し戻しになる。タスクの `enum` も主ソースの列だけで作る。

### 10.2 コンパイラ（`compile-tool-spec.ts`）

- **期間があるなら必ず並べ替える**。`sort: 'none'` でも `parse-period` があるときは `periodStart desc` へ倒す。意味検査が「parse-period があるのに periodStart で並べない」Toolを差し戻すうえ、`limit` で残る行が file 順になって「最新」が取れないため。
- **`granularity: 'argument'` は必須引数**（`nullable: false`）。省略できる引数にすると、省略時に条件が無効化されて月次と年次が混ざる。したがって、そのToolに「引数なしの呼び出し」は存在しない。
- **溢れガードは「必須引数だけを設計時サンプルで埋めた呼び出し」で見る**（`describeDefaultCallOverflow` に `requiredArguments` を足した）。引数なしで呼ぶと実行前に `required argument missing` で落ちるだけで、溢れるかどうかを確かめられない。

### 10.3 オーケストレーション（`staged-tool-generation.ts`）

- **`write-expression` の外側でのやり直しはしない**。式提案ユースケースは内部で既に「検証 → 診断つきで1回だけ差し戻し」を持っており、同じプロンプトで外からもう一度頼むのは往復を増やすだけである。辞退・検証失敗・モデル失敗はいずれも**その計算列を落として**続行し、`dropped computation: <列> (<理由>)` を残す（契約 §6 の「`write-expression`（1回）→ 駄目ならその計算列を落とす」のうち、外側の1回を省いた）。
- **式のモデル呼び出し回数は実測で数える**。成功時は `proposal.repaired` が真なら2回・偽なら1回、失敗時は文言に「after one repair」が含まれれば2回・そうでなければ1回として `onRoleCall` を呼ぶ。
- **式を頼むグラフは「対象より後ろの計算列を落とした複製」**。ユースケースは提案を当てたグラフでスキーマ伝播まで確かめるので、式が空の `calculate` が後ろに残っていると必ず落ちる。前の計算列は既に式が入っているのでそのまま残す（上流として正しい）。
- **モデルが計算列の名前を変えてきた提案は落ちる**。ユースケースは自分が読んだ `outputColumn` で伝播を確かめるため、こちらが決めた列名と違う名前を返されると検証に落ち、その計算列は落ちる（式そのものは採る余地があるが、静かに名前を読み替えるより落とす方を選んだ）。
- **`maxRepairAttempts` を依頼に足した**。契約 §6 の signature には無いが、一括経路と同じ `budget.maxRepairAttempts` を効かせるために `StagedToolGenerationRequest` で受ける（省略時2）。
- **予算を使い切っているなら差し戻さない**。最後のコンパイルで検査に落ちたときは、担当タスクへ頼み直してもコンパイルできないので、モデルを呼ばずに `ok: false` を返す。
- **呼び出し規約は別 file（`staged-tool-port.ts`）**。実装は一括経路と同じ決定的検査（`generate-agent-assets.ts`）を再利用し、`generate-agent-assets.ts` は段階的経路を呼ぶ側なので、型だけの葉を挟んで依存を一方向に保つ（`depcruise` の循環禁止）。
- **やり直しの後は `output.columns` を機械的に間引く**。`decide-join` / `decide-filters` / `decide-computations` をやり直すと列一覧が変わるため、消えた列を `decide-output` の選択から落とす（存在しない列を残すと必ず検証違反になり、差し戻し回数を無駄に使う）。

### 10.4 組み込み（`generate-agent-assets.ts`）

- **段階的経路の出力は正規化に掛けない**。`makeArgumentsOptional` を通すと必須の `granularity` が省略可能になり、粒度の混在を防ぐ構造が壊れる。コンパイラの出力は正規形なので `normalizeProposedGraph` も通さない。
- **計算列があるAgentには規律を1文足す**（`hasComputedColumns`）。「差・比・率が列として入っているときは、その列の値をそのまま引き写す。自分で計算しない」。保存したToolに `calculate` があるときだけ書く。
- **一括経路の台本を持つ既存テストは `toolGeneration: 'one-shot'` を明示**した（FIFOの台本は Planner → ToolSmith → SkillWriter → Assembler の順序を前提にしているため）。

