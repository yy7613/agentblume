# v18 実装契約: ペルソナ登録 → 疑似ユーザーエージェント統合

> 本書は Increment 18（[ADR-0019](../docs/adr/0019-persona-pseudo-user-agent-integration.md)）の**単一の真実**。
> 前提: v16完成（Persona/Scenario/RunScenario稼働・704テスト+e2e 4本）。v17（マルチエージェント）とは独立に実装可能だが、両方が `domain/agent` を触るため**順次実装**とする（並行不可）。

## 0. 規約（従来どおり）
strict / ESM / Zod v4 / Vitest / 既存エラー型 / 非mutate / テスト同居 / 閾値維持 / 設定ファイルは親管理。**既存テストの変更は「本増分で仕様が変わる箇所」のみ許可**し、完了報告で列挙する。

## 1. domain 変更

### 1.1 `domain/agent/agent.ts`
```typescript
export interface AgentPersonaRef { readonly personaId: string; readonly version: SemVer; }
export interface Agent {
  // 既存 + 追加:
  readonly persona?: AgentPersonaRef;   // kind==='pseudo-user' のときのみ許可
}
```
- `createAgent` 追加検証: `persona` があるのに `kind!=='pseudo-user'` → `AgentValidationError`。`kind==='pseudo-user'` のとき `tools`/`skills` は**空必須**（v17実装済みなら `agents` も空必須）→ 違反は `AgentValidationError`（メッセージに「v18時点の制約」と明記）。
- `serialization.ts`: `persona` 追加（後方互換: 無し→undefined。既存往復テスト無変更でgreen）。

### 1.2 `domain/validation` — ベース/目標の分離
- `buildPersonaBasePrompt(persona: Persona): string` を新設 — 現行 `buildPersonaSystemPrompt` から **goal/context 合成部を除いた**人物設定・出力規律部分。
- `composeScenarioPrompt(basePrompt: string, goal: string, context?: string): string` を新設 — goal/context 合成部を関数化。
- 既存 `buildPersonaSystemPrompt(persona, goal, context)` は `composeScenarioPrompt(buildPersonaBasePrompt(persona), goal, context)` の合成として再実装（**出力文字列は現行と同一**であること — 既存スナップショット系テストが無変更でgreenになるのが証明）。

### 1.3 `domain/validation/scenario.ts`
```typescript
export interface ScenarioPseudoUserRef { readonly agentId: string; readonly version: SemVer; }
export interface Scenario {
  // 変更: persona は optional（deprecated）、pseudoUser を追加
  readonly persona?: ScenarioPersonaRef;
  readonly pseudoUser?: ScenarioPseudoUserRef;
}
```
- `createScenario` 検証: `persona` と `pseudoUser` は**排他かつどちらか必須**。
- `serialization.ts`: 両対応（旧データ=personaのみ→そのまま復元）。

## 2. application 層

### 2.1 `register-pseudo-user-agent.ts`（新設・統合の中核）
```typescript
export interface RegisterPseudoUserAgentInput {
  readonly scope: TenantScope;
  readonly personaId: string;
  readonly personaVersion?: SemVer;        // 省略時 latest
  readonly agentInternalId?: string;       // 省略時 `pseudo-${personaId}`
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly promptOverride?: string;        // 生成ベースプロンプトの上書き（エスケープハッチ）
}
export class RegisterPseudoUserAgentUseCase {
  constructor(personas: PersonaRepository, agents: AgentRepository, saveAgent: SaveAgentUseCase /* 既存を再利用 */);
  async execute(input: RegisterPseudoUserAgentInput): Promise<Agent>;
}
```
- Persona をロード（無→NotFound）→ `systemPrompt = promptOverride ?? buildPersonaBasePrompt(persona)` → 既存 `SaveAgentUseCase` で `kind:'pseudo-user'`・`persona: { personaId, version }`・tools/skills空・メタ（workingName/displayName/publishName は Persona のものから導出、衝突時は `-pseudo` サフィックス等の決定的規則）として保存。既存Agent（同internalId）があればバージョンbump。

### 2.2 `run-scenario.ts` 変更
- `pseudoUser` 指定時: Agent をロード（`kind!=='pseudo-user'` → `ValidationDomainError`）→ system prompt = `composeScenarioPrompt(agent.systemPrompt, goal, context)`。以降のターンループ・survey は現行と同一（`ModelProviderPort` 直呼び・構造化ターン出力）。
- `persona` 指定時（後方互換）: 現行どおり。
- ScenarioRun に使用した疑似ユーザーの参照（persona@version or agent@version）を記録するフィールドを追加（`pseudoUserRef: { type: 'persona' | 'agent'; id: string; version: string }`）。

### 2.3 `save-scenario.ts` 変更
- `pseudoUser` の参照整合: Agent版の存在 + `kind==='pseudo-user'` 検証。

## 3. api 層
| 変更 | 内容 |
|---|---|
| `POST /personas/:id/register-agent` | RegisterPseudoUserAgentUseCase（body: scope, personaVersion?, agentInternalId?, bump?, promptOverride?）→ 201 `{ agent }` |
| `POST /scenarios` | body に `pseudoUser?: { agentId, version }` 追加（personaと排他・どちらか必須） |
| `GET /agents` | `?kind=pseudo-user` フィルタ（クエリ任意。無指定は従来どおり全件） |
| schemas / error-mapping | 上記に対応（新規エラー型は不要の見込み） |

## 4. ui 層
- **Personasタブ**: 保存済みPersonaに「疑似ユーザーAgentとして登録」ボタン → 登録API → 成功時に `agent@version` チップ表示（再実行=bump）。`promptOverride` 入力（任意・折りたたみ）。
- **Scenariosタブ**: 疑似ユーザー選択を **`kind=pseudo-user` のAgentセレクタに置換**（`GET /agents?kind=pseudo-user`）。未登録Personaしかない場合は「Personasタブで登録」への誘導文言。既存シナリオ（persona参照）は読み取り表示可・編集保存時はAgent選択を要求。
- **AgentBuilder**: kind セレクタに `pseudo-user` を追加してもよいが、v18ではツール等が空必須のため、**登録経路はPersonasタブを正とし、AgentBuilderでは pseudo-user を選択不可のまま**でよい（表示のみ対応: 一覧でkindバッジ）。Chat画面のAgentセレクタは `pseudo-user` を既定除外。
- i18n en/ja。

## 5. テスト要件
- domain: persona付きAgentの検証（kind不一致・tools/skills非空拒否）/ プロンプト分割の**同値性**（`buildPersonaSystemPrompt` 出力が現行と一致）/ scenario排他検証・直列化後方互換。
- application: 登録ユースケース（新規1.0.0/再登録bump/override/personaNotFound）/ run-scenario の pseudoUser 経路（Fakeモデル・kind検証・pseudoUserRef記録）/ 旧persona経路の無変更green。
- api: 登録→シナリオ保存（pseudoUser）→実行→Run取得の統合 / kindフィルタ。
- ui: 登録ボタン→API DTO / Scenariosのセレクタ切替 / 誘導文言。
- **e2e（親が対応）**: 検証節に「Persona登録→Agent登録→（シナリオ保存）」の最小フロー追加を親へ提案。

## 6. 完了条件（DoD）
- [ ] typecheck 3構成 / vitest 全green / depcruise 0 / カバレッジ閾値
- [ ] 変更した既存テストの列挙と理由（仕様変更箇所のみ）
- [ ] Playwright e2e 4本green（画面変更の影響があれば親へ報告）
