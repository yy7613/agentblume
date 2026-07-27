/**
 * Composition Root（v3 実装契約 §3 / ADR-0005）
 *
 * プロファイルに応じてアダプタ実装を選択し、ユースケース群を配線して App を返す。
 * composition だけが adapters 実装を import してよい（depcruise ルール）。
 *
 * - profile 'local' → SQLiteリポジトリ群。**共有接続を1本だけ開いて全リポジトリへ渡す**
 *   （接続が分裂しているとリポジトリをまたぐトランザクションが張れない）。
 * - profile 'test'  → InMemory リポジトリ群。
 * - 既定値は env AGENTCONTEXT_PROFILE / AGENTCONTEXT_DB_PATH。options が env より優先。
 * - 不正な profile 値 → ToolValidationError（メッセージに値を含める）。
 *
 * ## 保存先の既定（重要）
 *
 * `local` の既定は **`~/.agentblume/agentblume.db`（永続ファイル）**。
 * 以前の既定は `:memory:` で、readme の標準手順（`start-dev.ps1`）には
 * `AGENTCONTEXT_DB_PATH` の設定が無かったため、**普通に起動すると全データがプロセス終了で消えていた**。
 * 明示的に `:memory:` を指定したときだけ揮発する。解決したパスは起動時にログへ出す。
 */
import { InMemoryToolRepository } from '../adapters/storage/in-memory-tool-repository';
import { SqliteToolRepository } from '../adapters/storage/sqlite-tool-repository';
import { InMemoryRunRepository } from '../adapters/storage/in-memory-run-repository';
import { SqliteRunRepository } from '../adapters/storage/sqlite-run-repository';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { RunAgentPreviewUseCase } from '../application/agent/run-agent-preview';
import { QueryRunsUseCase } from '../application/agent/query-runs';
import { EtlEngine } from '../application/etl/engine';
import type { ModelProviderPort } from '../application/model/model-provider';
import { DraftToolUseCase } from '../application/tool/draft-tool';
import { SuggestAnalysisConfigUseCase } from '../application/tool/suggest-analysis-config';
import { PreviewToolUseCase } from '../application/tool/preview-tool';
import { DeleteToolUseCase, GetToolUseCase, ListToolVersionsUseCase, ListToolsUseCase } from '../application/tool/query-tool';
import { SaveToolUseCase } from '../application/tool/save-tool';
import { createDefaultRegistry } from '../domain/etl/nodes/index';
import { ToolValidationError } from '../domain/tool/errors';
import type { ToolRepository } from '../domain/tool/tool-repository';
import type { RunRepository } from '../domain/run/run-repository';
import { InMemoryAgentRepository } from '../adapters/storage/in-memory-agent-repository';
import { SqliteAgentRepository } from '../adapters/storage/sqlite-agent-repository';
import { DeleteAgentUseCase } from '../application/agent/delete-agent';
import { GenerateAgentPromptUseCase } from '../application/agent/generate-agent-prompt';
import { QueryAgentsUseCase } from '../application/agent/query-agents';
import { SaveAgentUseCase } from '../application/agent/save-agent';
import type { AgentRepository } from '../domain/agent/agent-repository';
import { InMemorySkillRepository } from '../adapters/storage/in-memory-skill-repository';
import { SqliteSkillRepository } from '../adapters/storage/sqlite-skill-repository';
import { GenerateSkillPromptUseCase } from '../application/skill/generate-skill-prompt';
import { DeleteSkillUseCase, QuerySkillsUseCase } from '../application/skill/query-skills';
import { SaveSkillUseCase } from '../application/skill/save-skill';
import type { SkillRepository } from '../domain/skill/skill-repository';
import { InMemoryPersonaRepository } from '../adapters/storage/in-memory-persona-repository';
import { SqlitePersonaRepository } from '../adapters/storage/sqlite-persona-repository';
import { InMemoryScenarioRepository } from '../adapters/storage/in-memory-scenario-repository';
import { SqliteScenarioRepository } from '../adapters/storage/sqlite-scenario-repository';
import { InMemoryScenarioRunRepository } from '../adapters/storage/in-memory-scenario-run-repository';
import { SqliteScenarioRunRepository } from '../adapters/storage/sqlite-scenario-run-repository';
import { DeletePersonaUseCase, QueryPersonasUseCase } from '../application/validation/query-personas';
import { QueryScenarioRunsUseCase } from '../application/validation/query-scenario-runs';
import { DeleteScenarioUseCase, QueryScenariosUseCase } from '../application/validation/query-scenarios';
import { RunScenarioUseCase } from '../application/validation/run-scenario';
import { RegisterPseudoUserAgentUseCase } from '../application/validation/register-pseudo-user-agent';
import { EvaluateAgentRunUseCase } from '../application/evaluation/evaluate-agent-run';
import { MastraEvalsEvaluator } from '../adapters/evaluation/mastra-evals-evaluator';
import { InMemoryWikiRepository } from '../adapters/storage/in-memory-wiki-repository';
import { SqliteWikiRepository } from '../adapters/storage/sqlite-wiki-repository';
import { InMemoryMemoryProposalRepository } from '../adapters/storage/in-memory-memory-proposal-repository';
import { SqliteMemoryProposalRepository } from '../adapters/storage/sqlite-memory-proposal-repository';
import { SaveWikiPageUseCase } from '../application/memory/save-wiki-page';
import { DeleteWikiPageUseCase, QueryWikiUseCase } from '../application/memory/query-wiki';
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
import { DeleteEvaluationDatasetUseCase, QueryEvaluationDatasetsUseCase } from '../application/evaluation/query-evaluation-datasets';
import { SaveEvaluatorProfileUseCase } from '../application/evaluation/save-evaluator-profile';
import { DeleteEvaluatorProfileUseCase, QueryEvaluatorProfilesUseCase } from '../application/evaluation/query-evaluator-profiles';
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
import { CompareExperimentsUseCase, DecidePromotionUseCase, DeleteGatePolicyUseCase, EvaluateQualityGateUseCase, QualityGateExitCodeUseCase, QueryQualityGatesUseCase, RequestPromotionUseCase, SaveGatePolicyUseCase } from '../application/evaluation/quality-gate-actions';
import { InMemoryJudgeRubricRepository } from '../adapters/storage/in-memory-judge-rubric-repository';
import { SqliteJudgeRubricRepository } from '../adapters/storage/sqlite-judge-rubric-repository';
import type { JudgeRubricRepository } from '../domain/evaluation/evaluation-asset-repositories';
import { SaveJudgeRubricUseCase } from '../application/evaluation/save-judge-rubric';
import { DeleteJudgeRubricUseCase, QueryJudgeRubricsUseCase } from '../application/evaluation/query-judge-rubrics';
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
import { DeleteWikiSpaceUseCase, QueryWikiSpacesUseCase, SaveWikiSpaceUseCase } from '../application/memory/wiki-spaces';
import { InMemoryAgentSessionRepository } from '../adapters/storage/in-memory-agent-session-repository';
import { SqliteAgentSessionRepository } from '../adapters/storage/sqlite-agent-session-repository';
import { InMemorySessionArtifactRepository } from '../adapters/storage/in-memory-session-artifact-repository';
import { SqliteSessionArtifactRepository } from '../adapters/storage/sqlite-session-artifact-repository';
import type { AgentSessionRepository, SessionArtifactRepository } from '../domain/session/session-repository';
import { CreateAgentSessionUseCase, QueryAgentSessionUseCase } from '../application/session/agent-sessions';
import { QuerySessionArtifactsUseCase } from '../application/session/session-artifacts';
import { InMemoryDataSourceRepository } from '../adapters/storage/in-memory-data-source-repository';
import { SqliteDataSourceRepository } from '../adapters/storage/sqlite-data-source-repository';
import type { DataSourceRepository } from '../domain/data-source/data-source-repository';
import { EnvironmentPostgresConnectionCatalog } from '../adapters/database/environment-postgres';
import { DeleteDataSourceUseCase, QueryDataSourcesUseCase, QueryDatabaseConnectionsUseCase, RegisterDatabaseDataSourceUseCase, SaveFileDataSourceUseCase } from '../application/data-source/manage-data-sources';
import { ResolveDataSourceGraphUseCase } from '../application/data-source/resolve-data-source-graph';
import { EnvironmentSearchProviderCatalog } from '../adapters/search/environment-search-provider-catalog';
import { WebSearchUseCase } from '../application/search/web-search';
import type { SearchProviderCatalog } from '../application/search/search-provider';
import { InMemoryAgentHarnessRepository } from '../adapters/storage/in-memory-harness-repository';
import { SqliteAgentHarnessRepository } from '../adapters/storage/sqlite-harness-repository';
import type { AgentHarnessRepository } from '../domain/harness/harness-repository';
import { SaveHarnessUseCase } from '../application/harness/save-harness';
import { DeleteHarnessUseCase } from '../application/harness/delete-harness';
import { QueryHarnessesUseCase } from '../application/harness/query-harnesses';
import { ValidateHarnessUseCase } from '../application/harness/validate-harness';
import { CompileHarnessUseCase } from '../application/harness/compile-harness';
import { InMemoryHarnessRunRepository } from '../adapters/storage/in-memory-harness-run-repository';
import { SqliteHarnessRunRepository } from '../adapters/storage/sqlite-harness-run-repository';
import type { HarnessRunRepository } from '../domain/harness/harness-run-repository';
import { QueryHarnessRunsUseCase, RunHarnessUseCase } from '../application/harness/run-harness';
import { InMemoryFactoryRunRepository } from '../adapters/storage/in-memory-factory-run-repository';
import { SqliteFactoryRunRepository } from '../adapters/storage/sqlite-factory-run-repository';
import type { FactoryRunRepository } from '../domain/factory/factory-run-repository';
import { InProcessFactoryWorker } from '../adapters/factory/in-process-factory-worker';
import { ApplyImprovementsUseCase } from '../application/factory/apply-improvements';
import { GenerateAgentAssetsUseCase } from '../application/factory/generate-agent-assets';
import { ProfileDataSourcesUseCase } from '../application/factory/profile-data-sources';
import { AnalystRole } from '../application/factory/roles/analyst-role';
import { AssemblerRole } from '../application/factory/roles/assembler-role';
import { PlannerRole } from '../application/factory/roles/planner-role';
import { SkillWriterRole } from '../application/factory/roles/skill-writer-role';
import { ToolSmithRole } from '../application/factory/roles/tool-smith-role';
import { RunFactoryUseCase } from '../application/factory/run-factory';
import { CreateFactoryRunUseCase } from '../application/factory/create-factory-run';
import { ResumeFactoryRunUseCase } from '../application/factory/resume-factory-run';
import { RetryFactoryRunUseCase } from '../application/factory/retry-factory-run';
import { CancelFactoryRunUseCase } from '../application/factory/cancel-factory-run';
import { QueryFactoryRunsUseCase } from '../application/factory/query-factory-runs';
import { InMemoryMcpServerRepository } from '../adapters/storage/in-memory-mcp-server-repository';
import { SqliteMcpServerRepository } from '../adapters/storage/sqlite-mcp-server-repository';
import { SdkMcpClient } from '../adapters/mcp/sdk-mcp-client';
import type { McpServerRepository } from '../domain/mcp/mcp-server-repository';
import type { McpClientPort } from '../application/mcp/mcp-client';
import { DeleteMcpServerUseCase, ListMcpServersUseCase, ReplaceMcpServersUseCase, SaveMcpServerUseCase } from '../application/mcp/manage-mcp-servers';
import { TestMcpServerUseCase } from '../application/mcp/test-mcp-server';
import { InMemoryModelSettingsRepository } from '../adapters/storage/in-memory-model-settings-repository';
import { SqliteModelSettingsRepository } from '../adapters/storage/sqlite-model-settings-repository';
import { AesGcmSecretCipher } from '../adapters/security/aes-gcm-secret-cipher';
import { MastraModelProviderFactory } from '../adapters/model/mastra-model-provider-factory';
import { RegistryModelCatalog } from '../adapters/model/registry-model-catalog';
import type { ModelSettingsRepository } from '../domain/model-settings/model-settings-repository';
import type { SecretCipherPort } from '../application/model-settings/secret-cipher';
import type { ModelCatalogPort } from '../application/model-settings/model-catalog';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from '../application/model-settings/model-provider-factory';
import { SwitchableModelProvider } from '../application/model-settings/switchable-model-provider';
import { GetModelSettingsUseCase, SaveModelSettingsUseCase } from '../application/model-settings/manage-model-settings';
import { TestModelSettingsUseCase } from '../application/model-settings/test-model-settings';
import { QueryModelCatalogUseCase } from '../application/model-settings/query-model-catalog';
import type { ModelSlotName } from '../domain/model-settings/model-settings';
import type { TenantScope } from '../domain/tool/ids';
import { defaultDatabasePath, MEMORY_DB_PATH, openSqliteDatabase, type SqliteDatabase } from '../adapters/storage/sqlite-database';
import { SqliteUnitOfWork } from '../adapters/storage/sqlite-unit-of-work';
import { NoopUnitOfWork, type UnitOfWorkPort } from '../application/persistence/unit-of-work';

/** 実行プロファイル。 */
export type Profile = 'local' | 'test';

/** createApp のオプション。 */
export interface AppOptions {
  /** 既定: env AGENTCONTEXT_PROFILE（'local'|'test'）→ 無ければ 'local'。 */
  readonly profile?: Profile;
  /** local のみ有効。既定: env AGENTCONTEXT_DB_PATH → 無ければ `~/.agentblume/agentblume.db`。 */
  readonly dbPath?: string;
  /** 起動時の保存先ログの出力先。既定は console.info（テストで差し替え・抑止できる）。 */
  readonly logger?: (message: string) => void;
  /** テスト・埋め込み用の明示provider。省略時はprofileに従う。 */
  readonly modelProvider?: ModelProviderPort;
  readonly runRepository?: RunRepository;
  readonly agentRepository?: AgentRepository;
  readonly harnessRepository?: AgentHarnessRepository;
  readonly harnessRunRepository?: HarnessRunRepository;
  readonly factoryRunRepository?: FactoryRunRepository;
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
  /** 検索adapterの契約テスト・埋め込み用差し替え。省略時は環境変数でproviderを検出する。 */
  readonly searchProviderCatalog?: SearchProviderCatalog;
  readonly mcpServerRepository?: McpServerRepository;
  /** テスト・埋め込み用の明示MCPクライアント。省略時は SDK 実装（実接続）。 */
  readonly mcpClient?: McpClientPort;
  /** モデル設定（v34）のfake注入口。省略時は profile に従う。 */
  readonly modelSettingsRepository?: ModelSettingsRepository;
  readonly secretCipher?: SecretCipherPort;
  readonly modelProviderFactory?: ModelProviderFactoryPort;
  readonly modelCatalog?: ModelCatalogPort;
  /** モデル設定を読むスコープ。既定は env AGENTCONTEXT_TENANT_ID / _WORKSPACE_ID。 */
  readonly modelSettingsScope?: TenantScope;
}

/** 配線済みアプリケーション。 */
export interface App {
  readonly profile: Profile;
  /** 実際に使っている保存先（'local' のみ）。`:memory:` は揮発を意味する。 */
  readonly dbPath?: string;
  /** 複数リポジトリにまたがる書き込みを1トランザクションで括る（test配線では no-op）。 */
  readonly unitOfWork: UnitOfWorkPort;
  readonly repo: ToolRepository;
  readonly engine: EtlEngine;
  readonly modelProvider: ModelProviderPort;
  readonly judgeModelProvider: ModelProviderPort;
  readonly judgeEvaluator: JudgeEvaluatorPort;
  readonly runRepo: RunRepository;
  readonly agentRepo: AgentRepository;
  readonly harnessRepo: AgentHarnessRepository;
  readonly harnessRunRepo: HarnessRunRepository;
  readonly factoryRunRepo: FactoryRunRepository;
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
  readonly dataSourceRepo: DataSourceRepository;
  readonly mcpServerRepo: McpServerRepository;
  readonly modelSettingsRepo: ModelSettingsRepository;
  /** 外部MCPサーバーへの接続。shutdown時に close() を呼び、プール済み接続（子プロセス）を解放する。 */
  readonly mcpClient: McpClientPort;
  readonly telemetry: TelemetryPort;
  readonly pricing: PricingPort;
  readonly runAgentPreview: RunAgentPreviewUseCase;
  readonly queryRuns: QueryRunsUseCase;
  readonly createAgentSession: CreateAgentSessionUseCase;
  readonly queryAgentSession: QueryAgentSessionUseCase;
  readonly querySessionArtifacts: QuerySessionArtifactsUseCase;
  readonly saveFileDataSource: SaveFileDataSourceUseCase;
  readonly registerDatabaseDataSource: RegisterDatabaseDataSourceUseCase;
  readonly queryDataSources: QueryDataSourcesUseCase;
  readonly deleteDataSource: DeleteDataSourceUseCase;
  readonly queryDatabaseConnections: QueryDatabaseConnectionsUseCase;
  readonly webSearch: WebSearchUseCase;
  readonly saveAgent: SaveAgentUseCase;
  readonly queryAgents: QueryAgentsUseCase;
  readonly generateAgentPrompt: GenerateAgentPromptUseCase;
  readonly deleteAgent: DeleteAgentUseCase;
  readonly saveHarness: SaveHarnessUseCase;
  readonly queryHarnesses: QueryHarnessesUseCase;
  readonly validateHarness: ValidateHarnessUseCase;
  readonly compileHarness: CompileHarnessUseCase;
  readonly deleteHarness: DeleteHarnessUseCase;
  readonly runHarness: RunHarnessUseCase;
  readonly queryHarnessRuns: QueryHarnessRunsUseCase;
  readonly profileDataSources: ProfileDataSourcesUseCase;
  readonly plannerRole: PlannerRole;
  readonly runFactory: RunFactoryUseCase;
  readonly createFactoryRun: CreateFactoryRunUseCase;
  readonly resumeFactoryRun: ResumeFactoryRunUseCase;
  readonly retryFactoryRun: RetryFactoryRunUseCase;
  readonly cancelFactoryRun: CancelFactoryRunUseCase;
  readonly queryFactoryRuns: QueryFactoryRunsUseCase;
  readonly saveMcpServer: SaveMcpServerUseCase;
  readonly listMcpServers: ListMcpServersUseCase;
  readonly deleteMcpServer: DeleteMcpServerUseCase;
  readonly replaceMcpServers: ReplaceMcpServersUseCase;
  readonly testMcpServer: TestMcpServerUseCase;
  readonly getModelSettings: GetModelSettingsUseCase;
  readonly saveModelSettings: SaveModelSettingsUseCase;
  readonly testModelSettings: TestModelSettingsUseCase;
  readonly queryModelCatalog: QueryModelCatalogUseCase;
  readonly saveSkill: SaveSkillUseCase;
  readonly querySkills: QuerySkillsUseCase;
  readonly deleteSkill: DeleteSkillUseCase;
  readonly generateSkillPrompt: GenerateSkillPromptUseCase;
  readonly savePersona: SavePersonaUseCase;
  readonly deletePersona: DeletePersonaUseCase;
  readonly registerPseudoUserAgent: RegisterPseudoUserAgentUseCase;
  readonly queryPersonas: QueryPersonasUseCase;
  readonly saveScenario: SaveScenarioUseCase;
  readonly queryScenarios: QueryScenariosUseCase;
  readonly deleteScenario: DeleteScenarioUseCase;
  readonly runScenario: RunScenarioUseCase;
  readonly queryScenarioRuns: QueryScenarioRunsUseCase;
  readonly evaluateAgentRun: EvaluateAgentRunUseCase;
  readonly saveEvaluationDataset: SaveEvaluationDatasetUseCase;
  readonly queryEvaluationDatasets: QueryEvaluationDatasetsUseCase;
  readonly deleteEvaluationDataset: DeleteEvaluationDatasetUseCase;
  readonly importEvaluationCases: ImportEvaluationCasesUseCase;
  readonly exportEvaluationDataset: ExportEvaluationDatasetUseCase;
  readonly saveEvaluatorProfile: SaveEvaluatorProfileUseCase;
  readonly queryEvaluatorProfiles: QueryEvaluatorProfilesUseCase;
  readonly deleteEvaluatorProfile: DeleteEvaluatorProfileUseCase;
  readonly saveJudgeRubric: SaveJudgeRubricUseCase;
  readonly queryJudgeRubrics: QueryJudgeRubricsUseCase;
  readonly deleteJudgeRubric: DeleteJudgeRubricUseCase;
  readonly runExperiment: RunExperimentUseCase;
  readonly createExperiment: CreateExperimentUseCase;
  readonly queryExperiments: QueryExperimentsUseCase;
  readonly cancelExperiment: CancelExperimentUseCase;
  readonly resumeExperiment: ResumeExperimentUseCase;
  readonly compareExperiments: CompareExperimentsUseCase;
  readonly saveGatePolicy: SaveGatePolicyUseCase;
  readonly queryQualityGates: QueryQualityGatesUseCase;
  readonly deleteGatePolicy: DeleteGatePolicyUseCase;
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
  readonly deleteWikiPage: DeleteWikiPageUseCase;
  readonly reflectRun: ReflectRunUseCase;
  readonly listProposals: ListProposalsUseCase;
  readonly reviewProposal: ReviewProposalUseCase;
  readonly saveWikiSpace: SaveWikiSpaceUseCase;
  readonly queryWikiSpaces: QueryWikiSpacesUseCase;
  readonly deleteWikiSpace: DeleteWikiSpaceUseCase;
  readonly draftTool: DraftToolUseCase;
  readonly suggestAnalysisConfig: SuggestAnalysisConfigUseCase;
  readonly saveTool: SaveToolUseCase;
  readonly getTool: GetToolUseCase;
  readonly listToolVersions: ListToolVersionsUseCase;
  readonly listTools: ListToolsUseCase;
  readonly deleteTool: DeleteToolUseCase;
  readonly previewTool: PreviewToolUseCase;
  /**
   * shutdown猶予（`AGENTCONTEXT_SHUTDOWN_GRACE_MS`）。ワーカーの新規受付を止め、
   * 実行中のジョブを最大 `graceMs` だけ待ってから abort する。**`close()` の前に呼ぶ**
   * （`close()` は待たずに即 abort する最終手段）。戻り値は猶予内に全て終わったか。
   * ジョブの永続化・再起動復旧はまだ無いため、abort されたジョブは再開されない。
   */
  drainWorkers(graceMs: number): Promise<boolean>;
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

/**
 * local プロファイルの保存先を決める。
 *
 * 優先順: options.dbPath → env `AGENTCONTEXT_DB_PATH` → `~/.agentblume/agentblume.db`。
 * 空文字の env は「未設定」と同じ扱いにする（`AGENTCONTEXT_DB_PATH=` だけ書かれた .env で
 * 黙って揮発するのを防ぐ）。`:memory:` を明示したときだけ揮発する。
 */
export function resolveDatabasePath(dbPath: string | undefined): string {
  if (dbPath !== undefined) return dbPath;
  const fromEnv = process.env['AGENTCONTEXT_DB_PATH']?.trim();
  return fromEnv === undefined || fromEnv === '' ? defaultDatabasePath() : fromEnv;
}

/** 明示注入 → SQLite（共有ハンドル）→ InMemory の順で実装を選ぶ。 */
function pickRepository<T>(
  explicit: T | undefined,
  database: SqliteDatabase | undefined,
  sqlite: (db: SqliteDatabase) => T,
  memory: () => T,
): T {
  if (explicit !== undefined) return explicit;
  return database === undefined ? memory() : sqlite(database);
}

/** 正のミリ秒 env を読む。未設定は既定値、不正値は ToolValidationError。 */
function resolvePositiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolValidationError(`createApp: invalid ${name}: "${raw}"`);
  }
  return value;
}

/** 総時間の上限。ハング検知は idle timeout が担うため長めに取る。 */
function resolveModelTimeoutMs(): number {
  return resolvePositiveEnv('LM_STUDIO_TIMEOUT_MS', 600_000);
}

/** 出力が1バイトも来ない状態の上限。推論モデルの長考中は出力継続で更新される。 */
function resolveModelIdleTimeoutMs(): number {
  return resolvePositiveEnv('LM_STUDIO_IDLE_TIMEOUT_MS', 60_000);
}

/** 未設定なら max_tokens を送らない（モデル既定に委ねる）。 */
function resolveModelMaxTokens(): number | undefined {
  const raw = process.env['LM_STUDIO_MAX_TOKENS'];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ToolValidationError(`createApp: invalid LM_STUDIO_MAX_TOKENS: "${raw}"`);
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
  // local は共有接続を1本だけ開く（PRAGMA適用とマイグレーションもここで1回だけ走る）。
  const path = profile === 'local' ? resolveDatabasePath(options?.dbPath) : undefined;
  const database = path === undefined ? undefined : openSqliteDatabase(path);
  // 保存先は起動時に必ず伝える。既定が揮発だった頃、利用者は「消えた」ことに気づけなかった。
  if (path !== undefined && options?.dbPath === undefined) {
    (options?.logger ?? ((message: string) => { console.info(message); }))(
      path === MEMORY_DB_PATH
        ? 'agentblume: database is EPHEMERAL (:memory:) — all data is lost when the process exits. Set AGENTCONTEXT_DB_PATH to persist.'
        : `agentblume: database file = ${path}`,
    );
  }
  const unitOfWork: UnitOfWorkPort = database === undefined ? new NoopUnitOfWork() : new SqliteUnitOfWork(database);

  const repo = pickRepository<ToolRepository>(undefined, database, (db) => new SqliteToolRepository(db), () => new InMemoryToolRepository());
  const runAdapter = { repo: pickRepository<RunRepository>(options?.runRepository, database, (db) => new SqliteRunRepository(db), () => new InMemoryRunRepository()) };
  const agentAdapter = { repo: pickRepository<AgentRepository>(options?.agentRepository, database, (db) => new SqliteAgentRepository(db), () => new InMemoryAgentRepository()) };
  const harnessAdapter = { repo: pickRepository<AgentHarnessRepository>(options?.harnessRepository, database, (db) => new SqliteAgentHarnessRepository(db), () => new InMemoryAgentHarnessRepository()) };
  const harnessRunAdapter = { repo: pickRepository<HarnessRunRepository>(options?.harnessRunRepository, database, (db) => new SqliteHarnessRunRepository(db), () => new InMemoryHarnessRunRepository()) };
  const factoryRunAdapter = { repo: pickRepository<FactoryRunRepository>(options?.factoryRunRepository, database, (db) => new SqliteFactoryRunRepository(db), () => new InMemoryFactoryRunRepository()) };
  const sessionAdapter = { repo: pickRepository<AgentSessionRepository>(undefined, database, (db) => new SqliteAgentSessionRepository(db), () => new InMemoryAgentSessionRepository()) };
  // payloadはDBの外（ディレクトリ）に置くため、close で一時ディレクトリの後始末が要る唯一のアダプタ。
  const sessionArtifactSqlite = database === undefined ? undefined : new SqliteSessionArtifactRepository(database);
  const sessionArtifactAdapter = { repo: (sessionArtifactSqlite ?? new InMemorySessionArtifactRepository()) as SessionArtifactRepository, close: () => sessionArtifactSqlite?.close() };
  const dataSourceAdapter = { repo: pickRepository<DataSourceRepository>(undefined, database, (db) => new SqliteDataSourceRepository(db), () => new InMemoryDataSourceRepository()) };
  const mcpServerAdapter = { repo: pickRepository<McpServerRepository>(options?.mcpServerRepository, database, (db) => new SqliteMcpServerRepository(db), () => new InMemoryMcpServerRepository()) };
  const skillAdapter = { repo: pickRepository<SkillRepository>(options?.skillRepository, database, (db) => new SqliteSkillRepository(db), () => new InMemorySkillRepository()) };
  const personaAdapter = { repo: pickRepository<PersonaRepository>(undefined, database, (db) => new SqlitePersonaRepository(db), () => new InMemoryPersonaRepository()) };
  const scenarioAdapter = { repo: pickRepository<ScenarioRepository>(undefined, database, (db) => new SqliteScenarioRepository(db), () => new InMemoryScenarioRepository()) };
  const scenarioRunAdapter = { repo: pickRepository<ScenarioRunRepository>(undefined, database, (db) => new SqliteScenarioRunRepository(db), () => new InMemoryScenarioRunRepository()) };
  const wikiAdapter = { repo: pickRepository<WikiRepository>(undefined, database, (db) => new SqliteWikiRepository(db), () => new InMemoryWikiRepository()) };
  const memoryProposalAdapter = { repo: pickRepository<MemoryProposalRepository>(undefined, database, (db) => new SqliteMemoryProposalRepository(db), () => new InMemoryMemoryProposalRepository()) };
  const evaluationDatasetAdapter = { repo: pickRepository<EvaluationDatasetRepository>(undefined, database, (db) => new SqliteEvaluationDatasetRepository(db), () => new InMemoryEvaluationDatasetRepository()) };
  const evaluatorProfileAdapter = { repo: pickRepository<EvaluatorProfileRepository>(undefined, database, (db) => new SqliteEvaluatorProfileRepository(db), () => new InMemoryEvaluatorProfileRepository()) };
  const experimentAdapter = { repo: pickRepository<ExperimentRepository>(options?.experimentRepository, database, (db) => new SqliteExperimentRepository(db), () => new InMemoryExperimentRepository()) };
  const qualityGateAdapter = { repo: pickRepository<QualityGateRepository>(options?.qualityGateRepository, database, (db) => new SqliteQualityGateRepository(db), () => new InMemoryQualityGateRepository()) };
  const judgeRubricAdapter = { repo: pickRepository<JudgeRubricRepository>(options?.judgeRubricRepository, database, (db) => new SqliteJudgeRubricRepository(db), () => new InMemoryJudgeRubricRepository()) };
  const operationsAdapter = { repo: pickRepository<OperationsRepository>(options?.operationsRepository, database, (db) => new SqliteOperationsRepository(db), () => new InMemoryOperationsRepository()) };
  experimentAdapter.repo.interruptRunning(new Date().toISOString());

  const engine = new EtlEngine(createDefaultRegistry());
  const modelMaxTokens = resolveModelMaxTokens();

  // モデル設定（v34）: 設定は暗号化してDBへ、鍵はDBの外（鍵ファイル）へ置く。
  // testプロファイルは揮発鍵（ファイルを作らない）にして、テスト実行が利用者のホームを汚さないようにする。
  const modelSettingsAdapter = { repo: pickRepository<ModelSettingsRepository>(options?.modelSettingsRepository, database, (db) => new SqliteModelSettingsRepository(db), () => new InMemoryModelSettingsRepository()) };
  const secretCipher = options?.secretCipher ?? (profile === 'local' ? new AesGcmSecretCipher() : AesGcmSecretCipher.ephemeral());
  const modelProviderFactory = options?.modelProviderFactory ?? new MastraModelProviderFactory({
    timeoutMs: resolveModelTimeoutMs(),
    idleTimeoutMs: resolveModelIdleTimeoutMs(),
    ...(modelMaxTokens !== undefined ? { maxTokens: modelMaxTokens } : {}),
  });
  const modelCatalog = options?.modelCatalog ?? new RegistryModelCatalog();
  const modelSettingsScope = options?.modelSettingsScope ?? { tenantId: process.env['AGENTCONTEXT_TENANT_ID'] ?? 'local', workspaceId: process.env['AGENTCONTEXT_WORKSPACE_ID'] ?? 'default' };
  /** env 既定（設定を保存していないスロットで使う）。従来の LM_STUDIO_* 配線と等価。 */
  const envSlotDefault = (slot: ModelSlotName): ResolvedSlotOptions => {
    const prefix = slot === 'judge' ? 'JUDGE_' : '';
    const apiKey = process.env[`${prefix}LM_STUDIO_API_KEY`];
    return {
      model: {
        id: process.env[`${prefix}LM_STUDIO_MODEL`] ?? '',
        url: process.env[`${prefix}LM_STUDIO_BASE_URL`] ?? 'http://127.0.0.1:1234/v1',
        ...(apiKey === undefined ? {} : { apiKey }),
      },
    };
  };
  const sourceRevision = process.env['AGENTCONTEXT_SOURCE_REVISION'];
  const makeSwitchable = (slot: ModelSlotName): SwitchableModelProvider => new SwitchableModelProvider(
    modelSettingsAdapter.repo, secretCipher, modelProviderFactory, slot, envSlotDefault(slot), modelSettingsScope,
    slot === 'main' && sourceRevision !== undefined ? { sourceRevision } : {},
  );
  // testプロファイルは決定的な ScriptedModelProvider を直接使い、設定切替の対象外にする。
  const mainSwitchable = profile === 'test' || options?.modelProvider !== undefined ? undefined : makeSwitchable('main');
  const judgeSwitchable = profile === 'test' || options?.judgeModelProvider !== undefined ? undefined : makeSwitchable('judge');
  const modelProvider = options?.modelProvider ?? mainSwitchable ?? new ScriptedModelProvider();
  const judgeModelProvider = options?.judgeModelProvider ?? judgeSwitchable ?? new ScriptedModelProvider();

  // 切替可能な配線では指紋も実行時点で解決する。static は「明示provider注入」「testプロファイル」用の退避。
  const staticJudgeSnapshot: ExperimentModelSnapshot = profile === 'test'
    ? { provider: 'scripted-judge', model: 'scripted-judge', modelConfigHash: hashConfig({ profile: 'test', purpose: 'judge' }) }
    : { provider: 'lm-studio-judge', model: process.env['JUDGE_LM_STUDIO_MODEL'] ?? '', modelConfigHash: hashConfig({ baseUrl: process.env['JUDGE_LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1', model: process.env['JUDGE_LM_STUDIO_MODEL'] ?? '' }) };
  // StructuredJudgeEvaluator は complete() 直後に snapshot() を読むため、
  // lastSnapshot()（同期・直近解決値）で「実際に使った設定」が記録される。
  const judgeEvaluator = new StructuredJudgeEvaluator(
    judgeModelProvider,
    options?.judgeModelSnapshot ?? (judgeSwitchable === undefined ? staticJudgeSnapshot : () => judgeSwitchable.lastSnapshot()),
  );
  /**
   * judge の指紋を評価の**前**に解決する。これが無いと、UIでjudgeを切り替えた直後の
   * 失敗レコードに env 既定由来の指紋が残り、capabilities() のガードも古い設定を見る。
   */
  const resolveJudgeSnapshot = options?.judgeModelSnapshot === undefined && judgeSwitchable !== undefined
    ? (): Promise<ExperimentModelSnapshot> => judgeSwitchable.currentSnapshot()
    : undefined;
  const staticSnapshot: ExperimentModelSnapshot = profile === 'test'
    ? { provider: 'scripted', model: 'scripted', modelConfigHash: hashConfig({ profile: 'test' }) }
    : { provider: 'lm-studio', model: process.env['LM_STUDIO_MODEL'] ?? '', modelConfigHash: hashConfig({ baseUrl: process.env['LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1', model: process.env['LM_STUDIO_MODEL'] ?? '' }), ...(sourceRevision !== undefined ? { sourceRevision } : {}) };
  const snapshot = options?.modelSnapshot ?? mainSwitchable?.lastSnapshot() ?? staticSnapshot;
  /** Run開始・実験起票の時点で設定を解決する（未設定なら env 既定の指紋）。 */
  const resolveModelSnapshot = options?.modelSnapshot === undefined && mainSwitchable !== undefined
    ? (): Promise<ExperimentModelSnapshot> => mainSwitchable.currentSnapshot()
    : undefined;
  const telemetry = options?.telemetry ?? (process.env['AGENTCONTEXT_OTEL_ENABLED'] === 'true' ? new OpenTelemetryAdapter() : new NoopTelemetryAdapter());
  const pricing = options?.pricing ?? new StaticPricingAdapter(resolvePricingCatalog(profile));
  const databaseConnections = new EnvironmentPostgresConnectionCatalog();
  // 接続は初回利用まで張られず、スイープタイマーも接続後にしか起動しないため、
  // testプロファイルでも実装をそのまま使える（外部プロセスは設定が保存されない限り生まれない）。
  const mcpClient = options?.mcpClient ?? new SdkMcpClient();
  const webSearch = new WebSearchUseCase(options?.searchProviderCatalog ?? new EnvironmentSearchProviderCatalog());
  const resolveDataSources = new ResolveDataSourceGraphUseCase(dataSourceAdapter.repo, databaseConnections, webSearch);

  const runAgentPreview = new RunAgentPreviewUseCase(repo, engine, modelProvider, runAdapter.repo, undefined, undefined, agentAdapter.repo, skillAdapter.repo, { telemetry, pricing, operations: operationsAdapter.repo, model: snapshot, ...(resolveModelSnapshot === undefined ? {} : { resolveModel: resolveModelSnapshot }) }, wikiAdapter.repo, sessionAdapter.repo, sessionArtifactAdapter.repo, resolveDataSources, webSearch, mcpServerAdapter.repo, mcpClient);
  const saveSkill = new SaveSkillUseCase(skillAdapter.repo, repo);
  const saveWikiPage = new SaveWikiPageUseCase(wikiAdapter.repo);
  const runScenario = new RunScenarioUseCase(scenarioAdapter.repo, personaAdapter.repo, runAgentPreview, modelProvider, scenarioRunAdapter.repo, agentAdapter.repo);
  const evaluator = new MastraEvalsEvaluator();
  const runExperiment = new RunExperimentUseCase(experimentAdapter.repo, evaluationDatasetAdapter.repo, evaluatorProfileAdapter.repo, agentAdapter.repo, scenarioAdapter.repo, runAgentPreview, runScenario, evaluator, undefined, undefined, { rubrics: judgeRubricAdapter.repo, evaluator: judgeEvaluator, ...(resolveJudgeSnapshot === undefined ? {} : { resolveSnapshot: resolveJudgeSnapshot }) }, telemetry);
  const experimentWorker = new InProcessExperimentWorker(runExperiment);
  const submitRunFeedback = new SubmitRunFeedbackUseCase(runAdapter.repo, operationsAdapter.repo);

  // Agent Factory（v33）: Stage 0（決定的プロファイル）+ Stage 1（Plannerロール）+ 承認checkpoint +
  // Stage 2-4（ToolSmith/SkillWriter/Assemblerロール + 既存Save系ユースケースの資産生成、M2）+
  // Stage 5-6（検証資産の決定的マテリアライズ + 検証実行、M3）+ 改善ループ（Analystロール + 改訂適用 + 停止条件・
  // レポート、M4）。
  const saveTool = new SaveToolUseCase(repo, engine, resolveDataSources);
  const saveAgent = new SaveAgentUseCase(agentAdapter.repo, repo, skillAdapter.repo, wikiAdapter.repo);
  const generateAgentPrompt = new GenerateAgentPromptUseCase(repo, skillAdapter.repo, agentAdapter.repo);
  const profileDataSources = new ProfileDataSourcesUseCase(dataSourceAdapter.repo, resolveDataSources, engine);
  const plannerRole = new PlannerRole(modelProvider);
  const toolSmithRole = new ToolSmithRole(modelProvider);
  const skillWriterRole = new SkillWriterRole(modelProvider);
  const assemblerRole = new AssemblerRole(modelProvider);
  const analystRole = new AnalystRole(modelProvider);
  const generateAgentAssets = new GenerateAgentAssetsUseCase(toolSmithRole, skillWriterRole, assemblerRole, saveTool, saveSkill, saveAgent, generateAgentPrompt, engine, resolveDataSources);
  // Stage 5（検証資産）が使うSave系ユースケース。既存の疑似ユーザー検証（validation-routes）と同じ配線を再利用する。
  const savePersona = new SavePersonaUseCase(personaAdapter.repo);
  const registerPseudoUserAgent = new RegisterPseudoUserAgentUseCase(personaAdapter.repo, saveAgent);
  const saveScenario = new SaveScenarioUseCase(scenarioAdapter.repo, agentAdapter.repo, personaAdapter.repo);
  // `add-tool` 提案の適用はStage 2と同じToolSmith修復ループを回すため、生成側と同じ協働者を注入する
  // （未注入なら add-tool は「未設定」として却下される）。第9引数は既定の now。
  const applyImprovements = new ApplyImprovementsUseCase(
    agentAdapter.repo, skillAdapter.repo, repo, saveAgent, saveSkill, saveTool, generateAgentPrompt, engine, undefined,
    { toolSmith: toolSmithRole, resolveDataSources, profiler: profileDataSources }, undefined, unitOfWork,
  );
  const runFactory = new RunFactoryUseCase(factoryRunAdapter.repo, profileDataSources, plannerRole, generateAgentAssets, runScenario, savePersona, registerPseudoUserAgent, saveScenario, analystRole, applyImprovements, agentAdapter.repo, skillAdapter.repo, repo);
  const factoryWorker = new InProcessFactoryWorker(runFactory);
  const createFactoryRun = new CreateFactoryRunUseCase(factoryRunAdapter.repo, factoryWorker);
  const resumeFactoryRun = new ResumeFactoryRunUseCase(factoryRunAdapter.repo, runFactory, factoryWorker);
  // 失敗Runの再実行は「同じ入力で新しいRunを起票する」ため CreateFactoryRunUseCase へ委譲する。
  const retryFactoryRun = new RetryFactoryRunUseCase(factoryRunAdapter.repo, createFactoryRun);
  const cancelFactoryRun = new CancelFactoryRunUseCase(factoryRunAdapter.repo, factoryWorker);
  const queryFactoryRuns = new QueryFactoryRunsUseCase(factoryRunAdapter.repo);

  return {
    profile,
    ...(path === undefined ? {} : { dbPath: path }),
    unitOfWork,
    repo,
    engine,
    modelProvider,
    judgeModelProvider,
    judgeEvaluator,
    runRepo: runAdapter.repo,
    agentRepo: agentAdapter.repo,
    harnessRepo: harnessAdapter.repo,
    harnessRunRepo: harnessRunAdapter.repo,
    factoryRunRepo: factoryRunAdapter.repo,
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
    dataSourceRepo: dataSourceAdapter.repo,
    mcpServerRepo: mcpServerAdapter.repo,
    modelSettingsRepo: modelSettingsAdapter.repo,
    mcpClient,
    telemetry,
    pricing,
    runAgentPreview,
    queryRuns: new QueryRunsUseCase(runAdapter.repo),
    createAgentSession: new CreateAgentSessionUseCase(sessionAdapter.repo, agentAdapter.repo),
    queryAgentSession: new QueryAgentSessionUseCase(sessionAdapter.repo),
    querySessionArtifacts: new QuerySessionArtifactsUseCase(new QueryAgentSessionUseCase(sessionAdapter.repo), sessionArtifactAdapter.repo),
    saveFileDataSource: new SaveFileDataSourceUseCase(dataSourceAdapter.repo),
    registerDatabaseDataSource: new RegisterDatabaseDataSourceUseCase(dataSourceAdapter.repo, databaseConnections),
    queryDataSources: new QueryDataSourcesUseCase(dataSourceAdapter.repo),
    deleteDataSource: new DeleteDataSourceUseCase(dataSourceAdapter.repo),
    queryDatabaseConnections: new QueryDatabaseConnectionsUseCase(databaseConnections),
    webSearch,
    saveAgent,
    queryAgents: new QueryAgentsUseCase(agentAdapter.repo),
    generateAgentPrompt,
    deleteAgent: new DeleteAgentUseCase(agentAdapter.repo),
    saveHarness: new SaveHarnessUseCase(harnessAdapter.repo, agentAdapter.repo),
    queryHarnesses: new QueryHarnessesUseCase(harnessAdapter.repo),
    validateHarness: new ValidateHarnessUseCase(agentAdapter.repo),
    compileHarness: new CompileHarnessUseCase(),
    deleteHarness: new DeleteHarnessUseCase(harnessAdapter.repo),
    runHarness: new RunHarnessUseCase(harnessAdapter.repo, harnessRunAdapter.repo, runAgentPreview),
    queryHarnessRuns: new QueryHarnessRunsUseCase(harnessRunAdapter.repo),
    profileDataSources,
    plannerRole,
    runFactory,
    createFactoryRun,
    resumeFactoryRun,
    retryFactoryRun,
    cancelFactoryRun,
    queryFactoryRuns,
    saveMcpServer: new SaveMcpServerUseCase(mcpServerAdapter.repo),
    listMcpServers: new ListMcpServersUseCase(mcpServerAdapter.repo),
    deleteMcpServer: new DeleteMcpServerUseCase(mcpServerAdapter.repo),
    replaceMcpServers: new ReplaceMcpServersUseCase(mcpServerAdapter.repo),
    testMcpServer: new TestMcpServerUseCase(mcpServerAdapter.repo, mcpClient),
    // 保存先が :memory:（AGENTCONTEXT_DB_PATH 未指定）なら再起動で設定が消えることをUIへ伝える。
    getModelSettings: new GetModelSettingsUseCase(modelSettingsAdapter.repo, profile === 'local' && (path ?? ':memory:') !== ':memory:' ? 'persistent' : 'ephemeral'),
    saveModelSettings: new SaveModelSettingsUseCase(modelSettingsAdapter.repo, secretCipher),
    testModelSettings: new TestModelSettingsUseCase(modelSettingsAdapter.repo, secretCipher, modelProviderFactory, envSlotDefault),
    queryModelCatalog: new QueryModelCatalogUseCase(modelCatalog, modelSettingsAdapter.repo, secretCipher),
    saveSkill,
    querySkills: new QuerySkillsUseCase(skillAdapter.repo),
    deleteSkill: new DeleteSkillUseCase(skillAdapter.repo),
    generateSkillPrompt: new GenerateSkillPromptUseCase(repo),
    savePersona,
    queryPersonas: new QueryPersonasUseCase(personaAdapter.repo),
    deletePersona: new DeletePersonaUseCase(personaAdapter.repo),
    registerPseudoUserAgent,
    saveScenario,
    queryScenarios: new QueryScenariosUseCase(scenarioAdapter.repo),
    deleteScenario: new DeleteScenarioUseCase(scenarioAdapter.repo),
    runScenario,
    queryScenarioRuns: new QueryScenarioRunsUseCase(scenarioRunAdapter.repo),
    // 評価は決定的（Mastra code系スコアラー・オフライン）でスコープ非依存のため profile 非依存に配線する。
    evaluateAgentRun: new EvaluateAgentRunUseCase(evaluator),
    saveEvaluationDataset: new SaveEvaluationDatasetUseCase(evaluationDatasetAdapter.repo, scenarioAdapter.repo),
    queryEvaluationDatasets: new QueryEvaluationDatasetsUseCase(evaluationDatasetAdapter.repo),
    deleteEvaluationDataset: new DeleteEvaluationDatasetUseCase(evaluationDatasetAdapter.repo),
    importEvaluationCases: new ImportEvaluationCasesUseCase(),
    exportEvaluationDataset: new ExportEvaluationDatasetUseCase(),
    saveEvaluatorProfile: new SaveEvaluatorProfileUseCase(evaluatorProfileAdapter.repo, judgeRubricAdapter.repo),
    queryEvaluatorProfiles: new QueryEvaluatorProfilesUseCase(evaluatorProfileAdapter.repo),
    deleteEvaluatorProfile: new DeleteEvaluatorProfileUseCase(evaluatorProfileAdapter.repo),
    saveJudgeRubric: new SaveJudgeRubricUseCase(judgeRubricAdapter.repo),
    queryJudgeRubrics: new QueryJudgeRubricsUseCase(judgeRubricAdapter.repo),
    deleteJudgeRubric: new DeleteJudgeRubricUseCase(judgeRubricAdapter.repo),
    runExperiment,
    createExperiment: new CreateExperimentUseCase(experimentAdapter.repo, evaluationDatasetAdapter.repo, evaluatorProfileAdapter.repo, agentAdapter.repo, experimentWorker, () => resolveModelSnapshot?.() ?? snapshot),
    queryExperiments: new QueryExperimentsUseCase(experimentAdapter.repo),
    cancelExperiment: new CancelExperimentUseCase(experimentAdapter.repo, experimentWorker),
    resumeExperiment: new ResumeExperimentUseCase(experimentAdapter.repo, experimentWorker),
    compareExperiments: new CompareExperimentsUseCase(experimentAdapter.repo),
    saveGatePolicy: new SaveGatePolicyUseCase(qualityGateAdapter.repo),
    queryQualityGates: new QueryQualityGatesUseCase(qualityGateAdapter.repo),
    deleteGatePolicy: new DeleteGatePolicyUseCase(qualityGateAdapter.repo),
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
    deleteWikiPage: new DeleteWikiPageUseCase(wikiAdapter.repo),
    reflectRun: new ReflectRunUseCase(modelProvider, memoryProposalAdapter.repo, wikiAdapter.repo, skillAdapter.repo),
    listProposals: new ListProposalsUseCase(memoryProposalAdapter.repo),
    reviewProposal: new ReviewProposalUseCase(memoryProposalAdapter.repo, saveWikiPage, skillAdapter.repo, saveSkill, unitOfWork),
    saveWikiSpace: new SaveWikiSpaceUseCase(wikiAdapter.repo),
    queryWikiSpaces: new QueryWikiSpacesUseCase(wikiAdapter.repo),
    deleteWikiSpace: new DeleteWikiSpaceUseCase(wikiAdapter.repo),
    draftTool: new DraftToolUseCase(engine, resolveDataSources),
    suggestAnalysisConfig: new SuggestAnalysisConfigUseCase(engine, modelProvider, async () => {
      if (profile === 'test' || (process.env['ANALYSIS_ASSISTANT_ENABLED'] ?? 'true') === 'false') return false;
      // モデルはUIからも設定できるため、envだけで判定しない（保存済みのmainスロットがあればそれで足りる）。
      if ((process.env['LM_STUDIO_MODEL']?.trim() ?? '') !== '') return true;
      try { return (await modelSettingsAdapter.repo.find(modelSettingsScope))?.main !== undefined; }
      catch { return false; } // 設定が読めない/復号できない場合は「使えない」側へ倒す。
    }),
    saveTool,
    getTool: new GetToolUseCase(repo),
    listToolVersions: new ListToolVersionsUseCase(repo),
    listTools: new ListToolsUseCase(repo),
    deleteTool: new DeleteToolUseCase(repo),
    previewTool: new PreviewToolUseCase(repo, engine, resolveDataSources),
    // 2つのワーカーは互いに独立なので同時に待つ（直列にすると猶予が最大2倍かかる）。
    drainWorkers: async (graceMs: number) => {
      const drained = await Promise.all([experimentWorker.drainInFlight(graceMs), factoryWorker.drainInFlight(graceMs)]);
      return drained.every(Boolean);
    },
    // 接続は1本しかないので解放も1回だけ。前段が失敗しても後段は必ず走らせ、最初の失敗を投げ直す。
    close: () => {
      const steps: Array<() => void> = [
        () => experimentWorker.shutdown(),
        () => factoryWorker.shutdown(),
        // App.close は同期契約のため待てない。確実に待ちたいエントリポイントは
        // app.close() の前に await app.mcpClient.close() を呼ぶ（src/server.ts のshutdown参照）。
        () => { void mcpClient.close(); },
        // payload置き場の一時ディレクトリを片付ける（共有ハンドルは閉じない）。
        () => sessionArtifactAdapter.close(),
        () => database?.close(),
      ];
      let failure: unknown;
      for (const step of steps) {
        try { step(); } catch (error) { failure ??= error; }
      }
      if (failure !== undefined) throw failure;
    },
  };
}
