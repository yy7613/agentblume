# 08. セキュリティ・認証認可設計

> 参照: [`ideas-v2.md` §9 セキュリティ最低要件, §10 認証・認可](../ideas/ideas-v2.md)

本製品独自のユーザー管理へ固定せず、一般的なWebアプリの認証・認可機能を **アダプターとして挿入** できる構造にする。認証画面だけを挿してAPIが無防備になる状態を防ぐため、認証・認可は「画面 + HTTPミドルウェア + APIルート + サーバー側ポリシー判定 + 監査」を一つの構成単位として登録する。

---

## 1. セキュリティ最低要件

DB/API接続・カスタムコード・MCP公開・Webhookを提供する前に、次を満たす。

| # | 要件 |
|---|---|
| 1 | 資格情報はフロー・プロンプト・生成コードへ埋め込まず、`SecretProvider` の参照として保存する |
| 2 | カスタムコードは時間・メモリ・CPU・ネットワーク・ファイルアクセス・利用可能パッケージを制限した分離環境で実行する |
| 3 | Toolは副作用を `read-only / write / external-action` として宣言し、`write` と `external-action` は実行前承認を要求する |
| 4 | MCP・Webhook・公開Agentのエンドポイントは未認証公開を既定にしない |
| 5 | 実行者・対象バージョン・入力参照・使用Tool・承認・結果・エラーを監査ログへ記録し、秘密情報・個人情報はマスキングする |
| 6 | ワークスペース・接続・Tool・Skill・Agent・公開エンドポイントごとにアクセス制御を適用できる |

---

## 2. 認証（Authentication）

### 2.1 標準接続境界

```mermaid
flowchart LR
  subgraph App["agentblume"]
    AN["AuthenticationProvider"]
    PM["PrincipalMapper"]
    PR["内部Principal<br/>subject / tenant / displayName<br/>groups / claims / authenticationMethod"]
  end

  subgraph IdP["Identity Provider（差し替え可）"]
    ENTRA["Microsoft Entra ID"]
    AUTH0["Auth0"]
    KC["Keycloak"]
    OKTA["Okta"]
    LOCAL["ローカル認証<br/>（小規模/開発。本番既定にしない）"]
  end

  IdP -->|OIDC / OAuth2| AN
  AN --> PM --> PR

  classDef pr fill:#e8f5e9,stroke:#2e7d32;
  class PR pr;
```

- **Web UI**: Authorization Code Flow + PKCE を基本。
- **API**: 短寿命アクセストークン or 安全なサーバーサイドセッション。
- **Webhook / MCP / サービス間**: ユーザー認証と分離した Service Principal / Client Credentials / 署名付きトークン。

### 2.2 Authorization Code Flow + PKCE

```mermaid
sequenceDiagram
  actor User
  participant UI as Web UI
  participant AN as AuthenticationProvider
  participant IdP as Identity Provider
  participant PM as PrincipalMapper

  User->>UI: ログイン
  UI->>UI: code_verifier生成 → code_challenge
  UI->>IdP: 認可要求（code_challenge, PKCE）
  IdP->>User: 認証・同意
  User->>IdP: 資格情報
  IdP-->>UI: authorization code
  UI->>AN: handleCallback(code, code_verifier)
  AN->>IdP: token交換（code + verifier）
  IdP-->>AN: id_token / access_token
  AN->>PM: toPrincipal(claims)
  PM-->>AN: 内部Principal（正規化）
  AN-->>UI: Session（HttpOnly/Secure/SameSite Cookie）
  Note over UI,AN: セッションIDのローテーション・失効・CSRF対策を共通基盤で
```

### 2.3 アカウント機能のCapability化

ログイン/ログアウト/登録/招待/メール確認/パスワード再設定/MFA・パスキー/ソーシャルログイン/セッション失効/アカウント無効化を **任意機能（Capability）** として宣言する。外部IdPが担当する機能をアプリ側で重複実装しない（`AuthFeatureProvider`、[04-api-spec.md](./04-api-spec.md#25-認証機能uiのcapability拡張)）。

---

## 3. 認可（Authorization）

認証済みPrincipalに対して認可する。認証の有無だけで操作を許可しない。初期実装はRBAC、将来ABAC/Policy Engineへ拡張できるインターフェースを用意する。

### 3.1 認可判定モデル

```mermaid
flowchart LR
  REQ["要求"] --> AZ["AuthorizationProvider.decide"]
  P["Principal"] --> AZ
  R["Resource<br/>workspace/connection/secret-ref/<br/>tool/skill/agent/workflow/<br/>deployment/audit-log"] --> AZ
  A["Action<br/>read/create/edit/execute/<br/>approve/publish/manage-access/delete"] --> AZ
  C["Context（将来ABAC）<br/>所有者/環境/データ分類/テナント/副作用"] --> AZ
  AZ --> D{"判定"}
  D -->|Allow| OK["許可"]
  D -->|Deny / 未定義 / 利用不能| DENY["既定で拒否"]

  classDef deny fill:#ffebee,stroke:#c62828,color:#b71c1c;
  class DENY deny;
```

> **フェイルセーフ**: 権限が未定義、または認可プロバイダーが利用不能な場合は既定で拒否する。UI非表示だけに依存せず、すべてのAPI・実行要求・公開操作でサーバー側判定を行う。

### 3.2 RBAC ロール × アクション（初期実装）

ロールはワークスペース単位で割り当てる。

| リソース \ ロール | Viewer | Editor | Publisher | Operator | Workspace Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| tool / skill / agent（read） | ✅ | ✅ | ✅ | ✅ | ✅ |
| tool / skill / agent（create/edit） | — | ✅ | ✅ | ✅ | ✅ |
| 実行（execute） | — | ✅ | ✅ | ✅ | ✅ |
| 承認（approve） | — | — | ✅ | ✅ | ✅ |
| 公開（publish / deployment） | — | — | ✅ | — | ✅ |
| 運用・実行監視（operate） | — | — | — | ✅ | ✅ |
| アクセス管理（manage-access） | — | — | — | — | ✅ |
| 削除（delete） | — | 自作のみ | 自作のみ | — | ✅ |
| audit-log（read） | — | — | — | ✅ | ✅ |

> 判定操作は `read / create / edit / execute / approve / publish / manage-access / delete` に分離。将来、所有者・環境・データ分類・テナント・Toolの副作用を条件にできるABACを追加。

---

## 4. 副作用と実行前承認

```mermaid
flowchart TB
  CALL["Tool実行要求"] --> SE{"副作用宣言"}
  SE -->|read-only| RUN["即実行"]
  SE -->|write| APPR["実行前承認（ポリシー）"]
  SE -->|external-action| APPR
  APPR --> AZ["approve 権限を認可判定"]
  AZ -->|承認| RUN
  AZ -->|拒否| BLOCK["実行拒否 → 監査記録"]
  RUN --> AUD["AuditSink 記録"]

  classDef block fill:#ffebee,stroke:#c62828,color:#b71c1c;
  class BLOCK block;
```

副作用宣言はTool側のメタデータ（[06-etl-tool-builder.md](./06-etl-tool-builder.md#36-副作用の宣言)）で行い、実行シーケンスは [07-execution-model.md](./07-execution-model.md#3-agentチャット実行tool-calling) を参照。

---

## 5. 秘密情報（Secrets）

```mermaid
flowchart LR
  CONN["接続定義"] -->|参照のみ保持| REF["SecretReference"]
  REF -.実行時に解決.-> SP["SecretProvider"]
  SP --> VAULT["Vault / KMS / env"]
  VAULT -->|SecretValue| RUNTIME["実行時のみ利用"]

  ADMIN["管理者"] -. "標準画面から<br/>秘密値は読めない" .-x VAULT

  classDef block fill:#ffebee,stroke:#c62828,color:#b71c1c;
  class ADMIN block;
```

- 接続情報は **参照（SecretReference）** として保存し、実行時に `SecretProvider` が解決する。
- 管理者であっても秘密値そのものを標準画面から読み出せない設計を基本とする。

---

## 6. テナントと権限境界

```mermaid
flowchart TB
  subgraph Tenant["テナント / ワークスペース境界"]
    direction LR
    DATA["すべての永続データに<br/>tenant/workspace境界"]
    QUERY["問い合わせ時に必ず適用"]
  end

  IDP_GRP["外部IdPのgroup/role"] -->|マッピング| INT_ROLE["内部ロール"]

  subgraph Provisioning["ユーザー作成経路（テナントポリシーで制御）"]
    JIT["初回ログインJITプロビジョニング"]
    INVITE["管理者による招待"]
    SYNC["外部ディレクトリ同期"]
  end

  subgraph Delegation["Agent代理接続の区別"]
    SHARED["共有資格情報"]
    USERDEL["ユーザー委任"]
    SVC["サービス資格情報"]
  end
```

- すべての永続データにtenant/workspace境界を持たせ、問い合わせ時に必ず適用する。
- 外部IdPのgroup/roleを内部ロールへマッピングできるようにする。
- Agentが利用者の代理で外部接続する場合、共有資格情報・ユーザー委任・サービス資格情報を区別して表示・監査する。

---

## 7. 監査（Audit）

```mermaid
flowchart LR
  EV["認証イベント / 認可拒否 / 承認 / 公開 / 実行"] --> MASK["秘密情報・個人情報マスキング"]
  MASK --> SINK["AuditSink"]
  SINK --> EXT["外部監査基盤 / SIEM"]
```

記録対象: 実行者・対象バージョン・入力参照・使用Tool・承認・結果・エラー。関連Portは [04-api-spec.md](./04-api-spec.md#24-永続化観測監査) を参照。

---

## 8. 認証・認可の拡張インターフェース一覧

| インターフェース | 責務 |
|---|---|
| `AuthenticationProvider` | ログイン・ログアウト・コールバック・セッション/トークン検証 |
| `AuthFeatureProvider` | 登録・招待・メール確認・パスワード再設定・MFA・セッション一覧の対応可否と実行 |
| `AuthUiExtension` | ログイン・登録・アカウント・セッション・メンバー管理画面の差し替え |
| `PrincipalMapper` | IdP固有claimを内部Principalへ変換 |
| `AuthorizationProvider` | Principal・resource・action・context → 許可/拒否 |
| `SecretProvider` | 接続情報の参照と実行時取得（資格情報の保管を認証認可から分離） |
| `AuditSink` | 認証イベント・認可拒否・承認・公開・実行を外部監査基盤へ転送 |

型定義は [04-api-spec.md](./04-api-spec.md#23-認証認可秘密詳細は-08-参照) を参照。
