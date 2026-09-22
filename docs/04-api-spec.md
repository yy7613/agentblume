# 04. API仕様

> 参照: [01-architecture.md](./01-architecture.md)

APIは3層に分かれる。
1. **Portインターフェース** — アプリケーションが所有する外部SDK境界（内部契約）。
2. **REST/RPC API** — Web UIやWebhookからユースケースを駆動する外部API。
3. **Tool Callingスキーマ** — LLMがToolを呼ぶための引数スキーマ（Input/Output Schema）。

> 型記法はTypeScriptを想定（`ideas.md` のMastra前提）。`Result<T, E>` は成功/失敗を型で表す想定の値。

---

## 1. API表層マップ

```mermaid
flowchart LR
  subgraph Ext["外部呼び出し元"]
    UI["Web UI"]
    LLM["LLM (Tool Calling)"]
    HOOK["Webhook / cron / MCP Client"]
  end

  subgraph API["REST / RPC API"]
    R1["/tools"]
    R2["/skills"]
    R3["/agents"]
    R4["/runs"]
    R5["/validations"]
    R6["/mcp"]
    R7["/auth"]
  end

  subgraph Ports["Portインターフェース（内部契約）"]
    P1["AgentRuntimePort"]
    P2["ModelProviderPort"]
    P3["McpClient/ServerPort"]
    P4["AuthN/Z / Secret / Storage / Telemetry / Audit"]
  end

  UI --> API
  HOOK --> API
  LLM -->|input schema| R4
  API --> Ports
```

---

## 2. Portインターフェース定義

外部SDKはこれらのPortを介してのみ利用する。SDK固有の型・例外・ストリームイベント・認証設定は内部共通型へ変換する。

### 2.1 実行・モデル系

```typescript
interface AgentRuntimePort {
  run(input: {
    agentRef: PublishRef;
    messages: Message[];
    context: MinimalContext;      // LLMへ渡すコンテキストは最小限
    mode: "preview" | "test" | "production";
  }): AsyncIterable<RuntimeEvent>; // ストリーミングは内部イベントへ正規化

  cancel(runId: RunId): Promise<void>;
}

interface HarnessRuntimePort {
  start(input: StartHarnessInput, signal?: AbortSignal): Promise<HarnessRunSnapshot>;
  resume(input: ResumeHarnessInput, signal?: AbortSignal): Promise<HarnessRunSnapshot>;
}

interface ModelProviderPort {
  // v1 Agent previewはTool Callingを含む正規化済みcompletionを返す。
  // token streamingは後続のAgentRuntimePort実装で共通RuntimeEventへ拡張する。
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<ModelCompletion>;
  capabilities(): ModelCapability[]; // 未対応機能は暗黙フォールバックしない
}
```

`ModelProviderPort` のcapabilityは `chat` / `tool-calling` / `structured-output` / `vision` である。`vision` を持つproviderには、ユーザー入力をテキストpartと`image_url` partの配列として渡せる。LM Studio adapterは画像のデータURLをOpenAI互換の`image_url.url`へ変換する。埋め込みはRAG導入時に `embed` capabilityと要求型を追加する。

AgentにStructured Outputがある場合、completion requestへ`responseFormat: { name, strict, schema }`を指定する。LM Studio adapterはOpenAI互換`response_format.json_schema`へ変換し、最終contentはアプリケーション側でも再検証する。

### 2.2 MCP系

```typescript
interface McpClientPort {
  listTools(server: McpServerRef): Promise<ToolDescriptor[]>;
  callTool(server: McpServerRef, name: string, args: Json): Promise<Json>;
}

interface McpServerPort {
  publish(tool: ToolRef, exposeAs: PublishName): Promise<McpEndpoint>;
  unpublish(endpoint: McpEndpoint): Promise<void>;
  // 既定で未認証公開にしない
}
```

### 2.3 認証・認可・秘密（詳細は 08 参照）

```typescript
interface AuthenticationProvider {
  login(req: LoginRequest): Promise<Session>;
  logout(session: SessionRef): Promise<void>;
  handleCallback(cb: OidcCallback): Promise<Session>;
  verify(token: Token | SessionRef): Promise<Principal>;
}

interface AuthorizationProvider {
  // 権限未定義 or プロバイダー利用不能時は既定で拒否
  decide(input: {
    principal: Principal;
    resource: ResourceRef;   // workspace | connection | secret-ref | tool | skill | agent | workflow | deployment | audit-log
    action: Action;          // read | create | edit | execute | approve | publish | manage-access | delete
    context?: PolicyContext;
  }): Promise<Decision>;      // Allow | Deny(reason)
}

interface PrincipalMapper {
  toPrincipal(claims: IdpClaims): Principal; // subject/tenant/displayName/groups/claims/authenticationMethod
}

interface SecretProvider {
  resolve(ref: SecretReference): Promise<SecretValue>; // 実行時のみ取得
  register(ref: SecretReference, value: SecretValue): Promise<void>;
  // 管理者でも標準画面から秘密値そのものは読み出せない
}
```

### 2.4 永続化・観測・監査

```typescript
interface StoragePort {
  // すべての問い合わせに tenant/workspace 境界を適用
  save<T>(entity: T, scope: TenantScope): Promise<Id>;
  load<T>(id: Id, scope: TenantScope): Promise<T | null>;
  listVersions(ref: PublishRef, scope: TenantScope): Promise<Version[]>;
}

interface TelemetryPort {
  startSpan(name: string, attrs: Attrs): Span;
  metric(name: string, value: number, attrs: Attrs): void;
}

interface AuditSink {
  // 実行者・対象バージョン・入力参照・使用Tool・承認・結果・エラーを記録
  // 秘密情報・個人情報はマスキング
  record(event: AuditEvent): Promise<void>;
}
```

### 2.5 認証機能・UIのCapability拡張

```typescript
interface AuthFeatureProvider {
  supports(feature: AuthFeature): Capability; // registration/invite/emailVerify/passwordReset/mfa/socialLogin/sessionList ...
  execute(feature: AuthFeature, req: Json): Promise<Json>;
}

interface AuthUiExtension {
  routes(): UiRoute[];                 // login/register/account/session/member管理
  component(route: UiRoute): UiComponent;
}
```

### 2.6 ツールテンプレート

```typescript
interface ToolTemplateCatalogPort {
  list(): Promise<ToolTemplateCatalog>; // templates: 読めたテンプレート / invalid: 読めなかったfile（理由と直し方つき）
}
```

テンプレートは**外部ファイル**（`templates/tools/*.json` + `AGENTCONTEXT_TOOL_TEMPLATES_DIR`）なので、壊れたfileは黙って落とさず`invalid[]`へ理由付きで残す。代表Adapterはファイルシステム（`FsToolTemplateCatalog`）で、要求時に読みファイルの更新時刻・サイズでキャッシュする。詳細は[ADR-0049](./adr/0049-tool-templates.md) / [implementation/v43](../implementation/v43-tool-templates.md) §1。

### 2.7 プロンプトカタログ

```typescript
interface PromptCatalogPort {
  // 読み込み済みのプロンプトを返す。ファイルの更新時刻・サイズが変わっていれば読み直す
  // （壊れていれば直前の良い版を返して警告を残す）。id が無ければ PromptNotFoundError。
  get(id: string): PromptTemplate; // { id, version, sections, render(section, vars?) }
  // 起動時の検査。無い id / 無い節を、ファイルの置き場所と直し方つきで一括で投げる（MissingPromptsError）。
  require(specs: readonly PromptSpec[]): void; // PromptSpec = { id, sections }
}
```

モデルへ送る指示文（system の規則・差し戻しの文・タスクの目的）は**外部ファイル**（`prompts/**/*.md` + `AGENTCONTEXT_PROMPTS_DIR`）で持つ。どの節をどの順に使うか・条件での入れ替え・untrusted dataの隔離（`wrapUntrusted`）・JSON schemaはコードに残し、ファイルには文だけを置く。代表Adapterはファイルシステム（`FsPromptCatalog`）で、起動時に全件読み、コードが宣言した`PromptSpec`（id・節）が揃っているかを`require`で検査する（揃っていなければどのファイルの何が無いかを出して起動を止める）。実行中はファイルの更新時刻で再読込し、壊れたファイルは直前の良い版を使い続ける。詳細は[ADR-0052](./adr/0052-prompt-files.md) / [implementation/v48](../implementation/v48-prompt-files.md)。

> **契約テスト**: 各Portには契約テストを用意し、実SDKアダプターとFakeが同じ契約を満たすことを検証する（[01-architecture.md](./01-architecture.md#5-composition-root-と依存性注入)）。

---

## 3. REST / RPC API

Web UI・Webhookからユースケースを駆動する外部API。**すべてのエンドポイントでサーバー側の認可判定を行う**。

> 実装では、ルート → 必要権限の対応表を `src/api/authorization.ts` の `ROUTE_RULES` が1箇所で持ち、`onRequest` フックが全ルートへ機械的に適用する。下表は主要エンドポイントの抜粋で、**正本は `ROUTE_RULES`**（登録済みの全ルートが載っていることをテストが強制する）。ロールとアクションの対応は [08-security-auth.md §3.2](./08-security-auth.md#32-rbac-ロール--アクション初期実装)。

| メソッド | パス | ユースケース | 認可アクション |
|---|---|---|---|
| `POST` | `/tools` | Tool作成（ノードフロー） | `tool:create` |
| `GET` | `/tools` | workspace内のTool latest一覧 | `tool:read` |
| `PUT` | `/tools/{id}` | Toolフロー更新 | `tool:edit` |
| `POST` | `/tools/{id}/preview` | 固定サンプルでプレビュー実行 | `tool:execute` |
| `POST` | `/tools/{id}/infer-schema` | スキーマ伝播・推論 | `tool:edit` |
| `POST` | `/tool-drafts/diagnose` | 未保存Toolのプリフライト診断（`POST /tools` と同じbodyを受け、保存せずに検査。§3.1） | `tool:execute` |
| `GET` | `/tool-templates` | ツールテンプレートの一覧（読めたものと、読めなかったファイルの理由と直し方。§3.8） | `tool:read` |
| `POST` | `/tool-templates/{id}/slot-candidates` | スロットごとの候補（列の型・実在値の例・粒度・結合キーの重なり付き。§3.8） | `tool:read` |
| `POST` | `/tool-templates/{id}/instantiate` | テンプレートの実体化（保存しない。手で組んだ Tool と同じ検査を通す。§3.8） | `tool:execute` |
| `POST` | `/tool-checks/run` | ツール検証: 保存済みToolを引数付きで単体実行し、期待との合否を返す（保存しない。§3.2） | `tool:execute` |
| `GET` | `/tool-checks/cases` | ツール検証ケースの一覧（`toolId` で絞り込み。新しい定義が先） | `tool:read` |
| `POST` | `/tool-checks/cases` | ツール検証ケースの保存（`id` 省略で新規、指定で上書き） | `tool:edit` |
| `DELETE` | `/tool-checks/cases/{id}` | ツール検証ケースの削除 | `tool:edit` |
| `POST` | `/tool-checks/cases/{id}/run` | 保存済みケースを実行し `lastResult` を更新 | `tool:execute` |
| `POST` | `/tool-checks/cases/run-all` | 全ケース（または `toolId` のケース）を逐次実行 | `tool:execute` |
| `POST` | `/tool-checks/suggest` | LLM による 正常 / 境界 / 異常 のケース案（保存しない。モデル未設定は 502。§3.2） | `tool:execute` |
| `GET` | `/runtime/capabilities` | UI の機能フラグ: `{ analysisAssistant: { enabled }, toolCheckSuggestions: { enabled }, judge: { configured, provider?, model? }, journal: { extraction: { enabled, vision }, hearing: { enabled } }, expense: { extraction: { enabled, vision } }, receivables: { invoiceDraft: { enabled, vision } }, contract: { extraction: { enabled, vision }, review: { llm } } }`（現在のモデル設定を毎回見る。業務ごとのキーは業務が自分のキーだけを返す。§3.5〜§3.7、ADR-0039 §5） | `workspace:read` |
| `GET` | `/journal/chart` | 科目マスタの取得（未保存なら標準セット。保存はしない。§3.4） | `workspace:read` |
| `PUT` | `/journal/chart` | 科目マスタの全体保存 | `workspace:edit` |
| `POST` | `/journal/chart/reset` | 科目マスタを標準セットへ戻す | `workspace:edit` |
| `GET` | `/journal/chart/export` | 科目 CSV の出力（`{ content }`） | `workspace:read` |
| `POST` | `/journal/chart/import` | 科目 CSV の取込（勘定科目の一覧だけを置き換え） | `workspace:edit` |
| `GET` | `/journal/rules` | 自動仕訳ルールの一覧（priority 降順） | `workspace:read` |
| `POST` | `/journal/rules` | ルールの保存（`id` 省略で新規、指定で上書き） | `workspace:edit` |
| `DELETE` | `/journal/rules/{id}` | ルールの削除 | `workspace:edit` |
| `POST` | `/journal/rules/test` | ルール草案を保存せずに文書群へ照合 | `workspace:read` |
| `GET` | `/journal/documents` | 文書一覧（**要約**。証憑本体を含まない。`status` / `kind` / `from` / `to` / `limit`） | `workspace:read` |
| `POST` | `/journal/documents` | 文書の作成（facts 直接 / JSON 貼付） | `workspace:edit` |
| `GET` | `/journal/documents/{id}` | 文書の取得（証憑本体つき） | `workspace:read` |
| `PUT` | `/journal/documents/{id}` | 文書の更新（facts が変われば未判定へ戻る） | `workspace:edit` |
| `DELETE` | `/journal/documents/{id}` | 文書の削除（下書きの仕訳も消す） | `workspace:edit` |
| `POST` | `/journal/documents/import-csv` | 銀行 / カード明細 CSV の取込（1 行 = 1 文書。読めない行は `skippedRows`） | `workspace:edit` |
| `POST` | `/journal/documents/judge` | Stage 1 判定（`documentIds` 省略で未判定の全件） | `workspace:edit` |
| `GET` | `/journal/csv-presets` | CSV プリセットの一覧（列名署名つき） | `workspace:read` |
| `GET` | `/journal/entries` | 仕訳一覧（`status` / `from` / `to` / `documentId`） | `workspace:read` |
| `POST` | `/journal/entries` | 仕訳の手入力（作成） | `workspace:edit` |
| `PUT` | `/journal/entries/{id}` | 仕訳の更新 | `workspace:edit` |
| `POST` | `/journal/entries/{id}/confirm` | 仕訳の確定（draft → confirmed） | `workspace:edit` |
| `DELETE` | `/journal/entries/{id}` | 仕訳の削除（紐づく文書は未判定へ戻る） | `workspace:edit` |
| `GET` | `/journal/export` | 仕訳 CSV の出力（`format` / `status` / `from` / `to` / `markExported`） | `workspace:read` |
| `POST` | `/journal/documents/extract` | 画像 / テキストから facts を LLM 抽出（**保存しない**。§3.4） | `workspace:edit` |
| `POST` | `/journal/hearings` | Stage 2 ヒアリングの開始（既に開いていればそれを返す） | `workspace:edit` |
| `GET` | `/journal/hearings` | ヒアリングの一覧（`documentId` で絞れる） | `workspace:read` |
| `GET` | `/journal/hearings/{id}` | ヒアリングの取得 | `workspace:read` |
| `POST` | `/journal/hearings/{id}/answers` | 回答 → 次の質問か提案 | `workspace:edit` |
| `POST` | `/journal/hearings/{id}/accept` | 提案の受け入れ（**選んだ id だけ**登録 → ルール保存 → 再判定） | `workspace:edit` |
| `POST` | `/journal/hearings/{id}/cancel` | ヒアリングの中止（文書は未判定へ戻る） | `workspace:edit` |
| `GET` | `/expense/policy` | 規程の取得（未保存なら初期テンプレート。保存はしない。§3.5） | `workspace:read` |
| `PUT` | `/expense/policy` | 規程の全体保存 | `workspace:edit`（監査） |
| `POST` | `/expense/policy/reset` | 規程を初期テンプレートへ戻す | `workspace:edit`（監査） |
| `GET` | `/expense/policy/export` | 費目 CSV の出力 | `workspace:read` |
| `POST` | `/expense/policy/import` | 費目 CSV の取込 | `workspace:edit`（監査） |
| `GET` | `/expense/claims` | 申請一覧（`status` / `verdict` / `claimant` / `from` / `to` / `limit`） | `workspace:read` |
| `POST` | `/expense/claims` | 申請の作成（`draft`） | `workspace:edit` |
| `POST` | `/expense/claims/import-csv` | 経費明細 CSV の取込（申請者ごとに申請を作る） | `workspace:edit` |
| `POST` | `/expense/claims/check` | Stage 1 判定（`claimIds` 省略で `draft` / 判定が古いもの全件） | `workspace:edit` |
| `POST` | `/expense/claims/settle` | 精算済みの一括登録（`approved` 以外が混ざれば 409） | `workspace:edit`（監査） |
| `GET` / `PUT` / `DELETE` | `/expense/claims/{id}` | 申請の取得 / 更新（判定済みなら `draft` へ戻る）/ 削除（証憑本体も削除） | read / edit / edit（監査） |
| `POST` | `/expense/claims/{id}/items` | 明細の保存（`itemId` 省略で新規） | `workspace:edit` |
| `DELETE` | `/expense/claims/{id}/items/{itemId}` | 明細の削除 | `workspace:edit` |
| `GET` | `/expense/claims/{id}/items/{itemId}/receipt` | 証憑本体（data URL）の取得 | `workspace:read` |
| `POST` | `/expense/receipts/extract` | 画像 / PDF / テキストから明細の下書きを LLM 抽出（**保存しない**。§3.5） | `workspace:edit` |
| `POST` | `/expense/claims/{id}/acknowledge` | 要確認の理由 1 件の確認済み登録（根拠コメント必須） | `workspace:edit`（監査） |
| `GET` | `/expense/claims/{id}/return-draft` | 差し戻し文言の下書き（保存しない） | `workspace:read` |
| `POST` | `/expense/claims/{id}/return` | 差し戻し | `workspace:edit`（監査） |
| `POST` | `/expense/claims/{id}/approve` | 承認（自己承認・要確認未消化などは 409） | `workspace:approve`（監査） |
| `POST` | `/expense/claims/{id}/unapprove` | 承認取消 | `workspace:approve`（監査） |
| `POST` | `/expense/claims/{id}/journal-drafts` | 仕訳下書きの作成（仕訳 BC へ） | `workspace:edit`（監査） |
| `GET` | `/expense/export` | 精算 CSV の出力（`format=payout\|detail`。状態を変えない） | `workspace:read`（監査） |
| `GET` | `/receivables/settings` | 設定の取得（未保存なら初期値。§3.6） | `workspace:read` |
| `PUT` | `/receivables/settings` | 設定の全体保存 | `workspace:edit`（監査） |
| `GET` | `/receivables/customers` | 取引先一覧（`enabled` で絞り込み。未回収額つき） | `workspace:read` |
| `POST` | `/receivables/customers` | 取引先の作成 | `workspace:edit` |
| `GET` / `PUT` | `/receivables/customers/{id}` | 取引先の取得（別名つき）/ 更新 | read / edit |
| `DELETE` | `/receivables/customers/{id}` | 削除（参照が無いときだけ物理削除。あれば 409） | `workspace:edit`（監査） |
| `GET` | `/receivables/invoices` | 請求書一覧（`status` / `customerId` / `overdue` / `from` / `to`。要約） | `workspace:read` |
| `POST` | `/receivables/invoices/check` | 保存しない検査と税額集計 | `workspace:read` |
| `POST` | `/receivables/invoices` | 下書き作成（`check` の結果を同梱） | `workspace:edit` |
| `GET` / `PUT` / `DELETE` | `/receivables/invoices/{id}` | 取得（入金の配分履歴つき）/ 下書きの更新 / 削除（発行済みは 409） | read / edit / edit |
| `POST` | `/receivables/invoices/{id}/issue` | 発行 | `workspace:edit`（監査） |
| `POST` | `/receivables/invoices/{id}/void` | 取消（`reason` 必須） | `workspace:edit`（監査） |
| `POST` | `/receivables/invoices/{id}/duplicate` | 複製して下書きを作る | `workspace:edit` |
| `GET` | `/receivables/bank-csv-profiles` | 明細 CSV プロファイル一覧（組込み + 利用者） | `workspace:read` |
| `POST` | `/receivables/bank-csv-profiles` | プロファイルの保存（組込みへの上書きは 400） | `workspace:edit` |
| `DELETE` | `/receivables/bank-csv-profiles/{id}` | プロファイルの削除 | `workspace:edit` |
| `POST` | `/receivables/bank-transactions/preview` | 入金明細 CSV の文字コード・プリセット判定・先頭行プレビュー（保存しない） | `workspace:read` |
| `POST` | `/receivables/bank-transactions/import` | 入金明細の取込 | `workspace:edit` |
| `GET` | `/receivables/bank-transactions` | 入金明細一覧（`status` / `from` / `to` / `accountKey`） | `workspace:read` |
| `DELETE` | `/receivables/bank-transactions/{id}` | 明細の削除（`unmatched` / `ignored` のみ） | `workspace:edit`（監査） |
| `POST` | `/receivables/bank-transactions/{id}/ignore` / `/unignore` | 対象外にする / 戻す | `workspace:edit` |
| `POST` | `/receivables/matching/judge` | 消込候補の判定（`transactionIds` 省略で全未消込） | `workspace:edit` |
| `GET` | `/receivables/matching/candidates` | 1 明細の消込候補を保存せず計算 | `workspace:read` |
| `POST` | `/receivables/matchings` | 消込の確定（配分・手数料・別名学習） | `workspace:edit`（監査） |
| `POST` | `/receivables/matchings/confirm-decided` | `decided` の一括確定 | `workspace:edit`（監査） |
| `GET` | `/receivables/matchings` | 消込一覧（`status` / `invoiceId` / `transactionId`） | `workspace:read` |
| `POST` | `/receivables/matchings/{id}/cancel` | 消込の取消 | `workspace:edit`（監査） |
| `GET` / `POST` | `/contracts/playbooks` | 審査基準の一覧（0 件は既定テンプレートを保存せず返す。§3.7）/ 保存 | read / edit（監査） |
| `GET` | `/contracts/playbooks/{id}` | 審査基準の取得 | `workspace:read` |
| `DELETE` | `/contracts/playbooks/{id}` | 審査基準の削除 | `workspace:edit`（監査） |
| `GET` | `/contracts/playbook-templates` | 同梱テンプレートの一覧 | `workspace:read` |
| `POST` | `/contracts/playbooks/from-template` | テンプレートから審査基準を作成 | `workspace:edit`（監査） |
| `GET` | `/contracts/documents` | 契約文書一覧（**要約**。本文を含まない） | `workspace:read` |
| `POST` | `/contracts/documents/transcribe` | 画像 1〜4 枚を vision で文字起こし（**保存しない**） | `workspace:edit` |
| `POST` | `/contracts/documents` | 契約文書の取込（本文・ページ境界・当事者。条文分割もここで行う） | `workspace:edit` |
| `GET` / `PUT` / `DELETE` | `/contracts/documents/{id}` | 取得（本文つき）/ 更新（本文が変われば抽出・Review を破棄）/ 削除（`signed` は 409） | read / edit / edit（監査） |
| `POST` | `/contracts/documents/{id}/extract` | 条項抽出（LLM。結果を文書へ保存） | `workspace:edit` |
| `PUT` | `/contracts/documents/{id}/clauses` | 人が確認・修正した条項で確定 | `workspace:edit` |
| `POST` | `/contracts/documents/{id}/reviews` | レビュー実行（決定的判定 + LLM 基準） | `workspace:edit` |
| `GET` | `/contracts/reviews/{id}` | レビューの取得 | `workspace:read` |
| `PUT` | `/contracts/reviews/{id}/decisions` | 人の判断・メモの保存 | `workspace:edit` |
| `POST` | `/contracts/reviews/{id}/finalize` | レビューの確定（未判断が残れば 400） | `workspace:edit`（監査） |
| `POST` | `/contracts/deadlines/preview` | 締結日から期限を試算（保存しない） | `workspace:read` |
| `POST` | `/contracts/signed` | 締結登録 | `workspace:edit`（監査） |
| `GET` | `/contracts/signed` | 締結済み契約の一覧（`status` / `counterparty`） | `workspace:read` |
| `GET` / `PUT` / `DELETE` | `/contracts/signed/{id}` | 取得 / 条項・期限の手修正・終了日以外の更新 / 削除 | read / edit（監査） / edit（監査） |
| `POST` | `/contracts/signed/{id}/terminate` | 契約の終了 | `workspace:edit`（監査） |
| `GET` | `/contracts/deadlines` | 期限台帳（`withinDays` / `includeOverdue` / `kind` / `limit`） | `workspace:read` |
| `POST` | `/contracts/signed/{id}/deadlines/{deadlineId}/complete` | 期限の完了（通知済み）登録 | `workspace:edit`（監査） |
| `POST` | `/tools/{id}/publish` | 公開（エイリアス/互換性管理） | `tool:publish` |
| `POST` | `/tools/{id}/expose-mcp` | MCPサーバとして公開 | `deployment:publish` |
| `POST` | `/skills` | Skill作成 | `skill:create` |
| `GET` | `/skills` | workspace内のSkill latest一覧 | `skill:read` |
| `GET` | `/skills/{id}` | Skill取得（latest / version固定） | `skill:read` |
| `GET` | `/skills/{id}/versions` | Skill version一覧 | `skill:read` |
| `POST` | `/skill-drafts/generate-prompt` | 未保存Skillの責務・Toolメタからprompt草案生成 | `skill:edit` |
| `POST` | `/skills/{id}/generate-prompt` | 発火条件からプロンプト草案生成 | `skill:edit` |
| `POST` | `/agents` | Agent作成 | `agent:create` |
| `GET` | `/agents` | workspace内のAgent latest一覧 | `agent:read` |
| `GET` | `/agents/{id}` | Agent取得（latest / version固定） | `agent:read` |
| `GET` | `/agents/{id}/diagnostics` | Tool呼び出しのプリフライト診断（参照解決・function定義・スキーマ整合・データソース・ドライランの段階別検査。§3.1） | `agent:execute` |
| `GET` | `/agents/{id}/versions` | Agent version一覧 | `agent:read` |
| `POST` | `/agent-drafts/diagnose` | 未保存Agentのプリフライト診断（`POST /agents` と同じbodyを受け、保存せずに検査。§3.1） | `agent:execute` |
| `POST` | `/agent-drafts/generate-prompt` | 未保存AgentのToolメタからsystem prompt草案生成 | `agent:edit` |
| `POST` | `/agents/{id}/generate-prompt` | Skill/Toolメタからsystem prompt自動生成 | `agent:edit` |
| `POST` | `/agents/{id}/export` | Mastraコードへ一方向エクスポート | `agent:edit` |
| `POST` | `/runs` | Agent実行（chat / preview / test） | `agent:execute` |
| `GET` | `/runs` | workspace内のRun履歴一覧 | `agent:read` |
| `GET` | `/runs/{id}/trace` | 実行トレース取得 | `agent:read` |
| `POST` | `/validations` | 検証ケース定義 | `agent:edit` |
| `POST` | `/validations/{id}/run` | 疑似ユーザーで検証実行 | `agent:execute` |
| `GET` | `/validations/{id}/report` | 検証指標・定性評価取得 | `agent:read` |
| `POST` | `/connections` | 接続先登録（SecretReference参照） | `connection:create` |
| `GET` | `/operations/audit` | 監査ログの参照（誰が何をしたか） | `audit-log:read` |
| `GET`/`POST` | `/auth/*` | ログイン/コールバック/セッション | — |
| `POST` | `/webhooks/{trigger}` | Webhookトリガー（Phase3） | Service Principal |

### 3.1 プリフライト診断（diagnostics）

「作ったToolがAgentから呼び出せない」原因は複数の層に潜むが、実行時には最初に踏んだ1つしか見えない。診断は**実行経路と同じ判定関数**で各段階を個別に検査し、モデル呼び出し・副作用なしで一覧を返す（ドライランは設計時サンプル値で行う）。保存済みは `GET /agents/{id}/diagnostics`、未保存は `POST /agent-drafts/diagnose`（body は `POST /agents` と同じ）と `POST /tool-drafts/diagnose`（body は `POST /tools` と同じ）。draft の `version` は未保存の印として `0.0.0` で報告する。

```jsonc
// GET /agents/{id}/diagnostics ・ POST /agent-drafts/diagnose → { "diagnostics": AgentDiagnostics }
{
  "agent": { "internalId": "assistant", "version": "1.0.0" },
  "status": "error",                       // ok | warning | error（配下すべての最悪値）
  "checks": [ { "id": "skills", "status": "ok" }, { "id": "model", "status": "error", "detail": "configured model provider does not support tool-calling" } ],
  "tools": [ ToolDiagnostics ]
}
// POST /tool-drafts/diagnose → { "diagnostics": ToolDiagnostics }
{
  "internalId": "scores", "version": "0.0.0", "source": "direct", // skill経由なら "skill" + skillId
  "functionName": "filter_scores",         // function definition を組めた場合のみ
  "status": "error",
  "checks": [ { "id": "graph", "status": "error", "detail": "sel: unknown column: missing", "nodeId": "sel" } ]
}
```

`detail` は実行時エラーと同じ英文（UI側で日本語化する）。`nodeId` は失敗がグラフ内の特定ノード由来のとき（`graph` / `execution`）だけ付く。

| 対象 | check id | 意味（error になる条件 / warning になる条件） |
|---|---|---|
| Agent | `skills` | Skill参照が解決できない |
| Agent | `tool-versions` | 直付けとSkill由来で同一Toolの版が食い違う（実行時 ambiguous tool versions） |
| Agent | `sub-agents` | サブエージェント参照切れ / `ask_{publishName}` が既存Tool・サブエージェントと衝突 / `ask_` 名が function 名の形式（`^[A-Za-z0-9_-]{1,64}$`）でない |
| Agent | `function-names` | LLMへ公開する function 名の重複（後のToolへ永久に届かない） |
| Agent | `mcp-servers` | 参照MCPサーバーが未登録（error） / disabled で実行時にスキップされる（warning）。実行時は黙ってスキップするため診断でしか見えない |
| Agent | `model` | 設定中モデルが tool-calling（呼び出し可能物があり functionInvocation が有効なとき）/ structured output（`output` 指定時）を持たない、または設定を解決できない。モデル配線が無い環境では項目自体を出さない |
| Agent | `harness` | warning のみ: webSearch 有効だが検索プロバイダ未設定 / fileMemory 有効だが Wiki 参照が無い |
| Tool | `resolved` | 参照先の Tool version が存在しない（Agent診断のみ） |
| Tool | `state` | `archived`（Agentに付けるべきでない: error） / `deprecated`（今後 archived になり得る: warning） |
| Tool | `function-definition` | function definition を組めない（名前の形式・input列の重複） |
| Tool | `agent-input` | inputSchema に列があるのに agent-input ノードが無い / ノードの schema が inputSchema と一致しない（実行時 graphWithArguments と同一判定。保存時にも同じ規則で拒否する） |
| Tool | `data-sources` | データソース参照が解決できない |
| Tool | `graph` | 解決済みグラフのスキーマ伝播エラー・構造違反（`nodeId` は最初のエラーノード） |
| Tool | `execution` | 設計時サンプル値でのドライランがノード実行エラーになる（`nodeId` は投げたノード） |
| Tool | `output-schema` | 宣言 outputSchema が推論終端と不整合（実行後に落ちる。再保存で更新） |
| Tool | `operator-arguments` | opBinding の許可リストが空・既定演算子の不一致・引数型が string でない（error） / 引数が inputSchema に無く実行時に不活性（warning） |
| Tool | `side-effect` | warning のみ: 非 read-only は承認ゲートで停止する |

### 3.2 ツール検証（tool checks）

保存済み Tool を「Agent が渡すのと同じ引数」で**単体実行**し、出力・ノード別行数・所要時間を見せ、期待（行数 / 必須列 / セル値 / 所要時間上限）との合否を返す。引数の検証・グラフへの束縛・全行実行は Agent 経路と**同じ関数**（`validateToolArguments` → `graphWithArguments` → データソース解決 → `engine.preview`）を通すので、ここで通れば Agent から呼んでも同じ結果になる。出力ディスパッチャ（セッション成果物の書き込み）は呼ばず、`engine.preview` 内の sink ノードは表を通すだけなので、`write` の Tool も副作用なしに実行できる。

実行自体の失敗（引数不正 `TOOL_ARGUMENTS`・inputSchema と agent-input の不整合 `AGENT_RUN`・ノードの実行エラー `ETL_*`＋`nodeId`）は HTTP エラーではなく **200 で `status: "error"`** の結果になる（画面の仕事は「実行すると何が起きるか」を見せること）。Tool が存在しなければ 404 `TOOL_NOT_FOUND`。

```jsonc
// POST /tool-checks/run
{ "scope": {…}, "toolId": "sales", "version": "1.2.0",          // version 省略で最新版
  "arguments": { "region": "Tokyo", "minimum": 10 },              // JSON セル（string / number / boolean / null）のみ
  "expectations": {
    "rowCount": { "op": "gte", "value": 1 },                       // op: eq | gte | lte
    "columns": ["region", "amount"],
    "cells": [{ "column": "region", "op": "eq", "value": "Tokyo", "mode": "all" }], // op: eq | neq | gte | lte | contains、mode: any | all
    "rows": [{                                                      // 終端出力の1行を特定した期待（最大50件、cellsは1行あたり最大20件）
      "where": { "column": "id", "value": "E1" },                     // 最初に一致した行
      "present": true,                                                 // false なら「その行が無い」ことを期待（省略時 true。cells は評価しない）
      "cells": [{ "column": "amount", "op": "gte", "value": 10000 }]    // 列・演算子・値。mode は無い（特定した行だけを見る）
    }],
    "judgments": [{                                                  // AI判定ノード（ai-judge）の入力行を特定した期待（最大100件）
      "nodeId": "judge1",
      "where": { "column": "id", "value": "E2" },
      "verdict": ["no", "unclear"],                                    // いずれかに一致すれば合格（モデルの揺れを許容。最大21件）
      "reasonContains": "重複"                                          // 任意: 理由に含まれるべき文字列
    }],
    "maxDurationMs": 5000,
    "outcome": "success"                                          // success | error（省略可。後述）
  },
  "rowLimit": 100 }                                                    // 表示用スナップショットの行数（既定 100、0 で本文なし）
// → 200 { "result": ToolCheckRunResult }
{ "tool": { "internalId": "sales", "version": "1.2.0", "publishName": "sales_search" },
  "status": "failed",                                                 // passed | failed | error
  "assertions": [
    { "kind": "rowCount", "passed": true,  "expected": "row count >= 1", "actual": "row count 2" },
    { "kind": "column",   "passed": false, "expected": "column 'amount' exists", "actual": "columns: region, total" },
    { "kind": "cell",     "passed": true,  "expected": "every row has region == \"Tokyo\"", "actual": "2 of 2 rows match" },
    { "kind": "row",      "passed": true,  "expected": "row[id == \"E1\"].amount >= 10000", "actual": "12000" },
    { "kind": "judgment", "passed": true,  "expected": "judgment[judge1][id == \"E2\"] in [\"no\", \"unclear\"]", "actual": "no (重複行のため除外)" },
    { "kind": "duration", "passed": true,  "expected": "duration <= 5000ms", "actual": "12ms" }
  ],
  "output": Table,                                                     // 先頭 rowLimit 行のスナップショット
  "rowCount": 2,                                                       // 全行数（期待の評価もこちら）
  "nodes": [{ "nodeId": "data", "rowCount": 3 }, { "nodeId": "filter", "rowCount": 2 }],
  "judgments": [{ "nodeId": "judge1", "verdictColumn": "aiVerdict", "reasonColumn": "aiReason", "table": Table, "rowCount": 5 }], // ai-judgeノードがあるときだけ（判定表のスナップショット、rowLimit行まで）
  "judgedBy": "lm-studio/qwen2.5-14b-instruct",                        // judgments があるときだけ（判定に使ったモデル）
  "durationMs": 12, "checkedAt": "2026-09-12T09:00:00.000Z",
  "error": { "code": "TOOL_ARGUMENTS", "message": "…", "nodeId": "…" } }  // status = error のときだけ
```

`expected` / `actual` は英語の定型文で UI が正規表現で日本語化する（`row count <sym> <n>` / `column '<name>' exists` / `some row has <col> <sym> <json>` / `every row has …` / `<matched> of <total> rows match` / `column '<name>' not in output` / `duration <= <ms>ms` / `outcome success` / `outcome error (<code>)`）。セル比較は eq / neq が JSON 表現の一致（Date は ISO 文字列化）、gte / lte は数値同士だけ、contains は文字列化した部分一致。null セルは `eq null` にだけ一致する。

**行を特定した期待（`rows`、kind: "row"）** は終端出力（全行）から `where`（`column == value`、最初に一致した行）で1行を特定し、`present: false` なら「その行が無い」ことを期待する（`row[<where>] absent` に対し `actual` は `present` / `absent` / `column '<column>' not in output`）。`cells` が無ければ存在だけを見る（`row[<where>] present`）。`cells` は1セル1 assertion で `row[<where>].<column> <op> <value>` に対し、`actual` は実際の値（JSON）か `row not found` / `column '<column>' not in output`。

**AI判定ノードへの期待（`judgments`、kind: "judgment"）** は `nodeId` で指定した `ai-judge` ノードの**入力行**を `where` で特定し（終端出力ではなくノードの判定表を見るので、`keep` / `exclude` で行が消えていても検証できる）、判定値が `verdict` のいずれかに一致すること（`judgment[<nodeId>][<where>] in [<verdicts>]` に対し `actual` は `<verdict> (<reason>)`）を確かめる。`reasonContains` を添えると理由文字列の部分一致も別 assertion（`judgment[<nodeId>][<where>] reason contains <text>`）として出る。ノードが判定されていない・行が見つからないときは `actual` に `node '<nodeId>' not judged` / `row not found` / `column '<column>' not in node input` が入る。判定値はモデルの揺れがあるため `verdict` に複数（any-of、最大21件）を書いてよい。

**結末の期待（`expectations.outcome`）** で異常系ケースを表現する。`"error"` は「引数不正・inputSchema の不整合・ノードエラーで**失敗すること**」自体を期待する: 実行が失敗すれば `status: "passed"`、assertions は `[{ kind: "outcome", passed: true, expected: "outcome error", actual: "outcome error (TOOL_ARGUMENTS)" }]` の 1 件だけ（他の期待は出力が無いので評価しない）、`error` は表示のために残る。失敗するはずが成功したら `status: "failed"` で結末の assertion（`actual: "outcome success"`）が不合格になり、残りの期待も評価して「実際に何が起きたか」を見せる。`"success"` を明示すると合格の結末 assertion が先頭に付き、実行が失敗したときは従来どおり `status: "error"` のまま不合格の結末 assertion（`actual: "outcome error (<code>)"`）を添える。省略時は従来どおり（結末の assertion は出ない）。要約は合格した異常系で `passed 1/1 (expected error: <message>)` になる。

ケース（`ToolCheckCase`）は `{ id, toolId, toolVersion?, name, arguments, expectations, lastResult?, createdAt, updatedAt }`。版を持たず `id` で上書きし、上書きでは `createdAt` と `lastResult` を引き継ぐ。`lastResult` は `{ status, checkedAt, toolVersion, summary }` の要約だけ（`passed 3/3` / `failed 1/3: row count == 3 → row count 5` / `error: <message>`）で、実行（`/cases/{id}/run`・`/cases/run-all`）のたびに更新される。一括実行は一覧順に逐次実行し、1件が error でも止まらない。版を固定したケースの Tool が削除されていても 404 にせず `status: "error"`（`TOOL_NOT_FOUND`）の結果として返す。ケース定義の不変条件違反は 400 `TOOL_CHECK_VALIDATION`、未知のケースは 404 `TOOL_CHECK_NOT_FOUND`。

#### ケース案の生成（`POST /tool-checks/suggest`）

保存済み Tool の公開契約（inputSchema・`agentTool` の名前と説明・outputSchema）、グラフの要約（ノード id / type と、filter 条件が Agent 引数を束縛している箇所）、agent-input ノードの設計時サンプルでの 1 回の実行結果（出力列・先頭 5 行・全行数）を文脈としてモデルへ渡し、カテゴリ（`normal` / `boundary` / `abnormal`）ごとに `perCategory` 件のケース案を JSON（structured output、temperature 0）で返させる。**保存はしない**（利用者がレビューして `/tool-checks/run` で試し、`/tool-checks/cases` へ保存する）。分析アシスタントと同じ有効判定・同じモデル（main スロット）を使い、`GET /runtime/capabilities` の `toolCheckSuggestions.enabled` で UI に有無を伝える。

```jsonc
// POST /tool-checks/suggest
{ "scope": {…}, "toolId": "sales", "version": "1.2.0",   // version 省略で最新版
  "perCategory": 2,                                        // 1〜5、省略時 2（範囲外は 400）
  "focus": "価格の境界を重点的に" }                          // 任意・500 文字まで
// → 200 { "suggestions": ToolCheckSuggestions }
{ "tool": { "internalId": "sales", "version": "1.2.0", "publishName": "sales_search" },
  "suggestions": [
    { "category": "normal", "name": "Tokyo rows", "rationale": "…",
      "arguments": { "region": "Tokyo", "minimum": 0 }, "expectations": { "rowCount": { "op": "gte", "value": 1 } },
      "warnings": ["argument 'minimum' was \"0\" (string); converted to number 0"] },
    { "category": "abnormal", "name": "missing region", "rationale": "…",
      "arguments": { "minimum": 0 }, "expectations": { "outcome": "error" }, "warnings": [] }
  ],
  "model": { "provider": "lm-studio", "model": "…" },        // 分かるときだけ
  "warnings": ["model returned 4 normal cases; kept the first 2"] }
```

モデルの出力は信用せず、サーバーで検証・修復する（落とした・直した点は各案の `warnings`、全体の注意は応答の `warnings`）: 未知のカテゴリは捨てる。カテゴリごとの超過分は切り詰める。名前は空・120 文字超なら `<category> case N` に置き換える。引数は inputSchema に無いキーを落とす（**異常系で `outcome: "error"` のときだけ未宣言キーを 1 つ残す**＝それが検証の狙い）、曖昧でない型違いは列の型へ寄せる（`"12"` → `12`、`"true"` → `true`、`12` → `"12"`）、nullable でない列への `null` は正常・境界では落とす（異常系では残す）。期待は保存時と同じドメイン検証をキーごとに通し、不正なものだけ落とす。`cells[].column` は出力列（宣言 outputSchema、無ければサンプル実行の列）に無ければ落とす。サンプル実行が失敗しても提案は続け、`warnings` に `sample run failed (…)` を残す。

エラー: Tool が無ければ 404 `TOOL_NOT_FOUND`。モデル未設定・structured output 非対応は 502 `MODEL_PROVIDER`（`tool check suggestions are not configured`）、JSON でない／形の違う応答は `tool check suggestions returned invalid JSON`、使えるケースが 0 件なら `tool check suggestions returned no usable case`（いずれも 502）。

### 3.3 評価: 実験と Judge ルーブリック（experiments / judge rubrics）

LLM-as-Judge の採点は **基準別**（[ADR-0037](./adr/0037-criterion-level-judging.md)）。判定者はルーブリックの基準ごとに「理由 → 段階スコア」を返し、サーバーが重み付きで合成する。実装は `src/adapters/evaluation/structured-judge-evaluator.ts`、使い方の解説は [11-scenario-validation.md §9](./11-scenario-validation.md#9-llm-判定基準別採点判定契約自己一貫性)。

| メソッド | パス | ユースケース | 認可アクション |
|---|---|---|---|
| `POST` | `/judge-rubrics` | ルーブリック保存（版は自動採番） | `evaluation:create` |
| `GET` | `/judge-rubrics` / `/judge-rubrics/{id}` / `/judge-rubrics/{id}/versions` | 一覧 / 取得（`version` 省略で最新）/ 版一覧 | `evaluation:read` |
| `POST` | `/experiments` | 実験の起票（202。worker が非同期に実行） | `evaluation:execute` |
| `GET` | `/experiments` / `/experiments/{id}` / `/experiments/{id}/results` | 一覧 / 取得 / 事例ごとの結果 | `evaluation:read` |

```jsonc
// POST /judge-rubrics
{ "scope": {…}, "internalId": "quality", "workingName": "…", "displayName": "…", "publishName": "quality", "owner": "…",
  "instructions": "Judge factual correctness against the reference.",
  "criteria": [{ "id": "accuracy", "label": "Accuracy", "description": "…", "weight": 2,
                 "levels": [{ "score": 0, "label": "Wrong", "description": "…" }, { "score": 0.5, "label": "Partial", "description": "…" }, { "score": 1, "label": "Correct", "description": "…" }] }],
  "referencePolicy": "required",          // optional | required | forbidden: 参照解答を渡すか
  "tracePolicy": "optional" }             // optional | required | forbidden: ツール呼び出し列と会話履歴を渡すか（省略時 optional）
// POST /experiments
{ "scope": {…}, "target": { "agentId": "agent", "version": "1.2.0" }, "dataset": { "id": "set", "version": "1.0.0" }, "evaluatorProfile": { "id": "profile", "version": "1.0.0" },
  "repetitions": 1,                       // 1〜10
  "judgeSamples": 3 }                     // 1〜5（省略時 1）。2 以上で判定を独立に複数回行い中央値とばらつきを記録する
// → 202 { "experiment": { …, "repetitions": 1, "judgeSamples": 3, "status": "queued", … } }
```

`tracePolicy` と `judgeSamples` は後付けの項目で、保存済みのルーブリック・実験は `optional` / `1` として読める。範囲外（`judgeSamples` 0 や 6、未知の `tracePolicy`）は 400。

**判定レコード（`GET /experiments/{id}/results` の `judgeEvaluations[]`）**

```jsonc
{ "scorer": "llm-as-judge", "metricId": "judge", "rubric": { "id": "quality", "version": "1.0.0" }, "required": true,
  "model": { "provider": "…", "model": "…", "modelConfigHash": "…" },
  "status": "succeeded",
  "score": 0.667,                                                    // 重み付き合成 Σ(weight×score)/Σ(weight)。判定不能（null）の基準は分母から外す。judgeSamples>1 なら各サンプルの合成の中央値
  "reason": "…",                                                     // 全体の理由（judgeSamples>1 なら中央値に最も近いサンプルのもの）
  "criteria": [{ "id": "accuracy", "score": 1, "reason": "…" },      // 基準別。score は基準の levels のいずれか、null = 判定不能（理由は必須）
                { "id": "tone", "score": null, "reason": "…" }],
  "samples": 3,                                                      // 実際に判定を得られたサンプル数（失敗したサンプルは数えない）
  "dispersion": { "min": 0.5, "max": 0.833, "stddev": 0.136 },       // サンプル合成スコアの範囲と母標準偏差（samples=1 なら min=max=score, stddev 0）
  "uncertain": true,                                                 // max − min ≥ 0.25 のとき true。UI は「判定が割れている」と示す
  "usage": { "promptTokens": 1830, "completionTokens": 240, "totalTokens": 2070 },   // 修復呼び出し・全サンプル分の合計（provider が返した分だけ）
  "contract": { "promptHash": "9f1c0b2a7d3e4f56", "rubricId": "quality", "rubricVersion": "1.0.0" } }   // 判定契約の指紋（後述）
```

- **派生指標**: 事例の `scores[]` には合成スコアが `metricId` で、基準別スコアが **`"<metricId>:<criterionId>"`**（例 `judge:accuracy`）で並ぶ（null の基準は出さない）。実験比較（`/experiments/compare`）や品質ゲートの `metric-threshold` / `max-regression` はこの名前で基準ごとに拾える。
- **判定契約**: `contract.promptHash` はシステムプロンプトの版マーカー + ルーブリック JSON（id・版・文面・基準）+ 応答スキーマの sha256 先頭 16 hex。判定者側のプロンプト更新やルーブリック改版は指紋の変化として結果に残り、スコアのドリフトを説明できる。
- **判定者が見るもの**: `input` / `output` / `reference`（`referencePolicy` に従う）に加え、`tracePolicy` が `forbidden` でなければ turn 事例では Run の `tool-call` / `tool-result`（引数と出力プレビュー先頭 10 行の JSON、上限 20 件・各 2,000 文字）、scenario 事例では最終応答を除く会話履歴（上限 20 件・各 2,000 文字）を **untrusted data ブロックの中に** 渡す。scenario 事例には軌跡が無いため、`tracePolicy: "required"` のルーブリックを scenario 事例に使うと判定は `JUDGE_INPUT` で失敗する。
- **修復 1 回**: 判定者の出力がスキーマ・基準 id・段階に合わないときは、違反内容を添えて **1 回だけ** 修正を求める。それでも合わなければ `JUDGE_SCHEMA`。

**判定の失敗コード（`status: "failed"` の `error.code`）** — 判定の失敗は事例の失敗にはせず、その指標のスコアを欠損（`scores[]` に出さない）として記録する。

| code | 意味 |
|---|---|
| `JUDGE_INPUT` | 入力が契約を満たさない: ルーブリックが見つからない、`referencePolicy: required` で参照解答が無い、`tracePolicy: required` で軌跡が無い、`judgeSamples` が範囲外 |
| `JUDGE_PROVIDER` | judge スロットのモデルが未設定・structured output 非対応・呼び出し失敗（一時障害の再試行は実験側） |
| `JUDGE_SCHEMA` | 出力が応答契約に合わず、修復 1 回でも直らなかった |
| `JUDGE_UNASSESSABLE` | 判定者が全基準を `null`（判定不能）にした。合成スコアを出せないので失敗として記録する |

**起票時の判定ガード（`POST /experiments` の 409）** — 走らせれば必ず全事例が判定失敗になる組み合わせは実験を作らない。

| code | 意味 | 本文 |
|---|---|---|
| `JUDGE_MODEL_NOT_CONFIGURED` | プロファイルに judge 指標があるが judge スロットにモデルが無い。設定画面で judge を保存すると直る | `{ error: { code, message } }` |
| `JUDGE_TRACE_UNAVAILABLE` | `tracePolicy: required` のルーブリックを scenario 事例を含むデータセットに使った。ルーブリックの `tracePolicy` を `optional` にすると直る | `{ error: { code, message, rubric: { id, version } } }` |

### 3.4 仕訳（journal）

伝票・帳票を取り込み、**2 段階判定**（① 既存ルールで決定的に仕訳できるか / ② できなければヒアリングでルール化）で仕訳を起こし、汎用 CSV へ出す（[docs/20-journal.md](./20-journal.md) / [ADR-0038](./adr/0038-journal-two-stage-judgment.md)）。LLM 抽出（`/journal/documents/extract`）と Stage 2 ヒアリング（`/journal/hearings*`）も登録済み。画面は `GET /runtime/capabilities` の `journal`（`extraction: { enabled, vision }` / `hearing: { enabled }`）を見て、モデルが無い環境では導線を出さない。

応答の文書 / ルール / 仕訳は永続化用の形から `tenant` を除いたもの（スコープは Principal 由来なので返さない）。すべて `{ chart } / { rules } / { rule } / { documents } / { document } / { entries } / { entry } / { presets } / { content } / { result }` のいずれかで包み、削除は 204。

#### 科目マスタ（`/journal/chart`）

**勘定科目・税区分・補助軸はコードに持たず、ワークスペースのデータとして持つ**（ADR-0038）。保存したことが無いワークスペースは `GET` で標準セットを返すが**保存はしない**（参照が書き込みを起こすと、読み取り権限しか無い利用者が失敗し、標準セットの改善が焼き付く）。

```jsonc
// GET /journal/chart?tenantId&workspaceId → 200 { chart }
{ "accounts": [{ "id": "expense.supplies", "name": "消耗品費", "category": "expense", "defaultTaxCode": "JP-IN-10-S", "aliases": ["消耗品", "事務用品"], "enabled": true, "sortOrder": 140 }],
  "dimensions": [{ "id": "sub_account", "name": "補助科目", "values": [] }, { "id": "department", "name": "部門", "values": [] }],
  "taxCategories": [{ "code": "JP-IN-10-S", "name": "課税仕入 10%", "side": "in", "rate": 10, "enabled": true, "mapping": { "yayoi": "課対仕入込10%" } }],
  "updatedAt": "2026-09-13T00:00:00.000Z" }
// PUT /journal/chart  { scope, accounts, dimensions, taxCategories } → 200 { chart }（全体を置き換え）
// POST /journal/chart/reset  { scope } → 200 { chart }（標準セットを保存して返す）
```

科目 CSV は `id,code,name,category,defaultTaxCode,aliases,enabled`（`aliases` は `;` 区切り、`enabled` は `true|false`、BOM 付き CRLF）。**取込は勘定科目の一覧だけを置き換え、税区分と補助軸は既存のものを残す**（科目 CSV に税区分の定義が無いため、全体上書きと解釈すると既存のルールと仕訳が一斉に壊れる）。行の不正は 400 `JOURNAL_DOMAIN` で、メッセージに**行番号（1 始まり・ヘッダ込み）**を含める。

削除は論理削除（`enabled: false`）。ルールと仕訳は科目を **id** で参照するので改名に追従し、仕訳の各行は確定時の科目名も写して持つ（過去の仕訳は当時の名前のまま）。

#### ルール（`/journal/rules`）

```jsonc
// POST /journal/rules  { scope, rule } → 200 { rule }
{ "scope": {…},
  "rule": { "id": "…",                       // 省略で新規。更新は createdAt を保つ（優先順が入れ替わらない）
    "name": "Amazon は消耗品費", "enabled": true, "mode": "auto", "priority": 100,
    "scope": { "documentKinds": ["card_statement"], "direction": "out", "accountHints": ["楽天カード"] },
    "conditions": [{ "field": "descriptionNorm", "op": "contains", "value": "アマゾン" }],
    "outcome": { "lines": [
        { "side": "debit",  "accountId": "expense.supplies", "taxCode": "JP-IN-10-S", "amount": "total", "partnerFrom": "issuerName" },
        { "side": "credit", "accountId": "liability.other_payables", "taxCode": "JP-NA", "amount": "total" }],
      "descriptionTemplate": "{issuerName} {description}", "invoiceStatus": "auto" },
    "askIf": [{ "conditions": [{ "field": "grandTotal", "op": "gte", "value": 100000 }], "questionId": "fixed_asset_check", "prompt": "固定資産の確認" }],
    "requiredFacts": ["grandTotal"] } }
```

`op` は `equals | contains | startsWith | endsWith | regex | between | gte | lte | in | exists | notExists | isTrue | isFalse`。`amount` は `total | taxable:10 | taxable:8 | tax:10 | tax:8 | remainder | { fixed } | { ratio }`。保存時に **outcome が参照する科目 id と税区分コードが現在のマスタにあり有効か**を確かめ、無ければ 400 `JOURNAL_DOMAIN`（ここで弾かないと、保存は通るのに判定のたびに `unknown-account` で止まるルールが溜まる）。

`POST /journal/rules/test` は草案 × 文書 id の一覧を受け、**保存せずに**判定と同じ関数で照合する（`{ result: [{ documentId, matched, specificity?, entry?, reasons? }] }`）。見つからない文書 id は結果に現れない。

#### 文書（`/journal/documents`）

一覧は**要約**を返す（`sourceType` / `fileName` / `transactionDate` / `issuerName` / `grandTotal` / `judgment` など）。証憑本体（画像 data URL・原文テキスト・CSV 1 行の生値）は含まれないので、一覧の応答が数 MiB になることはない。本体は `GET /journal/documents/{id}` で 1 件ずつ読む。`source.dataUrl` と `source.text` は 1 件 8 MiB が上限。

保存時に facts を正規化する（`descriptionNorm` を作り直し、`registrationNumber` を `T` + 13 桁へ寄せ、`counterpartyHint` を摘要から切り出す）。**facts が変わった更新は `judgment` と `entryId` を落として `extracted`（未判定）へ戻す** — 帳票を直したのに古い判定結果と仕訳が残ると、画面には「確定済み」と出るのに中身が食い違う。facts が同じなら状態は保つ。

`DELETE` は紐づく仕訳が **`draft` のときだけ**一緒に消す（判定が作った下書きは元の証憑が消えれば残す意味が無い）。`confirmed` / `exported` の仕訳は会計上の記録なので残す。

#### CSV 取込（`POST /journal/documents/import-csv`）

```jsonc
{ "scope": {…}, "content": "日付,摘要,出金,入金,残高\r\n…",  // 5 MiB まで
  "preset": "rakuten-bank",        // 省略時は columnMapping →列名署名の自動判定の順
  "columnMapping": { "date": "取引日", "description": "摘要", "amount": "入出金" },
  "fileName": "202609.csv", "accountHint": "楽天銀行" }
// → 200 { result }
{ "preset": "rakuten-bank", "imported": [ JournalDocumentSummary ],
  "skippedRows": [{ "row": 12, "reason": "CSV row 12: date is missing or unreadable" }],
  "warnings": ["detected preset: rakuten-bank", "skipped 1 of 40 rows"] }
```

**1 行の失敗で取込全体を捨てない**。明細 CSV には合計行・注記行が混ざるので、読めなかった行は `skippedRows`（行番号 + 理由）へ積み、残りを保存する。行番号は**ヘッダ行を 1 とした 1 始まり**（表計算ソフトの行番号と一致する）。全列が空白の行は黙って捨てる。プリセットが決まらない（列名がどれにも一致せず列マッピングも無い）ときだけ、行の問題ではなく取込全体の前提の問題として 400 `JOURNAL_CSV_IMPORT`（`row` なし）で断る。引用符の閉じ忘れは `row` つきで返る。

`GET /journal/csv-presets` は `{ presets: [{ id, name, description, headerSignature, kind }] }`（楽天銀行・MUFG・SMBC・ゆうちょ・楽天カード・汎用）。

#### 判定（`POST /journal/documents/judge`）

`{ scope, documentIds? }` → `{ result: { judged: [JournalDocumentSummary], decided, undecided, skipped } }`。`documentIds` 省略時は状態が `extracted` / `undecided` の全件。判定は純粋関数（`judgeDocument`）で、確定できないことは**エラーではなく結果**として返る。

```jsonc
"judgment": { "stage": "undecided", "judgedAt": "…", "candidates": [{ "ruleId": "…", "ruleName": "…", "mode": "suggest", "priority": 100, "specificity": 4 }],
  "reasons": [{ "code": "multiple-rules", "ruleIds": ["r1", "r2"] }] }
```

理由コードは `no-rule` / `multiple-rules` / `missing-fact` / `ask-if` / `rule-suggest-mode` / `unknown-account` / `unbalanced`。UI はこれを「原因 → 次の一手 → 修正場所へのボタン」に写す。

**確定済みの仕訳は再判定で上書きしない**。`confirmed` / `exported` の仕訳が紐づく文書は判定結果だけを更新し、仕訳には触れない（利用者が確認・修正した内容を黙って消さない）。`exported` の文書は判定の対象外（明示指定でも飛ばす）。

#### 仕訳と出力（`/journal/entries`・`/journal/export`）

仕訳は借方合計 = 貸方合計を不変条件に持ち、状態は `draft` → `confirmed` → `exported`。保存時に**各行の科目名をマスタから写し直す**（クライアントの申告を採らない。id と名前が食い違う行は CSV の中身を壊す）。マスタに無い / 無効な科目は 400 `JOURNAL_DOMAIN`。`DELETE` は紐づく文書を `extracted` へ戻す（参照切れの `entryId` を残さない）。

```jsonc
// GET /journal/export?format=generic&status=confirmed&from&to&markExported=true → 200 { result }
{ "format": "generic", "fileName": "journal-2026-09-13.csv", "content": "﻿entry_id,line_no,…", "entryCount": 12,
  "encoding": "utf-8", "warnings": [] }

// GET /journal/export?format=yayoi → 200 { result }（弥生は Shift-JIS）
{ "format": "yayoi", "fileName": "journal-yayoi-2026-09-13.csv",
  "content": "2000,000123,,2026/09/10,消耗品費,…",   // 画面のテキストエリア用の読める UTF-8 本文
  "contentBase64": "MjAwMCww…",                      // 会計ソフトへ渡す Shift-JIS のバイト列（shift_jis のときだけ）
  "entryCount": 12, "encoding": "shift_jis",
  "warnings": ["税区分 JP-IN-10-S-D70 に弥生の対応名が無いため、内部コードのまま出力しました。…"] }
```

汎用 CSV は 25 列・UTF-8 BOM・CRLF・`YYYY/MM/DD`・税込整数（列は docs/20 §8）。単純仕訳（借方 1 行 × 貸方 1 行）は 1 行に両側を出し、複合仕訳は行ごとに片側だけを出して同じ `entry_id` で束ねる。`markExported=true` は出力した仕訳を `exported` にする（既定 off。中身を確かめるだけのダウンロードで状態を動かさない）。

`format` は `generic` / `yayoi` / `freee` / `mf` の 4 つ（列写像と値の組み立ては `src/application/journal/export-presets.ts`。汎用 25 列の**純粋な写像**で、税区分名は科目マスタの `mapping` から引く）。知らない形式は 400 `JOURNAL_EXPORT`。応答の共通フィールド:

| フィールド | 内容 |
|---|---|
| `encoding` | `utf-8`（汎用 / freee / MF）/ `shift_jis`（弥生。Shift-JIS でないと取込画面で文字化けする） |
| `content` | 常に**読める UTF-8 本文**（画面のテキストエリアのフォールバック用） |
| `contentBase64` | `shift_jis` のときだけ。会計ソフトへ渡すバイト列（base64）。UI はこれを復号して `type: 'text/csv'`（charset 無し）の Blob にする |
| `warnings[]` | **値を作れなかったことの申告**（税区分に各社の対応名が無い / 摘要を上限で切り詰めた / `entry_id` に伝票番号にできる数字が無い / 1 仕訳の行数が 1 伝票の上限を超える / Shift-JIS に無い文字がある）。黙って別の値で埋めない |

弥生は 25 項目・ヘッダ行なし・識別フラグ（単一行 `2000`、複合仕訳は `2110` / `2100` / `2101`）、freee は 1 行目 `[表題行]`・データ行 `[明細行]`、MF はヘッダ行つきで借方 / 貸方インボイス列（`適格` / `80％控除` / `70％控除` / `50％控除` / `30％控除` / `控除なし`）を持つ。

#### 帳票の LLM 読取（`POST /journal/documents/extract`）

```jsonc
{ "scope": {…}, "images": ["data:image/jpeg;base64,…"],  // 最大 4 枚・1 枚 4,200,000 文字。SVG と外部 URL は不可
  "text": "メール本文…",                                   // 最大 100,000 文字。画像とテキストはどちらか一方でよい
  "fileName": "receipt.jpg", "hintKind": "simplified_invoice" }
// → 200 { result }
{ "kind": "simplified_invoice",
  "facts": { "issuerName": "サンプルマート 霞が関店", "transactionDate": "2026-08-31", "issueDate": "2026-09-05", "grandTotal": 1230, … },
  "extraction": { "method": "llm", "model": { "provider": "…", "model": "…" }, "confidence": 0.82,
    "warnings": ["税率別の内訳の合計（1430 円）が総額（1230 円）と 200 円ずれている…"],
    "fieldEvidence": { "grandTotal": { "sourceText": "合計 ¥1,230", "confidence": 0.9 } } } }
```

**保存しない**（利用者が確認・修正してから `POST /journal/documents`）。読み取った値はサーバー側で正規化し（和暦 → ISO、全角・カンマ → 整数、登録番号 → `T` + 13 桁）、通らない項目は落として理由を `extraction.warnings` に残す。抽出後の整合チェック（税率別合計 vs 総額 ±税率行数、明細合計 vs 総額、単価 × 数量、お預り − お釣、8% 行の軽減記号、請求書なのに登録番号が無い）も同じ `warnings` に積む。**値を勝手に補正はしない**（帳簿の数字を推測で書き換えない）。UI は warnings を一覧で見せ、`fieldEvidence` の信頼度が低い項目を強調する。

モデルが 1 枚 20〜230 秒かかることがあるので、クライアント切断で処理ごと中断する（`clientAbortSignal`）。

#### ヒアリング（Stage 2。`/journal/hearings`）

```jsonc
// POST /journal/hearings  { scope, documentId } → 200 { hearing }
// 文書は undecided か hearing であること。既に開いているセッションがあればそれを返す（二重に作らない）。
{ "id": "…", "documentId": "…", "status": "open",
  "turns": [{ "role": "assistant", "question": { "id": "meal_purpose", "text": "誰と・何の目的の飲食でしたか？",
    "kind": "single", "options": [{ "value": "internal-meeting", "label": "社内打合せ" }], "factPath": "extra.purpose", "catalogId": "meal_purpose" }, "at": "…" }],
  "createdAt": "…", "updatedAt": "…" }

// POST /journal/hearings/{id}/answers  { scope, answers: [{ questionId, value }] } → 200 { hearing, warnings }
// 回答は question.factPath（`extra.<key>` のみ）へ書き戻す。次の質問か proposal が付く。
// POST /journal/hearings/{id}/accept  { scope, registerAccountIds?, registerDimensionValueIds?, registerTaxCodes?, rule?, entry? }
//   → 200 { hearing, rule, entry?, chart }
// POST /journal/hearings/{id}/cancel  { scope } → 200 { hearing }（文書は undecided へ戻る）
```

一度に聞くのは最大 3 問、1 セッションの発話は 60 件まで（超えたら打ち切ってセッションを閉じ、文書を未判定へ戻す）。聞いていない `questionId` への回答と、`extra.` 以外への書き戻しは 400 `JOURNAL_DOMAIN`。

**提案は検証を通ったものだけ保存する**: 科目 id・税区分コード・補助軸の値がマスタか同じ提案の `newAccounts` などにあること、仕訳の貸借が一致すること、ルールがドメインの検証（条件の演算子・金額指定・置換子）を通ること、条件の `field` が facts のパスであること。壊れていれば 1 回だけ修復を求め、それでも駄目なら**提案の無いセッション**として保存し、理由を `warnings` と assistant の発話で返す（壊れた提案を保存すると「登録」を押せてしまう）。

`accept` が科目マスタへ書き込むのは **`register*` に明示された id だけ**で、提案に無い id を指定すると 400。モデルが科目体系を勝手に増やす経路は存在しない。受け入れ後はルールを `provenance: { origin: 'hearing', hearingId, exampleDocumentIds }` で保存し、対象文書を再判定する（当たれば `decided` + 仕訳の下書き）。

#### エラー

| 例外 | status | code |
|---|---|---|
| `JournalDocumentNotFoundError` ほか参照切れ | 404 | `JOURNAL_DOCUMENT_NOT_FOUND` / `JOURNAL_RULE_NOT_FOUND` / `JOURNAL_ENTRY_NOT_FOUND` / `JOURNAL_HEARING_NOT_FOUND` |
| `JournalExtractionUnavailableError`（モデル未設定 / structured output・vision 非対応） | 409 | `JOURNAL_EXTRACTION_UNAVAILABLE`（設定画面で直せる） |
| `JournalExtractionSchemaError`（修復後もスキーマ違反） | 502 | `JOURNAL_EXTRACTION_SCHEMA` |
| `JournalDomainError`（不変条件違反） | 400 | `JOURNAL_DOMAIN` |
| `JournalCsvImportError` | 400 | `JOURNAL_CSV_IMPORT`（**本文に `row`**。行が特定できるときだけ） |
| `JournalExportError` | 400 | `JOURNAL_EXPORT` |

### 3.5 経費精算（expense）

領収書・経費明細を取り込み、規程との**決定的チェック**（Stage 1 のみ。ヒアリングは無い）で申請の合否を判定し、承認を経て精算 CSV へ出す（[docs/21-expense.md](./21-expense.md) / [ADR-0040](./adr/0040-expense-policy-check.md)）。登録点は仕訳と同じ形（[ADR-0039](./adr/0039-business-feature-registration.md)）で、ルートは `src/api/expense-routes.ts`、スキーマは `expense-schemas.ts`、認可は `expense-authorization.ts` の `EXPENSE_ROUTE_RULES`、エラー写像は `expense-error-mapping.ts` の `expenseHttpError`。応答は永続化用の形から `tenant` を除いたもの（journal と同じ）。

**規程（`/expense/policy`）**: 費目・上限額・必須項目（証憑・登録番号・参加者）・事前承認ルールはすべてワークスペースのデータで、コードに固定表を持たない。未保存のワークスペースは `GET` で初期テンプレートを返すが保存はしない（`{ policy, saved: false }`）。CSV の入出力は `POST /expense/policy/import` / `GET /expense/policy/export`（`workingName`/税区分名などの列は docs/21 §5.4）。

**申請とチェック（`/expense/claims`）**: 状態は `draft → checked → approved → settled`（差し戻しは `returned` を経て `draft` へ）。`checkClaim` は申請・規程・重複候補・時刻だけを引数に取る純粋関数で、同じ入力からは必ず同じ `verdict`（`pass` / `needs-review` / `returned`）が出る。明細・規程を変えると `stale: true` になり、承認前に再チェックが要る。理由コードは `src/domain/expense/reason-codes.ts` の `REASON_CODES`（43 件。MVP 27 件 + 実用化 16 件）が正本で、コードごとに対象（明細/申請）・重さ・検索要件・導線先を持つ。

```jsonc
// POST /expense/receipts/extract { scope, images（≤4・画像 data URL）, text?, fileName? }
// → 200 { result: { drafts: [ExpenseItemDraft], claimantHint?, warnings } }（**保存しない**）
// POST /expense/claims/:id/items { scope, itemId?, categoryId?, categoryText?, facts, source, extraction?, receipt? }
// → 200 { claim }（申請の応答は tenant 抜き・証憑本体なし・hasReceipt と stale / approvalBlockers つき）
// POST /expense/claims/:id/approve { scope, comment? } → 200 { claim }
// 拒否（要確認未消化・stale・自己承認・規程違反の残存）は 409 EXPENSE_TRANSITION（blockingReasons）
```

**承認と職務分掌**: 承認・承認取消だけ認可アクションが `approve`（Publisher 以上）。自己承認の禁止はロールではなく規程（`claimRules.forbidSelfApproval`）で扱う。`approvalBlockers` は応答に含まれる「承認できない理由」の一覧（画面が承認ボタンの脇に出す）。

**仕訳連携（`POST /expense/claims/:id/journal-drafts`）**: 承認済みの申請から仕訳の下書きを作る（仕訳 BC へ書く。経費 domain は仕訳 domain の純関数・値型だけを import する一方向依存）。一部の明細が科目未設定などで下書きにできないときは、作れた分は残しつつ 409 `EXPENSE_JOURNAL_LINK`（`problems` / `createdEntryIds`）で伝える。

**出力（`GET /expense/export`）**: `format=payout|detail`。GET は状態を変えない（精算済みの印は別の `POST /expense/claims/settle`）。CSV は UTF-8 BOM・CRLF・`YYYY/MM/DD`・税込整数（仕訳と同じ流儀）。

#### 実用化のルート（docs/21 §20。系統 A / B / C）

従業員マスタ・多段承認・全銀協の振込データ・仮払金・法人カード明細・集計・経費専用の読取・交通費・規程のヒアリングの 9 ユースケース（[docs/21-expense.md](./21-expense.md) §20 / [ADR-0043](./adr/0043-expense-practical-extensions.md)）。系統ごとにルート・スキーマ・認可を分けている（`src/api/expense-{people,money,input}-{routes,schemas,authorization}.ts`。認可は `EXPENSE_PEOPLE_ROUTE_RULES` / `EXPENSE_MONEY_ROUTE_RULES` / `EXPENSE_INPUT_ROUTE_RULES`、エラー写像は既存の `expense-error-mapping.ts` が全部持つ）。本文にはどれも `scope`、GET はクエリに `tenantId` / `workspaceId` を付ける。認可のリソース種別はすべて `workspace`。下の表の「監査」は監査ログに残るルート。

**口座番号は応答に含めない**（`bankAccount.accountNumberLast4` の末尾 4 桁だけ）。平文を返すのは、口座番号つき従業員 CSV（`/expense/employees/export-bank-accounts`）と振込ファイル（`POST /expense/payouts` / `GET /expense/payouts/:id/file`）だけで、どれも `approve` 権限 + 監査。保存は `SecretCipherPort` で封緘する。

**既存ルートの拡張**: `POST` / `PUT /expense/claims(/:id)` の `claimant.employeeId?`（指定するとサーバーが氏名・社員番号・部門の写しを埋める）、`GET /expense/claims` の `employeeId` / `departmentId` / `advanceId` / `awaiting=me` / `unlinked=true` と状態 `in-approval`、申請の応答の `reimbursableAmount` / `approvalPlan`（`checked` なら予定・`in-approval` なら保存済みの流れ）/ `approvalBlockers`、`POST /expense/claims/:id/approve` の `stepId`（画面が見ていた段。食い違えば 409 `approval-step-changed`）、`PUT /expense/policy` の `approval` / `transport` / `card` / `advance` 節、`POST /expense/receipts/extract` の `detail?`、`GET /runtime/capabilities` の `expense.detailExtraction` / `expense.policyHearing`。理由コードは 43 件（MVP 27 + 実用化 16）。

**A: 人と承認（15 本）**

| Method | Path | 入力の要点 | 出力 | 認可 | 監査 |
|---|---|---|---|---|---|
| GET | `/expense/me` | — | `{ me: { subject, displayName?, singleUser, canApprove, employee? } }` | read | |
| GET | `/expense/people/readiness` | — | `{ readiness: { employees: { configured, enabledCount }, organization: { saved, departmentCount, approverGroupCount }, payout: { configured, saved } } }` | read | |
| GET | `/expense/employees` | `query?`（≤100 字）, `departmentId?`, `enabled?`（`true`/`false`）, `limit?`（≤1,000） | `{ employees }`（口座は末尾 4 桁、`departmentName?` / `managerName?` / `payoutReadiness`） | read | |
| POST | `/expense/employees` | `id?, code?, name, nameKana?, departmentId?, managerEmployeeId?, loginSubjects?, bankAccount?: { bankCode, bankNameKana?, branchCode, branchNameKana?, accountType, accountNumber?（平文）, holderKana }, commuterPasses?, enabled?, note?` | `{ employee }` | edit | ✅ |
| GET | `/expense/employees/export` | — | `{ content, fileName }`（口座番号の列は空） | read | ✅ |
| GET | `/expense/employees/export-bank-accounts` | — | `{ content, fileName }`（口座番号つき） | **approve** | ✅ |
| POST | `/expense/employees/import` | `content`（UTF-8 CSV） | `{ result: { created, updated, skippedRows, warnings } }`（ヘッダに無い列は既存の値を保つ） | edit | ✅ |
| GET | `/expense/employees/:id` | — | `{ employee }`（`history` 付き） | read | |
| PUT | `/expense/employees/:id` | POST と同じ（`bankAccount` 省略 = 保つ、`null` = 外す、`accountNumber` 省略 = 番号を保つ） | `{ employee }` | edit | ✅ |
| GET | `/expense/organization` | — | `{ organization, saved }` | read | |
| PUT | `/expense/organization` | `departments[]（≤500）, approverGroups[]（≤50）` | `{ organization }` | edit | ✅ |
| GET | `/expense/claims/employee-links` | `status?` | `{ links }`（紐付け候補） | read | |
| POST | `/expense/claims/employee-links` | `links: [{ claimId, employeeId }]`（1 件以上） | `{ result: { linked, movedToDraft, skipped } }`（`in-approval` が 1 件でもあれば何も書かずに 409） | edit | ✅ |
| GET | `/expense/claims/:id/approval-flow` | — | `{ plan, flow?, current?, canAct, proxy, blockers }` | read | |
| POST | `/expense/approval-routes/preview` | `approval`（規程の承認設定の下書き）, `policyCategoryIds`, `subject: { categoryIds, totalAmount, departmentId?, claimantEmployeeId? }` | `{ result: { plan, firstStepId? } }`（保存しない） | read | |

**B: お金の流れ（37 本）**

| Method | Path | 入力の要点 | 出力 | 認可 | 監査 |
|---|---|---|---|---|---|
| GET | `/expense/money-readiness` | — | `{ readiness: { cards, cardCount, cardImportCount, lastCardImportAt?, cardCoverage, payout } }` | read | |
| GET | `/expense/payout-settings` | — | `{ settings, saved }`（振込元の口座は末尾 4 桁） | read | |
| PUT | `/expense/payout-settings` | `source?: { bankCode, bankNameKana?, branchCode, branchNameKana?, accountType, accountNumber?（平文。省略 = 保つ） } \| null`, `requesterCode?`, `requesterNameKana?`, `format?`（改行・EOF・銀行名・顧客コード 1・文字種・件数上限など）, `journal?: { createPaymentEntry?, sourceAccountId? }` | `{ settings }` | edit | ✅ |
| POST | `/expense/payouts/preview` | `claimIds?`, `advanceIds?`（各 ≤500）, `transferDate` | `{ result: { candidates, lines, totalAmount, recordCount, problems, warnings } }`（状態を変えない） | read | |
| POST | `/expense/payouts` | preview と同じ + `acknowledgedWarnings[]` | `{ batch, file: { fileName, contentBase64, byteLength, sha256 } }`（止める理由・未確認の警告があれば 409 `EXPENSE_PAYOUT_BLOCKED`） | **approve** | ✅ |
| GET | `/expense/payouts` | `status?`（`exported` / `confirmed` / `cancelled`）, `limit?`（≤500） | `{ batches }` | read | |
| GET | `/expense/payouts/:id/file` | — | `{ file }`（作り直して SHA-256 が作成時と一致したときだけ。違えば・取消済みなら 409） | **approve** | ✅ |
| POST | `/expense/payouts/:id/confirm` | `note?` | `{ batch, claims, advances, warnings }`（申請 → 精算済み・仮払の支払と追加支給 → 支払済み。支払の仕訳下書きは設定が on のときだけ、拒否されても確定は止めず `warnings`） | edit | ✅ |
| POST | `/expense/payouts/:id/cancel` | `note` | `{ batch }`（`exported` だけ。申請と追加支給の印を戻す） | edit | ✅ |
| GET | `/expense/advances` | `status?`, `employeeId?`, `limit?`（≤500） | `{ advances }`（`linkedClaimCount` / `linkedClaimTotal` / `overdue`） | read | |
| POST | `/expense/advances` | `employeeId, purpose, amount, neededOn, plannedSettleBy` | `{ advance }` | edit | |
| GET | `/expense/advances/:id` | — | `{ advance, claims }` | read | |
| PUT | `/expense/advances/:id` | `purpose, amount, neededOn, plannedSettleBy` | `{ advance }` | edit | |
| POST | `/expense/advances/:id/approve` | `comment?` | `{ advance }` | **approve** | ✅ |
| POST | `/expense/advances/:id/cancel` | `note` | `{ advance }` | edit | ✅ |
| POST | `/expense/advances/:id/mark-paid` | `paidOn, method: 'cash' \| 'transfer'` | `{ advance }` | edit | ✅ |
| POST | `/expense/advances/:id/unpay` | `note` | `{ advance }` | edit | ✅ |
| GET | `/expense/advances/:id/settlement-preview` | — | `{ preview: { claims, claimsTotal, difference, direction, blockers } }` | read | |
| POST | `/expense/advances/:id/settle` | — | `{ advance, claims }` | edit | ✅ |
| POST | `/expense/advances/:id/refund-received` | `receivedOn` | `{ advance }` | edit | ✅ |
| POST | `/expense/advances/:id/additional-paid` | `paidOn, method` | `{ advance }` | edit | ✅ |
| POST | `/expense/advances/:id/journal-drafts` | `stage: 'payment' \| 'settlement'` | `{ advance, entryIds, warnings }` | edit | ✅ |
| PUT | `/expense/claims/:id/advance` | `advanceId: string \| null` | `{ claim }` | edit | |
| GET | `/expense/card-settings` | — | `{ settings, saved }` | read | |
| PUT | `/expense/card-settings` | `cards[]: { id, label, issuerName?, last4, holderEmployeeId?, enabled }`, `profiles[]`（列の対応） | `{ settings }` | edit | ✅ |
| POST | `/expense/card-statements/preview` | `content, profileId?, mapping?, cardId?` | `{ result: { headers, detectedProfileId?, suggestedMapping, rows, rowCount, skippedRows, periodFrom?, periodTo?, problems } }`（保存しない） | read | |
| POST | `/expense/card-statements` | preview と同じ + `fileName, saveProfileAs?` | `{ result: { importId, imported, duplicates, skippedRows, warnings, periodFrom, periodTo, profileId? } }`（同じファイルは 409 `EXPENSE_CARD_DUPLICATE_IMPORT`） | edit | ✅ |
| GET | `/expense/card-statements` | `limit?`（≤1,000） | `{ imports }` | read | |
| DELETE | `/expense/card-statements/:id` | — | 204（その取込の利用行も消す） | edit | ✅ |
| GET | `/expense/card-transactions` | `status?, cardId?, from?, to?, claimId?, limit?`（≤2,000） | `{ transactions }` | read | |
| POST | `/expense/card-transactions/match` | `from?, to?` | `{ result: { matched, reimbursementMatches, unmatched, kept } }` | edit | |
| POST | `/expense/card-transactions/:id/exclude` | `reason`（1〜200 字） | `{ transaction }` | edit | ✅ |
| POST | `/expense/card-transactions/:id/include` | — | `{ transaction }` | edit | ✅ |
| POST | `/expense/card-transactions/:id/link` | `claimId, itemId` | `{ transaction }` | edit | ✅ |
| POST | `/expense/card-transactions/:id/unlink` | — | `{ transaction }` | edit | ✅ |
| GET | `/expense/summary` | `from, to`（`YYYY-MM`）, `groupBy?` / `status?`（カンマ区切り）, `basis?` | `{ result: { rows, totals, warnings, … } }` | read | |
| GET | `/expense/summary/export` | 同上 | `{ content, fileName }` | read | ✅ |

**C: 入力と規程（13 本）**

| Method | Path | 入力の要点 | 出力 | 認可 | 監査 |
|---|---|---|---|---|---|
| POST | `/expense/receipts/extract-detail` | `images`（1 枚以上）, `draft: { categoryId?, categoryText?, facts, source?, extraction }` | `{ result }`（印・食い違い付きの下書き。保存しない。モデルが使えなければ 409 `EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE`） | edit | |
| GET | `/expense/fares` | — | `{ table, saved }` | read | |
| PUT | `/expense/fares` | `routes[]: { id, stations, fareType, fare, bidirectional, validFrom?, validTo?, note? }`, `stationAliases[]: { name, aliases }` | `{ table }` | edit | ✅ |
| GET | `/expense/fares/export` | — | `{ content, fileName }` | read | |
| POST | `/expense/fares/import` | `content` | `{ table }` | edit | ✅ |
| POST | `/expense/fares/lookup` | `stations, fareType?, date?, trips?, employeeId?` | `{ result: { fareType, candidates, maxFare?, routeCount, commuterHint? } }` | read | |
| POST | `/expense/policy-hearings` | `mode, documentText?, fileName?` | `{ hearing }`（409 `EXPENSE_HEARING_UNAVAILABLE` / 502 `EXPENSE_HEARING_SCHEMA`） | edit | |
| GET | `/expense/policy-hearings` | `status?` | `{ hearings }`（原文を含めない要約） | read | |
| GET | `/expense/policy-hearings/:id` | — | `{ hearing }` | read | |
| POST | `/expense/policy-hearings/:id/answers` | `answers: [{ questionId, value }]`（1 件以上） | `{ hearing }` | edit | |
| GET | `/expense/policy-hearings/:id/diff` | — | `{ changes, basePolicyUpdatedAt, stale }`（現在の規程に対する差分。提案が無ければ 409） | read | |
| POST | `/expense/policy-hearings/:id/accept` | `changeIds`（1〜500）, `basePolicyUpdatedAt` | `{ hearing, policy }`（規程の版が違えば 409 `EXPENSE_POLICY_CONFLICT`） | edit | ✅ |
| POST | `/expense/policy-hearings/:id/cancel` | — | `{ hearing }` | edit | |

#### エラー（`expense-error-mapping.ts`）

| 例外 | status | code | 付加情報 |
|---|---|---|---|
| `Expense{Claim,Item,Receipt}NotFoundError` | 404 | `EXPENSE_{CLAIM,ITEM,RECEIPT}_NOT_FOUND` | |
| `ExpenseCsvImportError` / `ExpenseDomainError` | 400 | `EXPENSE_CSV_IMPORT` / `EXPENSE_DOMAIN` | `row?` |
| `ExpenseTransitionError` | 409 | `EXPENSE_TRANSITION` | `blockingReasons`, `nextStep?`, `claims?` |
| `ExpenseJournalLinkError` / `JournalDraftRejectedError` | 409 | `EXPENSE_JOURNAL_LINK` | `problems`, `createdEntryIds` |
| `JournalExtraction*Error`（読取。仕訳と共通） | 409 / 502 | `JOURNAL_EXTRACTION_UNAVAILABLE` / `JOURNAL_EXTRACTION_SCHEMA` | §3.4 と同じ |
| `Expense{Employee,Advance,Payout,CardTransaction,CardImport,Hearing}NotFoundError` | 404 | `EXPENSE_*_NOT_FOUND` | |
| `ExpenseEmployeeCsvImportError` / `ExpenseCardImportError` | 400 | `EXPENSE_EMPLOYEE_CSV_IMPORT` / `EXPENSE_CARD_IMPORT` | `row?`, `missingColumns?`（カードは `suggestedMapping?`） |
| `ExpenseCardDuplicateImportError` | 409 | `EXPENSE_CARD_DUPLICATE_IMPORT` | `importId`, `importedAt` |
| `ExpensePayoutBlockedError` | 409 | `EXPENSE_PAYOUT_BLOCKED` | `problems[{ code, employeeId?, claimId?, advanceId?, field?, message, fixTarget }]`, `warnings[]` |
| `ExpensePolicyConflictError` | 409 | `EXPENSE_POLICY_CONFLICT` | `currentUpdatedAt` |
| `ExpenseDetailExtractionUnavailableError` / `ExpenseHearingUnavailableError` | 409 | `EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE` / `EXPENSE_HEARING_UNAVAILABLE` | `missing` |
| `ExpenseHearingSchemaError` | 502 | `EXPENSE_HEARING_SCHEMA` | `issues[]` |

実用化で `ExpenseDomainError` の付加情報に `field?` / `employeeId?` / `conflictEmployeeId?` / `converted?` が、`ExpenseTransitionError` の `blockingReasons` に承認・仮払・カードの擬似コード（`approval-step-changed` / `advance-status` / `card-item-matched` など。理由コードではない。docs/21 §20.5.1 / §20.9.3）が増えた。

### 3.6 請求書発行と入金消込（receivables）

請求書を発行し、銀行明細を取り込んで自動で消込候補を判定する（[docs/22-receivables.md](./22-receivables.md) / [ADR-0041](./adr/0041-receivables-payment-matching.md)）。登録点は `receivables-routes.ts` / `receivables-schemas.ts` / `receivables-authorization.ts`（`RECEIVABLES_ROUTE_RULES`）/ `receivables-error-mapping.ts`（`receivablesHttpError`）。

**請求書（`/receivables/invoices`）**: 状態は `draft → issued`（取消は `void`）。`POST /receivables/invoices/check` は**保存せずに**税額（明細ごとの端数処理・税率別集計）を検査し集計するので、下書き保存前にも同じ規則で試算できる。発行後は明細を直接編集できず、`PUT` は 409 になる。

**入金明細と消込（`/receivables/bank-transactions`・`/receivables/matching*`）**: CSV の文字コード判定・プリセット判定・列マッピングは `POST /receivables/bank-transactions/preview`（保存しない）で試してから `import`。`POST /receivables/matching/judge` が消込候補を計算し、明細ごとに `stage`（`decided` / `candidate` / `unmatched`）を付ける。`decided` は金額と支払人名が一意に一致したもので、`POST /receivables/matchings/confirm-decided` で一括確定できる。`candidate` は振込手数料差引・複数請求書の合算・部分入金・部分一致名などが理由で、人が `GET /receivables/matching/candidates?transactionId=` で候補を見てから `POST /receivables/matchings` で配分を確定する。確定時に `expectedOutstanding`（画面が見ていた未回収額）を渡すと、その間に他で消し込まれていた場合の競合を検出できる。

```jsonc
// POST /receivables/matchings { scope, transactionId, allocations: [{ invoiceId, amount }], feeAmount, expectedOutstanding?, learnAlias?: { customerId } }
// → 200 { result: { matching, invoicesUpdated, journalEntryIds? } }
```

**仕訳連携**: 設定（`/receivables/settings` の `journal`）に科目・税区分・売上計上日の基準を持ち、発行・消込確定のたびに仕訳下書きを作る。科目が未設定なら 409 `RECEIVABLES_JOURNAL_ACCOUNT_MISSING`（`missing` に足りない科目キー）。

**注文書・見積書からの請求書案**: 添付画像を vision で読んで請求書下書きを作る組込みツール（`receivables_invoice_draft`）向けの機能フラグは `GET /runtime/capabilities` の `receivables.invoiceDraft`。

#### エラー（`receivables-error-mapping.ts`）

| 例外 | status | code | 付加情報 |
|---|---|---|---|
| `ReceivablesDomainError` | 400 | `RECEIVABLES_DOMAIN` | |
| `InvoiceComplianceError` | 400 | `RECEIVABLES_INVOICE_COMPLIANCE` | `violations` |
| `ReceivablesCsvImportError` | 400 | `RECEIVABLES_CSV_IMPORT` | `row?` |
| `{Customer,Invoice,BankTransaction,Matching,BankCsvProfile}NotFoundError` | 404 | `RECEIVABLES_*_NOT_FOUND` | |
| `ReceivablesStateError` | 409（配分・プロファイル系の理由は 400） | `RECEIVABLES_STATE` | `reason`, `params` |
| `JournalLinkError` | 409 | `RECEIVABLES_JOURNAL_ACCOUNT_MISSING` | `missing` |
| `ReceivablesExtractionUnavailableError` | 409 | `RECEIVABLES_EXTRACTION_UNAVAILABLE` | |

### 3.7 契約書レビューと期限台帳（contract）

契約書を取り込み、審査基準（playbook）と突き合わせて条項ごとの評価（`accept` / `negotiate` / `reject` / `unresolved`）を出し、締結後は更新・満了・通知期限を期限台帳で追跡する（[docs/23-contract.md](./23-contract.md) / [ADR-0042](./adr/0042-contract-playbook-review.md)）。登録点は `contract-routes.ts` / `contract-schemas.ts` / `contract-authorization.ts`（`CONTRACT_ROUTE_RULES`）/ `contract-error-mapping.ts`（`contractHttpError`）。**レビュー結果は審査基準との照合であり法的判断ではない** — 応答は必ず定型の注意文言（`notice`。`LEGAL_DISCLAIMER_JA`）を添えて返す（`contractReviewResponse`）。

**文書の取込（`/contracts/documents`）**: PDF はブラウザ側でテキスト層抽出 or ページ画像化してから本文・ページ境界を送る（サーバーは PDF を扱わない。仕訳・経費と同じ方針）。スキャン PDF や画像は先に `POST /contracts/documents/transcribe`（vision。**保存しない**）で文字起こしする。取込・更新の本文上限は 2 MiB（`CONTRACT_IMPORT_BODY_LIMIT_BYTES`）。

**条項抽出とレビュー**: `POST /contracts/documents/:id/extract` が LLM で条項を抽出し文書へ保存する（`scanAllArticles` / `articleRefs` で一部だけ読み直せる）。人が `PUT /contracts/documents/:id/clauses` で確認・修正して確定（`confirmed`）させたのち、`POST /contracts/documents/:id/reviews` が審査基準の決定的な判定 + はい/いいえ型の LLM 基準でレビューを起こす。`PUT /contracts/reviews/:id/decisions` で人がトピックごとに `accept` / `negotiate` / `reject` を選び、`POST /contracts/reviews/:id/finalize` で確定する（未判断のトピックが残っていれば 400 に一覧が付く）。

**締結登録と期限台帳**: `POST /contracts/deadlines/preview` は締結日・締結方法から更新/満了/通知期限を**保存せず**試算する（画面の即時表示用）。`POST /contracts/signed` で締結登録すると期限台帳（`GET /contracts/deadlines`）に載る。`kind` は `renewal_notice` / `expiry` / `renewal` / `custom`。印紙税の候補（`stampDuty`）も文書全体の突き合わせ結果として付く。

```jsonc
// POST /contracts/documents/:id/reviews { scope, playbookId? } → 200 { review, notice }
// review.topics[]: { topicId, verdict, articleRef?, quote?, quoteVerified, reasons[], recommendedText? }
```

**LLM 機能フラグ**: `GET /runtime/capabilities` の `contract`（`extraction: { enabled, vision }` は文字起こし・条項抽出、`review.llm` ははい/いいえ型基準の LLM 判定。使えなくても決定的な判定は出る）。

#### エラー（`contract-error-mapping.ts`）

| 例外 | status | code | 付加情報 |
|---|---|---|---|
| `Contract{Playbook,Document,Review}NotFoundError` / `SignedContractNotFoundError` | 404 | `CONTRACT_*_NOT_FOUND` | |
| `ContractDomainError` | 400 | `CONTRACT_DOMAIN` | `details`（例: `undecidedTopicIds`） |
| `ContractStateError` | 409 | `CONTRACT_STATE` | `documentId` / `contractId` / `reviewId` |
| `ContractExtractionUnavailableError`（モデル未設定・能力不足） | 409 | `CONTRACT_EXTRACTION_UNAVAILABLE` | |
| `ContractExtractionSchemaError`（修復後もスキーマ違反） | 502 | `CONTRACT_EXTRACTION_SCHEMA` | |

### プロンプト自動生成（目玉機能）のリクエスト/レスポンス例

```jsonc
// POST /agents/{id}/generate-prompt
// request
{
  "skills": ["skill:rag-qa@1.2.0"],
  "tools":  ["tool:search-docs@2.0.0"],
  "regenerate": ["skill-description", "tool-usage-guide"]
}
// response — 生成物は必ず人がレビュー・編集できる（エスケープハッチ）
{
  "systemPromptDraft": "あなたは... （自動生成）",
  "sections": {
    "skillDescription": "...",
    "toolUsageGuide": "..."
  },
  "editable": true,
  "sources": ["skill:rag-qa の責務・発火条件", "tool:search-docs の入出力"]
}
```

保存済みAgent実行では、system promptとTool候補をAgent versionから解決する。
v1の実行上限はTool call 4回、model round 5回であり、実際の呼び出し順はRun traceと`tools`へ保存する。

複数Agentの制御フローは`/harnesses`と`/harness-runs`で分離する。Harnessはpattern別の型付き定義を保存し、Handoffの追加入力やMagenticの計画承認は`POST /harness-runs/:runId/responses`の型付きrequest/responseで再開する。完全な契約は [14-agent-harness-builder.md §9](./14-agent-harness-builder.md#9-rest-api) を参照。

```jsonc
// POST /runs
{
  "scope": { "tenantId": "local", "workspaceId": "default" },
  "agent": { "internalId": "assistant-agent", "version": "1.0.0" },
  "message": "Aliceのスコアを確認して",
  "mode": "preview"
}
```

`POST /runs`（`agent` / `tool` どちらの本文にも共通）は添付を 2 種類受ける。

- `images`（最大 2 枚）: `{ name, dataUrl }`。SVG と外部 URL は不可（データ URL に限定）。
- `documents`（テキスト添付。最大 2 件・合計 400,000 文字、1 件 300,000 文字まで）: `{ name, text, pageCount? }`。ブラウザで PDF のテキスト層から抜いた本文などを、画像とは別の一覧で渡す。**本文はモデルへのメッセージには載せず、ツールの実行文脈にだけ渡す**（12B 級モデルの文脈をメッセージ本文で埋めないため）。契約書レビューの vision を使わない経路（docs/23-contract.md §9.4 C2）はこれで本文を渡す。

いずれも `runAgentBodySchema`（`src/api/schemas.ts`）が検証する。

---

### 3.8 ツールテンプレート（tool templates）

Tool を 1 から組む代わりに、**テンプレートを選んでスロットを埋める**経路（[ADR-0049](./adr/0049-tool-templates.md) / [implementation/v43](../implementation/v43-tool-templates.md)）。テンプレートは外部ファイル（`templates/tools/*.json`）で、Agent Factory とツール作成画面（[docs/06 §3.16](./06-etl-tool-builder.md)）が同じ 3 本を使う。**保存はしない** — 返すのはキャンバスへ展開するためのグラフである。

```jsonc
// GET /tool-templates?tenantId=…&workspaceId=…
{
  "templates": [
    {
      "id": "period-series", "version": "1.0.0",
      "title":   { "ja": "時系列の取り出し", "en": "Time series lookup" },
      "summary": { "ja": "期間の範囲・粒度・カテゴリで絞って…", "en": "Returns a value series filtered by…" },
      "whenToUse": { "ja": ["ある指標の推移を答えたい"], "en": ["Trends over time"] },
      "notFor":    { "ja": ["前年比が要る（period-change を使う）"], "en": ["Year-over-year change"] },
      "tags": ["time-series", "lookup"],
      "sources": { "min": 1, "max": 1 },
      "slots": [
        { "name": "source", "kind": "dataSource", "label": { "ja": "データソース", "en": "Data source" }, "optional": false },
        { "name": "periodColumn", "kind": "column", "source": "source", "role": "period", "label": { … }, "optional": false },
        { "name": "valueColumns", "kind": "column", "source": "source", "role": "value", "multiple": { "min": 1, "max": 5 }, "label": { … }, "optional": false },
        { "name": "limit", "kind": "number", "min": 1, "max": 100, "integer": true, "default": 36, "label": { … }, "optional": false }
      ]
    }
  ],
  // 読めなかったファイル。問題文は必ず「何が悪いか」と「どう直すか」を含む。
  "invalid": [{ "file": "broken.json", "problems": ["id 'Broken!' does not match …; rename it to lowercase letters, digits and hyphens"] }]
}
```

置き場所が 1 つも無い構成でも `{ "templates": [], "invalid": [] }` を返す（機能が無効なだけで、エラーではない）。

```jsonc
// POST /tool-templates/period-series/slot-candidates
{ "scope": { … }, "dataSourceIds": ["ds-population"], "values": { "periodColumn": "時点" }, "language": "ja" }  // values は部分でよい。language は arguments の説明の言語（既定 ja）
// → 200
{
  "templateId": "period-series", "version": "1.0.0",
  "candidates": [
    { "slot": "source", "kind": "dataSource", "options": [{ "value": "ds-population", "name": "人口" }] },
    { "slot": "periodColumn", "kind": "column", "options": [
      { "value": "時点", "type": "string", "granularities": { "year": 4, "month": 1 }, "minStart": "2022-01-01", "maxStart": "2023-05-01" }] },
    { "slot": "categoryColumn", "kind": "column", "options": [
      { "value": "地域", "type": "string", "examples": ["北海道", "東京都"], "distinctCount": 2 }] },
    { "slot": "joinKeys", "kind": "joinKeys", "options": [
      { "value": "時点", "overlap": 1, "uniqueLeft": false, "uniqueRight": false }] },
    { "slot": "defaultGranularity", "kind": "choice", "options": [{ "value": "year" }, { "value": "month" }] },
    { "slot": "limit", "kind": "number", "range": { "min": 1, "max": 100 } },
    { "slot": "outputColumn", "kind": "text", "freeText": true }
  ],
  // いまの values で `when` を評価して**残る**エージェント引数だけ（画面はこれを「必須」チェックの行として描く）。
  // nullable はテンプレートの既定。lock があれば切り替え不可で、その理由（language の言語）。
  "arguments": [
    { "name": "granularity", "type": "string", "nullable": false, "lock": "省略できると月次と年次が混ざるため、必須に固定しています", "description": "期間の粒度。…" },
    { "name": "period_from", "type": "date", "nullable": true, "description": "この日以降に始まる期間（ISO 日付）…" }
  ]
}
```

候補は**プロファイルから決定的に**作る（LLM を使わない）。`options` には「なぜ選べるか」を添える: 列の型、カテゴリ列の実在値（最大 8 件）と総数、期間列の粒度ごとの行数と開始日の範囲、結合キーの値の重なり（0..1）と、**候補キーを全部使ったときの**左右の一意性。`values` を渡すと、それに依存する候補（どのソースの列か・結合キー・粒度）がその選択に合わせて絞られる。

```jsonc
// POST /tool-templates/period-series/instantiate
{
  "scope": { … }, "dataSourceIds": ["ds-population"], "language": "ja",
  "values": { "source": "ds-population", "periodColumn": "時点", "valueColumns": ["人口"], "defaultGranularity": "year", "limit": 12 },
  // 必須。モデルへ公開する function 名（`^[A-Za-z0-9_-]{1,64}$`）。既定は持たない — テンプレート id を既定にすると
  // 同じテンプレートから作った2本目が1本目と同じ内部ID・公開名になり、別のToolのつもりが既存Toolの新版になる。
  "toolName": "population_series",
  // 任意。引数名 → nullable。テンプレートの既定から変える引数だけを書く。lock のある引数を変える・テンプレートに無い名前・
  // 設計時の見本が無い引数を必須にする、は 422 TOOL_TEMPLATE_SLOTS（slot は "argument:<name>"）。when で落ちた引数への指定は無視する。
  "argumentNullability": { "period_from": false }
}
// → 200
{
  "template": { "id": "period-series", "version": "1.0.0" },
  "graph": { "nodes": [ … ], "edges": [ … ] },
  "inputSchema": { "columns": [{ "name": "granularity", "type": "string", "nullable": false }, … ] },
  "agentTool": { "name": "period-series", "description": "人口 の推移を返します（新しい順、最大 12 行）。…" },
  // `$intent` を持つテンプレートだけ。式は空のまま返り、画面が関数電卓の「AIに式を書かせる」へ意図文を入れる。
  "pendingExpressions": [{ "nodeId": "calc", "intent": "人口を千で割る" }]
}
```

実体化した結果は**手で組んだ Tool と同じ検査**（スキーマ伝播・設計時プレビュー）を通してから返す（テンプレート経路だけの抜け道を作らない）。ただし `pendingExpressions` が残るグラフは式が空の中間生成物なので、その検査は式が入った後（ツール作成画面の自動プレビュー・保存時の検証）に回す。

**エラー**

| 状況 | status | code | 本文 |
|---|---|---|---|
| 知らないテンプレート `id` | 404 | `TOOL_TEMPLATE_NOT_FOUND` | 使える id を挙げる |
| スロットの値がデータに合わない | 422 | `TOOL_TEMPLATE_SLOTS` | `slots: [{ slot, message }]` |
| 実体化そのものの失敗（データソースの数が合わない等） | 422 | `TOOL_TEMPLATE` | 何個選べばよいかを言う |
| 本文の形が違う | 400 | `BAD_REQUEST` | どの項目が悪いか |

```jsonc
// 422 TOOL_TEMPLATE_SLOTS
{
  "error": {
    "code": "TOOL_TEMPLATE_SLOTS",
    "message": "1 slot(s) of the template 'period-series' need a different value",
    "slots": [
      { "slot": "valueColumns", "message": "slot 'valueColumns' is set to '世帯数', which is not a value column of that data source; choose one of 人口" }
    ]
  }
}
```

`slots[].slot` は**どの入力欄を直せばよいか**で、画面はその欄の真下にメッセージを出す。欄に紐づけられない問題（グラフ全体の検査で出たもの）は `slot` を持たない。

### 3.9 設計アシスタント

ツール作成画面のチャットパネルから、自由文の指示で**いまのキャンバスを編集する**（[docs/06 §3.17](./06-etl-tool-builder.md#317-設計アシスタント文章で指示するとノードが増える) / [ADR-0051](./adr/0051-tool-design-chat.md)）。認可は `execute` on `tool`（設計時プレビューでデータを読むため、プレビューと同じ）。**保存はしない** — 返るのはキャンバスへ展開する編集後のグラフで、保存は従来どおり `PUT /tools/{id}` 等。

```jsonc
// POST /tool-drafts/design-chat
{
  "graph": { "nodes": [ … ], "edges": [ … ] },     // いまのキャンバス（position つき）
  "inputSchema": { "columns": [ … ] },              // 任意。省略すると graph の agent-input から読む
  "instruction": "地域を引数で絞れるようにして",
  "transcript": [                                    // 任意。直近の会話（画面が持つ。古い順、最大40ターン。
                                                       // モデルへ送る直近12ターンへの切り詰めは応用層が行う）
    { "role": "user", "content": "都道府県別の総人口を年次に絞って多い順に10件返して" },
    { "role": "assistant", "content": "年次の総人口を多い順に10件返すツールにしました。" }
  ]
}
// → 200
{
  "message": "地域コードを引数 region にして、filter を束縛しました。省略すると全地域を返します。",
  "graph": { "nodes": [ … ], "edges": [ … ] },      // 編集後。変更が無いときは省略（キャンバスは変えない）
  "changes": [                                        // 画面が一覧に出し、対象ノードを強調する。summary は決定的な英文
    { "op": "set-config", "nodeId": "agent-input", "summary": "set config of agent-input 'agent-input': schema={\"columns\":[…]}" },
    { "op": "set-config", "nodeId": "filter-1", "summary": "set config of filter 'filter-1': column=\"地域\", op=\"eq\", valueBinding=\"region\"" }
  ],
  "repaired": false,                                  // 1回差し戻して通ったか
  "repairedFrom": ["node 'out': …"],                   // 差し戻したときだけ。1回目の失敗理由（画面には出さない。文を調整する材料）
  "problems": [],                                      // 適用できなかったときだけ、理由（英語の原文。画面が localizeDetail 経由で日本語化）
  "warnings": [],                                      // 適用はしたが注意点（例: 粒度が混在する列に粒度の filter が無い）。画面は黄色の注記で出す
  "promptTemplateVersion": "design-chat/v2"
}
```

- 質問への回答・曖昧で聞き返す等、キャンバスを変えない応答は `graph` を省略し `changes: []`。
- 差し戻しても検査（正規化 → スキーマ伝播 → 設計時プレビュー）を通らなかったときは `graph` を省略し、`problems` に理由と `message` にモデルの説明を返す。**この場合も HTTP は 200**（アシスタントの応答であって、API 呼び出しそのものの失敗ではない）。
- モデル未設定・モデル呼び出しの失敗は 502 `MODEL_PROVIDER`（既存の式提案と同じ経路。画面は先に `/runtime/capabilities` で案内する）。本文の形が違えば 400 `BAD_REQUEST`。
- request には任意で `agentTool: { name, description }`（いまの Tool Calling 契約。空文字を含んでよい）と `transcriptSummary`（圧縮済みの古い会話。最大 4,000 字）を載せる。応答には `set-agent-tool` を適用したときだけ `agentTool`、毎回 `usage: { promptTokens?, completionTokens?, contextWindow? }`（直前の呼び出しの実数。`contextWindow` は LM Studio の `/api/v0/models/<id>` から取れたときだけ）。
- 操作の語彙には `set-agent-tool { description, name? }` があり、グラフではなく Tool Calling 契約（エージェントが呼ぶ前に読む説明文）を置き換える。引数を足した・変えたときは同じ応答で説明文も更新するよう規則で求めている（`changes` には `{ "op": "set-agent-tool", "nodeId": "agent-tool" }`）。

```jsonc
// POST /tool-drafts/design-chat/compact — 古い会話をモデルに要約させる（認可: execute on tool）
{ "scope": { … }, "previousSummary": "…", "turns": [{ "user": "…", "assistant": "…", "changes": ["added parse-period 'period' after 'src' …"] }], "language": "ja" }
// → 200
{ "summary": "- データソース: eStat 総人口 …
- 全国の行は除外 …", "usage": { "promptTokens": 761, "completionTokens": 120, "contextWindow": 200192 } }
```

`turns` は 1〜40 件（古い順）。要約は `prompts/tool/design-chat-compact.md` の指示で作り（次のターンで読む覚え書き。目的・決めたこと・適用した変更の要点・未解決の質問を残す）、空なら 1 回、800 字超なら 1 回だけ出し直させる。画面は直近 4 ターンを残し、それより古いターンをここへ送って `transcriptSummary` に置き換える。

`GET /runtime/capabilities` に `designAssistant: { enabled: boolean }` が加わる（`calculateAssistant` と同じ判定: main スロットのモデルが設定済みで構造化出力に対応していること）。

---

## 4. Tool Callingスキーマ（Input / Output）

`ideas-v2.md §1` の I/O契約化。引数スキーマ = Input Schema、出力スキーマ = Output Schema。

```mermaid
flowchart LR
  ARG["Tool引数定義<br/>（画面で定義）"] --> INSCH["Input Schema<br/>JSON Schema"]
  INSCH --> LLMCALL["LLM Tool Calling"]
  LLMCALL --> EXEC["Tool実行（ETL）"]
  EXEC --> OUT["出力"]
  OUT --> OUTSCH["Output Schema<br/>Zod検証"]
  OUTSCH --> VERIFY{"実データと一致?"}
  VERIFY -->|Yes| RET["構造化結果を返す"]
  VERIFY -->|No| FAIL["検証エラー → トレースへ"]
```

### Input Schema 例（LLMへ提示）

```json
{
  "name": "sales_summary",
  "description": "月次売上サマリを返す。read-only。",
  "input_schema": {
    "type": "object",
    "properties": {
      "month":  { "type": "string", "pattern": "^\\d{4}-\\d{2}$" },
      "region": { "type": "string", "enum": ["east", "west", "all"] }
    },
    "required": ["month"]
  },
  "x-side-effect": "read-only"
}
```

### Output Schema 例（アプリ側で検証）

```json
{
  "type": "object",
  "properties": {
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "region": { "type": "string" },
          "total":  { "type": "number" }
        },
        "required": ["region", "total"]
      }
    },
    "chart": { "$ref": "#/definitions/ChartJsData" }
  },
  "required": ["rows"]
}
```

- 出力を推論できない（API / pivot / カスタムコード）場合は作成者が Output Schema を明示し、実行時に実データと一致検証する。
- `x-side-effect` により `write` / `external-action` は実行前承認の対象（[08-security-auth.md](./08-security-auth.md)）。

---

## 5. API横断の規約

- **エラー**: SDK固有例外はAdapterで内部エラー型へ変換して返す（`ideas-v2.md §8`）。
- **テナント境界**: すべての永続API呼び出しに `tenant/workspace` スコープを適用。
- **実行モード**: `preview / test / production` を明示し、使用データと権限を分離。
- **冪等性**: `write` を伴う操作は冪等キーを推奨（`ideas-v2.md §1` 副作用宣言と対応）。
- **監査**: すべての実行・承認・公開・認可拒否を `AuditSink` へ記録。