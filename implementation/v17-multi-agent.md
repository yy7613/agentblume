# v17 実装契約: マルチエージェント（サブエージェント委譲）

> 本書は Increment 17（[ADR-0018](../docs/adr/0018-multi-agent-sub-agent-delegation.md) / [docs/12-multi-agent.md](../docs/12-multi-agent.md)）の**単一の真実**。
> 前提: v16まで完成・全テストgreen（704件 + Playwright e2e 4本）。

## 0. 規約（従来どおり）
TypeScript strict / `noUncheckedIndexedAccess` / ESM・拡張子なしimport / Zod v4 / Vitest / 既存エラー型 / 入力非mutate / テスト同居 / カバレッジ閾値維持。設定ファイルは親管理。**既存テストの変更禁止**（後方互換の証明）。ただし本増分で挙動が変わるUI（AgentBuilder）の既存テスト更新は可。

## 1. ステージ分割
- **Stage A**: domain/application/api（参照・検証・入れ子実行・バジェット・トレース）
- **Stage B**: UI（AgentBuilderのSub-agentsピッカー・実効副作用バッジ・Statusの入れ子リンク確認）+ e2e更新があれば親へ報告

## 2. domain/agent 拡張

### 2.1 `agent.ts`
```typescript
export interface AgentSubAgentRef {
  readonly internalId: string;
  readonly version: SemVer;
  readonly usage: string;          // 委譲基準（非空）。LLMへのツール説明文になる
}
export interface Agent {
  // 既存 + 追加:
  readonly agents: readonly AgentSubAgentRef[];   // 既定 []
}
```
- `createAgent`: `agents` 省略時 `[]`。各refの `internalId` 非空・`version` SemVer・`usage` 非空。**自分自身の `internalId` への参照 → `AgentValidationError`**。同一 `internalId` の重複参照 → `AgentValidationError`（バージョン違いでも1つのサブは1参照）。
- `serialization.ts`: `agents` を追加。**後方互換**: 既存保存データ（`agents` 無し）は `[]` として復元（既存往復テスト無変更でgreen）。

### 2.2 命名
`ask_{publishName}` の生成関数 `subAgentToolName(publishName: string): string` を domain/agent に置く（application/uiから共用）。

## 3. application 層

### 3.1 `resolve-agent-capabilities.ts` 拡張
```typescript
export interface ResolvedSubAgent {
  readonly ref: AgentSubAgentRef;
  readonly agent: Agent;             // ロード済みサブ定義
  readonly toolName: string;         // ask_{publishName}
}
export interface ResolvedAgentCapabilities {
  readonly skills: readonly Skill[];
  readonly tools: readonly Tool[];
  readonly subAgents: readonly ResolvedSubAgent[];   // 追加
}
```
- サブ定義を `AgentRepository.findVersion` でロード（無→ `AgentNotFoundError` 相当の既存エラー）。
- **ツール名衝突検証**: `ask_{publishName}` が解決済みTool群の公開名・他サブのツール名と衝突 → `AgentValidationError`。
- **実効副作用**: `resolveEffectiveSideEffect(scope, agent, deps): Promise<SideEffect>` — 自Tool群とサブの実効値の最大（`read-only < write < external-action`）。再帰・`internalId@version` メモ化・深さ上限（`HARD_MAX_DEPTH=3`）超過は `AgentValidationError`。

### 3.2 `run-agent-preview.ts` — 入れ子実行
```typescript
export interface RunBudget {
  readonly maxDelegationDepth: number;   // 既定2・上限3
  remainingModelRounds: number;          // ツリー共有・既定12
  remainingToolCalls: number;            // ツリー共有・既定16
}
```
- 実行入力に `budget?: Partial<RunBudget>`（既定値で補完。上限超の緩和は既定へクランプ）。内部で共有 `RunBudget` オブジェクトをツリーに通す（depth は呼び出しごとに +1）。
- **ツール提示**: 解決済み `subAgents` を `ModelToolDefinition { name: toolName, description: `${ref.usage}\n(delegates to agent: ${displayName}@${version})`, parameters: { message: string, required } }` として既存Tool定義群に**追加**。
- **ディスパッチ**: tool_call の名前がサブに一致 → `message` 引数を検証（非空文字列。不正はツール結果にエラー文字列を返しLLM継続）→ depth・バジェット確認 → **同ユースケースの入れ子実行**（サブの scope は同一テナント、mode 継承、`history` なし、共有budget・depth+1）→ 子Run永続化 → 親トレースに `agent_call` イベント → ツール結果 = サブの `structuredResponse` があれば `JSON.stringify`、なければ `response`。
- **バジェット消費**: 各ノードの model round / tool call 発行前に共有カウンタを減算。枯渇 → そのノードのRunを `error` 相当で確定（既存のエラー確定の流儀に従い保存）し、親へはエラー文字列のツール結果（`[delegation failed: budget exhausted]` 形式）。ルート自身の枯渇は既存の上限到達時の挙動に合わせる。
- **深さ超過**: `depth >= maxDelegationDepth` での委譲要求は実行せず、エラー文字列のツール結果。
- **read-only制約**: preview/test の実行前チェックを**実効副作用**（§3.1）で行うよう差し替え（直接Toolのみ→推移的に）。
- **トレースイベント**: `run-trace.ts` に `agent_call` 種別を追加: `{ kind: 'agent_call', toolName, agentRef: { internalId, version }, childRunId, ok: boolean, summary: string(先頭N文字) }`。既存イベント型は不変。

### 3.3 `save-agent.ts` 拡張
- 入力に `agents?: { internalId, version, usage }[]`。保存前の参照整合: 各サブ版が `AgentRepository` に存在 / 自己参照なし / `ask_` 名衝突なし（§3.1の検証を保存時にも実施）/ 実効副作用の算出が深さ上限内で完了。

## 4. api 層
- `schemas.ts`: save-agent body に `agents`（internalId/version/usage）追加。GET応答の直列化に `agents` を含める（serialization経由で自動）。
- run系エンドポイント: 変更なし（budgetの外部公開はv17ではしない。既定値で実行）。
- error-mapping: 変更なし（既存 `AgentValidationError`→400 等で足りる）。
- 統合テスト: ルート+サブ2階層を保存→ `/runs` でFakeモデル委譲シナリオ→ 親Runのtraceに `agent_call` と childRunId、子Runが `GET /runs/:id/trace` で取れる。

## 5. ui 層（Stage B）
- **AgentBuilder**: 「Sub-agents」ピッカー（Toolピッカーと同型・Agent一覧APIから・**編集中の自Agentは除外**・バージョンセレクト・`usage` 必須テキスト）。保存DTOに `agents`。実効副作用バッジ（サブ追加時にAPIの保存済み情報から計算できない場合は、参照サブの `GET /agents/:id` を引いて クライアント側で近似表示。厳密値は保存時にサーバー検証）。
- **プロンプト自動生成**: 既存の generate-prompt 系に「協働者」セクション（サブの表示名 + usage）を追加（サーバー側テンプレ拡張。生成物は従来どおり編集可能）。
- **Status**: `agent_call` イベント行に childRunId ボタン → 既存のRunトレース展開（RunsTab/tool-builderの既存方式）。
- i18n en/ja。既存AgentBuilderテストの更新可、他は不変。

## 6. テスト要件
- domain: agents検証（自己参照・重複・usage空）・直列化後方互換（agents無しJSON→[]）。
- resolve: サブ解決・`ask_`衝突・実効副作用（read-only+write サブ→write / 3階層推移 / メモ化で同一サブ2参照が1回ロード）。
- run（Fakeモデルスクリプト）: ①ルート→サブ委譲→結果統合の正常系（親traceに`agent_call`・子Run独立保存・子がsub自身のToolを使う） ②サブの構造化出力がJSONでツール結果になる ③depth超過→エラー結果で親継続 ④共有バジェット枯渇（サブ実行中）→子error保存+親継続 ⑤preview時に実効副作用がwriteのサブを含む→実行前拒否 ⑥`message`引数不正→エラー結果で継続。
- api統合・UI（ピッカー→保存DTO・usage必須・自Agent除外・`agent_call`行のドリルダウン）。

## 7. 完了条件（DoD）
- [ ] typecheck（3構成）エラー0 / `vitest run` 全green（既存704+新規・既存テスト無変更） / depcruise 違反0 / カバレッジ閾値
- [ ] Playwright e2e 4本green（AgentBuilder画面変更が既存specに影響する場合は親へ報告し親が更新）
- [ ] Fakeモデルでの2階層委譲統合テスト（保存→実行→入れ子トレース取得）がAPI経由で通る
