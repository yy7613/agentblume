# v28 実装計画: Tool Output Nodes + Agent Session Workspace

> Status: M2 partial implementation (2026-07-11). Local table Artifacts use JSONL files, bounded offset/limit reads, and a safe structured query DSL. Graph Output normalizes mapped edge tables into a bounded property-graph Artifact; graph streaming/query and ETL streaming remain follow-up slices.
> Architecture decision: [ADR-0027](../docs/adr/0027-tool-output-and-session-workspace.md)

## 1. Goal

Tool Builderへ明示的なOutputノードを追加し、Tool実行結果を次のどちらかへ配送できるようにする。

1. `agent-output`: 制限付きで整形し、Agentへ直接返す。
2. `workspace-output`: Agent Session WorkspaceへArtifactとして保存し、Agentへ参照だけを返す。

さらに、現在は独立している複数Runを`AgentSession`で束ね、同一会話およびサブAgent間でArtifactを安全に再利用できるようにする。

## Implementation status

The following usable vertical slice is now in the codebase.

- `agent-output` and `workspace-output` are registered `sink` nodes. The palette has a dedicated Output section, and sinks do not expose a downstream handle.
- `ToolOutputDispatcher` applies inline row/byte limits, deterministic output shapes, overflow-to-artifact, artifact descriptors, idempotency keys, revisions, and Session quotas.
- `AgentSession` and `SessionArtifact` are persisted in the test/local profiles. The local catalog is SQLite while payloads are atomically written to a Session-scoped filesystem directory; Run records carry `sessionId`. Chat creates one Session for a conversation and displays the Session Workspace artifact drawer.
- Table Artifacts use an NDJSON/JSONL payload file. `workspace_read` and the Artifact API accept bounded `offset`/`limit` pages instead of returning a whole table. `workspace_query` is a data-only DSL limited to selected columns, one scalar comparison filter, and one aggregate over the bounded table page; it does not interpret SQL or code. Graph Output provides source/target/optional-label column selectors, produces a property graph with node/edge counts, and supports bounded `nodes` or `edges` reads. Child Agents inherit the same Session.
- Tool Builder uses structured selectors/rule editors and an Apply/Cancel dialog for complex node settings. Raw text/JSON remains under Advanced only for bulk editing and compatibility.

Deliberate follow-ups are M2+ work: generic JSON/blob chunk reads, object storage, streamed graph codec/query traversal, richer table query operators and cross-page aggregation, `session-artifact-source`, background GC, and ETL materialization removal. The current local adapter streams table rows while writing and reads bounded JSONL pages, but the ETL input table is still materialized in memory; it is not yet a complete large-data pipeline.

## 2. Scope

### Included

- `sink`ノード種別と2つのOutput node config。
- Agent Sessionの作成、参照、close、TTL/状態遷移。
- Session Artifactのmetadata catalogとpayload store Port。
- SQLite catalog + filesystem payloadのローカルadapter。
- Tool Output Dispatcherとinline/Artifact descriptor result。
- Chat/Run/子Agent/Scenario/EvaluationへのsessionId伝播。
- Workspace一覧・describe・範囲read・安全な表queryの組み込みAgent Tool。
- Tool BuilderのOutput palette、sink専用表示、Inspector、preview。
- Session/Artifact trace、quota、GC、idempotency。
- legacy Tool/Run APIの後方互換。

### Not included in the first delivery

- 汎用NoSQL更新API。
- ユーザー定義ToolへArtifact全体をstream入力する`session-artifact-source`ノード（初期版は組み込みqueryで代替）。
- 任意SQL、任意コード、自由形式GraphQL。
- Project Workspaceへの長期保存、Wikiへの自動昇格。
- 複数終端sink。
- ETL全Transformの完全streaming化。
- object storage、Parquet、専用graph DBのproduction adapter。
- SessionをまたぐArtifact共有。

## 3. Domain model

### 3.1 Agent Session

新規: `src/domain/session/agent-session.ts`

```ts
type AgentSessionStatus = 'active' | 'closed' | 'expired';

interface AgentSession {
  readonly id: string;
  readonly scope: TenantScope;
  readonly rootAgent: { readonly internalId: string; readonly version: string };
  readonly status: AgentSessionStatus;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
  readonly expiresAt: string;
  readonly closedAt?: string;
  readonly quota: SessionQuota;
}

interface SessionQuota {
  readonly maxBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxArtifacts: number;
}
```

不変条件:

- ID、scope、root Agent版、時刻は必須。
- `expiresAt > createdAt`。
- close/expire済みSessionは再active化しない。
- root Agent版はSession途中で変更しない。
- touchはactive Sessionだけに許可し、最大TTLを超えて延長しない。

新規: `src/domain/session/session-repository.ts`

```ts
interface AgentSessionRepository {
  save(session: AgentSession): Promise<void>;
  find(scope: TenantScope, sessionId: string): Promise<AgentSession | null>;
  listExpired(now: string, limit: number): Promise<readonly AgentSession[]>;
}
```

### 3.2 Session Artifact

新規: `src/domain/session/session-artifact.ts`

```ts
type SessionArtifactKind = 'table' | 'json' | 'chart' | 'graph' | 'blob';

interface SessionArtifact {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: TenantScope;
  readonly name: string;
  readonly kind: SessionArtifactKind;
  readonly revision: number;
  readonly contentType: string;
  readonly schema?: Schema;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly counts?: { readonly rows?: number; readonly nodes?: number; readonly edges?: number };
  readonly origin: {
    readonly runId: string;
    readonly agentId?: string;
    readonly toolId: string;
    readonly toolVersion: string;
    readonly toolCallId: string;
    readonly sinkNodeId: string;
  };
  readonly createdAt: string;
  readonly expiresAt: string;
}
```

`name`は表示と競合判定用、`id`はopaque識別子。payload path/storage keyはdomainへ露出しない。

### 3.3 Output configs

新規:

- `src/domain/etl/nodes/agent-output.ts`
- `src/domain/etl/nodes/workspace-output.ts`

両ノードとも`kind:'sink'`、`inputArity:1`。`inferSchema`/`execute`はidentityで、config検証だけをdomainで行う。

`EtlNode.inputArity`は既存の`0 | 1 | 2`を維持する。`NodeKind`には既に`sink`があるため型追加は不要。

### 3.4 Tool contract

`Tool`へ後方互換なresult contractを追加する。

```ts
type ToolResultContract =
  | { readonly delivery: 'agent'; readonly contentType: string; readonly maxBytes: number }
  | { readonly delivery: 'session-workspace'; readonly schema: 'artifact-descriptor/v1' };

interface Tool {
  // existing fields
  readonly resultContract?: ToolResultContract;
}
```

古いToolの`resultContract:undefined`は暗黙のagent deliveryと解釈する。

### 3.5 Side effect

`SideEffect`を次へ拡張する。

```ts
type SideEffect = 'read-only' | 'session-write' | 'write' | 'external-action';
```

順序は`read-only < session-write < write < external-action`。Capability解決時は最大値を採る。preview/testは`read-only`と`session-write`を許可する。

## 4. Storage design

### 4.1 Catalog

SQLite tables:

```sql
CREATE TABLE agent_sessions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  root_agent_id TEXT NOT NULL,
  root_agent_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, session_id)
);

CREATE TABLE session_artifacts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, session_id, artifact_id),
  UNIQUE (tenant_id, workspace_id, session_id, idempotency_key),
  UNIQUE (tenant_id, workspace_id, session_id, name, revision)
);
```

### 4.2 Payload

ローカルprofile:

```text
<runtime-data>/session-artifacts/
  <tenant-hash>/<workspace-hash>/<session-id>/<artifact-id>/payload
```

- path componentはserver側で生成し、入力文字列をpathへ連結しない。
- 一時ファイルへstream書き込み、checksumとsizeを確定後にatomic renameする。
- catalog insertに失敗したpayloadは削除する。payload確定前のcatalog公開は禁止。
- readはoffset/limitまたはcodecのpage cursorを必須にする。
- GCはcatalogをexpiredへ遷移後、payload削除、catalog tombstone削除の順で行う。

### 4.3 Codecs

```ts
interface ArtifactCodec<T> {
  readonly kind: SessionArtifactKind;
  encode(value: T): AsyncIterable<Uint8Array>;
  describe(handle: ArtifactReadHandle): Promise<ArtifactDescription>;
  read(handle: ArtifactReadHandle, request: ArtifactReadRequest): Promise<ArtifactPage>;
}
```

初期codec:

- `table`: `application/x-ndjson`、1行目にschema metadata、その後1 row/line。
- `json`: `application/json`、size上限内のdocument。
- `chart`: `application/vnd.agentblume.chart+json`。
- `graph`: `application/vnd.agentblume.property-graph+ndjson`、header/nodes/edges section。
- `blob`: metadata付き`application/octet-stream`。Agentからの直接readは既定禁止。

## 5. Application services

### 5.1 Session use cases

新規: `src/application/session/`

- `CreateAgentSessionUseCase`
- `GetAgentSessionUseCase`
- `CloseAgentSessionUseCase`
- `TouchAgentSessionUseCase`
- `CollectExpiredSessionsUseCase`

Session作成時にAgent versionの存在を検証し、version省略はlatestへ解決して固定する。

### 5.2 Artifact use cases

- `ListSessionArtifactsUseCase`
- `DescribeSessionArtifactUseCase`
- `ReadSessionArtifactUseCase`
- `DeleteSessionArtifactUseCase`
- `QuerySessionTableUseCase`

すべて最初にscope/session/statusを検証し、readも`lastAccessedAt`を更新する。query DSLは列名、比較演算、limit、group aggregateだけのallowlistとする。

### 5.3 Tool Output Dispatcher

新規: `src/application/tool/tool-output-dispatcher.ts`

```ts
interface DispatchToolOutputInput {
  readonly scope: TenantScope;
  readonly session: AgentSession;
  readonly runId: string;
  readonly tool: Tool;
  readonly toolCallId: string;
  readonly sinkNode: GraphNode;
  readonly table: Table;
  readonly mode: RunMode;
}

type ToolDeliveryResult =
  | { readonly delivery: 'agent'; readonly contentType: string; readonly value: unknown; readonly sizeBytes: number }
  | { readonly delivery: 'session-workspace'; readonly artifact: ArtifactDescriptor };
```

処理順:

1. terminalがsinkか判定。legacy Toolなら暗黙agent sinkを生成。
2. `Tool.outputSchema`でpayload検証。
3. sink configを再検証。
4. inlineならshape/format/limitを適用。overflow policyを評価。
5. workspaceならquotaとSession状態を検証し、codecでstream保存。
6. Agent向けTool resultとtrace用metadataを返す。

Draft previewではworkspaceへ実書き込みせず、Artifact kind、推定件数、推定size、preview、実行時のwrite planを返す。

### 5.4 Agent runtime integration

`RunSavedAgentPreviewInput`へ`sessionId?: string`を追加する。

- 指定あり: scope、active、root Agent versionを検証して利用。
- 省略: Run限定Sessionを作成し、Run終了後にcloseする。legacy互換用。
- `NodeContext`へsessionを追加し、子Agentへ同じ参照を渡す。
- `executeTool`をasync化し、dispatcher/Artifact Storeをawaitする。
- Modelへ返すworkspace resultはdescriptor + bounded previewだけ。
- RunRecordへ`sessionId`を追加する。

組み込みWorkspace Toolは保存済みAgentのTool参照には含めず、Sessionがあるruntime capabilityとしてmodel tool definitionsへ合成する。ユーザー定義Toolとの公開名衝突を避けるため、予約prefix`workspace_`を設ける。

## 6. API

### 6.1 Session routes

新規: `src/api/session-routes.ts`

```text
POST /agent-sessions
body: { scope, agent: { internalId, version? } }

GET /agent-sessions/:sessionId?tenantId&workspaceId
POST /agent-sessions/:sessionId/close
```

### 6.2 Artifact routes

```text
GET    /agent-sessions/:sessionId/artifacts
GET    /agent-sessions/:sessionId/artifacts/:artifactId
GET    /agent-sessions/:sessionId/artifacts/:artifactId/content?cursor&limit
DELETE /agent-sessions/:sessionId/artifacts/:artifactId
POST   /agent-sessions/:sessionId/artifacts/:artifactId/query
```

content responseはkind別page envelopeとし、巨大JSONを単一responseで返さない。download/export APIは初期版に含めない。

### 6.3 Run route compatibility

`POST /runs`のAgent bodyへ`sessionId?`を追加する。responseとRun queryに`sessionId`を追加する。既存clientは変更なしでも動作する。

Errors:

- `SESSION_NOT_FOUND` 404
- `SESSION_CLOSED` 409
- `SESSION_EXPIRED` 410
- `ARTIFACT_NOT_FOUND` 404
- `ARTIFACT_CONFLICT` 409
- `SESSION_QUOTA_EXCEEDED` 413
- `ARTIFACT_READ_LIMIT` 413
- `UNSUPPORTED_ARTIFACT_QUERY` 422

## 7. Tool Builder UI

UI判断の詳細は [ADR-0028](../docs/adr/0028-structured-node-configuration-ui.md) を単一の真実とする。

### 7.1 Configuration architecture

現行`NodeInspector.tsx`のnode type条件分岐と文字列parserを、次へ分割する。

```text
src/ui/tool-builder/config/
  NodeConfigDialog.tsx
  node-editor-registry.ts
  controls/
    ColumnCombobox.tsx
    MultiColumnCombobox.tsx
    TypedValueInput.tsx
    RuleTable.tsx
    SchemaTable.tsx
  editors/
    AgentInputEditor.tsx
    SourceEditors.tsx
    SelectFilterEditors.tsx
    JoinUnionEditors.tsx
    ColumnRuleEditors.tsx
    OutputEditors.tsx
```

- `node-editor-registry`がnodeごとの`inline | dialog`、summary、draft validation、Editor componentを解決する。
- UIはwire DTOだけを使い、domain/applicationをimportしない。
- serverの`validateConfig`を最終権威とし、UI validationは即時feedbackだけを担う。
- raw JSON/CSV/bulk textはAdvanced tabへ残すが、primary UIでは使用しない。

### 7.2 Sidebar and dialog behavior

Sidebar:

- node名、説明、schema state、上流/出力schema概要、validation issue。
- 1〜3項目のquick settingと設定summary。
- 複雑なnodeには`設定を開く`buttonを表示。

Dialog:

- native `<dialog>`、最大960px、viewportから48px margin、bodyだけscroll。
- Basic / Advanced / Preview。Header/Footerは固定。
- open時にconfigをlocal draftへdeep cloneする。
- Apply時にlocal + server validationし、1回の`updateNodeConfig`で反映する。
- dirtyなCancel/Escape/overlay/別node選択はdiscard確認。
- Dialog draft previewは非永続draft APIを使用し、Canvasの確定previewと区別する。
- Apply後の更新をundo 1操作として扱えるようstore command境界を用意する。

### 7.3 Structured controls

- `ColumnCombobox`: 上流schema候補、検索、keyboard、invalid value保持。schema不明時だけAdvanced custom入力。
- `MultiColumnCombobox`: chip表示、検索追加、並べ替え、重複拒否。
- `TypedValueInput`: string/number/boolean/date/null/undefinedを区別し、列型変更時に無断変換しない。
- `RuleTable`: add/remove/duplicate/reorder、行単位error、keyboard操作。
- `SchemaTable`: name/type/required/sampleを各列で編集。
- 候補100列超で検索を常時表示、200列超でlistをvirtualizeする。

primary UIの置換対象:

| 現在 | 変更後 |
|---|---|
| select/distinctのカンマ区切り | MultiColumnCombobox |
| rename `from:to` | source column combo + target name Rule Table |
| cast `column:type` | column combo + DataType select Rule Table |
| sort `column:direction:nulls` | ordered Rule Table |
| replace `column:from:to` | column combo + typed values Rule Table |
| Agent input `name:type:required` | SchemaTable |
| JSON textarea | row table + Advanced JSON |
| CSV textarea | upload/paste dialog + delimiter combo + preview |

filter、fill-null、joinの現在のdatalist入力も共通ColumnComboboxへ置き換える。

### 7.4 Palette and canvas

- PaletteをInput、Transform、Outputの3sectionへ分割。
- Output nodeは右側のsource handleを描画しない。
- sink追加時は選択ノードから自動接続する。
- 既存sinkがある場合、新しいsink追加は置換確認または拒否する。
- sinkより下流への接続をstoreで拒否する。
- 新規starter graphは`json-source -> filter -> agent-output`。

### 7.5 Output editors

`agent-output`:

- shape、format、columns/valueColumn、max rows/bytes、overflow。
- 推定inline sizeとtoken目安。
- LLMへ実際に渡るbounded preview。

`workspace-output`:

- Artifact name、kind、write mode、conflict policy、preview rows。
- 「Session限定・TTLで削除」「Agentへは参照のみ」を常時表示。
- graph kindではnode id/source/target列mappingを設定する。
- Output設定は項目数が多いためDialogを既定とし、Sidebarにはdelivery、format/kind、limit、推定sizeだけを表示する。

### 7.6 Preview panel

- Payload previewとAgent result previewを分ける。
- workspace sinkは`Would store`としてkind、schema、推定size、descriptor例を表示する。
- inline上限超過をwarning/errorとしてnodeへ表示する。

### 7.7 Chat and Session Workspace drawer

- 初回送信前にSession作成。
- Agent変更時は現在Session closeの確認後、新Session。
- 「新しいチャット」でSession close、新Session未作成状態へ戻す。
- Chat右側にSession Workspace drawerを追加し、Artifact一覧、由来、schema、preview、削除を表示する。
- 大量payloadはページングし、UI stateへ全件保持しない。

## 8. Migration and compatibility

### Legacy Tool

- deserialize時はgraphを変更せず保持する。
- execution時はterminalがsinkでなければimplicit `agent-output`として扱う。
- Tool Builderで開くとvirtual output nodeを表示し、保存時にreal nodeとしてgraphへ追加する。
- legacy Tool versionは書き換えない。保存操作でpatch versionを作る。

### Legacy Run client

- `sessionId`無しの実行はRun限定Sessionで従来同様に完結する。
- 古いRun recordの`sessionId:undefined`を許可する。

### SideEffect

- 保存済み文字列3種はそのままdeserialize可能。
- workspace sinkを持つのに`read-only`で保存しようとした場合、新規saveでは`session-write`への修正を要求する。

## 9. Delivery slices

### Slice UI-0: Structured node configuration

- `NodeEditorRegistry`、`NodeConfigDialog`、Column/MultiColumn combobox、TypedValueInput、RuleTable、SchemaTable。
- select/distinct/rename/cast/sort/replace/agent-inputを文字列構文から構造化editorへ移行。
- join/filter/fill-nullのdatalistを共通comboboxへ移行。
- JSON/CSV sourceのtable/paste/previewとAdvanced raw editor。
- transactional Apply/Cancel、dirty discard、Dialog draft validation/preview。

Exit: 通常操作では区切り構文を入力せず既存全nodeを設定でき、保存されるconfig wire形式は変更しない。

### Slice A: Explicit output node, no persistence

- sink node 2種のdomain config、catalog/UI、legacy implicit sink。
- `agent-output` dispatcher、inline制限、preview/result二層表示。
- `workspace-output`はpreview write planまで。

Exit: 新規Toolは明示sink必須。既存Toolは変更なしで実行可能。

### Slice B: Agent Session

- Session domain/repository/API。
- ChatがSessionを作成し、Run/子Agent/Scenario/Evaluationへ伝播。
- Run recordにsessionId。

Exit: 複数Chat turnが同じSessionとして追跡され、new chatで分離される。

### Slice C: Artifact persistence

- Artifact domain、catalog、filesystem payload、table/json/chart codec。
- workspace dispatcher、quota/idempotency/trace、Artifact API/UI drawer。

Exit: Tool Aが保存した表を同一Session内で一覧・範囲readでき、別Sessionから見えない。

### Slice D: Agent workspace tools

- list/describe/read/query built-ins。
- bounded result、非信頼データ区切り、子Agent共有。

Exit: AgentがArtifact参照を使い、全payloadをpromptへ載せずに後続回答/Tool処理できる。

### Slice E: Large data and graph foundation

- chunked read/write、graph codec/query、`session-artifact-source`、GC負荷試験。
- ETL `DataHandle`またはspill-to-diskの別ADRを作成し、materialize解消へ進む。

Exit: 256 MiB Artifactを定メモリで保存・範囲readでき、property graphのnode/edge部分取得ができる。ETL全体のstreamingは別DoDとする。

## 10. Test strategy

### Domain

- Session状態遷移、TTL境界、root Agent固定、quota値域。
- Artifact kind/revision/origin/checksumの不変条件。
- sink config全分岐、identity schema/execute、invalid config。
- sideEffect順序。

### Repository contract

- InMemory/SQLite Session repositoryのscope分離、expiry list、往復。
- InMemory/filesystem Artifact Storeのstream round-trip、checksum、atomic failure、idempotency、revision、quota。
- 同名Artifactの競合とSession間漏洩拒否。

### Application

- inline rows/first/single/summary、markdown/chart、maxRows/maxBytes、overflow。
- workspace write、preview no-write、closed/expired/quota failure。
- retryしても同じArtifact IDを返す。
- child Agentが同Sessionを継承し、別root Sessionへアクセスできない。
- evaluation case/repetitionごとにSessionが異なる。

### API

- Session lifecycle、Artifact paging/query/error mapping。
- `POST /runs`のsessionId有無。
- scopeを変えたread/deleteを404にする。
- 413/410/409のwire contract。

### UI

- editor registryの解決、sidebar summary、inline/dialog昇格。
- ColumnComboboxの検索、keyboard、schema unknown、invalid選択保持、重複拒否。
- MultiColumn chipの追加/削除/順序、200列超の候補表示。
- TypedValueInputのstring/number/boolean/date/null/undefined。
- RuleTableのadd/remove/duplicate/reorderと行単位error。
- DialogのApply/Cancel、dirty discard、focus restore、Escape、server validation失敗。
- Advanced raw editorとのround-trip。parse不能時はBasicへ戻さない。
- 3分類palette、sink handle、下流接続拒否。
- Output Inspector config、size warning、write plan。
- Chat new session/new chat/Agent変更。
- Artifact drawerのpaging/delete。

### E2E

1. Input -> Transform -> agent-output -> Agentがbounded値を回答。
2. Tool A workspace-output -> descriptor -> Agentがworkspace_read -> 回答。
3. 同一Sessionの子AgentがArtifactを利用。
4. 新しいチャットから旧Artifactが見えない。
5. 旧Toolを開いてimplicit outputを表示し、patch保存。
6. Agent input schema、join、sort、replaceをcombobox/Rule Table/Dialogだけで設定し、previewと保存を完了する。

### Non-functional

- 256 MiB payloadをprocess memoryの一定上限内でwrite/read。
- 1,000 Artifact listのpaging。
- 同一idempotency keyへの並行write。
- GC途中停止からの再開。
- payloadにprompt injection文があってもsystem instructionへ混入しない。

## 11. Definition of Done

- Output nodeなしの新規Tool保存を拒否し、legacy Toolは互換実行できる。
- 通常UIでカンマ区切りや`column:type`構文を要求せず、全既存nodeを設定できる。
- 複雑な設定はDialog draftへ隔離され、Cancelでgraphを変更せず、Applyが単一更新になる。
- inline resultが64 KiB/200 rowsを超えて無制限にLLMへ渡らない。
- workspace-outputがpayloadをRun trace/SQLite JSON recordへ埋め込まない。
- 同一Session内でArtifactを再利用でき、別Session・別scopeから取得できない。
- root/child Agentの作成元をArtifact traceから追跡できる。
- close/expiry/quota/idempotency/GCのテストがgreen。
- `npm test`、`npm run typecheck`、`npm run depcruise`、`npm run build`、Playwright E2Eがgreen。

## 12. Open decisions before implementation

以下はSlice A着手前に短いspikeで数値または方式を確定する。

1. inline 64 KiBをUTF-8 byteで測る実装とmodelごとのtoken見積り表示。
2. local runtime data rootの既定pathとWindowsでのatomic rename/lock挙動。
3. `append`をtable/graphだけに限定するか、初期版から外すか。
4. graph mapping UIをSlice Cに含めるかSlice Eまで延期するか。
5. Agent workspace built-insを常時提示するか、Artifact作成後のroundだけ提示するか。

推奨は、`append`とgraph mapping UIをSlice Eへ延期し、Slice Cは`create/new-revision`とtable/json/chartに限定すること。
