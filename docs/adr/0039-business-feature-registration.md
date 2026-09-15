# ADR-0039: 業務テンプレートを業務ごとのファイルに閉じて足すための登録点

- Status: Accepted
- Date: 2026-09-14
- 関連: [ADR-0001](./0001-layered-single-package.md) / [ADR-0038](./0038-journal-two-stage-judgment.md) / [docs/20-journal.md](../20-journal.md) / docs/21-expense.md / docs/22-receivables.md / docs/23-contract.md

## 文脈

業務テンプレートは「仕訳（journal）」1 つだけで、仕訳が各層の共有ファイルに直書きされていた。

- application: `ResolveDataSourceGraphUseCase` がノード型の if 列挙を持ち、コンストラクタ引数 4〜6 が仕訳のポートだった。
- domain: `nodes/index.ts` が `journal-*` ノードを個別に register していた。
- 組込みツール: `src/builtin-tools.ts` が ID・定義・返り値の一覧を直書きしていた。
- composition: `root.ts` が仕訳の import・App 型の 30 項目・リポジトリ選択・ユースケース生成・機能フラグを持っていた。
- api: `server.ts` の deps 型の交差とルート登録、`authorization.ts` の表、`error-mapping.ts` の instanceof 列、`schemas.ts` の仕訳スキーマ、`draft-tool-routes.ts` の `/runtime/capabilities` の `journal` キー。
- adapters: `migrations.ts` の `JOURNAL_STATEMENTS` と version 5。
- UI: `screens.ts`・`App.tsx`（lazy と三項演算子の連鎖）・`TemplatesPage.tsx`（カタログ）・`help-content.ts`・`tool-api.ts`／`types.ts`／`error-messages.ts`・`JournalPage.tsx` の専用ステッパーと `styles.css` の `journal-step*`。

ここへ経費精算（expense）・請求書発行と入金消込（receivables）・契約書レビューと期限台帳（contract）の 3 業務を、**別々の担当が並行して**足す。上の共有ファイルを各担当が同時に書き換えると衝突し、しかも git 操作ができない状況なので、衝突の解消そのものができない。

## 決定

**「共有ファイルは業務ごとのファイルを並べて呼ぶだけ」にし、3 業務のスタブを先に全登録点へ配線しておく。** 各業務の担当は自分の業務ファイルを書き換えるだけで機能を完成でき、共有ファイルにも他業務のファイルにも触れない。

依存の循環（depcruise の `no-circular`）を避けるため、共有ファイルと業務ファイルの両方が使う型は**葉モジュール**に出した（`route-rule.ts` / `http-error.ts` / `schema-migration.ts` / `business-error-types.ts` / `business/screen-ids.ts` / `business/types.ts` / `composition/business.ts`）。既存の import 先を壊さないよう、元のファイルから型を再公開している。

### 1. 行ソースの登録表（application）

業務の行ソース（実行直前に行を差し込むノード）は `RowSourceResolver`（ノード型・固定スキーマ・`requirement: 'none' | 'context' | 'attachments'`・未配線の理由・添付が無いときの理由・`rows`）として宣言し、`ResolveDataSourceGraphUseCase` の第 4 引数に配列で渡す。

書き換えの規律は `application/data-source/row-sources.ts` の `resolveRowSourceNode` が 1 か所で持つ:

1. 文脈が要るソースは、文脈の無い呼び出し（保存・スキーマ点検・プレビュー）では書き換えない（組込みツールの登録が起動時に落ちないため）。
2. `rows` が未配線なら、空表ではなく `unavailableMessage` で落とす。
3. 添付必須で添付が無ければ、`missingAttachmentsMessage`（直し方の分かる文）で落とす。
4. 行には固定スキーマを添える（0 件でも列が消えない）。

設定（config）の形の検査は業務ごとに違うので `rows` の中で行い、ポートを呼ぶ前に `DataSourceValidationError` を投げる。同じノード型の二重登録は組み立て時に落とす。csv / json / database / web-search は業務に属さないのでリゾルバ本体に残した。仕訳の宣言は `application/journal/row-sources.ts`（仕訳 BC がデータソース BC の登録型へ依存するのはこのファイルだけ）。

### 2. ETL ノード（domain）

業務のノードは `nodes/<業務>-nodes.ts` の `register<業務>Nodes(registry)` が登録し、`nodes/index.ts` はそれを呼ぶだけにした（仕訳は従来の登録位置のまま）。

### 3. 組込みツール

`src/builtin-tools/seed.ts` の `seedTools` が共通の冪等ループ（既にある internalId は保存しない・並べた順に返す・業務をまたいだ internalId の重複は保存前に落とす）を持つ。定義は `src/builtin-tools/<業務>.ts` の `readonly BuiltinToolSeed[]`。`src/builtin-tools.ts` は並べてループへ渡すだけで、既存の export（`seedBuiltinTools` / `BUILTIN_SCOPE` / `CURRENT_DATETIME_TOOL_ID` / `JOURNAL_*_TOOL_ID`）は維持した。

### 4. 組み立て（composition）

業務は `composition/<業務>.ts` の `compose<業務>(context: BusinessCompositionContext): BusinessComposition<<業務>AppFeature>` が組む。文脈は業務が共通基盤から借りるものだけ（profile・リポジトリ選択・UnitOfWork・main モデル・「main モデルが設定済みか」・「main モデルの能力」・モデル指紋・ロガー）。戻り値の `feature` を App に展開し、`rowSources` をデータソース解決へ登録する。App 型は `interface App extends JournalAppFeature, ExpenseAppFeature, …` にした。

行ソースを登録する都合で、業務の組み立てはデータソース解決より**前**に走る。

仕訳へ下書きを渡す業務（経費精算・入金消込）は、第 2 引数 `<業務>CompositionDependencies` で**組み立て済みの** `JournalAppFeature` を受け取る（`composeExpense(context, { journal: journal.feature })`）。業務側で仕訳のリポジトリを作り直すと、test プロファイルでは InMemory の保管庫が別になり、作った下書きが仕訳から見えないため。業務から業務への依存はこの一方向（→ 仕訳）だけにする。

### 5. API

| 登録点 | 業務のファイル | 共有側 |
|---|---|---|
| ルートと deps 型 | `<業務>-routes.ts` の `register<業務>Routes` / `<業務>RouteDeps` | `server.ts` が呼び、deps 型を交差する |
| `/runtime/capabilities` | 同ファイルの `<業務>RuntimeCapabilities(deps)`（`{ <業務id>: … }` を返す）/ `<業務>RuntimeCapabilityDeps` | `draft-tool-routes.ts` が展開する（`journal` キーの応答形は不変） |
| 認可 | `<業務>-authorization.ts` の `<業務>_ROUTE_RULES` | `authorization.ts` の `ROUTE_RULES` が連結する |
| エラー写像 | `<業務>-error-mapping.ts` の `<業務>HttpError(err): HttpError \| undefined` | `toHttpError` が従来の仕訳の位置で順に尋ねる |
| スキーマ | `<業務>-schemas.ts` | 共通の `tenantScopeSchema` / `scopeQuerySchema` は `schemas.ts` から import |

`HttpError.body.error` は追加のキーを許すようにした。業務が「直す場所」を示す項目（行 ID など）を、共有の型を変えずに載せられる。

### 6. マイグレーション（版の予約と予約版）

業務の版は `adapters/storage/<業務>-migrations.ts` が `statementMigration(version, description, statements)` で宣言し、`MIGRATIONS` は並べるだけにした。版は予約済み（仕訳 5・経費精算 6・入金消込 7・契約 8・経費精算の追加 9）。業務の追加の版は、既存の版の文を変えずに次の連番で足す（適用済みの DB があるため。経費精算の実用化が 9、docs/21 §20.8）。

**文が 1 つも無い版は予約版（`placeholder`）として扱い、その先まで `user_version` を刻まない。** 並行実装では版の中身が埋まる順序が決まらない。予約版の先まで刻んでしまうと、後から予約版に中身が入ったとき「適用済み」と見なされ、そのテーブルが永久に作られない（利用者の永続 DB で起きる）。予約版より後ろの版は適用するが版は刻まず、次に開いたときにも流し直す。そのため業務の statements は `IF NOT EXISTS` で冪等に書く。`LATEST_SCHEMA_VERSION` は「先頭から途切れずに中身のある版の最後」になる。予約版が全部埋まれば従来の経路と同じになる。

### 7. UI（画面・一覧・ヘルプ・手順・CSS）

- 業務の画面 ID は葉の `business/screen-ids.ts`（`BUSINESS_SCREENS`）が持ち、`screens.ts` が連結する。画面 ID は型として列挙が要るので、記述子とは分けた。
- 業務の記述子 `BusinessDescriptor`（画面 ID・一覧カードの title / summary / order・`listed`・ヘルプ・読み込み中の文言・`loadPage`）を `<業務>/<業務>-business.ts` に置く。`business/registry.ts` が束ね、`App.tsx`（lazy + Suspense）・`TemplatesPage.tsx`（`listed` のものだけ）・`help-content.ts` はそこから引く。
- **`listed: false` の業務は一覧に並べない**。「使えない入口は並べない」という既存の方針を保つためで、直リンク `#/<画面ID>` では準備中の画面が開く。
- 仕訳専用だったステッパーを `components/BusinessStepper.tsx` に切り出し、CSS は `business-step*` に改名した。
- 業務の CSS は業務の画面ファイルから `import './<業務>.css'` する（vite の遅延チャンクに入る。共有の `styles.css` は触らない）。

### 8. UI の API クライアントとエラー文言

- `ToolApiClient.request` を公開し、`api/business-api.ts` の `ApiTransport`（`request` だけの構造型）として業務へ渡す。業務の HTTP 呼び出しは `api/<業務>-api.ts` の `<業務>Api(transport)`、DTO は `api/<業務>-types.ts` に置く。`/runtime/capabilities` の業務キーは業務の API クライアントが自分の型で読む（共有の `RuntimeCapabilitiesDto` は触らない）。
- `ApiError.details` に、共通で解釈しない error 本文の項目をそのまま載せる（無ければキーを作らない）。
- エラーの見出しは `api/<業務>-error-messages.ts` の `BusinessErrorMessages`（`headings` と、本文の項目を使う `heading`）。`error-messages.ts` が連結する。仕訳の見出しと CSV 行番号の見出しはここへ移した。
- 仕訳の API メソッドと DTO は `tool-api.ts` / `types.ts` に残した（画面とテストの参照が多く、移しても並行作業の衝突は減らないため）。

### 9. スタブ

3 業務のスタブを上のすべての登録点に配線した。スタブのファイルは先頭 1 行に「スタブ（docs/2x-<業務>.md で実装）」とだけ書いてあり、各業務の担当が丸ごと書き換える前提である。

## 検討した代替案

- **業務モジュールが import の副作用で自分をグローバルな登録表へ登録する**: 共有ファイルは一切触らずに済むが、App 型や api の deps 型を交差できない（型は静的に列挙するしかない）。どの業務が効くかが import 順に依存し、テストで一部だけを読み込んだときに登録が欠ける。
- **業務の api 登録を 1 つの集約モジュール（ルート・認可・エラー写像をまとめたもの）にする**: `error-mapping.ts` → 集約 → `<業務>-routes.ts` → `error-mapping.ts`（`BadRequestError`）の循環になる。関心ごとにファイルを分け、葉の型を共有する形にした。
- **業務ごとに適用済みの台帳テーブルを持つ**: 版の埋まる順序の問題は消えるが、`user_version` を前提にしたバックアップの互換判定（`schemaVersion`）と未来版の拒否を作り直すことになる。予約版の手前で刻みを止めれば、並行期間だけの問題として閉じられる。
- **予約版も普通に版を刻む**: 最も単純だが、上に書いたとおり後から埋めた版が永久に流れない。
- **スタブ業務も「準備中」として一覧に並べる**: 担当が画面を作る前から入口が見えるが、使えない入口を並べない方針に反する。`listed` で切り替える形にした。

## 帰結

- 3 業務の担当は、下の表のファイルだけで機能を完成できる。共有ファイルの網羅テスト（`authorization.test.ts` のルート網羅、`HelpDialog.test.tsx` の全画面ヘルプ、`business/registry.test.ts`、`builtin-tools/seed.test.ts` の ID と公開名の一意性、`schema-migration.test.ts` の版の予約、`business-error-messages.test.ts` の code の接頭辞）は、業務のファイルを書き換えるだけで業務の分も検査する。
- **5 つ目の業務を足すときは、共有ファイルへ 1 行ずつ足す**（表の最後）。予約枠は 3 業務分しか用意していない。
- `ResolveDataSourceGraphUseCase` を行ソース無しで作ると、業務のノードは書き換えられずに素通しになり、domain のノードが空表を返す。本番の配線は composition が必ず全業務の行ソースを登録するので fail closed が保たれる。以前の「引数を省略すると理由付きで落ちる」は、行ソースを登録したうえでポートを省略した場合の振る舞いになった。
- 業務の組み立て文脈に無いもの（Agent 実行など、データソース解決より後にしか作れないもの）を業務が使いたくなったら、`root.ts` の組み立て順ごと見直す必要がある。
- 予約版が残っている期間は `LATEST_SCHEMA_VERSION` が 5 のままで、その先の業務のテーブルは開くたびに流し直される。版を見るテストは数値ではなく `LATEST_SCHEMA_VERSION` と比べる（`migrations.test.ts` の version 5 のテストもそう直した）。
- 変えていないもの: 仕訳の振る舞い・API・エラーメッセージ・`/runtime/capabilities` の応答形・既存テストの期待値。テストの変更は、移したケースの置き場所（`resolve-data-source-graph.test.ts` → `application/journal/row-sources.test.ts`、期待値は同じ）、改名したクラス名のセレクタ（`JournalPage.test.tsx`）、版の数値（`migrations.test.ts`）だけ。

## 新しい業務を追加するときに作る／触るファイル

`<b>` は業務 id（英小文字）、`<B>` はその先頭大文字、`<BB>` は全大文字。3 業務の値は次のとおり。

| 業務 | `<b>` / `<B>` / `<BB>` | 画面 ID | API ルート | ツール名接頭辞 / 組込みツール ID | DB version | 仕様 |
|---|---|---|---|---|---|---|
| 経費精算 | `expense` / `Expense` / `EXPENSE` | `Expense`（`#/expense`） | `/expense/*` | `expense_` / `builtin-expense-*` | 6, 9 | docs/21-expense.md |
| 請求書発行と入金消込 | `receivables` / `Receivables` / `RECEIVABLES` | `Receivables`（`#/receivables`） | `/receivables/*` | `receivables_` / `builtin-receivables-*` | 7 | docs/22-receivables.md |
| 契約書レビューと期限台帳 | `contract` / `Contract` / `CONTRACT` | `Contract`（`#/contract`） | `/contracts/*` | `contract_` / `builtin-contract-*` | 8 | docs/23-contract.md |

### 業務の担当が書き換える／作るファイル（スタブ配線済み）

「書換」はスタブを丸ごと書き換えるファイル、「新規」は自由に作ってよいファイル。export の名前と形は共有側が import しているので**変えないこと**。

| 層 | ファイル | 書換 / 新規 | export すべき名前（形） | 注意 |
|---|---|---|---|---|
| domain | `src/domain/<b>/**` | 新規 | 任意 | 業務のドメインモデル・エラー・リポジトリのポート |
| domain（ETL） | `src/domain/etl/nodes/<b>-nodes.ts` | 書換 | `register<B>Nodes(registry: NodeRegistry): void` | ノード本体は `src/domain/etl/nodes/<b>-*.ts`（新規）。ノード型は `<b>-` で始める |
| application | `src/application/<b>/**` | 新規 | 任意 | ユースケース |
| application（行ソース） | `src/application/<b>/row-sources.ts` | 新規 | `<b>RowSources(ports): readonly RowSourceResolver[]` | 規律は共通側。`rows` の中で config を検査し、ポートを呼ぶ前に `DataSourceValidationError` を投げる。ポートが無くても業務の全ノード型を登録する（未配線を理由付きで拒否するため）。`compose<B>` の `rowSources` で返す |
| adapters | `src/adapters/storage/{sqlite,in-memory}-<b>-repositories.ts` | 新規 | 任意 | |
| adapters（スキーマ） | `src/adapters/storage/<b>-migrations.ts` | 書換 | `<BB>_STATEMENTS: readonly string[]` / `<BB>_MIGRATION`（`statementMigration(<version>, '<b> …', <BB>_STATEMENTS)`） | version は表の値のまま。description は `<b>` で始める。すべて `CREATE … IF NOT EXISTS`（冪等） |
| composition | `src/composition/<b>.ts` | 書換 | `interface <B>AppFeature` / `compose<B>(context: BusinessCompositionContext[, dependencies]): BusinessComposition<<B>AppFeature>` | App のキーは `<b>` で始める（他業務と重ねない）。LLM の可否は `context.profile === 'test'` なら使えない側へ倒す |
| 組込みツール | `src/builtin-tools/<b>.ts` | 書換 | `<BB>_BUILTIN_TOOLS: readonly BuiltinToolSeed[]` と ID 定数 `<BB>_…_TOOL_ID` | internalId は `builtin-<b>-*`、publishName / agentTool.name は `<b>_*` |
| api（ルート） | `src/api/<b>-routes.ts` | 書換 | `interface <B>RouteDeps` / `register<B>Routes(app, deps): void` / `interface <B>RuntimeCapabilityDeps` / `<b>RuntimeCapabilities(deps): Promise<Readonly<Record<string, unknown>>>` | 機能フラグは `{ <b>: … }` だけを返す（他のキーを返さない） |
| api（認可） | `src/api/<b>-authorization.ts` | 書換 | `<BB>_ROUTE_RULES: readonly RouteRule[]`（`rule()` は `./route-rule`） | 全ルートを載せる（網羅テストが検査する） |
| api（エラー） | `src/api/<b>-error-mapping.ts` | 書換 | `<b>HttpError(err: unknown): HttpError \| undefined` | 自分のエラーでなければ `undefined`。code は `<BB>_` で始める |
| api（スキーマ） | `src/api/<b>-schemas.ts` | 書換 | 任意 | 共通のスコープ検証は `./schemas` から import |
| UI（記述子） | `src/ui/<b>/<b>-business.ts` | 書換 | `<b>Business: BusinessDescriptor` | 使える状態になったら `listed: true`。`card.order` は 20 / 30 / 40 のまま |
| UI（画面） | `src/ui/<b>/<B>Page.tsx` | 書換 | `<B>Page(props: BusinessPageProps)` | 手順は `components/BusinessStepper` を使う。戻るリンクは `ScreenLink to="Templates"` |
| UI（CSS） | `src/ui/<b>/<b>.css` | 書換 | — | `<B>Page.tsx` から import 済み。クラス名は `<b>-` で始める |
| UI（部品） | `src/ui/<b>/**` | 新規 | 任意 | |
| UI（API） | `src/ui/api/<b>-api.ts` | 書換 | `interface <B>Api` / `<b>Api(transport: ApiTransport): <B>Api` | パスは表の API ルート。scope は `scopeQuery`（`./business-api`） |
| UI（DTO） | `src/ui/api/<b>-types.ts` | 書換 | DTO 型 | |
| UI（エラー文言） | `src/ui/api/<b>-error-messages.ts` | 書換 | `<BB>_ERROR_MESSAGES: BusinessErrorMessages` | code は `<BB>_` で始める。本文の追加項目は `payload.details` |
| テスト | 上の各ファイルの隣の `*.test.ts(x)` | 新規 | — | 共有のテストファイルは触らない |
| docs | `docs/2x-<b>.md` / `docs/adr/004x-*.md` | 新規 | — | |

### 業務の担当が触らない共有ファイル

`src/composition/root.ts` / `src/api/server.ts` / `src/api/authorization.ts` / `src/api/schemas.ts` / `src/api/error-mapping.ts` / `src/api/draft-tool-routes.ts` / `src/adapters/storage/migrations.ts` / `src/domain/etl/nodes/index.ts` / `src/application/data-source/resolve-data-source-graph.ts` / `src/application/data-source/row-sources.ts` / `src/builtin-tools.ts` / `src/builtin-tools/seed.ts` / `src/ui/App.tsx` / `src/ui/screens.ts` / `src/ui/business/*` / `src/ui/templates/TemplatesPage.tsx` / `src/ui/help-content.ts` / `src/ui/api/tool-api.ts` / `src/ui/api/types.ts` / `src/ui/api/error-messages.ts` / `src/ui/api/business-api.ts` / `src/ui/api/business-error-types.ts` / `src/ui/components/BusinessStepper.tsx` / `src/ui/styles.css`、および他の業務のファイル。

### 5 つ目の業務を足すとき（予約枠が無い場合）に 1 行ずつ足す共有ファイル

| ファイル | 足すもの |
|---|---|
| `src/domain/etl/nodes/index.ts` | `register<B>Nodes(registry)` の呼び出し |
| `src/composition/root.ts` | `<B>AppFeature` の extends、`compose<B>` の呼び出し、`rowSources` と `feature` の展開 |
| `src/adapters/storage/migrations.ts` | `<BB>_MIGRATION` を `MIGRATIONS` の末尾へ（version は次の連番） |
| `src/builtin-tools.ts` | `...<BB>_BUILTIN_TOOLS` |
| `src/api/server.ts` | deps 型へ `& <B>RouteDeps`、`register<B>Routes` の呼び出し |
| `src/api/authorization.ts` | `...<BB>_ROUTE_RULES` |
| `src/api/error-mapping.ts` | `?? <b>HttpError(err)` |
| `src/api/draft-tool-routes.ts` | `BusinessRuntimeCapabilityDeps` の extends と `...(await <b>RuntimeCapabilities(deps))` |
| `src/ui/business/screen-ids.ts` | `BUSINESS_SCREENS` へ画面 ID |
| `src/ui/business/registry.ts` | `BUSINESSES` へ記述子 |
| `src/ui/api/error-messages.ts` | `BUSINESS_ERROR_MESSAGES` へ見出し |
| `src/ui/api/business-error-messages.test.ts` / `src/adapters/storage/schema-migration.test.ts` | 接頭辞と版の予約の期待値 |
