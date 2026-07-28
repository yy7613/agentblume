import type {
  PreviewResultDto,
  PropagationResultDto,
  SaveToolDto,
  SerializedToolDto,
  TenantScopeDto,
  ToolGraphDto,
  AgentPreviewRunDto,
  RunAgentDto,
  RunRecordDto,
  RunSummaryDto,
  ToolSummaryDto,
  SaveAgentDto,
  SerializedAgentDto,
  AgentPromptDraftDto,
  AgentKindDto,
  AgentToolRefDto,
  AgentSubAgentRefDto,
  EvaluationResultDto,
  AgentSummaryDto,
  RunSavedAgentDto,
  AgentSessionDto,
  SessionArtifactDto,
  StructuredOutputDto,
  SaveSkillDto,
  SerializedSkillDto,
  SkillSummaryDto,
  SkillPromptDraftDto,
  SavePersonaDto,
  SerializedPersonaDto,
  PersonaSummaryDto,
  SaveScenarioDto,
  SerializedScenarioDto,
  ScenarioSummaryDto,
  ScenarioRunDto,
  RunScenarioDto,
  WikiPageDto,
  WikiPageSummaryDto,
  SaveWikiDto,
  MemoryProposalDto,
  MemoryProposalStateDto,
  ReflectRunDto,
  SaveEvaluationDatasetDto,
  SerializedEvaluationDatasetDto,
  EvaluationDatasetSummaryDto,
  EvaluationCaseDto,
  SaveEvaluatorProfileDto,
  SerializedEvaluatorProfileDto,
  EvaluatorProfileSummaryDto,
  CreateExperimentDto,
  ExperimentDto,
  ExperimentCaseResultDto,
  ExperimentStatusDto,
  ExperimentComparisonDto,
  SaveGatePolicyDto,
  SerializedGatePolicyDto,
  GatePolicySummaryDto,
  GateReportDto,
  PromotionRequestDto,
  SaveJudgeRubricDto,
  SerializedJudgeRubricDto,
  JudgeRubricSummaryDto,
  WikiSpaceDto,
  WikiSpaceSummaryDto,
  SaveWikiSpaceDto,
  RunFeedbackDto,
  SubmitRunFeedbackDto,
  OperationsStatusDto,
  RetentionPolicyDto,
  RetentionApplyResultDto,
  BackupListDto,
  CreatedBackupDto,
  DataSourceDto,
  DatabaseConnectionDto,
  DatabaseConnectionStatusDto,
  SearchProviderDto,
  WebSearchFetchDto,
  AnalysisConfigProposalDto,
  SaveHarnessDto,
  SerializedAgentHarnessDto,
  HarnessSummaryDto,
  HarnessValidationDto,
  HarnessRunDto,
  CreateFactoryRunDto,
  FactoryRunDto,
  FactoryEventDto,
  ResolveFactoryRunDto,
  ResumeRunDto,
  McpServerDto,
  SaveMcpServerDto,
  ReplaceMcpServersDto,
  McpServerTestResultDto,
  ModelSettingsDto,
  ModelCatalogProviderDto,
  ModelCatalogProviderModelsDto,
  ModelSlotNameDto,
  ModelSlotSettingsInputDto,
  ModelSettingsTestResultDto,
  ListOpenAiCompatibleModelsDto,
  OpenAiCompatibleModelsResultDto,
  SaveModelSettingsDto,
} from './types';
import { localizeApiErrorMessage } from './error-messages';

/**
 * message はローカライズ済み（各画面が err.message をそのまま表示するため）。
 * 原文は serverMessage に保持する。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serverMessage: string,
    readonly runId?: string,
  ) {
    super(localizeApiErrorMessage({ status, code, serverMessage }));
    this.name = 'ApiError';
  }
}

type Fetcher = typeof fetch;

export class ToolApiClient {
  private readonly fetcher: Fetcher;

  constructor(
    private readonly baseUrl = '',
    fetcher: Fetcher = fetch,
  ) {
    // Window.fetch は ToolApiClient のメソッドとして呼ぶと Illegal invocation になる。
    // globalThis へ束縛し、実ブラウザと注入テストの両方で同じ呼び出し規約にする。
    this.fetcher = fetcher.bind(globalThis);
  }

  async health(): Promise<{ readonly status: string }> {
    return this.request<{ status: string }>('/health');
  }

  async inferDraft(graph: ToolGraphDto, signal?: AbortSignal, scope?: TenantScopeDto): Promise<PropagationResultDto> {
    const body = await this.request<{ propagation: PropagationResultDto }>(
      '/tool-drafts/infer-schema',
      { method: 'POST', body: JSON.stringify({ graph, ...(scope === undefined ? {} : { scope }) }), signal },
    );
    return body.propagation;
  }

  async previewDraft(graph: ToolGraphDto, rowLimit = 100, signal?: AbortSignal, scope?: TenantScopeDto): Promise<PreviewResultDto> {
    const body = await this.request<{ result: PreviewResultDto }>(
      '/tool-drafts/preview',
      { method: 'POST', body: JSON.stringify({ graph, rowLimit, ...(scope === undefined ? {} : { scope }) }), signal },
    );
    return body.result;
  }

  async analysisAssistantCapability(): Promise<boolean> {
    return (await this.request<{ analysisAssistant: { enabled: boolean } }>('/runtime/capabilities')).analysisAssistant.enabled;
  }

  async suggestAnalysisConfig(input: { readonly graph: ToolGraphDto; readonly nodeId: string; readonly intent: string; readonly scope?: TenantScopeDto }): Promise<AnalysisConfigProposalDto> {
    return (await this.request<{ proposal: AnalysisConfigProposalDto }>('/tool-drafts/suggest-analysis-config', { method: 'POST', body: JSON.stringify(input) })).proposal;
  }

  async saveTool(input: SaveToolDto): Promise<SerializedToolDto> {
    return (await this.request<{ tool: SerializedToolDto }>('/tools', {
      method: 'POST',
      body: JSON.stringify(input),
    })).tool;
  }

  async listVersions(internalId: string, scope: TenantScopeDto): Promise<readonly string[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ versions: string[] }>(`/tools/${encodeURIComponent(internalId)}/versions?${query}`)).versions;
  }

  async getTool(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedToolDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ tool: SerializedToolDto }>(`/tools/${encodeURIComponent(internalId)}?${query}`)).tool;
  }

  async deleteTool(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/tools/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async listTools(scope: TenantScopeDto): Promise<readonly ToolSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ tools: ToolSummaryDto[] }>(`/tools?${query}`)).tools;
  }

  async saveAgent(input: SaveAgentDto): Promise<SerializedAgentDto> {
    return (await this.request<{ agent: SerializedAgentDto }>('/agents', {
      method: 'POST', body: JSON.stringify(input),
    })).agent;
  }

  async listAgents(scope: TenantScopeDto, kind?: AgentKindDto): Promise<readonly AgentSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (kind !== undefined) query.set('kind', kind);
    return (await this.request<{ agents: AgentSummaryDto[] }>(`/agents?${query}`)).agents;
  }

  async getAgent(internalId: string, scope: TenantScopeDto, version?: string, signal?: AbortSignal): Promise<SerializedAgentDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ agent: SerializedAgentDto }>(`/agents/${encodeURIComponent(internalId)}?${query}`, { signal })).agent;
  }

  async generateAgentPrompt(input: { readonly scope: TenantScopeDto; readonly displayName: string; readonly kind: AgentKindDto; readonly skills?: readonly AgentToolRefDto[]; readonly tools: readonly AgentToolRefDto[]; readonly agents?: readonly AgentSubAgentRefDto[]; readonly output?: StructuredOutputDto }): Promise<AgentPromptDraftDto> {
    return (await this.request<{ draft: AgentPromptDraftDto }>('/agent-drafts/generate-prompt', {
      method: 'POST', body: JSON.stringify(input),
    })).draft;
  }

  async deleteAgent(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/agents/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async saveSkill(input: SaveSkillDto): Promise<SerializedSkillDto> {
    return (await this.request<{ skill: SerializedSkillDto }>('/skills', { method: 'POST', body: JSON.stringify(input) })).skill;
  }

  async listSkills(scope: TenantScopeDto): Promise<readonly SkillSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ skills: SkillSummaryDto[] }>(`/skills?${query}`)).skills;
  }

  async getSkill(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedSkillDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ skill: SerializedSkillDto }>(`/skills/${encodeURIComponent(internalId)}?${query}`)).skill;
  }

  async deleteSkill(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/skills/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async generateSkillPrompt(input: Omit<SaveSkillDto, 'internalId' | 'workingName' | 'publishName' | 'owner' | 'instructions' | 'bump'>): Promise<SkillPromptDraftDto> {
    return (await this.request<{ draft: SkillPromptDraftDto }>('/skill-drafts/generate-prompt', { method: 'POST', body: JSON.stringify(input) })).draft;
  }

  async runAgent(input: RunAgentDto, signal?: AbortSignal): Promise<AgentPreviewRunDto> {
    return (await this.request<{ run: AgentPreviewRunDto }>('/runs', {
      method: 'POST', body: JSON.stringify(input), signal,
    })).run;
  }

  async runSavedAgent(input: RunSavedAgentDto, signal?: AbortSignal): Promise<AgentPreviewRunDto> {
    return (await this.request<{ run: AgentPreviewRunDto }>('/runs', {
      method: 'POST', body: JSON.stringify(input), signal,
    })).run;
  }

  /**
   * ツール承認待ち（status==='waiting-approval'）で停止したRunを再開する。
   * 応答は POST /runs と同形で、承認後にさらに別のツールで止まれば再び waiting-approval が返る。
   */
  async resumeRun(runId: string, scope: TenantScopeDto, decision: 'approve' | 'reject', feedback?: string, signal?: AbortSignal): Promise<AgentPreviewRunDto> {
    const body: ResumeRunDto = { scope, decision, ...(feedback !== undefined ? { feedback } : {}) };
    return (await this.request<{ run: AgentPreviewRunDto }>(`/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', body: JSON.stringify(body), signal,
    })).run;
  }

  async saveHarness(input: SaveHarnessDto): Promise<SerializedAgentHarnessDto> {
    return (await this.request<{ harness: SerializedAgentHarnessDto }>('/harnesses', { method: 'POST', body: JSON.stringify(input) })).harness;
  }

  async listHarnesses(scope: TenantScopeDto): Promise<readonly HarnessSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ harnesses: HarnessSummaryDto[] }>(`/harnesses?${query}`)).harnesses;
  }

  async getHarness(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedAgentHarnessDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ harness: SerializedAgentHarnessDto }>(`/harnesses/${encodeURIComponent(internalId)}?${query}`)).harness;
  }

  async deleteHarness(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/harnesses/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async validateHarness(input: SaveHarnessDto): Promise<HarnessValidationDto> {
    return (await this.request<{ validation: HarnessValidationDto }>('/harness-drafts/validate', { method: 'POST', body: JSON.stringify(input) })).validation;
  }

  async runHarness(input: { readonly scope: TenantScopeDto; readonly harness: { readonly internalId: string; readonly version?: string }; readonly message: string; readonly mode: 'preview' | 'test' }, signal?: AbortSignal): Promise<HarnessRunDto> {
    return (await this.request<{ run: HarnessRunDto }>('/harness-runs', { method: 'POST', body: JSON.stringify(input), signal })).run;
  }

  async respondToHarnessRun(runId: string, input: { readonly scope: TenantScopeDto; readonly response: { readonly kind: 'input'; readonly message: string } | { readonly kind: 'approval'; readonly decision: 'approve' | 'revise' | 'reject'; readonly feedback?: string } }, signal?: AbortSignal): Promise<HarnessRunDto> {
    return (await this.request<{ run: HarnessRunDto }>(`/harness-runs/${encodeURIComponent(runId)}/responses`, { method: 'POST', body: JSON.stringify(input), signal })).run;
  }

  async cancelHarnessRun(runId: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<HarnessRunDto> {
    return (await this.request<{ run: HarnessRunDto }>(`/harness-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: JSON.stringify({ scope }), signal })).run;
  }

  // Agent Factory（v33）
  async createFactoryRun(input: CreateFactoryRunDto, signal?: AbortSignal): Promise<FactoryRunDto> {
    return (await this.request<{ run: FactoryRunDto }>('/factory-runs', { method: 'POST', body: JSON.stringify(input), signal })).run;
  }

  async listFactoryRuns(scope: TenantScopeDto, options?: { readonly limit?: number; readonly status?: FactoryRunDto['status'] }): Promise<readonly FactoryRunDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (options?.limit !== undefined) query.set('limit', String(options.limit));
    if (options?.status !== undefined) query.set('status', options.status);
    return (await this.request<{ runs: FactoryRunDto[] }>(`/factory-runs?${query}`)).runs;
  }

  async getFactoryRun(scope: TenantScopeDto, runId: string, signal?: AbortSignal): Promise<FactoryRunDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ run: FactoryRunDto }>(`/factory-runs/${encodeURIComponent(runId)}?${query}`, { signal })).run;
  }

  async getFactoryRunEvents(scope: TenantScopeDto, runId: string, signal?: AbortSignal): Promise<readonly FactoryEventDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ events: FactoryEventDto[] }>(`/factory-runs/${encodeURIComponent(runId)}/events?${query}`, { signal })).events;
  }

  async respondToFactoryRun(runId: string, input: ResolveFactoryRunDto, signal?: AbortSignal): Promise<FactoryRunDto> {
    return (await this.request<{ run: FactoryRunDto }>(`/factory-runs/${encodeURIComponent(runId)}/responses`, { method: 'POST', body: JSON.stringify(input), signal })).run;
  }

  async cancelFactoryRun(runId: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<FactoryRunDto> {
    return (await this.request<{ run: FactoryRunDto }>(`/factory-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: JSON.stringify({ scope }), signal })).run;
  }

  /** 失敗Runを同じ入力で再実行する。返るのは元Runではなく新しく起票されたRun。 */
  async retryFactoryRun(runId: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<FactoryRunDto> {
    return (await this.request<{ run: FactoryRunDto }>(`/factory-runs/${encodeURIComponent(runId)}/retry`, { method: 'POST', body: JSON.stringify({ scope }), signal })).run;
  }

  async listDataSources(scope: TenantScopeDto): Promise<readonly DataSourceDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ sources: DataSourceDto[] }>(`/data-sources?${query}`)).sources;
  }

  async uploadDataSourceFile(input: { readonly scope: TenantScopeDto; readonly name: string; readonly format: 'csv' | 'json'; readonly content: string }): Promise<DataSourceDto> {
    return (await this.request<{ source: DataSourceDto }>('/data-sources/files', { method: 'POST', body: JSON.stringify(input) })).source;
  }

  async registerDatabaseDataSource(input: { readonly scope: TenantScopeDto; readonly name: string; readonly connectionId: string; readonly defaultSchema?: string }): Promise<DataSourceDto> {
    return (await this.request<{ source: DataSourceDto }>('/data-sources/databases', { method: 'POST', body: JSON.stringify(input) })).source;
  }

  async listDatabaseConnections(): Promise<readonly DatabaseConnectionDto[]> {
    return (await this.request<{ connections: DatabaseConnectionDto[] }>('/data-sources/connections')).connections;
  }

  async listSearchProviders(): Promise<readonly SearchProviderDto[]> {
    return (await this.request<{ providers: SearchProviderDto[] }>('/search-providers')).providers;
  }

  async fetchWebSearch(input: { readonly scope: TenantScopeDto; readonly provider: SearchProviderDto['id']; readonly query: string; readonly maxResults?: number; readonly includeDomains?: readonly string[] }): Promise<WebSearchFetchDto> {
    return (await this.request<{ search: WebSearchFetchDto }>('/web-searches', { method: 'POST', body: JSON.stringify(input) })).search;
  }

  async testDatabaseConnection(connectionId: string, scope: TenantScopeDto): Promise<DatabaseConnectionStatusDto> {
    return (await this.request<{ connection: DatabaseConnectionStatusDto }>(`/data-sources/connections/${encodeURIComponent(connectionId)}/test`, { method: 'POST', body: JSON.stringify({ scope }) })).connection;
  }

  async deleteDataSource(id: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/data-sources/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
  }

  async createAgentSession(input: { readonly scope: TenantScopeDto; readonly agent: { readonly internalId: string; readonly version?: string } }): Promise<AgentSessionDto> {
    return (await this.request<{ session: AgentSessionDto }>('/agent-sessions', { method: 'POST', body: JSON.stringify(input) })).session;
  }

  async closeAgentSession(sessionId: string, scope: TenantScopeDto): Promise<AgentSessionDto> {
    return (await this.request<{ session: AgentSessionDto }>(`/agent-sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: JSON.stringify({ scope }) })).session;
  }

  async listSessionArtifacts(sessionId: string, scope: TenantScopeDto): Promise<readonly SessionArtifactDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ artifacts: SessionArtifactDto[] }>(`/agent-sessions/${encodeURIComponent(sessionId)}/artifacts?${query}`)).artifacts;
  }

  async getSessionArtifact(sessionId: string, artifactId: string, scope: TenantScopeDto, limit = 100, offset = 0, section?: 'nodes' | 'edges'): Promise<{ readonly artifact: SessionArtifactDto; readonly payload: unknown }> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    query.set('limit', String(limit));
    query.set('offset', String(offset));
    if (section !== undefined) query.set('section', section);
    return this.request<{ artifact: SessionArtifactDto; payload: unknown }>(`/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}?${query}`);
  }

  async deleteSessionArtifact(sessionId: string, artifactId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request<unknown>(`/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}?${query}`, { method: 'DELETE' });
  }

  async listRuns(scope: TenantScopeDto, options?: { readonly limit?: number; readonly status?: 'running' | 'succeeded' | 'failed' }): Promise<readonly RunSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (options?.limit !== undefined) query.set('limit', String(options.limit));
    if (options?.status !== undefined) query.set('status', options.status);
    return (await this.request<{ runs: RunSummaryDto[] }>(`/runs?${query}`)).runs;
  }

  async listAgentVersions(internalId: string, scope: TenantScopeDto): Promise<readonly string[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ versions: string[] }>(`/agents/${encodeURIComponent(internalId)}/versions?${query}`)).versions;
  }

  async savePersona(input: SavePersonaDto): Promise<SerializedPersonaDto> {
    return (await this.request<{ persona: SerializedPersonaDto }>('/personas', {
      method: 'POST', body: JSON.stringify(input),
    })).persona;
  }

  async listPersonas(scope: TenantScopeDto): Promise<readonly PersonaSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ personas: PersonaSummaryDto[] }>(`/personas?${query}`)).personas;
  }

  async getPersona(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedPersonaDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ persona: SerializedPersonaDto }>(`/personas/${encodeURIComponent(internalId)}?${query}`)).persona;
  }

  async registerPseudoUserAgent(internalId: string, input: { readonly scope: TenantScopeDto; readonly personaVersion?: string; readonly agentInternalId?: string; readonly bump?: 'major' | 'minor' | 'patch'; readonly promptOverride?: string }): Promise<SerializedAgentDto> {
    return (await this.request<{ agent: SerializedAgentDto }>(`/personas/${encodeURIComponent(internalId)}/register-agent`, {
      method: 'POST', body: JSON.stringify(input),
    })).agent;
  }

  async deletePersona(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/personas/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async evaluate(input: { readonly scope: TenantScopeDto; readonly input: string; readonly output: string; readonly reference?: string }, signal?: AbortSignal): Promise<EvaluationResultDto> {
    return (await this.request<{ evaluation: EvaluationResultDto }>('/evaluations', {
      method: 'POST', body: JSON.stringify(input), signal,
    })).evaluation;
  }

  async saveScenario(input: SaveScenarioDto): Promise<SerializedScenarioDto> {
    return (await this.request<{ scenario: SerializedScenarioDto }>('/scenarios', {
      method: 'POST', body: JSON.stringify(input),
    })).scenario;
  }

  async listScenarios(scope: TenantScopeDto): Promise<readonly ScenarioSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ scenarios: ScenarioSummaryDto[] }>(`/scenarios?${query}`)).scenarios;
  }

  async getScenario(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedScenarioDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ scenario: SerializedScenarioDto }>(`/scenarios/${encodeURIComponent(internalId)}?${query}`)).scenario;
  }

  async runScenario(internalId: string, input: RunScenarioDto, signal?: AbortSignal): Promise<ScenarioRunDto> {
    return (await this.request<{ run: ScenarioRunDto }>(`/scenarios/${encodeURIComponent(internalId)}/run`, {
      method: 'POST', body: JSON.stringify(input), signal,
    })).run;
  }

  async deleteScenario(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/scenarios/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async listScenarioRuns(scope: TenantScopeDto, scenarioId?: string): Promise<readonly ScenarioRunDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (scenarioId !== undefined) query.set('scenarioId', scenarioId);
    return (await this.request<{ runs: ScenarioRunDto[] }>(`/scenario-runs?${query}`)).runs;
  }

  async getScenarioRun(id: string, scope: TenantScopeDto): Promise<ScenarioRunDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ run: ScenarioRunDto }>(`/scenario-runs/${encodeURIComponent(id)}?${query}`)).run;
  }

  async saveEvaluationDataset(input: SaveEvaluationDatasetDto): Promise<SerializedEvaluationDatasetDto> {
    return (await this.request<{ dataset: SerializedEvaluationDatasetDto }>('/evaluation-datasets', { method: 'POST', body: JSON.stringify(input) })).dataset;
  }

  async listEvaluationDatasets(scope: TenantScopeDto): Promise<readonly EvaluationDatasetSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ datasets: EvaluationDatasetSummaryDto[] }>(`/evaluation-datasets?${query}`)).datasets;
  }

  async getEvaluationDataset(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedEvaluationDatasetDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ dataset: SerializedEvaluationDatasetDto }>(`/evaluation-datasets/${encodeURIComponent(internalId)}?${query}`)).dataset;
  }

  async listEvaluationDatasetVersions(internalId: string, scope: TenantScopeDto): Promise<readonly string[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ versions: string[] }>(`/evaluation-datasets/${encodeURIComponent(internalId)}/versions?${query}`)).versions;
  }

  async importEvaluationCases(scope: TenantScopeDto, format: 'json' | 'csv', content: string): Promise<readonly EvaluationCaseDto[]> {
    return (await this.request<{ cases: EvaluationCaseDto[] }>('/evaluation-datasets/import', { method: 'POST', body: JSON.stringify({ scope, format, content }) })).cases;
  }

  async exportEvaluationDataset(internalId: string, scope: TenantScopeDto, format: 'json' | 'csv', version?: string): Promise<string> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, format });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ format: string; content: string }>(`/evaluation-datasets/${encodeURIComponent(internalId)}/export?${query}`)).content;
  }

  async deleteEvaluationDataset(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/evaluation-datasets/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async saveEvaluatorProfile(input: SaveEvaluatorProfileDto): Promise<SerializedEvaluatorProfileDto> {
    return (await this.request<{ profile: SerializedEvaluatorProfileDto }>('/evaluator-profiles', { method: 'POST', body: JSON.stringify(input) })).profile;
  }

  async listEvaluatorProfiles(scope: TenantScopeDto): Promise<readonly EvaluatorProfileSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ profiles: EvaluatorProfileSummaryDto[] }>(`/evaluator-profiles?${query}`)).profiles;
  }

  async getEvaluatorProfile(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedEvaluatorProfileDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ profile: SerializedEvaluatorProfileDto }>(`/evaluator-profiles/${encodeURIComponent(internalId)}?${query}`)).profile;
  }

  async listEvaluatorProfileVersions(internalId: string, scope: TenantScopeDto): Promise<readonly string[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ versions: string[] }>(`/evaluator-profiles/${encodeURIComponent(internalId)}/versions?${query}`)).versions;
  }

  async deleteEvaluatorProfile(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/evaluator-profiles/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async saveJudgeRubric(input: SaveJudgeRubricDto): Promise<SerializedJudgeRubricDto> {
    return (await this.request<{ rubric: SerializedJudgeRubricDto }>('/judge-rubrics', { method: 'POST', body: JSON.stringify(input) })).rubric;
  }

  async listJudgeRubrics(scope: TenantScopeDto): Promise<readonly JudgeRubricSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); return (await this.request<{ rubrics: JudgeRubricSummaryDto[] }>(`/judge-rubrics?${query}`)).rubrics;
  }

  async getJudgeRubric(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedJudgeRubricDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); if (version !== undefined) query.set('version', version); return (await this.request<{ rubric: SerializedJudgeRubricDto }>(`/judge-rubrics/${encodeURIComponent(internalId)}?${query}`)).rubric;
  }

  async listJudgeRubricVersions(internalId: string, scope: TenantScopeDto): Promise<readonly string[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); return (await this.request<{ versions: string[] }>(`/judge-rubrics/${encodeURIComponent(internalId)}/versions?${query}`)).versions;
  }

  async deleteJudgeRubric(internalId: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/judge-rubrics/${encodeURIComponent(internalId)}?${query}`, { method: 'DELETE' });
  }

  async createExperiment(input: CreateExperimentDto): Promise<ExperimentDto> {
    return (await this.request<{ experiment: ExperimentDto }>('/experiments', { method: 'POST', body: JSON.stringify(input) })).experiment;
  }

  async listExperiments(scope: TenantScopeDto, status?: ExperimentStatusDto): Promise<readonly ExperimentDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (status !== undefined) query.set('status', status);
    return (await this.request<{ experiments: ExperimentDto[] }>(`/experiments?${query}`)).experiments;
  }

  async getExperiment(id: string, scope: TenantScopeDto): Promise<ExperimentDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ experiment: ExperimentDto }>(`/experiments/${encodeURIComponent(id)}?${query}`)).experiment;
  }

  async listExperimentResults(id: string, scope: TenantScopeDto): Promise<readonly ExperimentCaseResultDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ results: ExperimentCaseResultDto[] }>(`/experiments/${encodeURIComponent(id)}/results?${query}`)).results;
  }

  async cancelExperiment(id: string, scope: TenantScopeDto): Promise<ExperimentDto> {
    return (await this.request<{ experiment: ExperimentDto }>(`/experiments/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ scope }) })).experiment;
  }

  async resumeExperiment(id: string, scope: TenantScopeDto): Promise<ExperimentDto> {
    return (await this.request<{ experiment: ExperimentDto }>(`/experiments/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ scope }) })).experiment;
  }

  async compareExperiments(scope: TenantScopeDto, baselineExperimentId: string, candidateExperimentId: string): Promise<ExperimentComparisonDto> {
    return (await this.request<{ comparison: ExperimentComparisonDto }>('/experiment-comparisons', { method: 'POST', body: JSON.stringify({ scope, baselineExperimentId, candidateExperimentId }) })).comparison;
  }

  async saveGatePolicy(input: SaveGatePolicyDto): Promise<SerializedGatePolicyDto> {
    return (await this.request<{ policy: SerializedGatePolicyDto }>('/gate-policies', { method: 'POST', body: JSON.stringify(input) })).policy;
  }

  async listGatePolicies(scope: TenantScopeDto): Promise<readonly GatePolicySummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); return (await this.request<{ policies: GatePolicySummaryDto[] }>(`/gate-policies?${query}`)).policies;
  }

  async getGatePolicy(id: string, scope: TenantScopeDto, version?: string): Promise<SerializedGatePolicyDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); if (version !== undefined) query.set('version', version); return (await this.request<{ policy: SerializedGatePolicyDto }>(`/gate-policies/${encodeURIComponent(id)}?${query}`)).policy;
  }

  async deleteGatePolicy(id: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/gate-policies/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
  }

  async evaluateGate(scope: TenantScopeDto, policy: { readonly id: string; readonly version: string }, candidateExperimentId: string, baselineExperimentId?: string): Promise<GateReportDto> {
    return (await this.request<{ report: GateReportDto }>('/gate-reports', { method: 'POST', body: JSON.stringify({ scope, policy, candidateExperimentId, ...(baselineExperimentId !== undefined ? { baselineExperimentId } : {}) }) })).report;
  }

  async listGateReports(scope: TenantScopeDto, candidateExperimentId?: string): Promise<readonly GateReportDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); if (candidateExperimentId !== undefined) query.set('candidateExperimentId', candidateExperimentId); return (await this.request<{ reports: GateReportDto[] }>(`/gate-reports?${query}`)).reports;
  }

  async requestPromotion(agentId: string, version: string, scope: TenantScopeDto, gateReportId: string, requestedBy: string): Promise<PromotionRequestDto> {
    return (await this.request<{ promotion: PromotionRequestDto }>(`/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version)}/promotion-requests`, { method: 'POST', body: JSON.stringify({ scope, gateReportId, requestedBy }) })).promotion;
  }

  async listPromotionRequests(scope: TenantScopeDto, agentId?: string): Promise<readonly PromotionRequestDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); if (agentId !== undefined) query.set('agentId', agentId); return (await this.request<{ promotions: PromotionRequestDto[] }>(`/promotion-requests?${query}`)).promotions;
  }

  async decidePromotion(id: string, decision: 'approve' | 'reject', scope: TenantScopeDto, decidedBy: string, reason?: string): Promise<PromotionRequestDto> {
    return (await this.request<{ promotion: PromotionRequestDto }>(`/promotion-requests/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: JSON.stringify({ scope, decidedBy, ...(reason !== undefined ? { reason } : {}) }) })).promotion;
  }

  async getRunTrace(runId: string, scope: TenantScopeDto): Promise<RunRecordDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ run: RunRecordDto }>(`/runs/${encodeURIComponent(runId)}/trace?${query}`)).run;
  }

  async getRunFeedback(runId: string, scope: TenantScopeDto): Promise<RunFeedbackDto | null> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ feedback: RunFeedbackDto | null }>(`/runs/${encodeURIComponent(runId)}/feedback?${query}`)).feedback;
  }

  async submitRunFeedback(runId: string, input: SubmitRunFeedbackDto): Promise<RunFeedbackDto> {
    return (await this.request<{ feedback: RunFeedbackDto }>(`/runs/${encodeURIComponent(runId)}/feedback`, { method: 'PUT', body: JSON.stringify(input) })).feedback;
  }

  async getOperationsStatus(scope: TenantScopeDto, days = 30): Promise<OperationsStatusDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, days: String(days) });
    return (await this.request<{ status: OperationsStatusDto }>(`/operations/status?${query}`)).status;
  }

  async getRetentionPolicy(scope: TenantScopeDto): Promise<RetentionPolicyDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ policy: RetentionPolicyDto }>(`/operations/retention?${query}`)).policy;
  }

  async saveRetentionPolicy(input: Omit<RetentionPolicyDto, 'updatedAt'>): Promise<RetentionPolicyDto> {
    return (await this.request<{ policy: RetentionPolicyDto }>('/operations/retention', { method: 'PUT', body: JSON.stringify(input) })).policy;
  }

  async applyRetention(scope: TenantScopeDto): Promise<RetentionApplyResultDto> {
    return (await this.request<{ result: RetentionApplyResultDto }>('/operations/retention/apply', { method: 'POST', body: JSON.stringify({ scope }) })).result;
  }

  /**
   * バックアップを作る。**サーバー側のファイルシステムへ書く**ので、応答はダウンロードではなく保存先パス。
   * スコープを取らないのは、単位が保存先ファイル全体（＝全テナント）だから。
   */
  async createBackup(includeSecretKey = false): Promise<CreatedBackupDto> {
    return (await this.request<{ backup: CreatedBackupDto }>('/operations/backups', { method: 'POST', body: JSON.stringify({ includeSecretKey }) })).backup;
  }

  async listBackups(signal?: AbortSignal): Promise<BackupListDto> {
    return await this.request<BackupListDto>('/operations/backups', { signal });
  }

  // 長期記憶（v21）
  async listWiki(scope: TenantScopeDto, query?: string, signal?: AbortSignal): Promise<readonly WikiPageSummaryDto[]> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (query !== undefined && query.trim().length > 0) params.set('q', query);
    return (await this.request<{ pages: WikiPageSummaryDto[] }>(`/wiki?${params}`, { signal })).pages;
  }

  async getWiki(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<WikiPageDto> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ page: WikiPageDto }>(`/wiki/${encodeURIComponent(id)}?${params}`, { signal })).page;
  }

  async saveWiki(input: SaveWikiDto, signal?: AbortSignal): Promise<WikiPageDto> {
    return (await this.request<{ page: WikiPageDto }>('/wiki', { method: 'POST', body: JSON.stringify(input), signal })).page;
  }

  async deleteWiki(id: string, scope: TenantScopeDto): Promise<void> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/wiki/${encodeURIComponent(id)}?${params}`, { method: 'DELETE' });
  }

  async listWikis(scope: TenantScopeDto, signal?: AbortSignal): Promise<readonly WikiSpaceSummaryDto[]> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ wikis: WikiSpaceSummaryDto[] }>(`/wikis?${params}`, { signal })).wikis;
  }

  async getWikiSpace(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<WikiSpaceDto> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ wiki: WikiSpaceDto }>(`/wikis/${encodeURIComponent(id)}?${params}`, { signal })).wiki;
  }

  async saveWikiSpace(input: SaveWikiSpaceDto, signal?: AbortSignal): Promise<WikiSpaceDto> {
    return (await this.request<{ wiki: WikiSpaceDto }>('/wikis', { method: 'POST', body: JSON.stringify(input), signal })).wiki;
  }

  async deleteWikiSpace(id: string, scope: TenantScopeDto): Promise<void> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/wikis/${encodeURIComponent(id)}?${params}`, { method: 'DELETE' });
  }

  async listWikiPages(wikiId: string, scope: TenantScopeDto, query?: string, signal?: AbortSignal): Promise<readonly WikiPageSummaryDto[]> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (query !== undefined && query.trim() !== '') params.set('q', query);
    return (await this.request<{ pages: WikiPageSummaryDto[] }>(`/wikis/${encodeURIComponent(wikiId)}/pages?${params}`, { signal })).pages;
  }

  async getWikiPage(wikiId: string, id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<WikiPageDto> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ page: WikiPageDto }>(`/wikis/${encodeURIComponent(wikiId)}/pages/${encodeURIComponent(id)}?${params}`, { signal })).page;
  }

  async saveWikiPage(wikiId: string, input: SaveWikiDto, signal?: AbortSignal): Promise<WikiPageDto> {
    return (await this.request<{ page: WikiPageDto }>(`/wikis/${encodeURIComponent(wikiId)}/pages`, { method: 'POST', body: JSON.stringify(input), signal })).page;
  }

  async reflectRun(input: ReflectRunDto, signal?: AbortSignal): Promise<readonly MemoryProposalDto[]> {
    return (await this.request<{ proposals: MemoryProposalDto[] }>('/memory/reflect', { method: 'POST', body: JSON.stringify(input), signal })).proposals;
  }

  async listProposals(scope: TenantScopeDto, state?: MemoryProposalStateDto, signal?: AbortSignal): Promise<readonly MemoryProposalDto[]> {
    const params = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (state !== undefined) params.set('state', state);
    return (await this.request<{ proposals: MemoryProposalDto[] }>(`/memory/proposals?${params}`, { signal })).proposals;
  }

  async approveProposal(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<MemoryProposalDto> {
    return (await this.request<{ proposal: MemoryProposalDto }>(`/memory/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ scope }), signal })).proposal;
  }

  async rejectProposal(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<MemoryProposalDto> {
    return (await this.request<{ proposal: MemoryProposalDto }>(`/memory/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ scope }), signal })).proposal;
  }

  // MCPクライアント（外部MCPサーバー接続設定）。設定は版を持たないため POST は upsert、PUT は一括置換。
  async listMcpServers(scope: TenantScopeDto, signal?: AbortSignal): Promise<readonly McpServerDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ servers: McpServerDto[] }>(`/mcp-servers?${query}`, { signal })).servers;
  }

  async saveMcpServer(input: SaveMcpServerDto): Promise<McpServerDto> {
    return (await this.request<{ server: McpServerDto }>('/mcp-servers', { method: 'POST', body: JSON.stringify(input) })).server;
  }

  /** 標準 mcpServers ドキュメントでスコープ内の設定を全置換する（JSONタブのApply）。 */
  async replaceMcpServers(input: ReplaceMcpServersDto): Promise<readonly McpServerDto[]> {
    return (await this.request<{ servers: McpServerDto[] }>('/mcp-servers', { method: 'PUT', body: JSON.stringify(input) })).servers;
  }

  async deleteMcpServer(name: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request(`/mcp-servers/${encodeURIComponent(name)}?${query}`, { method: 'DELETE' });
  }

  /** 接続テスト。設定ミスと通信障害を区別するため、接続失敗も200 + ok:false で返る。 */
  async testMcpServer(name: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<McpServerTestResultDto> {
    return this.request<McpServerTestResultDto>(`/mcp-servers/${encodeURIComponent(name)}/test`, { method: 'POST', body: JSON.stringify({ scope }), signal });
  }

  /**
   * モデル設定（main / judge）。応答の apiKey は常にマスク済み（`{ configured, hint? }`）で、
   * 平文も封緘済みデータも降りてこない。スロットが省略されていれば env 既定を使用中という意味。
   */
  async getModelSettings(scope: TenantScopeDto, signal?: AbortSignal): Promise<ModelSettingsDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ settings: ModelSettingsDto }>(`/model-settings?${query}`, { signal })).settings;
  }

  /**
   * モデル設定の保存（upsert）。スロットは undefined = 変更なし / null = 設定を消して env 既定へ戻す。
   * apiKey は **write-only の平文**（文字列=保存 / フィールド省略=既存維持 / 空文字=クリア）。
   */
  async saveModelSettings(input: SaveModelSettingsDto): Promise<ModelSettingsDto> {
    return (await this.request<{ settings: ModelSettingsDto }>('/model-settings', { method: 'PUT', body: JSON.stringify(input) })).settings;
  }

  /** 疎通テスト。設定ミスと通信障害を区別するため、失敗も200 + ok:false で返る。 */
  async testModelSettings(scope: TenantScopeDto, slot: ModelSlotNameDto, candidate?: ModelSlotSettingsInputDto, signal?: AbortSignal): Promise<ModelSettingsTestResultDto> {
    return this.request<ModelSettingsTestResultDto>('/model-settings/test', {
      method: 'POST',
      body: JSON.stringify({ scope, slot, ...(candidate === undefined ? {} : { candidate }) }),
      signal,
    });
  }

  /**
   * 登録簿の見出し（オフラインの静的データ）。**モデル一覧は含まない**（`modelCount` のみ）。
   * 選んだプロバイダのモデルは getProviderModels で個別に取る2段構成。
   */
  async getModelCatalog(signal?: AbortSignal): Promise<readonly ModelCatalogProviderDto[]> {
    return (await this.request<{ providers: ModelCatalogProviderDto[] }>('/model-catalog', { signal })).providers;
  }

  /** 1プロバイダぶんのチャットモデル全件（provider 接頭辞なし。設定値は `${providerId}/${model}`）。 */
  async getProviderModels(providerId: string, signal?: AbortSignal): Promise<readonly string[]> {
    return (await this.request<ModelCatalogProviderModelsDto>(`/model-catalog/${encodeURIComponent(providerId)}/models`, { signal })).models;
  }

  /**
   * OpenAI互換エンドポイントの `/models`。
   * **GET ではなく POST**（保存済みキーを使い得る操作を単純リクエストにしない = CSRF緩和）。
   * apiKey は送らず slot 指定で保存済みキーを使うが、宛先が保存済み設定と違えば
   * サーバーはキーを使わず `usedStoredKey: false` を返す。
   */
  async listOpenAiCompatibleModels(scope: TenantScopeDto, baseUrl: string, slot?: ModelSlotNameDto, signal?: AbortSignal): Promise<OpenAiCompatibleModelsResultDto> {
    const body: ListOpenAiCompatibleModelsDto = { scope, baseUrl, ...(slot === undefined ? {} : { slot }) };
    return this.request<OpenAiCompatibleModelsResultDto>('/model-catalog/openai-compatible-models', { method: 'POST', body: JSON.stringify(body), signal });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // body 無し（DELETE 等）に content-type を付けると Fastify が空JSON本文として 400/500 にする。
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.body === undefined || init.body === null ? {} : { 'content-type': 'application/json' }), ...init.headers },
    });
    let body: unknown = {};
    if (response.status !== 204) {
      const text = await response.text();
      if (text !== '') {
        try { body = JSON.parse(text) as unknown; }
        catch {
          throw new ApiError(
            response.status,
            response.ok ? 'INVALID_API_RESPONSE' : 'HTTP_ERROR',
            response.ok ? 'API returned a non-JSON response. Check that the API server is running and the development proxy is configured.' : response.statusText,
          );
        }
      }
    }
    if (!response.ok) {
      const error = body as { error?: { code?: string; message?: string; runId?: string } };
      throw new ApiError(
        response.status,
        error.error?.code ?? 'HTTP_ERROR',
        error.error?.message ?? response.statusText,
        error.error?.runId,
      );
    }
    return body as T;
  }
}
