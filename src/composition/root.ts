/**
 * Composition Root（v3 実装契約 §3 / ADR-0005）
 *
 * プロファイルに応じてアダプタ実装を選択し、ユースケース群を配線して App を返す。
 * composition だけが adapters 実装を import してよい（depcruise ルール）。
 *
 * - profile 'local' → SqliteToolRepository（dbPath 既定 ':memory:'）
 * - profile 'test'  → InMemoryToolRepository
 * - 既定値は env AGENTCONTEXT_PROFILE / AGENTCONTEXT_DB_PATH。options が env より優先。
 * - 不正な profile 値 → ToolValidationError（メッセージに値を含める）。
 */
import { InMemoryToolRepository } from '../adapters/storage/in-memory-tool-repository';
import { SqliteToolRepository } from '../adapters/storage/sqlite-tool-repository';
import { InMemoryRunRepository } from '../adapters/storage/in-memory-run-repository';
import { SqliteRunRepository } from '../adapters/storage/sqlite-run-repository';
import { LmStudioModelProvider } from '../adapters/model/lm-studio-model-provider';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { RunAgentPreviewUseCase } from '../application/agent/run-agent-preview';
import { QueryRunsUseCase } from '../application/agent/query-runs';
import { EtlEngine } from '../application/etl/engine';
import type { ModelProviderPort } from '../application/model/model-provider';
import { DraftToolUseCase } from '../application/tool/draft-tool';
import { PreviewToolUseCase } from '../application/tool/preview-tool';
import { GetToolUseCase, ListToolVersionsUseCase, ListToolsUseCase } from '../application/tool/query-tool';
import { SaveToolUseCase } from '../application/tool/save-tool';
import { createDefaultRegistry } from '../domain/etl/nodes/index';
import { ToolValidationError } from '../domain/tool/errors';
import type { ToolRepository } from '../domain/tool/tool-repository';
import type { RunRepository } from '../domain/run/run-repository';
import { InMemoryAgentRepository } from '../adapters/storage/in-memory-agent-repository';
import { SqliteAgentRepository } from '../adapters/storage/sqlite-agent-repository';
import { GenerateAgentPromptUseCase } from '../application/agent/generate-agent-prompt';
import { QueryAgentsUseCase } from '../application/agent/query-agents';
import { SaveAgentUseCase } from '../application/agent/save-agent';
import type { AgentRepository } from '../domain/agent/agent-repository';
import { InMemorySkillRepository } from '../adapters/storage/in-memory-skill-repository';
import { SqliteSkillRepository } from '../adapters/storage/sqlite-skill-repository';
import { GenerateSkillPromptUseCase } from '../application/skill/generate-skill-prompt';
import { QuerySkillsUseCase } from '../application/skill/query-skills';
import { SaveSkillUseCase } from '../application/skill/save-skill';
import type { SkillRepository } from '../domain/skill/skill-repository';
import { InMemoryPersonaRepository } from '../adapters/storage/in-memory-persona-repository';
import { SqlitePersonaRepository } from '../adapters/storage/sqlite-persona-repository';
import { InMemoryScenarioRepository } from '../adapters/storage/in-memory-scenario-repository';
import { SqliteScenarioRepository } from '../adapters/storage/sqlite-scenario-repository';
import { InMemoryScenarioRunRepository } from '../adapters/storage/in-memory-scenario-run-repository';
import { SqliteScenarioRunRepository } from '../adapters/storage/sqlite-scenario-run-repository';
import { QueryPersonasUseCase } from '../application/validation/query-personas';
import { QueryScenarioRunsUseCase } from '../application/validation/query-scenario-runs';
import { QueryScenariosUseCase } from '../application/validation/query-scenarios';
import { RunScenarioUseCase } from '../application/validation/run-scenario';
import { RegisterPseudoUserAgentUseCase } from '../application/validation/register-pseudo-user-agent';
import { EvaluateAgentRunUseCase } from '../application/evaluation/evaluate-agent-run';
import { MastraEvalsEvaluator } from '../adapters/evaluation/mastra-evals-evaluator';
import { InMemoryWikiRepository } from '../adapters/storage/in-memory-wiki-repository';
import { SqliteWikiRepository } from '../adapters/storage/sqlite-wiki-repository';
import { InMemoryMemoryProposalRepository } from '../adapters/storage/in-memory-memory-proposal-repository';
import { SqliteMemoryProposalRepository } from '../adapters/storage/sqlite-memory-proposal-repository';
import { SaveWikiPageUseCase } from '../application/memory/save-wiki-page';
import { QueryWikiUseCase } from '../application/memory/query-wiki';
import { ReflectRunUseCase } from '../application/memory/reflect-run';
import { ListProposalsUseCase } from '../application/memory/list-proposals';
import { ReviewProposalUseCase } from '../application/memory/review-proposal';
import type { WikiRepository } from '../domain/memory/wiki-repository';
import type { MemoryProposalRepository } from '../domain/memory/memory-proposal-repository';
import { SavePersonaUseCase } from '../application/validation/save-persona';
import { SaveScenarioUseCase } from '../application/validation/save-scenario';
import type { PersonaRepository } from '../domain/validation/persona-repository';
import type { ScenarioRepository } from '../domain/validation/scenario-repository';
import type { ScenarioRunRepository } from '../domain/validation/scenario-run-repository';
import { InMemoryEvaluationDatasetRepository } from '../adapters/storage/in-memory-evaluation-dataset-repository';
import { SqliteEvaluationDatasetRepository } from '../adapters/storage/sqlite-evaluation-dataset-repository';
import { InMemoryEvaluatorProfileRepository } from '../adapters/storage/in-memory-evaluator-profile-repository';
import { SqliteEvaluatorProfileRepository } from '../adapters/storage/sqlite-evaluator-profile-repository';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../domain/evaluation/evaluation-asset-repositories';
import { SaveEvaluationDatasetUseCase } from '../application/evaluation/save-evaluation-dataset';
import { QueryEvaluationDatasetsUseCase } from '../application/evaluation/query-evaluation-datasets';
import { SaveEvaluatorProfileUseCase } from '../application/evaluation/save-evaluator-profile';
import { QueryEvaluatorProfilesUseCase } from '../application/evaluation/query-evaluator-profiles';
import { ExportEvaluationDatasetUseCase, ImportEvaluationCasesUseCase } from '../application/evaluation/evaluation-dataset-transfer';
import { createHash } from 'node:crypto';
import { InMemoryExperimentRepository } from '../adapters/storage/in-memory-experiment-repository';
import { SqliteExperimentRepository } from '../adapters/storage/sqlite-experiment-repository';
import { InProcessExperimentWorker } from '../adapters/experiment/in-process-experiment-worker';
import type { ExperimentRepository } from '../domain/evaluation/experiment-repository';
import type { ExperimentModelSnapshot } from '../domain/evaluation/experiment';
import { RunExperimentUseCase } from '../application/evaluation/run-experiment';
import { CreateExperimentUseCase } from '../application/evaluation/create-experiment';
import { QueryExperimentsUseCase } from '../application/evaluation/query-experiments';
import { CancelExperimentUseCase } from '../application/evaluation/cancel-experiment';
import { ResumeExperimentUseCase } from '../application/evaluation/resume-experiment';
import { InMemoryQualityGateRepository } from '../adapters/storage/in-memory-quality-gate-repository';
import { SqliteQualityGateRepository } from '../adapters/storage/sqlite-quality-gate-repository';
import type { QualityGateRepository } from '../domain/evaluation/quality-gate-repository';
import { CompareExperimentsUseCase, DecidePromotionUseCase, EvaluateQualityGateUseCase, QualityGateExitCodeUseCase, QueryQualityGatesUseCase, RequestPromotionUseCase, SaveGatePolicyUseCase } from '../application/evaluation/quality-gate-actions';
import { InMemoryJudgeRubricRepository } from '../adapters/storage/in-memory-judge-rubric-repository';
import { SqliteJudgeRubricRepository } from '../adapters/storage/sqlite-judge-rubric-repository';
import type { JudgeRubricRepository } from '../domain/evaluation/evaluation-asset-repositories';
import { SaveJudgeRubricUseCase } from '../application/evaluation/save-judge-rubric';
import { QueryJudgeRubricsUseCase } from '../application/evaluation/query-judge-rubrics';
import { StructuredJudgeEvaluator } from '../adapters/evaluation/structured-judge-evaluator';
import type { JudgeEvaluatorPort } from '../application/evaluation/judge-evaluator';
import { InMemoryOperationsRepository } from '../adapters/storage/in-memory-operations-repository';
import { SqliteOperationsRepository } from '../adapters/storage/sqlite-operations-repository';
import type { OperationsRepository } from '../domain/operations/operations-repository';
import { NoopTelemetryAdapter } from '../adapters/telemetry/noop-telemetry-adapter';
import { OpenTelemetryAdapter } from '../adapters/telemetry/open-telemetry-adapter';
import type { TelemetryPort } from '../application/operations/telemetry';
import { StaticPricingAdapter } from '../adapters/pricing/static-pricing-adapter';
import type { ModelPriceSnapshot, PricingPort } from '../application/operations/pricing';
import { SubmitRunFeedbackUseCase, QueryRunFeedbackUseCase } from '../application/operations/feedback';
import { QueryOperationsStatusUseCase } from '../application/operations/query-operations-status';
import { RetentionUseCase } from '../application/operations/retention';
import { QueryWikiSpacesUseCase, SaveWikiSpaceUseCase } from '../application/memory/wiki-spaces';
import { InMemoryAgentSessionRepository } from '../adapters/storage/in-memory-agent-session-repository';
import { SqliteAgentSessionRepository } from '../adapters/storage/sqlite-agent-session-repository';
import { InMemorySessionArtifactRepository } from '../adapters/storage/in-memory-session-artifact-repository';
import { SqliteSessionArtifactRepository } from '../adapters/storage/sqlite-session-artifact-repository';
import type { AgentSessionRepository, SessionArtifactRepository } from '../domain/session/session-repository';
import { CreateAgentSessionUseCase, QueryAgentSessionUseCase } from '../application/session/agent-sessions';
import { QuerySessionArtifactsUseCase } from '../application/session/session-artifacts';

/** 実行プロファイル。 */
export type Profile = 'local' | 'test';

/** createApp のオプション。 */
export interface AppOptions {
  /** 既定: env AGENTCONTEXT_PROFILE（'local'|'test'）→ 無ければ 'local'。 */
  readonly profile?: Profile;
  /** local のみ有効。既定: env AGENTCONTEXT_DB_PATH → 無ければ ':memory:'。 */
  readonly dbPath?: string;
  /** テスト・埋め込み用の明示provider。省略時はprofileに従う。 */
  readonly modelProvider?: ModelProviderPort;
  readonly runRepository?: RunRepository;
  readonly agentRepository?: AgentRepository;
  readonly skillRepository?: SkillRepository;
  readonly experimentRepository?: ExperimentRepository;
  readonly qualityGateRepository?: QualityGateRepository;
  readonly judgeRubricRepository?: JudgeRubricRepository;
  readonly judgeModelProvider?: ModelProviderPort;
  readonly modelSnapshot?: ExperimentModelSnapshot;
  readonly judgeModelSnapshot?: ExperimentModelSnapshot;
  readonly operationsRepository?: OperationsRepository;
  readonly telemetry?: TelemetryPort;
  readonly pricing?: PricingPort;
}

/** 配線済みアプリケーション。 */
export interface App {
  readonly profile: Profile;
  readonly repo: ToolRepository;
  readonly engine: EtlEngine;
  readonly modelProvider: ModelProviderPort;
  readonly judgeModelProvider: ModelProviderPort;
  readonly judgeEvaluator: JudgeEvaluatorPort;
  readonly runRepo: RunRepository;
  readonly agentRepo: AgentRepository;
  readonly skillRepo: SkillRepository;
  readonly personaRepo: PersonaRepository;
  readonly scenarioRepo: ScenarioRepository;
  readonly scenarioRunRepo: ScenarioRunRepository;
  readonly wikiRepo: WikiRepository;
  readonly memoryProposalRepo: MemoryProposalRepository;
  readonly evaluationDatasetRepo: EvaluationDatasetRepository;
  readonly evaluatorProfileRepo: EvaluatorProfileRepository;
  readonly experimentRepo: ExperimentRepository;
  readonly qualityGateRepo: QualityGateRepository;
  readonly judgeRubricRepo: JudgeRubricRepository;
  readonly operationsRepo: OperationsRepository;
  readonly sessionRepo: AgentSessionRepository;
  readonly sessionArtifactRepo: SessionArtifactRepository;
  readonly telemetry: TelemetryPort;
  readonly pricing: PricingPort;
  readonly runAgentPreview: RunAgentPreviewUseCase;
  readonly queryRuns: QueryRunsUseCase;
  readonly createAgentSession: CreateAgentSessionUseCase;
  readonly queryAgentSession: QueryAgentSessionUseCase;
  readonly querySessionArtifacts: QuerySessionArtifactsUseCase;
  readonly saveAgent: SaveAgentUseCase;
  readonly queryAgents: QueryAgentsUseCase;
  readonly generateAgentPrompt: GenerateAgentPromptUseCase;
  readonly saveSkill: SaveSkillUseCase;
  readonly querySkills: QuerySkillsUseCase;
  readonly generateSkillPrompt: GenerateSkillPromptUseCase;
  readonly savePersona: SavePersonaUseCase;
  readonly registerPseudoUserAgent: RegisterPseudoUserAgentUseCase;
  readonly queryPersonas: QueryPersonasUseCase;
  readonly saveScenario: SaveScenarioUseCase;
  readonly queryScenarios: QueryScenariosUseCase;
  readonly runScenario: RunScenarioUseCase;
  readonly queryScenarioRuns: QueryScenarioRunsUseCase;
  readonly evaluateAgentRun: EvaluateAgentRunUseCase;
  readonly saveEvaluationDataset: SaveEvaluationDatasetUseCase;
  readonly queryEvaluationDatasets: QueryEvaluationDatasetsUseCase;
  readonly importEvaluationCases: ImportEvaluationCasesUseCase;
  readonly exportEvaluationDataset: ExportEvaluationDatasetUseCase;
  readonly saveEvaluatorProfile: SaveEvaluatorProfileUseCase;
  readonly queryEvaluatorProfiles: QueryEvaluatorProfilesUseCase;
  readonly saveJudgeRubric: SaveJudgeRubricUseCase;
  readonly queryJudgeRubrics: QueryJudgeRubricsUseCase;
  readonly runExperiment: RunExperimentUseCase;
  readonly createExperiment: CreateExperimentUseCase;
  readonly queryExperiments: QueryExperimentsUseCase;
  readonly cancelExperiment: CancelExperimentUseCase;
  readonly resumeExperiment: ResumeExperimentUseCase;
  readonly compareExperiments: CompareExperimentsUseCase;
  readonly saveGatePolicy: SaveGatePolicyUseCase;
  readonly queryQualityGates: QueryQualityGatesUseCase;
  readonly evaluateQualityGate: EvaluateQualityGateUseCase;
  readonly requestPromotion: RequestPromotionUseCase;
  readonly decidePromotion: DecidePromotionUseCase;
  readonly qualityGateExitCode: QualityGateExitCodeUseCase;
  readonly submitRunFeedback: SubmitRunFeedbackUseCase;
  readonly queryRunFeedback: QueryRunFeedbackUseCase;
  readonly queryOperationsStatus: QueryOperationsStatusUseCase;
  readonly retention: RetentionUseCase;
  readonly saveWikiPage: SaveWikiPageUseCase;
  readonly queryWiki: QueryWikiUseCase;
  readonly reflectRun: ReflectRunUseCase;
  readonly listProposals: ListProposalsUseCase;
  readonly reviewProposal: ReviewProposalUseCase;
  readonly saveWikiSpace: SaveWikiSpaceUseCase;
  readonly queryWikiSpaces: QueryWikiSpacesUseCase;
  readonly draftTool: DraftToolUseCase;
  readonly saveTool: SaveToolUseCase;
  readonly getTool: GetToolUseCase;
  readonly listToolVersions: ListToolVersionsUseCase;
  readonly listTools: ListToolsUseCase;
  readonly previewTool: PreviewToolUseCase;
  /** SqliteToolRepository の close を委譲する（InMemory は no-op）。 */
  close(): void;
}

/** options → env → 既定 'local' の順で profile を決定・検証する。 */
function resolveProfile(optionProfile: Profile | undefined): Profile {
  const raw = optionProfile ?? process.env['AGENTCONTEXT_PROFILE'] ?? 'local';
  if (raw !== 'local' && raw !== 'test') {
    throw new ToolValidationError(
      `createApp: invalid profile: "${raw}" (expected 'local' or 'test')`,
    );
  }
  return raw;
}

/** プロファイルに応じてリポジトリを構築し、close を確定する。 */
function createRepository(
  profile: Profile,
  dbPath: string | undefined,
): { repo: ToolRepository; close: () => void; path?: string } {
  if (profile === 'local') {
    const path = dbPath ?? process.env['AGENTCONTEXT_DB_PATH'] ?? ':memory:';
    const sqlite = new SqliteToolRepository(path);
    return { repo: sqlite, close: () => sqlite.close(), path };
  }
  return { repo: new InMemoryToolRepository(), close: () => {} };
}

function resolveModelTimeoutMs(): number {
  const raw = process.env['LM_STUDIO_TIMEOUT_MS'];
  if (raw === undefined) return 120_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolValidationError(`createApp: invalid LM_STUDIO_TIMEOUT_MS: "${raw}"`);
  }
  return value;
}

function hashConfig(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function resolvePricingCatalog(profile: Profile): ModelPriceSnapshot[] {
  const raw = process.env['AGENTCONTEXT_MODEL_PRICING_JSON'];
  if (raw === undefined) return profile === 'test' ? [{ provider: 'scripted', model: 'scripted', currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '1970-01-01T00:00:00.000Z' }] : [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ToolValidationError('AGENTCONTEXT_MODEL_PRICING_JSON must be valid JSON'); }
  if (!Array.isArray(value)) throw new ToolValidationError('AGENTCONTEXT_MODEL_PRICING_JSON must be an array');
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new ToolValidationError(`pricing entry ${index} must be an object`);
    const item = entry as Record<string, unknown>;
    if (typeof item['provider'] !== 'string' || typeof item['model'] !== 'string' || typeof item['inputPerMillionTokens'] !== 'number' || item['inputPerMillionTokens'] < 0 || typeof item['outputPerMillionTokens'] !== 'number' || item['outputPerMillionTokens'] < 0 || typeof item['effectiveAt'] !== 'string' || Number.isNaN(new Date(item['effectiveAt']).getTime())) throw new ToolValidationError(`pricing entry ${index} is invalid`);
    return { provider: item['provider'], model: item['model'], currency: 'USD', inputPerMillionTokens: item['inputPerMillionTokens'], outputPerMillionTokens: item['outputPerMillionTokens'], effectiveAt: new Date(item['effectiveAt']).toISOString() };
  });
}

/** プロファイルに従いアダプタとユースケースを配線した App を生成する。 */
export function createApp(options?: AppOptions): App {
  const profile = resolveProfile(options?.profile);
  const { repo, close: closeTools, path } = createRepository(profile, options?.dbPath);
  const runAdapter = options?.runRepository !== undefined
    ? { repo: options.runRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteRunRepository(path ?? ':memory:'); return { repo: sqlite as RunRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryRunRepository() as RunRepository, close: () => {} };
  const agentAdapter = options?.agentRepository !== undefined
    ? { repo: options.agentRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteAgentRepository(path ?? ':memory:'); return { repo: sqlite as AgentRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryAgentRepository() as AgentRepository, close: () => {} };
  const sessionAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteAgentSessionRepository(path ?? ':memory:'); return { repo: sqlite as AgentSessionRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryAgentSessionRepository() as AgentSessionRepository, close: () => {} };
  const sessionArtifactAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteSessionArtifactRepository(path ?? ':memory:'); return { repo: sqlite as SessionArtifactRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemorySessionArtifactRepository() as SessionArtifactRepository, close: () => {} };
  const skillAdapter = options?.skillRepository !== undefined
    ? { repo: options.skillRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteSkillRepository(path ?? ':memory:'); return { repo: sqlite as SkillRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemorySkillRepository() as SkillRepository, close: () => {} };

  const personaAdapter = profile === 'local'
    ? (() => { const sqlite = new SqlitePersonaRepository(path ?? ':memory:'); return { repo: sqlite as PersonaRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryPersonaRepository() as PersonaRepository, close: () => {} };
  const scenarioAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteScenarioRepository(path ?? ':memory:'); return { repo: sqlite as ScenarioRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryScenarioRepository() as ScenarioRepository, close: () => {} };
  const scenarioRunAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteScenarioRunRepository(path ?? ':memory:'); return { repo: sqlite as ScenarioRunRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryScenarioRunRepository() as ScenarioRunRepository, close: () => {} };
  const wikiAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteWikiRepository(path ?? ':memory:'); return { repo: sqlite as WikiRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryWikiRepository() as WikiRepository, close: () => {} };
  const memoryProposalAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteMemoryProposalRepository(path ?? ':memory:'); return { repo: sqlite as MemoryProposalRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryMemoryProposalRepository() as MemoryProposalRepository, close: () => {} };
  const evaluationDatasetAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteEvaluationDatasetRepository(path ?? ':memory:'); return { repo: sqlite as EvaluationDatasetRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryEvaluationDatasetRepository() as EvaluationDatasetRepository, close: () => {} };
  const evaluatorProfileAdapter = profile === 'local'
    ? (() => { const sqlite = new SqliteEvaluatorProfileRepository(path ?? ':memory:'); return { repo: sqlite as EvaluatorProfileRepository, close: () => sqlite.close() }; })()
    : { repo: new InMemoryEvaluatorProfileRepository() as EvaluatorProfileRepository, close: () => {} };
  const experimentAdapter = options?.experimentRepository !== undefined
    ? { repo: options.experimentRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteExperimentRepository(path ?? ':memory:'); return { repo: sqlite as ExperimentRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryExperimentRepository() as ExperimentRepository, close: () => {} };
  const qualityGateAdapter = options?.qualityGateRepository !== undefined
    ? { repo: options.qualityGateRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteQualityGateRepository(path ?? ':memory:'); return { repo: sqlite as QualityGateRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryQualityGateRepository() as QualityGateRepository, close: () => {} };
  const judgeRubricAdapter = options?.judgeRubricRepository !== undefined
    ? { repo: options.judgeRubricRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteJudgeRubricRepository(path ?? ':memory:'); return { repo: sqlite as JudgeRubricRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryJudgeRubricRepository() as JudgeRubricRepository, close: () => {} };
  const operationsAdapter = options?.operationsRepository !== undefined
    ? { repo: options.operationsRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteOperationsRepository(path ?? ':memory:'); return { repo: sqlite as OperationsRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryOperationsRepository() as OperationsRepository, close: () => {} };
  experimentAdapter.repo.interruptRunning(new Date().toISOString());

  const engine = new EtlEngine(createDefaultRegistry());
  const modelProvider = options?.modelProvider ?? (profile === 'test'
    ? new ScriptedModelProvider()
    : new LmStudioModelProvider({
        baseUrl: process.env['LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1',
        model: process.env['LM_STUDIO_MODEL'] ?? '',
        timeoutMs: resolveModelTimeoutMs(),
        ...(process.env['LM_STUDIO_API_KEY'] !== undefined ? { apiKey: process.env['LM_STUDIO_API_KEY'] } : {}),
      }));
  const judgeModelProvider = options?.judgeModelProvider ?? (profile === 'test'
    ? new ScriptedModelProvider()
    : new LmStudioModelProvider({ baseUrl: process.env['JUDGE_LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1', model: process.env['JUDGE_LM_STUDIO_MODEL'] ?? '', timeoutMs: resolveModelTimeoutMs(), ...(process.env['JUDGE_LM_STUDIO_API_KEY'] !== undefined ? { apiKey: process.env['JUDGE_LM_STUDIO_API_KEY'] } : {}) }));
  const judgeSnapshot = options?.judgeModelSnapshot ?? (profile === 'test'
    ? { provider: 'scripted-judge', model: 'scripted-judge', modelConfigHash: hashConfig({ profile: 'test', purpose: 'judge' }) }
    : { provider: 'lm-studio-judge', model: process.env['JUDGE_LM_STUDIO_MODEL'] ?? '', modelConfigHash: hashConfig({ baseUrl: process.env['JUDGE_LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1', model: process.env['JUDGE_LM_STUDIO_MODEL'] ?? '' }) });
  const judgeEvaluator = new StructuredJudgeEvaluator(judgeModelProvider, judgeSnapshot);
  const snapshot = options?.modelSnapshot ?? (profile === 'test'
    ? { provider: 'scripted', model: 'scripted', modelConfigHash: hashConfig({ profile: 'test' }) }
    : { provider: 'lm-studio', model: process.env['LM_STUDIO_MODEL'] ?? '', modelConfigHash: hashConfig({ baseUrl: process.env['LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1', model: process.env['LM_STUDIO_MODEL'] ?? '' }), ...(process.env['AGENTCONTEXT_SOURCE_REVISION'] !== undefined ? { sourceRevision: process.env['AGENTCONTEXT_SOURCE_REVISION'] } : {}) });
  const telemetry = options?.telemetry ?? (process.env['AGENTCONTEXT_OTEL_ENABLED'] === 'true' ? new OpenTelemetryAdapter() : new NoopTelemetryAdapter());
  const pricing = options?.pricing ?? new StaticPricingAdapter(resolvePricingCatalog(profile));

  const runAgentPreview = new RunAgentPreviewUseCase(repo, engine, modelProvider, runAdapter.repo, undefined, undefined, agentAdapter.repo, skillAdapter.repo, { telemetry, pricing, operations: operationsAdapter.repo, model: snapshot }, wikiAdapter.repo, sessionAdapter.repo, sessionArtifactAdapter.repo);
  const saveSkill = new SaveSkillUseCase(skillAdapter.repo, repo);
  const saveWikiPage = new SaveWikiPageUseCase(wikiAdapter.repo);
  const runScenario = new RunScenarioUseCase(scenarioAdapter.repo, personaAdapter.repo, runAgentPreview, modelProvider, scenarioRunAdapter.repo, agentAdapter.repo);
  const evaluator = new MastraEvalsEvaluator();
  const runExperiment = new RunExperimentUseCase(experimentAdapter.repo, evaluationDatasetAdapter.repo, evaluatorProfileAdapter.repo, agentAdapter.repo, scenarioAdapter.repo, runAgentPreview, runScenario, evaluator, undefined, undefined, { rubrics: judgeRubricAdapter.repo, evaluator: judgeEvaluator }, telemetry);
  const experimentWorker = new InProcessExperimentWorker(runExperiment);
  const submitRunFeedback = new SubmitRunFeedbackUseCase(runAdapter.repo, operationsAdapter.repo);

  return {
    profile,
    repo,
    engine,
    modelProvider,
    judgeModelProvider,
    judgeEvaluator,
    runRepo: runAdapter.repo,
    agentRepo: agentAdapter.repo,
    skillRepo: skillAdapter.repo,
    personaRepo: personaAdapter.repo,
    scenarioRepo: scenarioAdapter.repo,
    scenarioRunRepo: scenarioRunAdapter.repo,
    wikiRepo: wikiAdapter.repo,
    memoryProposalRepo: memoryProposalAdapter.repo,
    evaluationDatasetRepo: evaluationDatasetAdapter.repo,
    evaluatorProfileRepo: evaluatorProfileAdapter.repo,
    experimentRepo: experimentAdapter.repo,
    qualityGateRepo: qualityGateAdapter.repo,
    judgeRubricRepo: judgeRubricAdapter.repo,
    operationsRepo: operationsAdapter.repo,
    sessionRepo: sessionAdapter.repo,
    sessionArtifactRepo: sessionArtifactAdapter.repo,
    telemetry,
    pricing,
    runAgentPreview,
    queryRuns: new QueryRunsUseCase(runAdapter.repo),
    createAgentSession: new CreateAgentSessionUseCase(sessionAdapter.repo, agentAdapter.repo),
    queryAgentSession: new QueryAgentSessionUseCase(sessionAdapter.repo),
    querySessionArtifacts: new QuerySessionArtifactsUseCase(new QueryAgentSessionUseCase(sessionAdapter.repo), sessionArtifactAdapter.repo),
    saveAgent: new SaveAgentUseCase(agentAdapter.repo, repo, skillAdapter.repo, wikiAdapter.repo),
    queryAgents: new QueryAgentsUseCase(agentAdapter.repo),
    generateAgentPrompt: new GenerateAgentPromptUseCase(repo, skillAdapter.repo, agentAdapter.repo),
    saveSkill,
    querySkills: new QuerySkillsUseCase(skillAdapter.repo),
    generateSkillPrompt: new GenerateSkillPromptUseCase(repo),
    savePersona: new SavePersonaUseCase(personaAdapter.repo),
    queryPersonas: new QueryPersonasUseCase(personaAdapter.repo),
    registerPseudoUserAgent: new RegisterPseudoUserAgentUseCase(personaAdapter.repo, new SaveAgentUseCase(agentAdapter.repo, repo, skillAdapter.repo, wikiAdapter.repo)),
    saveScenario: new SaveScenarioUseCase(scenarioAdapter.repo, agentAdapter.repo, personaAdapter.repo),
    queryScenarios: new QueryScenariosUseCase(scenarioAdapter.repo),
    runScenario,
    queryScenarioRuns: new QueryScenarioRunsUseCase(scenarioRunAdapter.repo),
    // 評価は決定的（Mastra code系スコアラー・オフライン）でスコープ非依存のため profile 非依存に配線する。
    evaluateAgentRun: new EvaluateAgentRunUseCase(evaluator),
    saveEvaluationDataset: new SaveEvaluationDatasetUseCase(evaluationDatasetAdapter.repo, scenarioAdapter.repo),
    queryEvaluationDatasets: new QueryEvaluationDatasetsUseCase(evaluationDatasetAdapter.repo),
    importEvaluationCases: new ImportEvaluationCasesUseCase(),
    exportEvaluationDataset: new ExportEvaluationDatasetUseCase(),
    saveEvaluatorProfile: new SaveEvaluatorProfileUseCase(evaluatorProfileAdapter.repo, judgeRubricAdapter.repo),
    queryEvaluatorProfiles: new QueryEvaluatorProfilesUseCase(evaluatorProfileAdapter.repo),
    saveJudgeRubric: new SaveJudgeRubricUseCase(judgeRubricAdapter.repo),
    queryJudgeRubrics: new QueryJudgeRubricsUseCase(judgeRubricAdapter.repo),
    runExperiment,
    createExperiment: new CreateExperimentUseCase(experimentAdapter.repo, evaluationDatasetAdapter.repo, evaluatorProfileAdapter.repo, agentAdapter.repo, experimentWorker, () => snapshot),
    queryExperiments: new QueryExperimentsUseCase(experimentAdapter.repo),
    cancelExperiment: new CancelExperimentUseCase(experimentAdapter.repo, experimentWorker),
    resumeExperiment: new ResumeExperimentUseCase(experimentAdapter.repo, experimentWorker),
    compareExperiments: new CompareExperimentsUseCase(experimentAdapter.repo),
    saveGatePolicy: new SaveGatePolicyUseCase(qualityGateAdapter.repo),
    queryQualityGates: new QueryQualityGatesUseCase(qualityGateAdapter.repo),
    evaluateQualityGate: new EvaluateQualityGateUseCase(qualityGateAdapter.repo, experimentAdapter.repo, evaluationDatasetAdapter.repo, undefined, undefined, evaluatorProfileAdapter.repo),
    requestPromotion: new RequestPromotionUseCase(qualityGateAdapter.repo, experimentAdapter.repo, agentAdapter.repo),
    decidePromotion: new DecidePromotionUseCase(qualityGateAdapter.repo, agentAdapter.repo),
    qualityGateExitCode: new QualityGateExitCodeUseCase(qualityGateAdapter.repo, experimentAdapter.repo),
    submitRunFeedback,
    queryRunFeedback: new QueryRunFeedbackUseCase(operationsAdapter.repo),
    queryOperationsStatus: new QueryOperationsStatusUseCase(operationsAdapter.repo),
    retention: new RetentionUseCase(runAdapter.repo, operationsAdapter.repo),
    // 長期記憶（v21）。reflectRun は modelProvider（振り返り）を使用。承認は Wiki 保存 / Skill 蒸留へ委譲。
    saveWikiPage,
    queryWiki: new QueryWikiUseCase(wikiAdapter.repo),
    reflectRun: new ReflectRunUseCase(modelProvider, memoryProposalAdapter.repo, wikiAdapter.repo, skillAdapter.repo),
    listProposals: new ListProposalsUseCase(memoryProposalAdapter.repo),
    reviewProposal: new ReviewProposalUseCase(memoryProposalAdapter.repo, saveWikiPage, skillAdapter.repo, saveSkill),
    saveWikiSpace: new SaveWikiSpaceUseCase(wikiAdapter.repo),
    queryWikiSpaces: new QueryWikiSpacesUseCase(wikiAdapter.repo),
    draftTool: new DraftToolUseCase(engine),
    saveTool: new SaveToolUseCase(repo, engine),
    getTool: new GetToolUseCase(repo),
    listToolVersions: new ListToolVersionsUseCase(repo),
    listTools: new ListToolsUseCase(repo),
    previewTool: new PreviewToolUseCase(repo, engine),
    close: () => {
      experimentWorker.shutdown();
      try { closeTools(); }
      finally {
        try { runAdapter.close(); }
        finally {
          try { agentAdapter.close(); }
          finally {
            try { sessionAdapter.close(); }
            finally {
              try { sessionArtifactAdapter.close(); }
              finally {
                try { skillAdapter.close(); }
                finally {
                  try { personaAdapter.close(); }
                  finally {
                    try { scenarioAdapter.close(); }
                    finally {
                      try { scenarioRunAdapter.close(); }
                      finally {
                        try { wikiAdapter.close(); }
                        finally {
                          try { memoryProposalAdapter.close(); }
                          finally {
                            try { evaluationDatasetAdapter.close(); }
                            finally {
                              try { evaluatorProfileAdapter.close(); }
                              finally {
                                try { experimentAdapter.close(); }
                                finally {
                                  try { qualityGateAdapter.close(); }
                                  finally {
                                    try { judgeRubricAdapter.close(); }
                                    finally { operationsAdapter.close(); }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
  };
}
