# 実装契約 v21: 長期記憶（LLM Wiki 基盤 + Skill蒸留ループ）

- ADR: [ADR-0016](../docs/adr/0016-long-term-memory-llm-wiki.md)（Accepted）
- 設計: [docs/10-memory.md](../docs/10-memory.md)
- スコープ: M1（Wiki CRUD + キーワード/タグ検索 + 手動アタッチ）+ M2（Run抽出→提案）+ M3（承認→Wiki改訂 / Skill蒸留）
- 非対象: M4 埋め込み検索（`ModelProviderPort.embed` は未追加）、cross-workspace 共有、無承認の自動書き込み

## 0. 原則（ADR-0016 の実装写像）

- **二本柱**: 宣言的知識 = `WikiPage`（新エンティティ）。手続き的知識 = 既存 `Skill.instructions` への改訂提案（新 minor バージョンとして保存）。記憶専用の別 Skill 系統は作らない。
- **人手承認制**: Run 相当の対話（input/output）→ LLM 抽出 → `MemoryProposal`（`draft`）→ 人がレビュー → `approved`/`rejected`。承認時のみ実体（WikiPage 改訂 or 新 Skill バージョン）へ適用する。
- **読み出しは最小コンテキスト**: 検索（v1 キーワード/タグ）で絞り、選択ページのみを要約・字数制限つきで注入。Wiki 全文の無条件注入は禁止。

## 1. ドメイン（`src/domain/memory/`）

### 1.1 `wiki-page.ts`
```ts
interface WikiPage {
  id: string; tenant: TenantScope; title: string; tags: readonly string[];
  body: string; version: number; sourceRuns: readonly string[]; updatedAt: string;
}
interface WikiPageSummary { id; title; tags; version; updatedAt }
createWikiPage(props: { id; tenant; title; tags; body; sourceRuns?; updatedAt }): WikiPage  // version=1
reviseWikiPage(page, changes: { title?; tags?; body?; addSourceRun?; updatedAt }): WikiPage  // version+1
```
- 検証（`MemoryDomainError`）: `id`/`title`/`body` 非空。`tags` は trim 非空・重複排除。`version>=1`。
- `reviseWikiPage`: 未指定フィールドは据え置き。`addSourceRun` は既存 `sourceRuns` へ重複なく追加。`version = page.version + 1`。

### 1.2 `memory-proposal.ts`
```ts
type MemoryProposalState = 'draft' | 'approved' | 'rejected';
type MemoryProposalTarget =
  | { kind: 'wiki'; pageId: string; isNewPage: boolean; title: string; tags: readonly string[]; body: string }
  | { kind: 'skill'; skillId: string; instructions: string };
interface MemoryProposal {
  id: string; tenant: TenantScope; target: MemoryProposalTarget;
  summary: string; state: MemoryProposalState; sourceRun?: string; createdAt: string;
}
createMemoryProposal(props): MemoryProposal   // state='draft'
decideProposal(p, decision: 'approved'|'rejected'): MemoryProposal
```
- target に適用可能な全内容を内包（承認時に追加の推論をしない）。`diff` の語は使わず人間可読の `summary` を持つ。
- 検証: `id`/`summary` 非空。wiki は `pageId`/`title`/`body` 非空、skill は `skillId`/`instructions` 非空。
- `decideProposal`: 現在 `state==='draft'` でなければ `MemoryDomainError`（再決定禁止）。

### 1.3 `errors.ts`
- `MemoryDomainError`（code `MEMORY_DOMAIN`, 400）
- `WikiPageNotFoundError`（code `WIKI_PAGE_NOT_FOUND`, 404）
- `MemoryProposalNotFoundError`（code `MEMORY_PROPOSAL_NOT_FOUND`, 404）

### 1.4 `serialization.ts`
- `SerializedWikiPage` / `SerializedMemoryProposal`（JSON 素直な同型）+ `serialize*`/`deserialize*`（構造クローン）。

### 1.5 repository インターフェース
```ts
interface WikiRepository {
  save(page): Promise<void>;                       // id で upsert（改訂は置換）
  find(scope, id): Promise<WikiPage|null>;
  list(scope): Promise<WikiPageSummary[]>;
  search(scope, query, limit): Promise<WikiPageSummary[]>;   // v1: title/body/tags のキーワード AND 一致
}
interface MemoryProposalRepository {
  save(proposal): Promise<void>;                   // id で upsert（状態遷移）
  find(scope, id): Promise<MemoryProposal|null>;
  list(scope, state?): Promise<MemoryProposal[]>;  // createdAt DESC
}
```

## 2. アダプタ（`src/adapters/storage/`）

- `in-memory-wiki-repository.ts` / `sqlite-wiki-repository.ts`（table `wiki_pages`, PK `(tenant,workspace,id)`, `updated_at` index）。
- `in-memory-memory-proposal-repository.ts` / `sqlite-memory-proposal-repository.ts`（table `memory_proposals`, PK `(tenant,workspace,id)`, `created_at` index）。
- upsert は sqlite `INSERT ... ON CONFLICT DO UPDATE`。
- 共有契約: `wiki-repository.contract.ts` / `memory-proposal-repository.contract.ts`（in-memory・sqlite 双方で緑）。
- `search` v1: query を空白分割し全語が `title`/`body`/`tags` のいずれかに部分一致（大小無視）する要約を `updatedAt DESC`・`limit` で返す。

## 3. アプリケーション（`src/application/memory/`）

- `SaveWikiPageUseCase`: `{ scope, id?, title, tags, body, sourceRunId? }` → 既存なら `reviseWikiPage`、無ければ `createWikiPage`（id 省略時は `makeId()`）。`updatedAt=now()`。返り値 `WikiPage`。
- `QueryWikiUseCase`: `get/list/search`（`WikiPageNotFoundError`）。
- `ReflectRunUseCase`: `{ scope, input, output, sourceRunId?, targetSkillId?, existingWikiPageId? }` → `ModelProviderPort`（構造化出力）で `{ wiki:{shouldPropose,title,tags,body,summary}, skill:{shouldPropose,instructions,summary} }` を得て、`shouldPropose` の分だけ `MemoryProposal`（draft）を作成・保存。返り値 `readonly MemoryProposal[]`。
  - `targetSkillId` 指定時は `SkillRepository.findLatest` で現行 instructions をプロンプトへ添付。未存在なら skill 提案はスキップ。
  - `existingWikiPageId` 指定時は現行 body を添付し `isNewPage=false`。未指定は新規（`pageId=makeId()`, `isNewPage=true`）。
  - 不正 JSON は 1 回再試行、なお失敗で `MemoryDomainError`。1 件も提案が無ければ空配列（正常）。
- `ListProposalsUseCase`: `list(scope, state?)` / `get`（`MemoryProposalNotFoundError`）。
- `ReviewProposalUseCase`:
  - `reject(scope,id)`: `decideProposal→'rejected'` 保存。
  - `approve(scope,id)`: draft のみ。
    - wiki: `isNewPage` → `createWikiPage`、else `find`→`reviseWikiPage`。`WikiRepository.save`。
    - skill: `SkillRepository.findLatest` で現行 Skill を取得し、`SaveSkillUseCase.execute`（全フィールド流用・`instructions=target.instructions`・`bump='minor'`）。未存在なら `MemoryDomainError`。
    - 続けて `decideProposal→'approved'` 保存。返り値は更新後 `MemoryProposal`。

## 4. api（`src/api/`）

- schemas（`schemas.ts`）: `saveWikiBodySchema`, `reflectRunBodySchema`, `wikiSearchQuerySchema`。
- `memory-routes.ts`（`MemoryRouteDeps`）:
  - `GET /wiki?scope&q&limit` → 検索 or 一覧（`{ pages }`）。
  - `GET /wiki/:id` → `{ page }`。
  - `POST /wiki` → 保存 `{ page }`。
  - `POST /memory/reflect` → `{ proposals }`。
  - `GET /memory/proposals?state` → `{ proposals }`。
  - `POST /memory/proposals/:id/approve` → `{ proposal }`。
  - `POST /memory/proposals/:id/reject` → `{ proposal }`。
- `error-mapping.ts`: `MemoryDomainError`→400、`WikiPageNotFoundError`/`MemoryProposalNotFoundError`→404。
- `server.ts`: deps union と register に memory を追加。

## 5. composition（`root.ts`）

- profile 分岐で wiki / memory-proposal リポジトリを構築（local=sqlite, test=in-memory, close 委譲）。
- `App` に `wikiRepo`, `memoryProposalRepo`, `saveWikiPage`, `queryWiki`, `reflectRun`, `listProposals`, `reviewProposal` を追加。
- `reflectRun` は `modelProvider` を使用（profile 非依存、`ScriptedModelProvider` in test）。

## 6. UI（`src/ui/`）

- `api/types.ts`: `WikiPageDto`, `WikiPageSummaryDto`, `MemoryProposalDto`。
- `api/tool-api.ts`: `listWiki/searchWiki/getWiki/saveWiki/reflectRun/listProposals/approveProposal/rejectProposal`。
- `memory/MemoryPage.tsx`: 2 ペイン。左「Wiki」（検索ボックス + 一覧 + 編集フォーム: title/tags/body、保存）。右「Proposals」（state フィルタ + カード: target種別・summary・内容プレビュー・Approve/Reject）。承認で Wiki 一覧を再取得。
- `App.tsx` ナビに `Memory` を追加（既存 nav 構造を踏襲、`AB` ブランドは維持）。
- `inspector/AgentInspectorPage.tsx`: 応答カードに「Distill to memory」ボタン → 直前 user 発話 + 応答で `reflectRun`（targetは実行 Agent の最初の Skill があれば付与）→ 生成された提案数をトースト表示。
- `vite.config.ts` proxy に `/wiki`, `/memory` を追加。
- `styles.css`: `.mem-*` クラス。

## 7. 手動アタッチ（M1 読み出し / Stage F, 予算許せば）

- `RunAgentPreviewUseCase` に任意 `memoryContext?: string` を追加し、指定時のみ system prompt 先頭へ `# Memory\n<要約>` を字数制限（例 1200 字）で前置。
- api の saved-agent 実行 body に任意 `memoryPageIds?: string[]` を追加、ルートで `WikiRepository` から本文を読み最小要約に整形して `memoryContext` を渡す。
- UI Inspector に Wiki ページ選択（任意）を追加。
- 予算・DoD 圧迫時は Stage F を切り離し「即時 follow-up」とし、log で明示。

## 8. DoD

1. typecheck 3 構成（base / ui / e2e）緑。
2. vitest 全緑（新規: 各ドメイン factory、契約 x2、各 use case、api ルート、UI ページ）。
3. depcruise 0 違反（memory も layered 準拠。adapters 実装 import は composition のみ）。
4. coverage 閾値維持（lines/statements/functions 90 / branches 80）。
5. e2e 4 本緑（Memory ページの smoke を既存 e2e 方針に沿って必要なら追加）。
6. feature ブランチでコミット（`Co-Authored-By: Claude Opus 4.8 (1M context)`）。
