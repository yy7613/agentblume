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
  AgentDiagnosticsDto,
  ToolDiagnosticsDto,
  RunFailureToolRefDto,
  RunToolCheckDto,
  ToolCheckRunResultDto,
  ToolCheckCaseDto,
  SaveToolCheckCaseDto,
  ToolCheckCaseRunDto,
  SuggestToolCheckCasesDto,
  ToolCheckSuggestionsDto,
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
  AuditEntryDto,
  AuditLogQueryDto,
  BackupListDto,
  CreatedBackupDto,
  DataSourceDto,
  DatabaseConnectionDto,
  DatabaseConnectionStatusDto,
  SearchProviderDto,
  WebSearchFetchDto,
  AnalysisConfigProposalDto,
  CalculateExpressionProposalDto,
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
  ModelSlotNameDto,
  ModelSlotSettingsInputDto,
  ModelSettingsTestResultDto,
  ListOpenAiCompatibleModelsDto,
  OpenAiCompatibleModelsResultDto,
  SaveModelSettingsDto,
  SampleDataSummaryDto,
  AuthSessionDto,
  RuntimeCapabilitiesDto,
  JournalCapabilitiesDto,
  JournalChartOfAccountsDto,
  SaveJournalChartOfAccountsDto,
  JournalRuleDto,
  SaveJournalRuleDto,
  JournalRuleTestResultDto,
  JournalDocumentDto,
  JournalDocumentSummaryDto,
  SaveJournalDocumentDto,
  ImportJournalCsvDto,
  ImportJournalCsvResultDto,
  JournalCsvPresetDto,
  JudgeJournalDocumentsResultDto,
  ExtractJournalDocumentDto,
  ExtractJournalDocumentResultDto,
  JournalHearingDto,
  AnswerJournalHearingDto,
  AcceptJournalHearingDto,
  AcceptJournalHearingResultDto,
  JournalEntryDto,
  SaveJournalEntryDto,
  JournalExportResultDto,
  ToolTemplateCatalogDto,
  TemplateSlotCandidatesResultDto,
  TemplateSlotValuesDto,
  InstantiatedTemplateDto,
} from './types';
import { scopeQuery } from './business-api';
import { localizeApiErrorMessage } from './error-messages';

/**
 * message はローカライズ済み（各画面が err.message をそのまま表示するため）。
 * 原文は serverMessage に保持する。
 */
export class ApiError extends Error {
  // declare にして、無いときはキー自体を作らない（クラスフィールドの define 意味論だと undefined 値の
  // キーが生え、'nodeId' in error や toEqual の比較で「ある」と誤認される）。
  /** 失敗がツール実行由来のとき、サーバーが特定したツール（publishName は公開 function 名）。 */
  declare readonly tool?: RunFailureToolRefDto;
  /** 失敗がツール内の特定ノード由来のとき、そのノードID。 */
  declare readonly nodeId?: string;
  /** JUDGE_TRACE_UNAVAILABLE など、審査ルーブリックが原因の失敗が指すルーブリック（version は "1.0.0" 形式）。 */
  declare readonly rubric?: { readonly id: string; readonly version: string };
  /** JOURNAL_CSV_IMPORT が特定した失敗行（1 始まり）。取込画面がその行を示す。 */
  declare readonly row?: number;
  /**
   * サーバーが error 本文へ足した、上のどれにも当たらない項目（業務が「直す場所」を示すために載せる。ADR-0039）。
   * 該当が無ければキー自体を作らない。
   */
  declare readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    readonly status: number,
    readonly code: string,
    readonly serverMessage: string,
    readonly runId?: string,
    context?: { readonly tool?: RunFailureToolRefDto; readonly nodeId?: string; readonly rubric?: { readonly id: string; readonly version: string }; readonly row?: number; readonly details?: Readonly<Record<string, unknown>> },
  ) {
    super(localizeApiErrorMessage({ status, code, serverMessage, ...(context?.rubric === undefined ? {} : { rubric: context.rubric }), ...(context?.row === undefined ? {} : { row: context.row }), ...(context?.details === undefined ? {} : { details: context.details }) }));
    this.name = 'ApiError';
    if (context?.tool !== undefined) this.tool = context.tool;
    if (context?.nodeId !== undefined) this.nodeId = context.nodeId;
    if (context?.rubric !== undefined) this.rubric = context.rubric;
    if (context?.row !== undefined) this.row = context.row;
    if (context?.details !== undefined) this.details = context.details;
  }
}

/**
 * `AbortController.abort()` で fetch が投げた中断かどうか。
 *
 * これは失敗ではなく利用者の操作なので、画面は「エラー」ではなく「中断しました」として扱う。
 * 環境によって `DOMException`（ブラウザ / Node18+）だったり素の `Error` だったりするため、
 * instanceof ではなく name で判定する。
 */
export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

type Fetcher = typeof fetch;

export class ToolApiClient {
  private readonly fetcher: Fetcher;

  /**
   * 認証トークンの供給元。**値ではなく関数**で持つ。
   * 設定画面でトークンを入れ替えた直後の呼び出しにも、クライアントを作り直さずに追従させるため。
   */
  private authToken: () => string | undefined = () => undefined;

  constructor(
    private readonly baseUrl = '',
    fetcher: Fetcher = fetch,
  ) {
    // Window.fetch は ToolApiClient のメソッドとして呼ぶと Illegal invocation になる。
    // globalThis へ束縛し、実ブラウザと注入テストの両方で同じ呼び出し規約にする。
    this.fetcher = fetcher.bind(globalThis);
  }

  /** 以降の全リクエストへ `Authorization: Bearer <token>` を付ける。 */
  setAuthTokenProvider(provider: () => string | undefined): void {
    this.authToken = provider;
  }

  async health(): Promise<{ readonly status: string }> {
    return this.request<{ status: string }>('/health');
  }

  /**
   * 認証済みの主体と認証方式。**401 が返ること自体が「トークンが要る構成だ」という合図**になる。
   * UIはこれで単一ユーザーモードかを判定し、自分のテナントを知る。
   */
  async getSession(signal?: AbortSignal): Promise<AuthSessionDto> {
    return (await this.request<{ session: AuthSessionDto }>('/auth/session', { signal })).session;
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

  /**
   * 実行環境の機能一覧（分析アシスタント・ケース提案・判定モデルの準備状況）。
   * `judge` は新しいサーバーだけが返す（旧サーバーでは undefined）ので、呼び出し側は「無い = 不明」として扱う。
   */
  async runtimeCapabilities(): Promise<RuntimeCapabilitiesDto> {
    return this.request<RuntimeCapabilitiesDto>('/runtime/capabilities');
  }

  async analysisAssistantCapability(): Promise<boolean> {
    return (await this.runtimeCapabilities()).analysisAssistant.enabled;
  }

  /** AI判定ノード（ai-judge）を実行できるか。項目を返さない旧サーバーでは「使えない」として扱う。 */
  async aiJudgeCapability(): Promise<boolean> {
    return (await this.runtimeCapabilities()).aiJudge?.enabled ?? false;
  }

  async suggestAnalysisConfig(input: { readonly graph: ToolGraphDto; readonly nodeId: string; readonly intent: string; readonly scope?: TenantScopeDto }): Promise<AnalysisConfigProposalDto> {
    return (await this.request<{ proposal: AnalysisConfigProposalDto }>('/tool-drafts/suggest-analysis-config', { method: 'POST', body: JSON.stringify(input) })).proposal;
  }

  /** 関数電卓ノード（calculate）の式提案を実行できるか。項目を返さない旧サーバーでは「使えない」として扱う（v41）。 */
  async calculateAssistantCapability(): Promise<boolean> {
    return (await this.runtimeCapabilities()).calculateAssistant?.enabled ?? false;
  }

  /** 上流の列と利用者の指示文から、検証済みの式を1本提案させる（v41）。適用はUIの明示操作。 */
  async suggestCalculateExpression(input: { readonly graph: ToolGraphDto; readonly nodeId: string; readonly intent: string; readonly scope?: TenantScopeDto }): Promise<CalculateExpressionProposalDto> {
    return (await this.request<{ proposal: CalculateExpressionProposalDto }>('/tool-drafts/suggest-calculate-expression', { method: 'POST', body: JSON.stringify(input) })).proposal;
  }

  /**
   * ツールテンプレートの一覧（v43）。読めなかったファイルも `invalid` として一緒に返る
   * （画面は一覧の下に理由と直し方を出す）。置き場所が無いサーバーでは空の一覧。
   */
  async listToolTemplates(scope: TenantScopeDto): Promise<ToolTemplateCatalogDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return this.request<ToolTemplateCatalogDto>(`/tool-templates?${query}`);
  }

  /**
   * スロットごとの候補。`values`（部分でよい）を渡すと、それに依存する候補
   * （どのソースの列か・結合キー・粒度）がその選択に合わせて絞られる。
   */
  async toolTemplateSlotCandidates(input: {
    readonly templateId: string;
    readonly scope: TenantScopeDto;
    readonly dataSourceIds: readonly string[];
    readonly values?: TemplateSlotValuesDto;
  }): Promise<TemplateSlotCandidatesResultDto> {
    const { templateId, ...body } = input;
    return this.request<TemplateSlotCandidatesResultDto>(`/tool-templates/${encodeURIComponent(templateId)}/slot-candidates`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** テンプレートを実体化する（保存はしない）。スロット違反は 422 + `slots` で返る。 */
  async instantiateToolTemplate(input: {
    readonly templateId: string;
    readonly scope: TenantScopeDto;
    readonly dataSourceIds: readonly string[];
    readonly values: TemplateSlotValuesDto;
    readonly language: 'ja' | 'en';
    /** モデルへ公開する function 名（v45 で必須。省略してテンプレート id へ落ちると 2 本目が 1 本目の別版になる）。 */
    readonly toolName: string;
  }): Promise<InstantiatedTemplateDto> {
    const { templateId, ...body } = input;
    return this.request<InstantiatedTemplateDto>(`/tool-templates/${encodeURIComponent(templateId)}/instantiate`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
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

  /** Tool呼び出しのプリフライト診断（実行なしで「どの段階で呼び出せないか」を検査する）。 */
  async diagnoseAgent(internalId: string, scope: TenantScopeDto, version?: string, signal?: AbortSignal): Promise<AgentDiagnosticsDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ diagnostics: AgentDiagnosticsDto }>(`/agents/${encodeURIComponent(internalId)}/diagnostics?${query}`, { signal })).diagnostics;
  }

  // --- ツール検証（Tool Check） ---------------------------------------------------------------
  /** 保存済みツールを引数付きで単体実行し、期待との合否を返す（ケースの保存はしない）。 */
  async runToolCheck(input: RunToolCheckDto, signal?: AbortSignal): Promise<ToolCheckRunResultDto> {
    return (await this.request<{ result: ToolCheckRunResultDto }>('/tool-checks/run', { method: 'POST', body: JSON.stringify(input), signal })).result;
  }
  async listToolCheckCases(scope: TenantScopeDto, toolId?: string): Promise<readonly ToolCheckCaseDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (toolId !== undefined) query.set('toolId', toolId);
    return (await this.request<{ cases: readonly ToolCheckCaseDto[] }>(`/tool-checks/cases?${query}`)).cases;
  }
  async saveToolCheckCase(input: SaveToolCheckCaseDto): Promise<ToolCheckCaseDto> {
    return (await this.request<{ case: ToolCheckCaseDto }>('/tool-checks/cases', { method: 'POST', body: JSON.stringify(input) })).case;
  }
  async deleteToolCheckCase(id: string, scope: TenantScopeDto): Promise<void> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    await this.request<void>(`/tool-checks/cases/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
  }
  /** 保存済みケースを1件実行し、ケースの lastResult を更新して返す。 */
  async runToolCheckCase(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<ToolCheckCaseRunDto> {
    return this.request<ToolCheckCaseRunDto>(`/tool-checks/cases/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ scope }), signal });
  }
  /** 設定済みモデルが構造化出力に対応していれば true（提案ボタンの表示判定。失敗時は false 扱いにする）。 */
  async toolCheckSuggestionCapability(): Promise<boolean> {
    return (await this.runtimeCapabilities()).toolCheckSuggestions?.enabled === true;
  }
  /** LLM に 正常 / 境界 / 異常 のケース案を作らせる（保存はしない）。 */
  async suggestToolCheckCases(input: SuggestToolCheckCasesDto, signal?: AbortSignal): Promise<ToolCheckSuggestionsDto> {
    return (await this.request<{ suggestions: ToolCheckSuggestionsDto }>('/tool-checks/suggest', { method: 'POST', body: JSON.stringify(input), signal })).suggestions;
  }
  /** 保存済みケースをまとめて実行（toolId 指定でそのツールのケースだけ）。 */
  async runAllToolCheckCases(scope: TenantScopeDto, toolId?: string, signal?: AbortSignal): Promise<readonly ToolCheckCaseRunDto[]> {
    return (await this.request<{ results: readonly ToolCheckCaseRunDto[] }>('/tool-checks/cases/run-all', { method: 'POST', body: JSON.stringify({ scope, ...(toolId === undefined ? {} : { toolId }) }), signal })).results;
  }

  /** 未保存のAgent編集内容に対するプリフライト診断（保存せずに「組み込んだら呼び出せるか」を確認する）。 */
  async diagnoseAgentDraft(input: SaveAgentDto, signal?: AbortSignal): Promise<AgentDiagnosticsDto> {
    return (await this.request<{ diagnostics: AgentDiagnosticsDto }>('/agent-drafts/diagnose', { method: 'POST', body: JSON.stringify(input), signal })).diagnostics;
  }

  /** 未保存のTool編集内容に対するプリフライト診断（Agent側の検査項目をTool単体で実行する）。 */
  async diagnoseToolDraft(input: SaveToolDto, signal?: AbortSignal): Promise<ToolDiagnosticsDto> {
    return (await this.request<{ diagnostics: ToolDiagnosticsDto }>('/tool-drafts/diagnose', { method: 'POST', body: JSON.stringify(input), signal })).diagnostics;
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

  /**
   * 昇格を申請する。**申請者は送らない**。サーバーが認証済みの Principal から決める
   * （送れるようにすると、監査証跡の「誰が」を自由に名乗れてしまう）。
   */
  async requestPromotion(agentId: string, version: string, scope: TenantScopeDto, gateReportId: string): Promise<PromotionRequestDto> {
    return (await this.request<{ promotion: PromotionRequestDto }>(`/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version)}/promotion-requests`, { method: 'POST', body: JSON.stringify({ scope, gateReportId }) })).promotion;
  }

  async listPromotionRequests(scope: TenantScopeDto, agentId?: string): Promise<readonly PromotionRequestDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }); if (agentId !== undefined) query.set('agentId', agentId); return (await this.request<{ promotions: PromotionRequestDto[] }>(`/promotion-requests?${query}`)).promotions;
  }

  /** 昇格の採否。決定者もサーバーが Principal から決めるので送らない。 */
  async decidePromotion(id: string, decision: 'approve' | 'reject', scope: TenantScopeDto, reason?: string): Promise<PromotionRequestDto> {
    return (await this.request<{ promotion: PromotionRequestDto }>(`/promotion-requests/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: JSON.stringify({ scope, ...(reason !== undefined ? { reason } : {}) }) })).promotion;
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

  /**
   * 監査ログを読む。**Operator / Workspace Admin だけ**が呼べる（それ以外は403）。
   * 画面側は403を「権限が無い」として静かに扱う（一覧を出さないだけ）。
   */
  async listAuditLog(scope: TenantScopeDto, filter?: AuditLogQueryDto, signal?: AbortSignal): Promise<readonly AuditEntryDto[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (filter?.outcome !== undefined) query.set('outcome', filter.outcome);
    if (filter?.subject !== undefined) query.set('subject', filter.subject);
    if (filter?.limit !== undefined) query.set('limit', String(filter.limit));
    return (await this.request<{ entries: AuditEntryDto[] }>(`/operations/audit?${query}`, { signal })).entries;
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
   * 接続先の見出し（オフラインの静的データ）。**モデル名は含まない**。
   * モデルは手入力するか、OpenAI互換エンドポイントなら listOpenAiCompatibleModels で実際に問い合わせる。
   */
  async getModelCatalog(signal?: AbortSignal): Promise<readonly ModelCatalogProviderDto[]> {
    return (await this.request<{ providers: ModelCatalogProviderDto[] }>('/model-catalog', { signal })).providers;
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

  /**
   * オンボーディング用サンプル一式（データソース・ツール・スキル・Wiki・エージェント）を投入する。
   * 冪等: 既に投入済みなら何も作らず、同じ一覧と `created: 0` を返す。
   */
  async seedSampleData(scope: TenantScopeDto): Promise<SampleDataSummaryDto> {
    return (await this.request<{ sample: SampleDataSummaryDto }>('/sample-data', {
      method: 'POST',
      body: JSON.stringify({ scope }),
    })).sample;
  }

  // ---------------------------------------------------------------------------
  // 仕訳（docs/20-journal.md §9）。scope は他のメソッドと同じくクエリ（GET/DELETE）または JSON 本文に載せる。
  // 抽出（/journal/documents/extract）とヒアリング（/journal/hearings*）は LLM を呼ぶので遅い。
  // 画面が中断できるよう signal を受ける（tool-check の提案パネルと同じ作法）。
  // ---------------------------------------------------------------------------

  /**
   * 仕訳の LLM 抽出 / ヒアリングの可否。旧サーバー（`journal` 無し）は「どちらも使えない」として扱い、
   * 画面は機能の案内（設定画面のモデルスロットへのボタン）を出す。
   */
  async journalCapabilities(signal?: AbortSignal): Promise<JournalCapabilitiesDto> {
    const capabilities = await this.request<RuntimeCapabilitiesDto>('/runtime/capabilities', { signal });
    return capabilities.journal ?? { extraction: { enabled: false, vision: false }, hearing: { enabled: false } };
  }

  async getJournalChart(scope: TenantScopeDto, signal?: AbortSignal): Promise<JournalChartOfAccountsDto> {
    return (await this.request<{ chart: JournalChartOfAccountsDto }>(`/journal/chart?${scopeQuery(scope)}`, { signal })).chart;
  }

  async saveJournalChart(scope: TenantScopeDto, chart: SaveJournalChartOfAccountsDto): Promise<JournalChartOfAccountsDto> {
    return (await this.request<{ chart: JournalChartOfAccountsDto }>('/journal/chart', { method: 'PUT', body: JSON.stringify({ scope, ...chart }) })).chart;
  }

  async resetJournalChart(scope: TenantScopeDto): Promise<JournalChartOfAccountsDto> {
    return (await this.request<{ chart: JournalChartOfAccountsDto }>('/journal/chart/reset', { method: 'POST', body: JSON.stringify({ scope }) })).chart;
  }

  async exportJournalChartCsv(scope: TenantScopeDto, signal?: AbortSignal): Promise<string> {
    return (await this.request<{ content: string }>(`/journal/chart/export?${scopeQuery(scope)}`, { signal })).content;
  }

  async importJournalChartCsv(scope: TenantScopeDto, input: { readonly content: string }): Promise<JournalChartOfAccountsDto> {
    return (await this.request<{ chart: JournalChartOfAccountsDto }>('/journal/chart/import', { method: 'POST', body: JSON.stringify({ scope, content: input.content }) })).chart;
  }

  async listJournalRules(scope: TenantScopeDto, signal?: AbortSignal): Promise<readonly JournalRuleDto[]> {
    return (await this.request<{ rules: JournalRuleDto[] }>(`/journal/rules?${scopeQuery(scope)}`, { signal })).rules;
  }

  async saveJournalRule(scope: TenantScopeDto, rule: SaveJournalRuleDto): Promise<JournalRuleDto> {
    return (await this.request<{ rule: JournalRuleDto }>('/journal/rules', { method: 'POST', body: JSON.stringify({ scope, rule }) })).rule;
  }

  async deleteJournalRule(id: string, scope: TenantScopeDto): Promise<void> {
    await this.request(`/journal/rules/${encodeURIComponent(id)}?${scopeQuery(scope)}`, { method: 'DELETE' });
  }

  /** ルール草案を保存せずに文書群へ照合する（「文書でテスト」）。 */
  async testJournalRule(scope: TenantScopeDto, input: { readonly rule: SaveJournalRuleDto; readonly documentIds: readonly string[] }, signal?: AbortSignal): Promise<readonly JournalRuleTestResultDto[]> {
    return (await this.request<{ result: JournalRuleTestResultDto[] }>('/journal/rules/test', { method: 'POST', body: JSON.stringify({ scope, ...input }), signal })).result;
  }

  async listJournalDocuments(scope: TenantScopeDto, filter: { readonly status?: string; readonly kind?: string; readonly from?: string; readonly to?: string } = {}, signal?: AbortSignal): Promise<readonly JournalDocumentSummaryDto[]> {
    const query = scopeQuery(scope);
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') query.set(key, value);
    return (await this.request<{ documents: JournalDocumentSummaryDto[] }>(`/journal/documents?${query}`, { signal })).documents;
  }

  async getJournalDocument(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<JournalDocumentDto> {
    return (await this.request<{ document: JournalDocumentDto }>(`/journal/documents/${encodeURIComponent(id)}?${scopeQuery(scope)}`, { signal })).document;
  }

  /** id 無しは新規（POST）、id 付きは更新（PUT）。 */
  async saveJournalDocument(scope: TenantScopeDto, document: SaveJournalDocumentDto): Promise<JournalDocumentDto> {
    const path = document.id === undefined ? '/journal/documents' : `/journal/documents/${encodeURIComponent(document.id)}`;
    return (await this.request<{ document: JournalDocumentDto }>(path, { method: document.id === undefined ? 'POST' : 'PUT', body: JSON.stringify({ scope, ...document }) })).document;
  }

  async deleteJournalDocument(id: string, scope: TenantScopeDto): Promise<void> {
    await this.request(`/journal/documents/${encodeURIComponent(id)}?${scopeQuery(scope)}`, { method: 'DELETE' });
  }

  async importJournalCsv(scope: TenantScopeDto, input: ImportJournalCsvDto, signal?: AbortSignal): Promise<ImportJournalCsvResultDto> {
    return (await this.request<{ result: ImportJournalCsvResultDto }>('/journal/documents/import-csv', { method: 'POST', body: JSON.stringify({ scope, ...input }), signal })).result;
  }

  async listJournalCsvPresets(signal?: AbortSignal): Promise<readonly JournalCsvPresetDto[]> {
    return (await this.request<{ presets: JournalCsvPresetDto[] }>('/journal/csv-presets', { signal })).presets;
  }

  /** documentIds 省略時は未判定の全件。 */
  async judgeJournalDocuments(scope: TenantScopeDto, input: { readonly documentIds?: readonly string[] } = {}, signal?: AbortSignal): Promise<JudgeJournalDocumentsResultDto> {
    return (await this.request<{ result: JudgeJournalDocumentsResultDto }>('/journal/documents/judge', { method: 'POST', body: JSON.stringify({ scope, ...input }), signal })).result;
  }

  /**
   * 画像 / PDF ページ画像 / テキストから facts を LLM 抽出する（保存はしない。利用者が確認して保存する）。
   * 遅い（モデル 1 往復）ので signal を受ける。vision / 構造化出力に対応しないモデルでは 409
   * `JOURNAL_EXTRACTION_UNAVAILABLE`、画像が大きすぎる / 形式違いは 400 が返る。
   */
  async extractJournalDocument(scope: TenantScopeDto, input: ExtractJournalDocumentDto, signal?: AbortSignal): Promise<ExtractJournalDocumentResultDto> {
    return (await this.request<{ result: ExtractJournalDocumentResultDto }>('/journal/documents/extract', { method: 'POST', body: JSON.stringify({ scope, ...input }), signal })).result;
  }

  /** ヒアリング（Stage 2）を開始する。最初の質問は応答の hearing.turns に入る。 */
  async createJournalHearing(scope: TenantScopeDto, input: { readonly documentId: string }, signal?: AbortSignal): Promise<JournalHearingDto> {
    return (await this.request<{ hearing: JournalHearingDto }>('/journal/hearings', { method: 'POST', body: JSON.stringify({ scope, ...input }), signal })).hearing;
  }

  async getJournalHearing(id: string, scope: TenantScopeDto, signal?: AbortSignal): Promise<JournalHearingDto> {
    return (await this.request<{ hearing: JournalHearingDto }>(`/journal/hearings/${encodeURIComponent(id)}?${scopeQuery(scope)}`, { signal })).hearing;
  }

  async listJournalHearings(scope: TenantScopeDto, filter: { readonly documentId?: string } = {}, signal?: AbortSignal): Promise<readonly JournalHearingDto[]> {
    const query = scopeQuery(scope);
    if (filter.documentId !== undefined && filter.documentId !== '') query.set('documentId', filter.documentId);
    return (await this.request<{ hearings: JournalHearingDto[] }>(`/journal/hearings?${query}`, { signal })).hearings;
  }

  /** 回答をまとめて送る。次の質問か提案（proposal）が返る。遅い（モデル 1 往復）。 */
  async answerJournalHearing(id: string, scope: TenantScopeDto, input: AnswerJournalHearingDto, signal?: AbortSignal): Promise<JournalHearingDto> {
    // サーバーは { hearing, warnings } を返す。warnings は提案が作れなかった理由なので、
    // 捨てずに sessionWarnings として畳み込む（提案が無いときは他に出しどころが無い）。
    const response = await this.request<{ hearing: JournalHearingDto; warnings?: readonly string[] }>(`/journal/hearings/${encodeURIComponent(id)}/answers`, { method: 'POST', body: JSON.stringify({ scope, ...input }), signal });
    return response.warnings === undefined || response.warnings.length === 0 ? response.hearing : { ...response.hearing, sessionWarnings: response.warnings };
  }

  /** 提案を受け入れる。`register*Ids` に挙げたものだけをマスタへ登録する（既定は 1 件も登録しない）。 */
  async acceptJournalHearing(id: string, scope: TenantScopeDto, input: AcceptJournalHearingDto = {}): Promise<AcceptJournalHearingResultDto> {
    return this.request<AcceptJournalHearingResultDto>(`/journal/hearings/${encodeURIComponent(id)}/accept`, { method: 'POST', body: JSON.stringify({ scope, ...input }) });
  }

  async cancelJournalHearing(id: string, scope: TenantScopeDto): Promise<JournalHearingDto> {
    return (await this.request<{ hearing: JournalHearingDto }>(`/journal/hearings/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ scope }) })).hearing;
  }

  async listJournalEntries(scope: TenantScopeDto, filter: { readonly status?: string; readonly from?: string; readonly to?: string; readonly documentId?: string } = {}, signal?: AbortSignal): Promise<readonly JournalEntryDto[]> {
    const query = scopeQuery(scope);
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') query.set(key, value);
    return (await this.request<{ entries: JournalEntryDto[] }>(`/journal/entries?${query}`, { signal })).entries;
  }

  /** id 無しは新規（POST）、id 付きは更新（PUT）。 */
  async saveJournalEntry(scope: TenantScopeDto, entry: SaveJournalEntryDto): Promise<JournalEntryDto> {
    const path = entry.id === undefined ? '/journal/entries' : `/journal/entries/${encodeURIComponent(entry.id)}`;
    return (await this.request<{ entry: JournalEntryDto }>(path, { method: entry.id === undefined ? 'POST' : 'PUT', body: JSON.stringify({ scope, ...entry }) })).entry;
  }

  async confirmJournalEntry(id: string, scope: TenantScopeDto): Promise<JournalEntryDto> {
    return (await this.request<{ entry: JournalEntryDto }>(`/journal/entries/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({ scope }) })).entry;
  }

  async deleteJournalEntry(id: string, scope: TenantScopeDto): Promise<void> {
    await this.request(`/journal/entries/${encodeURIComponent(id)}?${scopeQuery(scope)}`, { method: 'DELETE' });
  }

  /** 仕訳 CSV。`markExported` で出力した仕訳を exported にする。 */
  async exportJournalEntries(scope: TenantScopeDto, input: { readonly format: 'generic' | 'yayoi' | 'freee' | 'mf'; readonly status?: string; readonly from?: string; readonly to?: string; readonly markExported?: boolean }, signal?: AbortSignal): Promise<JournalExportResultDto> {
    const query = scopeQuery(scope);
    query.set('format', input.format);
    if (input.status !== undefined && input.status !== '') query.set('status', input.status);
    if (input.from !== undefined && input.from !== '') query.set('from', input.from);
    if (input.to !== undefined && input.to !== '') query.set('to', input.to);
    if (input.markExported === true) query.set('markExported', 'true');
    return (await this.request<{ result: JournalExportResultDto }>(`/journal/export?${query}`, { signal })).result;
  }

  /**
   * 低レベルの送信口。認証ヘッダ・JSON 解析・`ApiError` への変換をここに集める。
   * 業務の API クライアント（`api/<業務>-api.ts`）はこれを `ApiTransport` として使う（ADR-0039）。
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.authToken();
    // body 無し（DELETE 等）に content-type を付けると Fastify が空JSON本文として 400/500 にする。
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined || init.body === null ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...init.headers,
      },
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
      const error = body as { error?: { code?: string; message?: string; runId?: string; tool?: RunFailureToolRefDto; nodeId?: string; rubric?: { id?: unknown; version?: unknown }; row?: unknown } };
      const row = typeof error.error?.row === 'number' && Number.isInteger(error.error.row) ? error.error.row : undefined;
      const rubric = error.error?.rubric;
      // rubric は JUDGE_TRACE_UNAVAILABLE だけが載せる。形が崩れていれば（id が文字列でない等）載せない。
      const rubricRef = rubric !== undefined && typeof rubric.id === 'string' && typeof rubric.version === 'string' ? { id: rubric.id, version: rubric.version } : undefined;
      // 共通で解釈する項目以外は details としてそのまま渡す（業務の画面が読む。無ければ付けない）。
      const details = Object.fromEntries(Object.entries(error.error ?? {}).filter(([key]) => !KNOWN_ERROR_FIELDS.has(key)));
      throw new ApiError(
        response.status,
        error.error?.code ?? 'HTTP_ERROR',
        error.error?.message ?? response.statusText,
        error.error?.runId,
        { ...(error.error?.tool === undefined ? {} : { tool: error.error.tool }), ...(error.error?.nodeId === undefined ? {} : { nodeId: error.error.nodeId }), ...(rubricRef === undefined ? {} : { rubric: rubricRef }), ...(row === undefined ? {} : { row }), ...(Object.keys(details).length === 0 ? {} : { details }) },
      );
    }
    return body as T;
  }
}

/** error 本文のうち、`ApiError` が個別の項目として受け取るもの（それ以外は details へ）。 */
const KNOWN_ERROR_FIELDS: ReadonlySet<string> = new Set(['code', 'message', 'runId', 'tool', 'nodeId', 'rubric', 'row']);
