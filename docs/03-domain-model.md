# 03. ドメインモデル

> 参照: [`ideas.md` 機能節](../ideas/ideas.md) / [`ideas-v2.md` §1〜§3](../ideas/ideas-v2.md)

ドメイン層は外部SDKに非依存（[01-architecture.md](./01-architecture.md)）。ここではエンティティ・値オブジェクト・状態遷移を定義する。

---

## 1. エンティティ関係（ER図）

```mermaid
erDiagram
  WORKSPACE ||--o{ CONNECTION : owns
  WORKSPACE ||--o{ TOOL : contains
  WORKSPACE ||--o{ SKILL : contains
  WORKSPACE ||--o{ AGENT : contains
  WORKSPACE ||--o{ WORKFLOW : contains
  WORKSPACE ||--o{ SECRET_REF : registers

  TOOL ||--|{ NODE : "has flow"
  NODE ||--o{ EDGE : "connected by"
  TOOL ||--|| INPUT_SCHEMA : "declares"
  TOOL ||--|| OUTPUT_SCHEMA : "declares"
  TOOL }o--o{ CONNECTION : "reads via"
  CONNECTION }o--|| SECRET_REF : "uses"

  SKILL }o--o{ TOOL : "depends on"
  AGENT }o--o{ SKILL : "composes"
  AGENT }o--o{ TOOL : "binds directly"
  AGENT ||--o| OUTPUT_SCHEMA : "structured output"

  WORKFLOW }o--o{ TOOL : "orchestrates"
  WORKFLOW }o--o{ AGENT : "invokes"

  TOOL ||--o{ VERSION : "versioned as"
  SKILL ||--o{ VERSION : "versioned as"
  AGENT ||--o{ VERSION : "versioned as"

  AGENT ||--o{ VALIDATION_CASE : "tested by"
  VALIDATION_CASE ||--o{ VALIDATION_RESULT : "produces"
  AGENT ||--o{ TRACE : "emits"
```

---

## 2. 共通メタデータ（Tool / Skill / Agent 共通）

`ideas.md` は「内部識別子・表示名・公開名・バージョン・所有者・公開状態」の分離を要求する。複数人開発と公開名の衝突管理のため、これを共通値オブジェクト化する。

```mermaid
classDiagram
  class Publishable {
    <<abstract>>
    +Id internalId
    +string workingName
    +string displayName
    +PublishName publishName
    +SemVer version
    +OwnerRef owner
    +PublishState state
    +List~Alias~ aliases
    +Tenant tenant
  }

  class PublishState {
    <<enumeration>>
    Draft
    InReview
    Published
    Deprecated
    Archived
  }

  class Tool {
    +InputSchema inputSchema
    +OutputSchema outputSchema
    +SideEffect sideEffect
    +List~Node~ nodes
    +List~Edge~ edges
    +Sample fixedSample
  }

  class Skill {
    +string responsibility
    +IOContract io
    +List~ToolRef~ dependencies
    +string activationCondition
  }

  class Agent {
    +string systemPrompt
    +StructuredOutput output
    +AgentKind kind
    +List~SkillRef~ skills
    +List~ToolRef~ tools
  }

  class SideEffect {
    <<enumeration>>
    ReadOnly
    Write
    ExternalAction
  }

  class AgentKind {
    <<enumeration>>
    Normal
    PseudoUser
    Evaluator
  }

  Publishable <|-- Tool
  Publishable <|-- Skill
  Publishable <|-- Agent
  Tool --> SideEffect
  Tool --> PublishState
  Agent --> AgentKind
```

### 命名の分離ルール（`ideas.md`）
- **開発画面**: 内部識別子（`internalId`）・作業用名称（`workingName`）を扱う。
- **エージェントに見せる**: 公開名（`publishName`）のみ。
- **公開時**: エイリアス・名前衝突・互換性を管理する仕組みを持つ（[04-api-spec.md](./04-api-spec.md) の Publish API）。

### 列挙値の意味
- `SideEffect`: `ReadOnly`（副作用なし）/ `Write`（書き込み）/ `ExternalAction`（外部操作）。`Write`・`ExternalAction` は実行前承認の対象。
- `AgentKind`: `Normal`（通常）/ `PseudoUser`（ユーザープロファイル駆動の疑似ユーザー）/ `Evaluator`（評価用）。

---

## 3. Tool の内部構造（ノードフロー）

```mermaid
classDiagram
  class Tool {
    +List~Node~ nodes
    +List~Edge~ edges
  }
  class Node {
    +NodeId id
    +NodeKind kind
    +NodeConfig config
    +Schema outSchema
    +SchemaState schemaState
  }
  class Edge {
    +NodeId from
    +NodeId to
    +PortRef fromPort
    +PortRef toPort
  }
  class NodeKind {
    <<enumeration>>
    Source
    Transform
    Analyze
    Sink
    Control
    CustomCode
  }
  Tool "1" o-- "1..*" Node
  Tool "1" o-- "0..*" Edge
  Node --> NodeKind
  Node --> SchemaState
```

ノード分類の詳細は [06-etl-tool-builder.md](./06-etl-tool-builder.md) を参照。

---

## 4. スキーマ状態の遷移

`ideas-v2.md §1` は「確定 / 部分確定 / 推論 / 不明 / 実行結果と不一致」の5状態を区別することを要求する。これはスキーマ自動伝播とインライン検証の基盤。

```mermaid
stateDiagram-v2
  [*] --> Unknown : ノード追加直後
  Unknown --> Inferred : 上流スキーマから推論
  Inferred --> Partial : 一部列のみ確定
  Partial --> Confirmed : 全列の型が確定
  Inferred --> Confirmed : 完全推論成功
  Confirmed --> Mismatch : 実行結果と不一致
  Inferred --> Mismatch : 実データ検証で乖離
  Mismatch --> Confirmed : 作成者がOutput Schema明示・再検証
  Confirmed --> [*]

  note right of Mismatch
    API / pivot / カスタムコードなど
    推論不能な出力は作成者が明示し
    実行時に実データと一致検証する
  end note
```

- 型不一致は接続線を赤く表示（インライン検証）。
- `Mismatch` はスナップショットテストの差分検知にも使う。

---

## 5. 公開・バージョンのライフサイクル

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> InReview : レビュー依頼
  InReview --> Draft : 差し戻し
  InReview --> Published : 公開承認
  Published --> Deprecated : 後継版へ移行
  Deprecated --> Archived : 廃止
  Published --> Draft : 新バージョン派生
  Archived --> [*]

  note right of Published
    公開名 + エイリアスで参照
    互換性（SemVer）を管理
    write / external-action は
    実行前承認の対象
  end note
```

- 公開状態の遷移は監査ログへ記録（[08-security-auth.md](./08-security-auth.md)）。
- `Published` への遷移は認可（`publish` アクション）の対象。

---

## 6. 検証（Validation）モデル

`ideas-v2.md §2, §11` に基づき、検証は「呼び出し率」だけでなく期待Skill/Tool・順序・引数・成否をケース単位で定義する。

```mermaid
classDiagram
  class ValidationCase {
    +string scenario
    +List~SkillRef~ expectedSkills
    +List~ToolRef~ expectedTools
    +bool shouldCall
    +List~ArgConstraint~ argConstraints
    +CallOrder expectedOrder
    +Expected finalOutcome
  }
  class ValidationResult {
    +float skillHitRate
    +float toolHitRate
    +float notCallWhenUnneeded
    +float schemaConformance
    +float orderConformance
    +float taskSuccessRate
    +Latency latency
    +Cost cost
    +Diff regressionDiff
    +Qualitative feedback
  }
  class PseudoUserAgent {
    +UserProfile profile
    +runScenario()
  }
  ValidationCase --> ValidationResult
  PseudoUserAgent --> ValidationCase : drives
```

検証指標の一覧は [09-roadmap.md](./09-roadmap.md#検証指標) を参照。
