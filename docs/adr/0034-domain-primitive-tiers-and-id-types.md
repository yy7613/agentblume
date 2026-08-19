# ADR-0034: ドメインプリミティブの表現規約と ID 型体系

- Status: Accepted
- Date: 2026-08-18
- 関連: [docs/03-domain-model.md §2](../03-domain-model.md) / [docs/05-dependency-graph.md](../05-dependency-graph.md) / [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md)

## 文脈

[03-domain-model.md §2](../03-domain-model.md) は共通メタデータの共通値オブジェクト化を宣言しているが、実装では ID・日時・URL の多くが素の型別名（`type ToolId = string` 等）のままであり、次のギャップがある。

1. TypeScript の構造的型付けでは型別名同士が相互代入可能で、ID の取り違え（ToolId⇄AgentId、fromSlotId⇄runId 等）をコンパイル時に検出できない。機械強制の方針（[docs/05](../05-dependency-graph.md)）に対し、ここだけがレビュー頼みになっている。
2. 値オブジェクト（VO）の表現形式が定まっておらず、新しい値を導入するたびに設計判断が発生する。唯一のクラス VO である [SemVer](../../src/domain/tool/semver.ts) は parse/toString の serialization 二段構えを要し、この形式を既定にはできない。
3. 本移行は既存テストを変更しない純増分を制約としており、生成点全域の書き換えを要する方式は採れない。

関連実装は src/domain/shared/（brand.ts / errors.ts / assert.ts / tenant-scope.ts）として着手済みである（shared 設立の経緯は [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md)）。本 ADR は VO の表現規約と ID 型体系を定める。

## 決定

### 1. VO 表現を3層規約に固定する

| Tier | 表現 | 対象 | 等価性 / JSON表現 |
|---|---|---|---|
| 1 | Flavored / Branded primitive | 単一プリミティブで検証のみを持つ値。全 ID、IsoDateTime、HttpUrl、TenantKey | `===` / プリミティブそのまま |
| 2 | interface + `createXxx` ファクトリ + `isXxx` ガード | 複合値。TenantScope、RegistryModelRef、PublishableMetadata | フィールド比較 / plain object そのまま |
| 3 | クラス VO | 2つ以上のドメイン操作を持つ場合のみ。既存 SemVer のみ | メソッド / parse・toString の明示変換 |

**新規クラス VO は原則禁止**とする。理由: クラスは実行時表現が JSON 表現から乖離し、serialization 二段構え（toString/toJSON とデシリアライザ側の復元）のコストが型ごとに増える。Tier 1/2 は実行時表現が JSON-safe なプリミティブ / plain object のままであり、境界変換規約（[ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定4）と噛み合う。

### 2. Brand（強）と Flavor（弱）を shared に定義する

[src/domain/shared/brand.ts](../../src/domain/shared/brand.ts) に unique symbol 方式で定義する。

```ts
declare const kind: unique symbol;

/** 強ブランド。素の string/number は代入不可（スマートコンストラクタでのみ生成）。 */
export type Brand<T, K extends string> = T & { readonly [kind]: K };

/** 弱ブランド。素の値は代入可、異種ブランド間のみ代入不可。 */
export type Flavor<T, K extends string> = T & { readonly [kind]?: K };
```

ブランドプロパティは unique symbol のためコンパイル後には存在せず、実行時表現は素の値のまま（実行時コストゼロ、JSON 表現不変）。

### 3. 既定は Flavor とする

新規・移行を問わず、ID 型の既定形式は Flavor とする。

理由: Flavor は素の string からの代入を許すため、既存の生成点・テスト・adapter を1行も変更せずに型定義の張り替えだけで導入でき、その時点から異種 ID 間の代入（ToolId⇄AgentId、fromSlotId⇄runId 等）がコンパイルエラーになる。既存テスト変更禁止（純増分）の制約下で、コード無修正のまま取り違え検出を得られる唯一の形式である。

### 4. Brand への昇格はラチェットとする

Flavor から Brand への昇格は次の条件で行う。

- (a) その型の生成経路がファクトリ / デシリアライザ / API ルートに限定済みであること。
- (b) 昇格してもコンパイルが通ること（通らない場合は生成経路の限定が未完了）。
- (c) セキュリティ境界値（TenantId / WorkspaceId）と取り違え多発値（SlotId）を優先すること。

昇格は型定義の1行変更（`Flavor` → `Brand`）であり、問題が出れば同じ1行で即ロールバックできる。逆方向（Brand → Flavor）への引き下げは原則行わない（ラチェット）。

### 5. 命名・配置規則

- ID 型は `XxxId` と命名する。
- ID 型はエンティティを所有する BC の `ids.ts` に定義する。`ids.ts` は shared 以外を import しない葉に保つ。
- 他 BC を参照するフィールドは所有 BC の型を import する。参照側での重複定義・独自別名を作らない。

### 6. `as` キャストはスマートコンストラクタ内部の1箇所のみ許可する

ブランドを付与する `as` キャストは、各型のスマートコンストラクタ（`tenantKey()` のような生成関数を含む）内部の1箇所に限定する。呼び出し側・テスト・adapters での `as XxxId` は禁止する。

### 7. 未昇格 Flavor は本 ADR の負債台帳で管理する

Brand へ昇格していない Flavor は、本 ADR 末尾の台帳（付記）への追記で管理する。行の削除は昇格完了時のみとする。

## 検討した代替案

| 代替案 | 不採用の理由 |
|---|---|
| zod `.brand()` 方式 | domain 層へ外部ライブラリを持ち込まない既存方針（ADR-0020 ほか）に反する。スキーマ検証とブランド付与が密結合し、検証なしの型注釈張り替え（決定3の Flavor 移行）ができないため、純増分の制約を満たせない |
| 全クラス VO 方式 | serialization 二段構えが全型に発生し、`===` 比較・JSON 契約・既存テストを広範に壊す。SemVer 1型ですらデシリアライザ側の復元コストが型ごとの追加負担として観測されている |
| 強 Brand 一斉導入 | 全生成点へのスマートコンストラクタ挿入が必要で、既存コード無修正の制約に反する。一括変更が大きすぎて失敗時に戻せない。ラチェット（決定4）で同じ終着点へ段階的に到達できる |
| 素の型別名の維持（現状維持） | ID の取り違えを検出できず、fromSlotId⇄runId 等の混同がレビュー頼みのまま残る。導入コストが型定義の張り替えのみである以上、放置を正当化できない |

## 帰結

- (+) 型定義の張り替えのみで ID 取り違えがコンパイルエラーになる。実行時表現・JSON 表現・実行時コストは一切変わらない。
- (+) 表現形式が Tier 規約で決まるため、新しい値を導入するたびの設計判断がなくなる。
- (+) 昇格・ロールバックが型ごと1行で完結し、移行を任意の地点で停止・再開できる。
- (−) Flavor のままでは素の string 代入を許すため、生成点の検証漏れは防げない（Brand 昇格までの既知の弱さ。台帳で追跡する）。
- (−) unique symbol ブランドは型エラーメッセージが長くなり、初見の読み手に学習コストがある。
- (−) 負債台帳の保守という運用が増える。

## 付記: 未昇格 Flavor の負債台帳

昇格（決定4）を完了していない Flavor をここへ追記する。

| 型 | 所有 BC | 状態（2026-08-19） | 備考 |
|---|---|---|---|
| TenantId / WorkspaceId | shared（tenant-scope） | Flavor 化済・Brand 昇格不可（実験ログ参照） | セキュリティ境界値。昇格優先度: 高。昇格試行でコンパイルエラー 1,447 件 |
| SlotId | harness | Flavor 化済・Brand 昇格不可（実験ログ参照） | 取り違え多発値（fromSlotId⇄runId）。昇格優先度: 高。昇格試行でエラー 88 件 |
| ToolId / AgentId ほか各 BC の ID | 各 BC の ids.ts | Flavor 化済 | 型別名からの張り替え完了。Brand 昇格は実験ログの帰結に従う |
| TerminalId | run | Flavor 化済・Brand 昇格不可（構造的） | 値空間が ETL 終端ノード ID と実行時ソース番兵（'runtime-harness' / 'mcp' / 'session-workspace'）の異種混合であり、生成経路の限定（決定4 (a)）が原理的に成立しない |
| IsoDateTime | shared（time） | ファクトリ厳格化 未実施 | shared/time.ts の assertIsoDateTime は新設済みだが未配線。既存テストの日時リテラルとの互換を確認しつつ BC ごとに意図的採用する（M4 決定） |
| （検証方言: nonEmpty） | session / operations | 共通 assert への委譲未了 | src/domain/session/agent-session.ts（`${field} must be non-empty` — 別文言のため委譲には契約変更判断が必要）/ src/domain/operations/backup.ts（`backup manifest field "key"` ラベル方言 — 委譲可能だが任意） |

### 実験ログ: Brand 昇格試行（2026-08-19）

結論: **現時点で昇格可能な ID はゼロ**。決定4 (b)（昇格してもコンパイルが通ること）を満たす Flavor は存在しなかった。

- `TenantId` / `WorkspaceId` → Brand: コンパイルエラー **1,447 件**。本番コード（adapters/security/token-authentication.ts、in-memory リポジトリ群）と既存テスト・契約テストに広く波及し、純増分ポリシー下では不可。
- `SlotId` → Brand: エラー **88 件**（既存テスト 79 / 本番 9）。本番側の内訳: application/harness/run-harness.ts ×3、api/harness-routes.ts ×2、domain/harness/serialization.ts ×2、domain/harness/run-serialization.ts ×1、adapters/storage/harness-run-repository.contract.ts ×1。本番側はいずれも zod 出力や LLM 出力由来の string 流入点であり、パース点へのスマートコンストラクタ導入が必要。主障壁はテスト側。
- 帰結: Brand 昇格には「既存テストの ID リテラルを更新する」という意図的な決断が前提となる。純増分運用の間は全 ID が Flavor に留まる。昇格を決断する場合の作業リストとしては、上記エラー一覧がそのまま使える。
