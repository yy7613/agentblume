# v1 実装契約: ETL Tool Engine（純ドメイン + アプリ層）

> 本書は最初の実装インクリメント（[ADR-0003](../docs/adr/0003-first-increment-etl-tool-engine.md)）の**単一の真実**。
> サブエージェントはここに定義した型・シグネチャ・振る舞い・テスト要件のとおり実装する。
> 参照: [06-etl-tool-builder.md](../docs/06-etl-tool-builder.md) / [03-domain-model.md](../docs/03-domain-model.md) / [07-execution-model.md](../docs/07-execution-model.md)

## 0. 規約

- TypeScript strict / ESM。相対importは拡張子なし（`moduleResolution: Bundler`）。
- 例外は `src/domain/etl/errors.ts` の型を投げる。`throw new Error()` の直接使用は禁止。
- `readonly` を積極的に付与し、入力を破壊的変更しない（純関数的に新しい `Table`/`Row` を返す）。
- テストは実装と同居（`foo.ts` ↔ `foo.test.ts`）。Vitest。
- 各公開関数・分岐に単体テストを付ける（正常系 + 異常系 + 境界）。目標: 行カバレッジ90%以上。
- `config` 検証は Zod を用い、失敗時は `ConfigError` を投げる。

## 1. ディレクトリ

```
src/
  domain/
    data/
      types.ts          types.test.ts(不要, 型のみ)
      schema.ts         schema.test.ts
    etl/
      errors.ts         errors.test.ts
      node.ts           （EtlNode契約・型のみ）
      state.ts          state.test.ts   （SchemaState 合成）
      topo.ts           topo.test.ts
      registry.ts       registry.test.ts
      nodes/
        json-source.ts  json-source.test.ts
        csv-source.ts   csv-source.test.ts
        select.ts       select.test.ts
        filter.ts       filter.test.ts
        rename.ts       rename.test.ts
        cast.ts         cast.test.ts
        index.ts        （createDefaultRegistry）
  application/
    etl/
      graph.ts          （型のみ）
      engine.ts         engine.test.ts
      journey.e2e.test.ts
  demo.ts               （npm run demo）
```

---

## 2. ドメイン: データ型 — `src/domain/data/types.ts`

```typescript
export type DataType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'unknown';

export interface Column {
  readonly name: string;
  readonly type: DataType;
  readonly nullable: boolean;
}

export interface Schema {
  readonly columns: readonly Column[];
}

export type Cell = string | number | boolean | Date | null;
export type Row = Readonly<Record<string, Cell>>;

export interface Table {
  readonly schema: Schema;
  readonly rows: readonly Row[];
}

/** 確定 / 部分確定 / 推論 / 不明 / 実行結果と不一致（docs/03 §4） */
export type SchemaState = 'confirmed' | 'partial' | 'inferred' | 'unknown' | 'mismatch';
```

---

## 3. ドメイン: スキーマ推論 — `src/domain/data/schema.ts`

```typescript
export function inferCellType(value: Cell): DataType;
export function findColumn(schema: Schema, name: string): Column | undefined;
export function hasColumn(schema: Schema, name: string): boolean;
export function columnNames(schema: Schema): string[];
export function unifyTypes(a: DataType, b: DataType): DataType;
export function inferColumn(name: string, values: readonly Cell[]): Column;
export function inferSchemaFromRows(rows: readonly Row[]): Schema;
```

**振る舞い**
- `inferCellType`: `null`→`'null'`; `number`(有限)→`'number'`; `boolean`→`'boolean'`; `Date`(有効)→`'date'`; `string`→`'string'`; それ以外→`'unknown'`。`NaN`/`Infinity`/`Invalid Date` は `'unknown'`。
- `unifyTypes`: 同型→その型; 片方 `'unknown'`→`'unknown'`; それ以外の異種→`'unknown'`。（`'null'` は列推論側で扱うため、ここでは通常型として比較）
- `inferColumn`: `nullable` = 値に `null` が1つでもあれば `true`（空配列も `true`）。`type` = 非null値の型を `unifyTypes` で畳み込み。非null値が無い場合は `'unknown'`。
- `inferSchemaFromRows`: 全行のキー和集合を**初出順**で列に。各列は全行の該当値（欠損キーは `null` 扱い）で `inferColumn`。空 `rows`→`{ columns: [] }`。

**テスト要件（例）**: 数値のみ列→`number`/`nullable:false`; null混在→`nullable:true`; 型混在→`unknown`; キー欠損行→`nullable:true`; 空配列→空スキーマ。

---

## 4. ドメイン: エラー — `src/domain/etl/errors.ts`

```typescript
export class EtlError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export class ConfigError extends EtlError {}   // code 'ETL_CONFIG'
export class SchemaError extends EtlError {}   // code 'ETL_SCHEMA'
export class GraphError extends EtlError {}    // code 'ETL_GRAPH'
```

`instanceof EtlError` が各サブクラスで真になること、`name` が各クラス名になることをテストする。

---

## 5. ドメイン: ノード契約 — `src/domain/etl/node.ts`（型のみ）

```typescript
export type NodeKind = 'source' | 'transform' | 'analyze' | 'sink';

export interface SchemaIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly column?: string;
}

export interface SchemaInference {
  readonly schema: Schema;
  readonly state: SchemaState;   // ノード“局所”の状態（上流状態はEngineが合成）
  readonly issues: readonly SchemaIssue[];
}

export interface EtlNode<Config = unknown> {
  readonly type: string;                 // 一意キー 例 'json-source'
  readonly kind: NodeKind;
  readonly inputArity: 0 | 1 | 2;        // 期待する入力数（v1: source=0, transform=1）
  validateConfig(config: unknown): Config;  // Zodで検証。失敗は ConfigError
  inferSchema(inputs: readonly Schema[], config: Config): SchemaInference;
  execute(inputs: readonly Table[], config: Config): Table;
}
```

**局所 state の意味**
- `confirmed`: 入力から出力スキーマを厳密に確定でき、issueなし。
- `inferred`: サンプル等からの推論で確定度が下がる（例: source）。
- `partial`: 一部列のみ確定。
- `mismatch`: エラーissueあり（例: 存在しない列参照、型不一致）。
- `unknown`: 入力不足等で判断不能。

---

## 6. ドメイン: 状態合成 — `src/domain/etl/state.ts`

```typescript
export function stateRank(s: SchemaState): number;      // confirmed<inferred<partial<unknown<mismatch
export function combineStates(states: readonly SchemaState[]): SchemaState; // 最悪(最大rank)を返す。空→'confirmed'
```

rank: `confirmed=0, inferred=1, partial=2, unknown=3, mismatch=4`。Engineが「上流finalstate群 + 当ノード局所state」を `combineStates` で畳む。

---

## 7. ドメイン: トポロジカルソート — `src/domain/etl/topo.ts`

```typescript
export interface DirectedEdge { readonly from: string; readonly to: string; }
export function topologicalSort(nodeIds: readonly string[], edges: readonly DirectedEdge[]): string[];
```

- Kahn法。安定な順序（`nodeIds` の入力順を尊重）で返す。
- 未知ノードidを参照するedge→`GraphError('ETL_GRAPH', ...)`。
- 閉路検出→`GraphError`。
- テスト: 直線/分岐/合流/孤立ノード/閉路/未知id。

---

## 8. ドメイン: レジストリ — `src/domain/etl/registry.ts`

```typescript
export class NodeRegistry {
  register(node: EtlNode): void;   // 重複typeは GraphError
  get(type: string): EtlNode;      // 未知は GraphError
  has(type: string): boolean;
  types(): string[];
}
```

テストはダミーの `EtlNode`（`type:'dummy'` 等）で行う。`createDefaultRegistry` は §9 の `nodes/index.ts` に置く（依存の向き: registry ← nodes）。

---

## 9. ドメイン: v1ノード5(+1)種 — `src/domain/etl/nodes/*.ts`

各ノードは `EtlNode<Config>` を実装した**オブジェクトまたはクラスインスタンス**を default/ named export する。`validateConfig` は Zod スキーマの `.parse()` を用い、失敗時 `ConfigError`（Zodのメッセージを含める）。

### 9.1 `json-source`（kind: source, arity: 0）
```typescript
interface JsonSourceConfig { rows: Row[]; schema?: Schema; }
```
- `inferSchema`: `schema` 指定あり→`{schema, state:'confirmed', issues:[]}`; 無し→`inferSchemaFromRows(rows)` で `{schema, state:'inferred', issues:[]}`。
- `execute`: `{ schema: (指定 or 推論), rows }`。

### 9.2 `csv-source`（kind: source, arity: 0）
```typescript
interface CsvSourceConfig { text: string; delimiter?: string; header?: boolean; inferTypes?: boolean; }
// 既定: delimiter=',', header=true, inferTypes=true
```
- CSVパース（RFC4180サブセット）: ダブルクオート囲みフィールド、`""` によるクオートエスケープ、クオート内区切り文字を尊重。**クオート内改行はv1範囲外**（テストで対象外と明記）。
- `header:true`→1行目を列名。`false`→`col1,col2,...`。
- `inferTypes:true`→各セル文字列を `number`/`boolean`(`true`/`false`)/`date`(ISO 8601らしき文字列) に緩く変換、無理なら文字列のまま。空文字→`null`。`inferTypes:false`→全て文字列（空→`null`）。
- `inferSchema`/`execute`: パース結果から `inferSchemaFromRows`、`state:'inferred'`。
- テスト: 通常/クオート内カンマ/`""`エスケープ/ヘッダなし/型推論on-off/空セル→null。

### 9.3 `select`（kind: transform, arity: 1）
```typescript
interface SelectConfig { columns: string[]; }
```
- `inferSchema`: 各要求列が入力に存在するか検査。欠損→`error` issue（`column`付き）、`state:'mismatch'`、schemaは存在する列のみ。全存在→要求順の列で `state:'confirmed'`。
- `execute`: 各行を要求列だけに射影（欠損列があれば `SchemaError`）。

### 9.4 `filter`（kind: transform, arity: 1）
```typescript
type FilterOp = 'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'contains'|'isNull'|'notNull';
interface FilterConfig { column: string; op: FilterOp; value?: Cell; }
```
- `inferSchema`: `column` 存在必須（欠損→error/mismatch）。`gt|gte|lt|lte` は列型が `number|date` 必須。違反→`error` issue（型不一致）+`state:'mismatch'`。それ以外は入力スキーマ**そのまま**、`state:'confirmed'`。
- `execute`: 述語で行を残す。`eq/neq`=厳密等価（Dateは時刻値比較）; 大小=数値/日付比較; `contains`=文字列包含（対象/valueをString化）; `isNull`=`null`; `notNull`=非`null`。スキーマは不変。

### 9.5 `rename`（kind: transform, arity: 1）
```typescript
interface RenameConfig { renames: { from: string; to: string }[]; }
```
- `inferSchema`: 各 `from` 存在必須。リネーム適用後に**列名重複**が生じる→`error`/`mismatch`。正常→列名を置換（順序保持）、`state:'confirmed'`。
- `execute`: 行のキーを付け替え（値保持）。

### 9.6 `cast`（kind: transform, arity: 1）
```typescript
interface CastConfig { casts: { column: string; to: DataType }[]; }  // to は 'string'|'number'|'boolean'|'date'
```
- `inferSchema`: 各 `column` 存在必須（欠損→error/mismatch）。出力スキーマは対象列の `type` を `to` に変更、`nullable` は変換失敗の可能性から `true`。`state:'confirmed'`（列は存在するため）。サポート外の変換ペアは `warning` issue（stateは維持）。
- `execute`: 各対象セルを変換。`string→number`(`Number()`, NaN→null); `string→boolean`(`'true'/'1'`→true, `'false'/'0'`→false, 他→null); `string→date`(`new Date()`, Invalid→null); `number→string`/`boolean→string`/`date→string`(ISO); `number→boolean`(0→false,他→true) 等。変換不能→`null`。

### 9.7 `nodes/index.ts`
```typescript
export function createDefaultRegistry(): NodeRegistry; // 上記6ノードを register 済みで返す
```

---

## 10. アプリ層: グラフ型 — `src/application/etl/graph.ts`（型のみ）

```typescript
export interface GraphNode { readonly id: string; readonly type: string; readonly config: unknown; }
export interface GraphEdge { readonly from: string; readonly to: string; readonly toInput?: number; } // 既定0
export interface ToolGraph { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[]; }
```

---

## 11. アプリ層: エンジン — `src/application/etl/engine.ts`

```typescript
export interface NodeInference {
  readonly nodeId: string;
  readonly schema: Schema;
  readonly state: SchemaState;   // 上流合成後の最終state
  readonly issues: readonly SchemaIssue[];
}
export interface PropagationResult {
  readonly order: string[];
  readonly nodes: Record<string, NodeInference>;
  readonly hasErrors: boolean;   // どこかに severity:'error' issue があれば true
}
export interface PreviewOptions { readonly rowLimit?: number; }  // 既定 100
export interface NodePreview { readonly nodeId: string; readonly table: Table; readonly truncated: boolean; }
export interface PreviewResult {
  readonly terminalId: string;
  readonly output: Table;
  readonly nodes: Record<string, NodePreview>;
}

export class EtlEngine {
  constructor(registry: NodeRegistry);
  propagateSchemas(graph: ToolGraph): PropagationResult;
  preview(graph: ToolGraph, options?: PreviewOptions): PreviewResult;
}
```

**共通のグラフ検証**（両メソッド冒頭・`GraphError`）
- ノードid一意。edgeの `from`/`to` が実在。
- 各ノードの入次数が `registry.get(type).inputArity` と一致（source=0, transform=1）。
- 閉路なし（`topologicalSort`）。
- **終端**（出次数0のノード）がちょうど1つ。0個/複数→`GraphError`。

**`propagateSchemas`**
- topo順に、各ノードの入力スキーマ（上流の確定スキーマ、`toInput`順）を集めて `node.inferSchema` を呼ぶ。
- 最終 `state` = `combineStates([...上流finalstates, 局所state])`。
- `issues` は局所issueをそのまま（上流issueは各ノードに帰属済み）。
- `config` は `node.validateConfig(graphNode.config)` で検証してから使用。
- `hasErrors` = いずれかのノードissueに `error` があれば true。

**`preview`**
- `propagateSchemas` と同様のtopo実行だが `node.execute` を呼ぶ。各ノード出力 `Table` を保存。
- `rowLimit` を各ノード出力に適用（超過分を切り捨て `truncated:true`）。
- `output` = 終端ノードの（制限適用後）`Table`。
- 実行時に列欠損等が出たら各ノードが `SchemaError` を投げてよい（Engineは伝播）。副作用は伴わない（v1ノードは全て純粋）。

**テスト要件**: 直線グラフのスキーマ伝播/プレビュー; sourceのinferred伝播で全体inferred; select欠損列→hasErrors=true & mismatch; filter型不一致→mismatch; rowLimitでtruncated; 終端0/複数でGraphError; 閉路でGraphError。エンジン単体テストは**インラインのスタブEtlNode**でも可（デフォルトレジストリ非依存でよい）。

---

## 12. E2E & デモ

### `src/application/etl/journey.e2e.test.ts`
[README §7](../docs/README.md) のジャーニー相当:
1. `csv-source` でCSVサンプル読込（id,name,age,active,joined 等）。
2. `select`（一部列）→ `filter`（`age gte 18`）→ `rename`（`name`→`displayName`）→ `cast`（`age`→`number` など）。
3. `EtlEngine.propagateSchemas` で各ノードのスキーマ変化と最終stateを検証。
4. `EtlEngine.preview` で最終行が期待どおり（件数・値・型）であることを検証。
5. わざと存在しない列を `select` して `hasErrors=true` と `mismatch` を確認する negative ケースも1本。

### `src/demo.ts`（`npm run demo`）
上記ジャーニーを構築し、各ノードのスキーマ状態と最終プレビュー行を `console.log` する短いスクリプト。副作用・外部通信なし。

---

## 13. 完了条件（Definition of Done）

- [ ] `npm run typecheck` がエラー0。
- [ ] `npm test` が全green。
- [ ] `npm run test:cov` で domain/application 行カバレッジ90%以上。
- [ ] `npm run depcruise` で境界違反0（`domain` が `application` を import していない 等）。
- [ ] `npm run demo` がジャーニーのスキーマ遷移とプレビューを出力する。
