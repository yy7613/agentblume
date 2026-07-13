# 07. 実行モデル・データフロー

> 参照: [01-architecture.md](./01-architecture.md#4-実行エンジンの三分割)

3つの実行規則（Tool / Workflow / Agent）ごとにデータフローを示す。共通原則は「プレビューは副作用を実行しない」「LLMへ渡すコンテキストは最小限」。

---

## 1. 実行モードの分離

```mermaid
flowchart LR
  subgraph Modes["実行モード"]
    P["preview<br/>固定サンプル/キャッシュ<br/>書き込み無効"]
    T["test<br/>検証データセット<br/>疑似ユーザー"]
    PR["production<br/>実データ・実権限<br/>承認・監査"]
  end
  P --> T --> PR
```

> 3モードは使用データと権限を分離して表示する。

| モード | データ | 副作用 | 権限 |
|---|---|---|---|
| `preview` | 固定サンプル / 明示キャッシュ | write系は実行せず内容表示のみ | 開発者権限 |
| `test` | 検証データセット | Fake / 保存済みレスポンス | テスト権限 |
| `production` | 実データ | 承認後に実行、監査記録 | 実行権限 + 認可 |

---

## 2. Toolプレビュー実行

ノード接続・設定変更のたびに、出力スキーマとサンプル行を制限付きで更新する（プレビュー駆動）。

```mermaid
sequenceDiagram
  actor Dev as 開発者
  participant UI as Tool開発画面
  participant App as BuildTool UseCase
  participant TE as Tool Engine
  participant Cache as 固定サンプル/キャッシュ

  Dev->>UI: ノード接続 / 設定変更
  UI->>App: preview(toolDraft)
  App->>App: スキーマ伝播・推論
  App->>TE: run(mode=preview, limit=行数/時間)
  TE->>Cache: サンプル取得（外部I/Oは保存済み）
  Cache-->>TE: サンプル行
  TE->>TE: 変換実行（write系はスキップし内容表示）
  TE-->>App: 出力サンプル + 実測スキーマ
  App->>App: スキーマ状態判定（確定/推論/不一致）
  App-->>UI: サンプル行 + スキーマ + 型不一致箇所
  UI-->>Dev: プレビュー更新（不一致は赤表示）
```

- 書き込み・副作用API・通知はプレビューで実行しない。代わりに入力と予想操作内容を表示。
- 実測スキーマが宣言と乖離したら `Mismatch` としてトレースへ（[03-domain-model.md](./03-domain-model.md#4-スキーマ状態の遷移)）。

---

## 3. Agentチャット実行（Tool Calling）

LLMは意図解釈・タスク計画・Skill/Tool選択に集中し、計算・データ処理・外部実行はToolへ委譲する。

```mermaid
sequenceDiagram
  actor User
  participant Chat as Chat画面
  participant App as RunAgent UseCase
  participant RT as AgentRuntimePort（Mastra）
  participant LLM as ModelProviderPort
  participant AZ as AuthorizationProvider
  participant TE as Tool Engine
  participant OD as Tool Output Dispatcher
  participant SW as Agent Session Workspace
  participant Aud as AuditSink

  User->>Chat: メッセージ
  Chat->>App: run(agentRef, message, mode)
  App->>App: 最小コンテキスト構築（前処理で絞り込み）
  App->>RT: run(messages, tools=公開名, context)
  RT->>LLM: 推論（Skill/Tool選択・引数生成）
  LLM-->>RT: tool_call(publishName, args)
  RT->>App: Tool呼び出し要求
  App->>App: Input Schema検証
  App->>AZ: decide(principal, tool, execute)
  alt write / external-action
    AZ-->>App: 要承認
    App-->>User: 実行前承認を要求
    User-->>App: 承認
  else read-only
    AZ-->>App: Allow
  end
  App->>TE: Tool実行（決定的変換）
  TE-->>App: 出力
  App->>App: Output Schema検証
  App->>OD: 終端sinkへ配送
  alt agent-output
    OD-->>App: bounded inline result
  else workspace-output / graph-output
    OD->>SW: Artifactをstream保存
    SW-->>OD: ArtifactDescriptor
    OD-->>App: 参照 + bounded preview
  end
  App->>Aud: 実行記録（マスキング）
  App-->>RT: tool_result（構造化）
  RT->>LLM: 結果を渡して継続
  LLM-->>RT: 構造化応答
  RT-->>Chat: ストリーミング応答
  Chat-->>User: 表示（Markdown/Mermaid/Chart.js）
```

v1のAgent preview/testは停止性を保証するため、1 RunあたりTool call最大4回・model round最大5回とする。各roundでは保存済みAgent versionに固定された同じTool集合を提示し、preview/testは候補集合全体がread-onlyの場合だけ実行する。
Structured Outputを持つAgentは最終contentをJSON parseし、required、primitive型、追加field禁止を検証してからRunへ保存する。

Toolの終端は`agent-output`、`workspace-output`、または`graph-output`で明示する。後二者では同一Agent Session内の複数RunとサブAgentがArtifactを再利用できるが、payload全体はLLMへ自動注入しない。`graph-output`は入力行をedge、指定列をnodeとして保存する。Session、Artifact、quota、TTLの境界は [ADR-0027](./adr/0027-tool-output-and-session-workspace.md) を参照。

---

## 4. 検証（疑似ユーザー）実行

`ideas.md §機能` / `ideas-v2.md §11`。疑似ユーザーエージェントに実際に利用させ、期待Skill/Tool・順序・引数・成否を測る。

```mermaid
sequenceDiagram
  actor Tester as 検証者
  participant VUI as 検証画面
  participant VE as Validation Engine
  participant PU as 疑似ユーザーAgent
  participant TA as 対象Agent
  participant Rep as レポート

  Tester->>VUI: 検証ケース定義（期待Skill/Tool/順序/引数/成否）
  VUI->>VE: run(cases)
  loop 各ケース
    VE->>PU: ユーザープロファイルでシナリオ実行
    PU->>TA: 対話（実利用フロー）
    TA-->>PU: 応答（Tool呼び出し含む）
    VE->>VE: 呼び出しSkill/Tool・順序・引数・出力を記録
  end
  VE->>VE: 指標集計（適合率・成功率・コスト・回帰差分）
  VE->>Rep: 定量指標 + 定性評価（感想/アンケート）
  Rep-->>Tester: 検証レポート
```

測定指標は [09-roadmap.md](./09-roadmap.md#検証指標) を参照。

複数ターン会話の終了条件（疑似ユーザーの `endConversation` / `maxUserTurns` 上限 / エラー）とアンケート取得の詳細シーケンスは [11-scenario-validation.md §4-§5](./11-scenario-validation.md) を参照。対象Agentの1ターンには本ドキュメントの実行上限（Tool call 4回 / model round 5回）と read-only 制約がそのまま適用される。

---

## 5. Workflow実行（Phase 3）

複数Toolの接続・分岐・反復・再試行・承認・スケジュール実行。制御ノードはここに属する。

```mermaid
flowchart TB
  START["トリガー<br/>cron / Webhook / 手動"] --> STEP1["Tool A 実行"]
  STEP1 --> BR{"分岐 if/switch"}
  BR -->|条件1| LOOP["foreach ループ"]
  BR -->|条件2| STEP2["Agent 起動"]
  LOOP --> TRY["try / catch"]
  TRY -->|成功| APPROVE{"承認要?<br/>write/external-action"}
  TRY -->|失敗| RETRY["再試行"]
  APPROVE -->|承認| SINK["結果格納 / 通知"]
  RETRY --> STEP1
  STEP2 --> SINK

  classDef ctrl fill:#fff3e0,stroke:#e65100;
  class BR,LOOP,TRY,RETRY,APPROVE ctrl;
```

---

## 6. 実行トレースの可視化

最小版（v1）: どのノード・どのサンプル行で落ちたかを色で示す。フル観測（Status画面の本格版）はPhase 4。

```mermaid
flowchart LR
  RUN["実行"] --> SPAN["TelemetryPort: span生成"]
  SPAN --> TRACE["トレース収集"]
  TRACE --> VIS["Status画面で可視化"]
  VIS --> NODE_STATE["ノード状態: 成功/失敗/未達"]
  VIS --> ROW_STATE["失敗行のハイライト"]
  TRACE --> AUD["AuditSink: 実行者/入力参照/使用Tool/承認/結果/エラー"]

  classDef ok fill:#e8f5e9,stroke:#2e7d32;
  class NODE_STATE ok;
```

- トレースは `TelemetryPort` 経由（[04-api-spec.md](./04-api-spec.md#24-永続化観測監査)）。
- 監査ログは秘密情報・個人情報をマスキングして `AuditSink` へ。
- v1ローカル実装は成功/失敗Runと最小traceを `RunRepository`（SQLite）へ保存し、Status画面から再取得する。OpenTelemetry exportとretention policyは後続で追加する。
