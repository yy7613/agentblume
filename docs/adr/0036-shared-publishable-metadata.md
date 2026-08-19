# ADR-0036: Publishable 共通メタデータの実装

- Status: Accepted
- Date: 2026-08-19
- 関連: [docs/03-domain-model.md §2](../03-domain-model.md) / [ADR-0034](./0034-domain-primitive-tiers-and-id-types.md) / [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md)

## 文脈

[03-domain-model.md §2](../03-domain-model.md) は共通メタデータ（内部識別子・表示名・公開名・バージョン・所有者・公開状態）の共通値オブジェクト化を宣言し、[ADR-0034](./0034-domain-primitive-tiers-and-id-types.md) 決定1 は PublishableMetadata を Tier 2 VO として挙げている。しかし実装では、同じ 8 フィールド（internalId / workingName / displayName / publishName / version / owner / state / tenant）の型定義・検証・シリアライズ断片が tool / agent / skill / harness / validation / evaluation の 6 BC にコピーされたままで、次のひずみがある。

1. 検証コピーに意味論の分岐が既に発生している。tool のみ空白のみ文字列を許し（trim しない — [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定2）、tool のみ tenant オブジェクト欠落を専用メッセージで先行検査し、skill はメタデータ検証の途中に本文フィールド検証が割り込む。
2. `PublishState` 一族が tool BC（src/domain/tool/metadata.ts）にあり、他 BC が tool へ横断 import している（TenantScope と同型の問題 — [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 文脈1）。
3. 永続化 JSON のメタデータ断片も 7 つの serialization ファイルが個別に定義しており、形状の同期がレビュー頼みである。

制約は3つ。shared は葉に保つため（[ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定1）、tool 残置の SemVer（同 決定3）を shared から import できない。エラー型・メッセージは HTTP マッピング・UI 日本語化・テストの契約であり不変が絶対条件である（同 決定6）。既存の永続 JSON 形状も不変とする（同 決定4）。

関連実装は [src/domain/shared/publishable.ts](../../src/domain/shared/publishable.ts) と各 BC の置き換えとして実施済みである。

## 決定

### 1. `PublishableMetadata<Id, V>` を shared に新設し、6 BC のメタデータ型をエイリアス化する

[src/domain/shared/publishable.ts](../../src/domain/shared/publishable.ts) に 8 フィールドの interface `PublishableMetadata<Id extends string = string, V = unknown>` を定義し、各 BC のメタデータ型を別名にする。

| BC | 別名 |
|---|---|
| tool | `ToolMetadata = PublishableMetadata<ToolId, SemVer>` |
| agent | `AgentMetadata = PublishableMetadata<AgentId, SemVer>` |
| skill | `SkillMetadata = PublishableMetadata<SkillId, SemVer>` |
| harness | `HarnessMetadata = PublishableMetadata<HarnessId, SemVer>` |
| validation | `ValidationMetadata = PublishableMetadata<string, SemVer>` |
| evaluation | `EvaluationAssetMetadata = PublishableMetadata<string, SemVer>` |

version をジェネリクス `V` で受けるのは、SemVer が tool BC 残置（[ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定3）により shared から import できないためである。`instanceof SemVer` 検査は述語 `isVersion` として呼び出し側から注入する。エイリアスは構造的に旧 interface と同一であり、利用側コードは無修正で通る。

### 2. `validatePublishableMetadata` を検証の単一情報源とする

`validatePublishableMetadata(metadata, prefix, { fail, isVersion, trim?, tenantGuardMessage? })` を 8 フィールド検証の唯一の実装とする。

- エラーメッセージは `${prefix}: metadata.xxx ...` 形で全 BC 統一されており、prefix（`createTool` / `createSkill` 等）と ErrorFactory `fail` の注入でバイト単位互換を保つ（[ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定6）。
- 検証順序は internalId → workingName → displayName → publishName → owner → （tenant ガード） → tenant.tenantId → tenant.workspaceId → version → state に固定し、統合前の各 BC の順序と一致させる。
- tool 固有の意味論はオプションで順序ごと保存する: `trim: false`（空白のみ文字列を許す歴史的意味論 — [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定2）と `tenantGuardMessage`（tenant 非オブジェクト時の専用メッセージ）。未指定の BC は optional chaining により tenant.tenantId の非空エラーへ落ちる（従来挙動のまま）。

### 3. `PublishState` 一族を shared へ実体移設し、旧パスは再エクスポートする

`PublishState` / `PUBLISH_STATES` / `isPublishState` を tool/metadata.ts から shared/publishable.ts へ実体移設する。旧パス（[src/domain/tool/metadata.ts](../../src/domain/tool/metadata.ts)）は再エクスポートを維持し、参照する 36 ファイルの import を無修正で通す（TenantScope 移設 — [ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定2 と同じ手法）。`SideEffect` / `SIDE_EFFECTS` / `isSideEffect` / `ToolSummary` は Tool 固有概念として tool/metadata.ts に残置する。

### 4. Serialized 断片を 7 つの serialization ファイルで共有する

`SerializedPublishableMetadata`（永続化 JSON 上の 8 フィールド表現）/ `serializedPublishableMetadataSchema`（構造検証用スキーマ断片）/ `serializePublishableMetadata`（version は toString）/ `deserializePublishableMetadata`（version の解釈は `parseVersion` 注入）を shared に置き、次の 7 ファイルが参照する: tool/serialization.ts、agent/serialization.ts、skill/serialization.ts、harness/serialization.ts、validation/serialization.ts、evaluation/assets-serialization.ts、evaluation/quality-gate-serialization.ts。

永続化 JSON の形状は不変であり、境界変換の変換点も各 BC の serialization.ts のまま動かない（[ADR-0035](./0035-domain-shared-kernel-and-boundary-conversion.md) 決定4）。スキーマ断片は domain の serialization ファイル群で既に使われている zod の慣行に従う。

### 5. 意図的な挙動変更を2点受容する

エラーメッセージと JSON 形状の不変は守った上で、次の2点は観測可能な挙動変更として意図的に受容する。

- (a) skill の本文5フィールド（responsibility / activationCondition / inputDescription / outputDescription / instructions）の検証が、従来の「メタデータ非空検証と version/state 検査の間」から version/state の後ろへ移動する。この順序に依存するテストはない。
- (b) skill / harness / validation / evaluation の防御的コピーがスプレッド（`{ ...metadata, ... }` — 余剰プロパティを保持）から明示列挙（8 フィールドのみを写し、余剰プロパティを落とす）へ統一される。未知プロパティの混入を防ぐ、より厳格な側への変更である。

### 6. スコープ外: aliases フィールドと internalId のブランド化

- `aliases: List<Alias>`（[docs/03 §2](../03-domain-model.md) の構想）は検証・シリアライズ・API に波及する機能追加であり、重複統合である本 ADR のスコープ外。後続課題とする。
- validation / evaluation の internalId は素の `string` のまま（`PublishableMetadata<string, SemVer>`）。ブランド化（[ADR-0034](./0034-domain-primitive-tiers-and-id-types.md)）はメタデータが generic 化されたため型引数 `Id` の張り替えのみで将来対応でき、shared 側の変更を要しない。

## 検討した代替案

| 代替案 | 不採用の理由 |
|---|---|
| 各 BC の個別定義を維持（現状維持） | 8 フィールド × 6 BC の型・検証・シリアライズの重複が既に意味論の分岐（tool の trim なし等）を生んでおり、修正が 6 箇所への同期修正のまま残る。docs/03 §2 の共通値オブジェクト化宣言と ADR-0034 の Tier 2 指定に実装が追随しない |
| interface 継承（`extends PublishableMetadata`） | shared は SemVer を import できないため、各 BC が version フィールドだけ再宣言する歪な形になる。型は共有できても検証・シリアライズの実装共有は別途必要で、重複の主因が残る。ジェネリクス `V` は「SemVer を shared から参照できない」制約を型引数として素直に表せる |
| zod スキーマからの型導出（`z.infer`） | ドメインの実行時表現は SemVer クラスインスタンスを含み、zod スキーマから導出できるのは境界（JSON）表現のみ。ドメイン型が外部ライブラリ由来になり Tier 2 規約（interface + ファクトリ — ADR-0034 決定1）に反する。zod 既定メッセージではエラーメッセージのバイト互換（ADR-0035 決定6）も保てない |

## 帰結

- (+) 8 フィールドの型・検証・シリアライズが単一情報源になり、6 BC のメタデータ定義がエイリアス1行に縮む。エラーメッセージはバイト互換、永続 JSON 形状は不変、旧パス再エクスポートで 36 ファイルの import も無修正のまま通る。
- (+) 将来の aliases 追加（決定6）や internalId のブランド化が、shared 1箇所の変更と型引数の張り替えで波及できる土台になる。
- (−) 意図的変更2点（決定5）は観測可能な挙動変更である（いずれも厳格化の側）。
- (−) `fail` / `isVersion` 注入の呼び出しは素朴なインライン検証より冗長になる（ADR-0035 帰結と同種）。
- (−) `V = unknown` の既定は version の型安全を各 BC の別名定義に委ねる。SemVer が型引数として各 BC に現れる非対称（tool 残置の帰結）も残る。
