# 05. 依存グラフとレイヤ依存ルール

> 参照: [`ideas-v2.md` §0(原則5), §8 SDK境界ルール](../ideas/ideas-v2.md) / [01-architecture.md](./01-architecture.md)

SOLID原則（特にDIP: 依存性逆転）を機構として強制するための、パッケージ依存と `import` 制約を定義する。**依存は常に内側（ドメイン）へ向かう。**

---

## 1. パッケージ依存グラフ（モノレポ想定）

```mermaid
flowchart TB
  subgraph inner["内核（SDK非依存）"]
    DOMAIN["@app/domain<br/>エンティティ・値オブジェクト・Port定義(interface)"]
    APP["@app/application<br/>ユースケース"]
  end

  subgraph adapters["アダプター（SDK依存）"]
    A_MASTRA["@app/adapter-mastra"]
    A_MODEL["@app/adapter-model<br/>LM Studio / Cloud"]
    A_MCP["@app/adapter-mcp"]
    A_AUTH["@app/adapter-auth-oidc"]
    A_STORE["@app/adapter-storage"]
    A_SEC["@app/adapter-secret"]
    A_TEL["@app/adapter-telemetry"]
  end

  subgraph edges2["外殻"]
    UI["@app/ui<br/>React / Mermaid / Chart.js"]
    API["@app/api<br/>REST/RPC ルート"]
    ROOT["@app/composition-root<br/>DI・Adapter選択"]
  end

  subgraph testpkg["テスト"]
    FAKES["@app/test-fakes<br/>各PortのFake実装"]
  end

  APP --> DOMAIN
  A_MASTRA --> DOMAIN
  A_MODEL --> DOMAIN
  A_MCP --> DOMAIN
  A_AUTH --> DOMAIN
  A_STORE --> DOMAIN
  A_SEC --> DOMAIN
  A_TEL --> DOMAIN
  FAKES --> DOMAIN

  API --> APP
  UI --> API

  ROOT --> APP
  ROOT --> A_MASTRA & A_MODEL & A_MCP & A_AUTH & A_STORE & A_SEC & A_TEL
  ROOT --> FAKES

  classDef corepkg fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
  classDef adapterpkg fill:#fce4ec,stroke:#ad1457,color:#880e4f;
  classDef rootpkg fill:#ede7f6,stroke:#4527a0,color:#311b92;
  class DOMAIN,APP corepkg;
  class A_MASTRA,A_MODEL,A_MCP,A_AUTH,A_STORE,A_SEC,A_TEL adapterpkg;
  class ROOT rootpkg;
```

**読み方**
- すべての矢印は「依存する先」を指す。`@app/domain` は何も指さない（最内核）。
- アダプターは `domain` が定義した **Port（interface）を実装** するために `domain` へ依存する。SDKへの依存はアダプター内部に閉じる。
- `composition-root` だけがアダプターとFakeの両方を知り、実行時に注入する。

---

## 2. 外部SDKの隔離境界

`ideas-v2.md §8`「SDKのimportはinfrastructure/adapter層に限定する」を図示。

```mermaid
flowchart LR
  subgraph forbidden["❌ SDK import 禁止ゾーン"]
    D["domain"]
    A["application"]
    U["ui"]
  end
  subgraph allowed["✅ SDK import 許可ゾーン"]
    AD["adapter-*"]
  end

  MASTRA_SDK["mastra"] -. import .-> AD
  LLM_SDK["LLM SDK / LM Studio"] -. import .-> AD
  MCP_SDK["MCP SDK"] -. import .-> AD
  OIDC_SDK["OIDC ライブラリ"] -. import .-> AD

  MASTRA_SDK -. "❌禁止" .-x D
  MASTRA_SDK -. "❌禁止" .-x A

  AD -->|Port実装| D

  classDef bad fill:#ffebee,stroke:#c62828,color:#b71c1c;
  classDef good fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
  class D,A,U bad;
  class AD good;
  style forbidden fill:#ffebee,stroke:#c62828,color:#b71c1c
  style allowed fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
```

---

## 3. レイヤ依存ルール表

| From ↓ \ To → | domain | application | adapter | api | ui | composition |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **domain** | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| **application** | ✅ | — | ❌※ | ❌ | ❌ | ❌ |
| **adapter** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **api** | ✅ | ✅ | ❌ | — | ❌ | ❌ |
| **ui** | 型のみ | ✅(API経由) | ❌ | ✅ | — | ❌ |
| **composition** | ✅ | ✅ | ✅ | ✅ | ✅ | — |

- ※ `application → adapter` は禁止。アプリケーションは **Port（interface）にのみ依存** し、実装は注入で受け取る。
- 外部SDKへの `import` は **adapter 行のみ**が許される。

---

## 4. 依存ルールの機械的強制

ルールをレビュー任せにせず、CIで機械検証する（🔷 提案）。

```mermaid
flowchart LR
  CODE["ソースコード"] --> LINT["import境界Lint<br/>(eslint boundaries / dependency-cruiser)"]
  LINT --> CHECK{"禁止依存あり?"}
  CHECK -->|Yes| FAIL["CI失敗"]
  CHECK -->|No| CONTRACT["契約テスト<br/>実Adapter vs Fake"]
  CONTRACT --> COV["カバレッジ計測<br/>（ideas.md 開発Tools）"]
  COV --> PASS["マージ可"]
```

- **import境界Lint**: `domain`/`application`/`ui` からのSDK importと、レイヤ違反を検出。
- **契約テスト**: 各Portで実SDKアダプターとFakeが同一契約を満たすことを保証（[04-api-spec.md](./04-api-spec.md)）。
- **カバレッジ計測**: `ideas.md §開発Tools` の要件。

---

## 5. ランタイム依存（実行時のオブジェクトグラフ）

静的なパッケージ依存とは別に、実行時にComposition Rootが組み立てる依存グラフ。

```mermaid
flowchart TB
  ENV["env プロファイル"] --> ROOT["Composition Root"]

  ROOT --> UC["UseCases"]
  UC --> P_RUN["AgentRuntimePort"]
  UC --> P_MODEL["ModelProviderPort"]
  UC --> P_STORE["StoragePort"]
  UC --> P_AUTH["AuthorizationProvider"]
  UC --> P_SEC["SecretProvider"]

  P_RUN -. local .-> IMPL_MASTRA["MastraAdapter"]
  P_MODEL -. local .-> IMPL_LMS["LMStudioAdapter"]
  P_MODEL -. team .-> IMPL_CLOUD["CloudLLMAdapter"]
  P_STORE -. local .-> IMPL_SQLITE["SQLite"]
  P_STORE -. team .-> IMPL_PG["PostgreSQL"]
  P_STORE -. test .-> IMPL_MEM["InMemory"]
  P_AUTH -. team .-> IMPL_RBAC["RBACAdapter"]
  P_SEC --> IMPL_VAULT["Vault/KMS"]

  classDef port fill:#e3f2fd,stroke:#1565c0;
  class P_RUN,P_MODEL,P_STORE,P_AUTH,P_SEC port;
```

プロファイル（`local` / `team` / `test`）ごとの実装割り当ては [02-tech-stack.md](./02-tech-stack.md#5-環境プロファイルenv) を参照。

---

## 6. 依存に関する不変条件

- [ ] `domain` はいかなる他パッケージにも依存しない
- [ ] `application` は Port（interface）にのみ依存し、具体Adapterへ依存しない
- [ ] 外部SDKの `import` は `adapter-*` パッケージ内に限定する
- [ ] Adapterの生成・選択は `composition-root` 以外で行わない
- [ ] SDKバージョン更新の影響範囲は原則Adapter内に収める。共通契約変更時は影響ユースケースを明示する
