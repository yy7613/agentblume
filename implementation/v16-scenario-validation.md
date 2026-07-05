# v16 実装契約: シナリオ検証（種別疑似ユーザー × 複数ターン × アンケート）

> 本書は Increment 16（[ADR-0017](../docs/adr/0017-scenario-validation-pseudo-users.md) / [docs/11-scenario-validation.md](../docs/11-scenario-validation.md)）の**単一の真実**。
> 前提: v15 まで完成・全テストgreen（648件）。保存済みAgent実行（`run-agent-preview.ts` の `RunSavedAgentPreviewInput`）・Runトレース永続化・Structured Output・`ModelProviderPort`・Skill/Agentのバージョン付きRepositoryが存在する。

## 0. 規約（従来どおり）
TypeScript strict / `noUncheckedIndexedAccess` / ESM・拡張子なしimport / Zod v4 / Vitest。例外は各コンテキストのエラー型。入力非mutate。テスト同居。カバレッジ閾値維持。設定ファイル編集は親が行う（サブエージェントは禁止）。
**既存規約への準拠が最優先**: メタデータ/SemVer/Repository/直列化は `src/domain/skill/`（最新のバージョン付きエンティティ実装）を、Repositoryアダプタと契約テストは `src/adapters/storage/` の既存物を、APIは `src/api/` の既存ルートを、UIは `src/ui/validation/ValidationPage.tsx` と i18n（v14）を読み、同じ形で実装する。

## 1. ステージ分割（委譲単位）
- **Stage A**: domain/validation + application/validation + adapters/storage（3 Repository）+ api ルート
- **Stage B**: UI（ValidationPage の3タブ化: Personas / Scenarios / Runs）+ i18n

## 2. domain/validation（新設 `src/domain/validation/`）

### 2.1 `persona.ts`
```typescript
type PersonaArchetype = 'novice' | 'expert' | 'busy' | 'vague' | 'skeptical' | 'custom';
interface Persona {
  metadata: /* skillと同じ共通メタ形（internalId/workingName/displayName/publishName/version/owner/state/tenant） */;
  archetype: PersonaArchetype;
  knowledgeLevel: 'low' | 'mid' | 'high';
  patience: 'low' | 'mid' | 'high';
  tone: string;                       // 非空
  verbosity: 'terse' | 'normal' | 'chatty';
  language: 'ja' | 'en';
  extraInstructions?: string;
  promptOverride?: string;            // 上書き時のみ。空文字は不可
}
createPersona(props): Persona          // 不変条件違反 → ValidationDomainError
buildPersonaSystemPrompt(persona: Persona, goal: string, context?: string): string
```
- `buildPersonaSystemPrompt` は**決定的**（LLM不使用）。`promptOverride` があればそれを基底にし、goal/context を末尾に合成する。テンプレは archetype ごとの人物設定 + 属性の文章化 + 「あなたはユーザーとして振る舞う。アシスタントの応答を評価しながら目標を目指す」+ 出力規律（`endConversation`/`goalAchieved` の判断基準: 目標達成、または patience に応じた諦め）。language でja/enテンプレ切替。
- スナップショット的テスト: 同一入力→同一出力、archetype/属性がプロンプト本文へ反映される。

### 2.2 `survey.ts`
```typescript
type SurveyQuestionKind = 'scale' | 'boolean' | 'text';
interface SurveyQuestion { id: string; textJa: string; textEn: string; kind: SurveyQuestionKind; min?: number; max?: number; } // scaleのみmin/max（既定1/5、min<max）
const DEFAULT_SURVEY: readonly SurveyQuestion[]  // docs/11 §5 の8問（q1..q8。q8 id='impressions'）
buildSurveySchema(questions): JsonSchemaObject   // 構造化出力用: scale→integer, boolean→boolean, text→string。全問required
validateSurveyAnswers(questions, answers: unknown): SurveyAnswer[]  // 型・範囲検証。違反→ValidationDomainError
interface SurveyAnswer { questionId: string; value: number | boolean | string; }
```

### 2.3 `scenario.ts`
```typescript
interface Scenario {
  metadata: /* 共通メタ形 */;
  target: { agentId: string; version: SemVer };
  persona: { personaId: string; version: SemVer };
  goal: string;                       // 非空
  context?: string;
  maxUserTurns: number;               // 整数1..8
  expectedTools?: string[];           // Tool公開名
  survey: SurveyQuestion[];           // 1問以上。id一意
}
createScenario(props): Scenario
```

### 2.4 `scenario-run.ts`
docs/11 §6 の `ScenarioRun` 型（status/goalAchieved/transcript/survey/impressions/metrics/時刻）。`Turn = { speaker: 'user' | 'agent'; message: string; runId?: string }`。生成は application 層（オーケストレータ）が行い、domainは型と検証（`createScenarioRun` は最小整合チェック）のみ。

### 2.5 `errors.ts` / `serialization.ts` / Repository ポート
- `ValidationDomainError`（code `'VALIDATION_DOMAIN'`）、`PersonaNotFoundError`、`ScenarioNotFoundError`、`ScenarioRunNotFoundError`（各404系）。既存の `VersionConflictError`（domain/tool/errors）は**再利用**（save系の衝突）。
- 直列化: skillの `serialization.ts` と同形式（Zod検証・SemVer文字列化・往復テスト）。
- ポート: `PersonaRepository` / `ScenarioRepository`（save/findVersion/findLatest/listVersions/list — ToolRepositoryと同契約形）+ `ScenarioRunRepository`（`save(run)` 一意id・重複→VersionConflictError相当は不要なので `ValidationDomainError` / `find(scope,id)` / `list(scope, filter?: { scenarioId?: string })` 新しい順）。

## 3. application/validation（新設 `src/application/validation/`）

### 3.1 Persona/Scenario の Save/Query ユースケース
`save-persona.ts` / `query-personas.ts` / `save-scenario.ts` / `query-scenarios.ts` — `save-tool.ts`/`query-tool.ts` の形を踏襲（初回1.0.0・bump・latest/version取得・一覧）。SaveScenario は保存前に **参照整合を検証**: target Agent と persona の指定バージョンが存在すること（`AgentRepository`/`PersonaRepository` 照会。無→ `ValidationDomainError`）。

### 3.2 `run-scenario.ts`（中核オーケストレータ）
```typescript
interface RunScenarioInput { scope: TenantScope; scenarioId: string; version?: SemVer; mode: 'preview' | 'test'; }
class RunScenarioUseCase {
  constructor(
    scenarios: ScenarioRepository, personas: PersonaRepository,
    runAgent: RunAgentPreviewUseCase,          // 既存を再利用
    model: ModelProviderPort,                  // 疑似ユーザー用
    scenarioRuns: ScenarioRunRepository,
    makeId?: () => string, now?: () => Date,
  );
  async execute(input: RunScenarioInput, signal?: AbortSignal): Promise<ScenarioRun>;
}
```
アルゴリズム（決定的・docs/11 §4）:
1. Scenario（version省略時latest）と Persona をロード。無→NotFound系エラー。
2. `buildPersonaSystemPrompt(persona, goal, context)` で疑似ユーザー system prompt を構築。
3. ループ（最大 `maxUserTurns` 回）:
   a. 疑似ユーザー呼び出し: `model.complete({ messages: [system, ...会話をユーザー視点でrole反転], responseFormat: PSEUDO_USER_TURN_SCHEMA })`。
      `PSEUDO_USER_TURN_SCHEMA` = `{ message: string; endConversation: boolean; goalAchieved: boolean }`（required全部・additionalProperties:false）。JSON parse+検証失敗→1回だけ再試行、再失敗→status:'error'。
   b. `endConversation:true` → ループを抜ける（初回発話前に終了した場合も許容: userTurns=0, transcript空）。
   c. 対象Agent呼び出し: **既存 `RunSavedAgentPreviewUseCase` 経路**に会話履歴を渡す。`RunSavedAgentPreviewInput` へ `history?: readonly { role: 'user' | 'assistant'; content: string }[]` を**後方互換で追加**し、system直後に履歴を注入する実装拡張を行う（既存テストは無変更でgreenであること）。応答（`response`）と `runId` を transcript へ。
4. アンケート: `model.complete({ messages:[system(Persona+会話全文+回答指示)], responseFormat: buildSurveySchema(scenario.survey) })` → `validateSurveyAnswers`。失敗→1回再試行→status:'error'（会話までの記録は保存）。`impressions` は id `'impressions'` の回答（無ければ空文字）。
5. metrics 集計: userTurns / agentRuns / totalToolCalls（各RunのtraceのTool call数合計）/ expectedToolHit（期待集合 vs 実呼び出し公開名集合、hitRate = |積|/|期待|、期待未指定ならundefined）/ durationMs / usage合計。
6. `ScenarioRun` を保存して返す。status: 正常=`'completed'`、上限到達=`'max-turns'`（アンケートは実施する）、エラー=`'error'`。
- **read-only制約**: 対象Agent実行は既存のpreview/test規則に従う（既存実装が拒否するならそのエラーを伝播し status:'error'）。

テスト: FakeのModelProviderPort（スクリプト応答列）+ InMemoryリポジトリ + 実RunAgentPreviewUseCase（Fakeモデル）で、①2ターンで目標達成→completed・survey保存・metrics正確 ②maxUserTurns到達→'max-turns' ③疑似ユーザー不正JSON→再試行→復帰/失敗 ④expectedToolHit計算 ⑤goalAchieved伝搬 ⑥エラー時も途中経過が保存される。

## 4. adapters/storage
`persona-repository`（InMemory+Sqlite）・`scenario-repository`（同）は既存の契約テスト方式（`*-repository.contract.ts`）で。`scenario-run-repository` は新契約（save/find/list・新しい順・テナント分離・重複id拒否）。SQLiteテーブルは既存の tools/skills/agents テーブル定義の流儀に合わせる（scenario_runs は `started_at` 降順取得用の列を持つ）。

## 5. api（`src/api/`）
既存ルート規約（scope明示・serialize済み返却・エラーマッピング）で追加:

| メソッド/パス | 処理 |
|---|---|
| `POST /personas` / `GET /personas` / `GET /personas/:id` / `GET /personas/:id/versions` | Save/一覧/取得(latest・version)/バージョン列挙 |
| `POST /scenarios` / `GET /scenarios` / `GET /scenarios/:id` / `GET /scenarios/:id/versions` | 同上（保存時に参照整合検証） |
| `POST /scenarios/:id/run` | `RunScenarioUseCase` 実行（body: scope, version?, mode。同期） |
| `GET /scenario-runs` | 一覧（query: tenantId/workspaceId/scenarioId?） |
| `GET /scenario-runs/:id` | 詳細（トランスクリプト・survey・metrics） |

エラーマッピング追加: `ValidationDomainError`→400、各NotFound→404（`error-mapping.ts` 拡張）。

## 6. ui（Stage B・`src/ui/validation/`）
`ValidationPage` を3タブ化（docs/11 §7）。既存UIの流儀（store・api client・i18n・フォーム部品）に準拠:
- **Personas**: 一覧（種別バッジ+バージョン）/ 新規（archetypeプリセット選択→属性フォーム）/ 生成プロンプトのプレビュー表示と上書きtextarea / 保存（bump選択）
- **Scenarios**: 一覧 / 編集（対象Agent+バージョンのセレクト（既存Agent一覧APIを利用）、Personaセレクト、goal/context、maxUserTurns、expectedTools（公開名のカンマ区切りorチップ）、survey設問エディタ（既定テンプレ読み込み・追加/削除/型切替）） / **実行ボタン**（実行中インジケータ→完了でRunsタブへ）
- **Runs**: 一覧（scenario名・status・達成・満足度・日時）→ 詳細: トランスクリプト（吹き出し、agentターンに Runトレースへのリンク（既存Status画面の該当Run））、アンケート結果（scaleは水平バー、booleanは○×、textはブロック）、感想、metrics表
- i18n: 新規文言をen/jaへ。テスト: タブ切替・Personaフォーム→保存DTO・Scenario実行の呼び出しDTO・Runs詳細のレンダリング（fetchモック）。

## 7. 完了条件（DoD）
- [ ] `npx tsc --noEmit`（+ ui/e2e tsconfig）エラー0
- [ ] `npx vitest run` 全green（既存648 + 新規。**既存テスト無変更**、run-agent-preview の `history` 追加は後方互換）
- [ ] カバレッジ閾値クリア / `depcruise` 違反0
- [ ] 統合テスト: Fakeモデルで「Persona保存→Scenario保存→実行→ScenarioRun取得」がAPI経由で通る
- [ ] UI統合テスト: シナリオ実行→Runsタブに結果が表示される
