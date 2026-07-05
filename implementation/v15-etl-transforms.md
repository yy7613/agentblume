# v15 実装契約: ETL変換ノード拡張（join / union / sort / distinct / fill-null / replace）

> 本書は Increment 15（[ADR-0015](../docs/adr/0015-etl-transform-expansion.md)）の**単一の真実**。
> 参照: [06-etl-tool-builder.md §2.2](../docs/06-etl-tool-builder.md) / `implementation/v1-etl-core.md`（ノード契約の規約） / `implementation/v5-tool-builder-ui.md`・`v14-ui-localization.md`（UI規約）
> 前提: v14 まで完成・全テストgreen。

## 0. 規約（従来どおり）
TypeScript strict / `noUncheckedIndexedAccess` / ESM・拡張子なしimport / Zod v4（config検証、失敗は `ConfigError`）/ Vitest。例外は `domain/etl/errors.ts` の型のみ。入力非mutate（新しい Table/Row を返す）。実装とテスト同居。**既存ノードの実装規約（`select.ts` 等）と `zod-error.ts` ヘルパの流儀に合わせる。**

## 1. スコープ

| ノードtype | kind | inputArity | 概要 |
|---|---|---|---|
| `join` | transform | **2** | キー結合（inner/left/right/full） |
| `union` | transform | **2** | 列名ベースの縦結合 |
| `sort` | transform | 1 | 複数キー安定ソート |
| `distinct` | transform | 1 | 重複排除 |
| `fill-null` | transform | 1 | null埋め/行削除 |
| `replace` | transform | 1 | 値の置換 |

エンジン変更は**原則不要**（arity=2 と `toInput` は実装済み。`engine.test.ts` の stub-join 参照）。万一エンジン修正が必要になった場合は最小変更とし、理由を完了報告に明記する。

**入力の意味**: 2入力ノードでは `toInput: 0` = **左**、`toInput: 1` = **右**。

## 2. ドメインノード仕様（`src/domain/etl/nodes/`）

### 2.1 `join`
```typescript
interface JoinKey { left: string; right: string; }
interface JoinConfig {
  mode: 'inner' | 'left' | 'right' | 'full';
  keys: JoinKey[];                    // 1個以上
  rightSuffix?: string;               // 既定 '_right'
}
```
- **inferSchema**（inputs = [左Schema, 右Schema]）:
  - 各 `keys[i].left` が左に、`.right` が右に存在しない → `error` issue（column付き）+ `state:'mismatch'`。
  - キーペアの型不一致（`left.type !== right.type`、どちらかが `unknown` の場合は許容し `warning`）→ `error` + `'mismatch'`。
  - 出力列 = 左の全列 + 右の列のうち**結合キーに使った右列を除く**残り。右列名が左と衝突したら `rightSuffix` を付与（付与後も衝突するなら `error`/`'mismatch'`）。
  - nullable: `left` join → 右由来列は `nullable:true`。`right` → 左由来列 true。`full` → 両方 true。`inner` → 元のまま。
  - 正常時 `state:'confirmed'`。
- **execute**: ハッシュ結合。**キー値が `null` の行はマッチしない**（SQL準拠。ただし outer 系では無マッチ行として残す）。複数マッチは直積。full は両側の無マッチ行を出力（欠損側は null 埋め）。行順: 左行順 → (fullのみ)右の無マッチ行順。

### 2.2 `union`
```typescript
interface UnionConfig { strict?: boolean; }   // 既定 false
```
- **inferSchema**（inputs = [上Schema, 下Schema]）:
  - `strict:true`: 列名集合が完全一致しない → `error` + `'mismatch'`。列順は左（input0）に合わせる。型は `unifyTypes`（異種→`unknown` + `warning`）。
  - `strict:false`: 列 = **左の列順 → 右にしかない列を初出順で後ろに**。片側にしかない列は `nullable:true`。共通列の型は `unifyTypes`（異種→`unknown` + `warning` issue）。
  - 正常時 `state:'confirmed'`。
- **execute**: input0 の全行 → input1 の全行。欠損列は `null`。重複排除はしない（必要なら後段に `distinct`）。

### 2.3 `sort`
```typescript
interface SortKey { column: string; direction?: 'asc' | 'desc'; nulls?: 'first' | 'last'; }
interface SortConfig { keys: SortKey[]; }     // 1個以上。direction既定'asc'、nulls既定'last'
```
- **inferSchema**: 各 `column` 存在必須（欠損→`error`/`'mismatch'`）。スキーマ不変、正常時 `'confirmed'`。
- **execute**: 安定ソート（`Array.prototype.sort` は ES2019+ で安定）。比較: number/date は数値比較（Dateは `getTime()`）、string は `<`/`>`、boolean は false<true、型混在セルは String化比較。`null` は `nulls` 指定位置へ（direction に関わらず first/last を絶対位置とする）。

### 2.4 `distinct`
```typescript
interface DistinctConfig { columns?: string[]; }   // 省略/空 = 全列
```
- **inferSchema**: 指定列の存在必須（欠損→`error`/`'mismatch'`）。スキーマ不変、`'confirmed'`。
- **execute**: 対象列値のタプル（`JSON.stringify` キー。Date は ISO 化、null は専用トークン）で重複判定し、**最初の行を保持**。行順維持。

### 2.5 `fill-null`
```typescript
interface FillRule { column: string; strategy: 'constant' | 'drop-row'; value?: Cell; }
interface FillNullConfig { rules: FillRule[]; }    // 1個以上
```
- config検証: `strategy:'constant'` なのに `value` 未指定（undefined）→ `ConfigError`。`value: null` は不可（ConfigError）。
- **inferSchema**: 各 `column` 存在必須（欠損→`error`/`'mismatch'`）。`constant` の列は `nullable:false` に更新。`value` の型が列型と不一致（列型が `unknown`/`null` 以外で異なる）→ `warning`（型は `unifyTypes` 結果に）。`drop-row` はスキーマの `nullable:false` 化（当該列）。正常時 `'confirmed'`。
- **execute**: ルール順に適用。`constant`: 当該列の `null` を `value` へ。`drop-row`: 当該列が `null` の行を除去。

### 2.6 `replace`
```typescript
interface ReplaceRule { column: string; from: Cell; to: Cell; }
interface ReplaceConfig { rules: ReplaceRule[]; }  // 1個以上
```
- **inferSchema**: 各 `column` 存在必須（欠損→`error`/`'mismatch'`）。`to` の型が列型と異なる場合は列型を `unifyTypes(列型, toの型)` に更新し `warning`。`from:null→to:x` は null置換として許容（`nullable` は他ルールに依らず**維持**でよい: fill-null の責務と分ける）。正常時 `'confirmed'`。
- **execute**: ルール順に適用。厳密等価（Date は `getTime()` 比較、null は null と一致）で `from` に一致したセルを `to` へ。

### 2.7 登録
`nodes/index.ts` の `createDefaultRegistry()` に6ノードを追加。

## 3. UI拡張（`src/ui/tool-builder/`）

**既存規約に完全準拠**（実装前に `node-catalog.ts` / `NodePalette.tsx` / `NodeInspector.tsx` / `FlowCanvas.tsx` / `ToolNode.tsx` / `store.ts` と v5・v14 契約を読むこと）。

1. **node-catalog**: `NODE_TYPES` に6 type を追加し、`NODE_CATALOG` に `label/labelJa/description/descriptionJa/defaultConfig` を追加（既存の書式・日本語文体に合わせる）。defaultConfig 例: join=`{ mode:'inner', keys:[], rightSuffix:'_right' }`, union=`{ strict:false }`, sort=`{ keys:[] }`, distinct=`{ columns:[] }`, fill-null=`{ rules:[] }`, replace=`{ rules:[] }`。
2. **2入力対応**: FlowCanvas / ToolNode / store の接続モデルを確認し、arity=2 ノードに **入力ハンドル2個（左=0 / 右=1、ラベル表示）** を描画・接続できるようにする。エッジ作成時に `toInput` を設定し、同一入力ポートへの二重接続は置換または拒否（既存の単一入力の挙動に合わせる）。ノードの inputArity は domain の `createDefaultRegistry()` から取得するか catalog に持たせる（既存構造に合わせて選択し、二重管理を避ける）。
3. **NodeInspector**: 6ノードの設定フォームを追加。上流スキーマの列名ドロップダウン提示（既存 select/filter フォームの流儀）。join は左右それぞれの上流スキーマから列候補を出す。
4. **i18n**: v14 の仕組みに従い、新規文言を en/ja 両方へ追加。
5. **プレビュー/スキーマ伝播**: 既存の use-draft-preview 経由で新ノードが `infer-schema`/`preview` に流れることを確認（API・エンジンは変更不要のはず）。

## 4. テスト要件

- **ドメイン各ノード**（`*.test.ts` 同居）: inferSchema（正常 / 欠損列 / 型不一致 / suffix衝突[join] / strict違反[union]）・execute（各mode網羅[join: inner/left/right/full/複数マッチ直積/nullキー不マッチ]、和集合とnull埋め[union]、安定性とnull位置[sort]、最初行保持[distinct]、constant/drop-row[fill-null]、Date/null等価[replace]）・config異常（Zod→ConfigError、fill-nullのvalue欠落）。非mutate検証を最低1本ずつ。
- **UI**: catalog追加のスモーク、2入力ノードの接続と `toInput` 設定（store テスト）、NodeInspector フォームの表示/入力（既存 ui-components.test の流儀）、join を含むグラフの統合テスト（tool-builder.integration.test の流儀で: 2ソース→join→プレビュー行が期待どおり）。
- **E2E**: 既存 `journey.e2e.test.ts` は変更しない。新たに `transforms.e2e.test.ts`（application/etl）: 2つの json-source → join → union（もう1ソースと）… は3入力になるため、代表フロー「A join B → sort → distinct → fill-null → replace → 出力検証」+「A union B → 検証」の2本で可。

## 5. 完了条件（DoD）
- [ ] `npx tsc --noEmit` エラー0
- [ ] `npx vitest run` 全green（既存全テスト + 新規）
- [ ] `npx vitest run --coverage` 閾値クリア
- [ ] `npx depcruise src --config .dependency-cruiser.cjs` 違反0
- [ ] Tool Builder UI で join/union を含むフローが組めてプレビューが出る（統合テストで担保）
