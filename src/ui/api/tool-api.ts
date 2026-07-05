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
  AgentSummaryDto,
  RunSavedAgentDto,
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
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly runId?: string,
  ) {
    super(message);
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

  async inferDraft(graph: ToolGraphDto, signal?: AbortSignal): Promise<PropagationResultDto> {
    const body = await this.request<{ propagation: PropagationResultDto }>(
      '/tool-drafts/infer-schema',
      { method: 'POST', body: JSON.stringify({ graph }), signal },
    );
    return body.propagation;
  }

  async previewDraft(graph: ToolGraphDto, rowLimit = 100, signal?: AbortSignal): Promise<PreviewResultDto> {
    const body = await this.request<{ result: PreviewResultDto }>(
      '/tool-drafts/preview',
      { method: 'POST', body: JSON.stringify({ graph, rowLimit }), signal },
    );
    return body.result;
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

  async listTools(scope: TenantScopeDto): Promise<readonly ToolSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ tools: ToolSummaryDto[] }>(`/tools?${query}`)).tools;
  }

  async saveAgent(input: SaveAgentDto): Promise<SerializedAgentDto> {
    return (await this.request<{ agent: SerializedAgentDto }>('/agents', {
      method: 'POST', body: JSON.stringify(input),
    })).agent;
  }

  async listAgents(scope: TenantScopeDto): Promise<readonly AgentSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ agents: AgentSummaryDto[] }>(`/agents?${query}`)).agents;
  }

  async generateAgentPrompt(input: { readonly scope: TenantScopeDto; readonly displayName: string; readonly kind: AgentKindDto; readonly skills?: readonly AgentToolRefDto[]; readonly tools: readonly AgentToolRefDto[]; readonly output?: StructuredOutputDto }): Promise<AgentPromptDraftDto> {
    return (await this.request<{ draft: AgentPromptDraftDto }>('/agent-drafts/generate-prompt', {
      method: 'POST', body: JSON.stringify(input),
    })).draft;
  }

  async saveSkill(input: SaveSkillDto): Promise<SerializedSkillDto> {
    return (await this.request<{ skill: SerializedSkillDto }>('/skills', { method: 'POST', body: JSON.stringify(input) })).skill;
  }

  async listSkills(scope: TenantScopeDto): Promise<readonly SkillSummaryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ skills: SkillSummaryDto[] }>(`/skills?${query}`)).skills;
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

  async listScenarioRuns(scope: TenantScopeDto, scenarioId?: string): Promise<readonly ScenarioRunDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (scenarioId !== undefined) query.set('scenarioId', scenarioId);
    return (await this.request<{ runs: ScenarioRunDto[] }>(`/scenario-runs?${query}`)).runs;
  }

  async getScenarioRun(id: string, scope: TenantScopeDto): Promise<ScenarioRunDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ run: ScenarioRunDto }>(`/scenario-runs/${encodeURIComponent(id)}?${query}`)).run;
  }

  async getRunTrace(runId: string, scope: TenantScopeDto): Promise<RunRecordDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ run: RunRecordDto }>(`/runs/${encodeURIComponent(runId)}/trace?${query}`)).run;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const body = (await response.json()) as unknown;
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
