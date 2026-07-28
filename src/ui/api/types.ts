export type DataType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'unknown';
export type SchemaState = 'confirmed' | 'partial' | 'inferred' | 'unknown' | 'mismatch';
export type JsonCell = string | number | boolean | null;
export type JsonRow = Readonly<Record<string, JsonCell>>;

export interface ColumnDto {
  readonly name: string;
  readonly type: DataType;
  readonly nullable: boolean;
}
export interface SchemaDto { readonly columns: readonly ColumnDto[] }
export interface TableDto { readonly schema: SchemaDto; readonly rows: readonly JsonRow[] }
/** キャンバス上の配置。保存して手動整列を保つためのメタデータで、ETL実行には影響しない。 */
export interface GraphNodePositionDto { readonly x: number; readonly y: number }
export interface GraphNodeDto { readonly id: string; readonly type: string; readonly config: unknown; readonly position?: GraphNodePositionDto }
export interface GraphEdgeDto { readonly from: string; readonly to: string; readonly toInput?: number }
export interface ToolGraphDto { readonly nodes: readonly GraphNodeDto[]; readonly edges: readonly GraphEdgeDto[] }

export interface SchemaIssueDto {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly column?: string;
}
export interface NodeInferenceDto {
  readonly nodeId: string;
  readonly schema: SchemaDto;
  readonly state: SchemaState;
  readonly issues: readonly SchemaIssueDto[];
}
export interface PropagationResultDto {
  readonly order: readonly string[];
  readonly nodes: Readonly<Record<string, NodeInferenceDto>>;
  readonly hasErrors: boolean;
}
export interface NodePreviewDto { readonly nodeId: string; readonly table: TableDto; readonly truncated: boolean }
export interface PreviewResultDto {
  readonly terminalId: string;
  readonly output: TableDto;
  readonly nodes: Readonly<Record<string, NodePreviewDto>>;
}

export interface TenantScopeDto { readonly tenantId: string; readonly workspaceId: string }

/** 認証方式。`single-user` は「資格情報を求めない」構成（ループバック限定）。 */
export type AuthModeDto = 'single-user' | 'token';

/** `GET /auth/session` の応答。テナント境界を決めている主体そのもの。 */
export interface AuthSessionDto {
  readonly mode: AuthModeDto;
  /** `false` なら単一ユーザーモード（トークン入力は不要）。 */
  readonly authenticationRequired: boolean;
  readonly principal: {
    readonly subject: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly displayName?: string;
    /** 次Wave（RBAC）用。現時点では表示にしか使わない。 */
    readonly roles: readonly string[];
  };
}
export type SideEffectDto = 'read-only' | 'session-write' | 'write' | 'external-action';
export interface SerializedToolDto {
  readonly metadata: {
    readonly internalId: string;
    readonly workingName: string;
    readonly displayName: string;
    readonly publishName: string;
    readonly version: string;
    readonly owner: string;
    readonly state: 'draft' | 'in-review' | 'published' | 'deprecated' | 'archived';
    readonly tenant: TenantScopeDto;
  };
  readonly sideEffect: SideEffectDto;
  readonly graph: ToolGraphDto;
  readonly inputSchema?: SchemaDto;
  readonly outputSchema?: SchemaDto;
  readonly agentTool?: { readonly name: string; readonly description: string };
}
export interface SaveToolDto {
  readonly scope: TenantScopeDto;
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly sideEffect: SideEffectDto;
  readonly graph: ToolGraphDto;
  readonly inputSchema?: SchemaDto;
  readonly outputSchema?: SchemaDto;
  readonly agentTool?: { readonly name: string; readonly description: string };
  readonly bump?: 'major' | 'minor' | 'patch';
}

export interface ToolSummaryDto {
  readonly internalId: string;
  readonly publishName: string;
  readonly displayName: string;
  readonly latestVersion: string;
  readonly state: SerializedToolDto['metadata']['state'];
  readonly sideEffect: SideEffectDto;
}

export type AgentKindDto = 'normal' | 'pseudo-user' | 'evaluator';
export type StructuredOutputTypeDto = 'string' | 'number' | 'integer' | 'boolean';
export interface StructuredOutputFieldDto {
  readonly name: string;
  readonly type: StructuredOutputTypeDto;
  readonly required: boolean;
  readonly description?: string;
}
export interface StructuredOutputDto {
  readonly name: string;
  readonly fields: readonly StructuredOutputFieldDto[];
}
export interface EvaluationScoreDto { readonly metric: string; readonly score: number; readonly reason?: string }
export interface EvaluationResultDto { readonly scores: readonly EvaluationScoreDto[]; readonly average: number }

export interface AgentToolRefDto { readonly internalId: string; readonly version: string }
export interface AgentSubAgentRefDto { readonly internalId: string; readonly version: string; readonly usage: string }
export interface AgentWikiRefDto { readonly wikiId: string }
/** 単一Agent実行のランタイムハーネス設定（Agent単位のopt-in）。 */
export interface AgentRuntimeHarnessDto {
  readonly fileMemory: boolean;
  readonly todoProvider: boolean;
  readonly compaction: boolean;
  readonly webSearch: boolean;
  readonly toolApproval: boolean;
  readonly functionInvocation: boolean;
}
export interface SerializedAgentDto {
  readonly metadata: {
    readonly internalId: string;
    readonly workingName: string;
    readonly displayName: string;
    readonly publishName: string;
    readonly version: string;
    readonly owner: string;
    readonly state: SerializedToolDto['metadata']['state'];
    readonly tenant: TenantScopeDto;
  };
  readonly kind: AgentKindDto;
  readonly systemPrompt: string;
  readonly skills: readonly AgentToolRefDto[];
  readonly tools: readonly AgentToolRefDto[];
  readonly agents: readonly AgentSubAgentRefDto[];
  readonly wikis?: readonly AgentWikiRefDto[];
  /** ツールを注入するMCPサーバー名（保存済み設定の name）。未指定はMCPツールなし。 */
  readonly mcpServers?: readonly string[];
  readonly harness?: AgentRuntimeHarnessDto;
  readonly persona?: { readonly personaId: string; readonly version: string };
  readonly output?: StructuredOutputDto;
}
export interface SaveAgentDto {
  readonly scope: TenantScopeDto;
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly kind: AgentKindDto;
  readonly systemPrompt: string;
  readonly skills?: readonly AgentToolRefDto[];
  readonly tools: readonly AgentToolRefDto[];
  readonly agents?: readonly AgentSubAgentRefDto[];
  readonly wikis?: readonly AgentWikiRefDto[];
  /** ツールを注入するMCPサーバー名（最大8件・各64字以内）。 */
  readonly mcpServers?: readonly string[];
  readonly harness?: AgentRuntimeHarnessDto;
  readonly output?: StructuredOutputDto;
  readonly bump?: 'major' | 'minor' | 'patch';
}
export interface AgentSummaryDto {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: string;
  readonly kind: AgentKindDto;
  readonly state: SerializedAgentDto['metadata']['state'];
}
export interface AgentPromptDraftDto {
  readonly systemPromptDraft: string;
  readonly sections: { readonly role: string; readonly skillGuide: string; readonly toolUsageGuide: string; readonly collaboratorGuide: string; readonly rules: string };
  readonly editable: true;
  readonly sources: readonly string[];
}

export interface SerializedSkillDto {
  readonly metadata: SerializedAgentDto['metadata'];
  readonly responsibility: string;
  readonly activationCondition: string;
  readonly inputDescription: string;
  readonly outputDescription: string;
  readonly instructions: string;
  readonly tools: readonly AgentToolRefDto[];
}
export interface SaveSkillDto {
  readonly scope: TenantScopeDto; readonly internalId: string; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly owner: string; readonly responsibility: string; readonly activationCondition: string;
  readonly inputDescription: string; readonly outputDescription: string; readonly instructions: string;
  readonly tools: readonly AgentToolRefDto[]; readonly bump?: 'major' | 'minor' | 'patch';
}
export interface SkillSummaryDto { readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: string; readonly state: SerializedAgentDto['metadata']['state'] }
export interface SkillPromptDraftDto { readonly promptDraft: string; readonly sections: { readonly responsibility: string; readonly activation: string; readonly ioContract: string; readonly toolGuide: string }; readonly editable: true; readonly sources: readonly string[] }

export type RunTraceEventDto =
  | { readonly sequence: number; readonly kind: 'model-request'; readonly step: number; readonly toolNames: readonly string[] }
  | { readonly sequence: number; readonly kind: 'tool-call'; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly sequence: number; readonly kind: 'tool-result'; readonly name: string; readonly terminalId: string; readonly nodes: readonly { readonly nodeId: string; readonly rowCount: number; readonly truncated: boolean }[]; readonly outputPreview: readonly Readonly<Record<string, unknown>>[] }
  | { readonly sequence: number; readonly kind: 'model-response'; readonly content: string }
  | { readonly sequence: number; readonly kind: 'agent_call'; readonly toolName: string; readonly agentRef: { readonly internalId: string; readonly version: string }; readonly childRunId: string; readonly ok: boolean; readonly summary: string }
  | { readonly sequence: number; readonly kind: 'compaction'; readonly beforeChars: number; readonly afterChars: number }
  | { readonly sequence: number; readonly kind: 'approval-requested'; readonly tool: string; readonly sideEffect: SideEffectDto; readonly prompt: string }
  // decidedBy は承認した主体。認可・監査を入れる前に保存されたRunには入っていないので任意。
  | { readonly sequence: number; readonly kind: 'approval-resolved'; readonly decision: 'approve' | 'reject'; readonly decidedBy?: string }
  | { readonly sequence: number; readonly kind: 'error'; readonly code: string; readonly message: string };

/** POST /runs / POST /runs/:runId/resume が waiting-approval で返す承認プロンプト。 */
export interface AgentRunApprovalPromptDto {
  readonly prompt: string;
  readonly expiresAt: string;
  /** 承認対象のツール名（モデルが呼んだ名前）。 */
  readonly tool: string;
  readonly sideEffect: string;
}

export interface AgentPreviewRunDto {
  readonly runId: string;
  readonly sessionId?: string;
  readonly mode: 'preview' | 'test';
  readonly agent?: { readonly internalId: string; readonly publishName?: string; readonly version?: string };
  readonly tool?: { readonly internalId: string; readonly publishName?: string; readonly version?: string };
  readonly tools?: readonly { readonly internalId: string; readonly publishName?: string; readonly version?: string }[];
  readonly response: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEventDto[];
  readonly usage: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number };
  readonly purpose?: RunPurposeDto;
  readonly model?: RunModelSnapshotDto;
  readonly latency?: RunLatencyDto;
  readonly estimatedCost?: RunEstimatedCostDto;
  /** 承認待ちで停止したときだけ 'waiting-approval'。完走時は未指定（後方互換）。 */
  readonly status?: RunStatusDto;
  /** status === 'waiting-approval' のときだけ設定される。 */
  readonly checkpoint?: AgentRunApprovalPromptDto;
}

export type HarnessPatternDto = 'agent-as-tools' | 'sequential' | 'concurrent' | 'handoff' | 'group-chat' | 'magentic';
export interface HarnessSlotDto { readonly id: string; readonly label: string; readonly purpose: string; readonly assignment: AgentToolRefDto; }
export type HarnessTopologyDto =
  | { readonly pattern: 'agent-as-tools'; readonly coordinatorSlotId: string; readonly participantSlotIds: readonly string[] }
  | { readonly pattern: 'sequential'; readonly orderedSlotIds: readonly string[]; readonly contextMode: 'full-conversation' | 'previous-response' }
  | { readonly pattern: 'concurrent'; readonly participantSlotIds: readonly string[]; readonly aggregation: 'collect' | 'vote' | 'agent'; readonly aggregatorSlotId?: string }
  | { readonly pattern: 'handoff'; readonly startSlotId: string; readonly transitions: readonly { readonly fromSlotId: string; readonly toSlotId: string; readonly condition: string }[]; readonly autonomous: boolean }
  | { readonly pattern: 'group-chat'; readonly participantSlotIds: readonly string[]; readonly selector: 'round-robin' | 'fixed-order' | 'agent'; readonly managerSlotId?: string; readonly maxRounds: number }
  | { readonly pattern: 'magentic'; readonly managerSlotId: string; readonly participantSlotIds: readonly string[]; readonly maxRounds: number; readonly maxStalls: number; readonly maxResets: number; readonly requirePlanSignoff: boolean };
export interface HarnessPoliciesDto {
  readonly budget: { readonly maxDurationMs: number; readonly maxParticipantRuns: number; readonly maxModelRounds: number; readonly maxToolCalls: number; readonly maxParallelism: number };
  readonly context: 'task-only' | 'previous-response' | 'full-conversation';
  readonly planning: { readonly enabled: boolean; readonly requireApproval: boolean };
  readonly memory: { readonly wikiIds: readonly string[]; readonly sessionWorkspace: boolean };
  readonly approvals: { readonly mode: 'inherit-agent' | 'always' | 'disabled-in-preview' };
  readonly failure: { readonly mode: 'fail-fast' | 'collect' | 'continue-with-error' };
}
export interface SerializedAgentHarnessDto {
  readonly metadata: SerializedAgentDto['metadata'];
  readonly pattern: HarnessPatternDto;
  readonly slots: readonly HarnessSlotDto[];
  readonly topology: HarnessTopologyDto;
  readonly policies: HarnessPoliciesDto;
  readonly output: { readonly format: 'text' };
}
export interface SaveHarnessDto {
  readonly scope: TenantScopeDto; readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string;
  readonly pattern: HarnessPatternDto; readonly slots: readonly HarnessSlotDto[]; readonly topology: HarnessTopologyDto; readonly policies?: HarnessPoliciesDto;
  readonly output?: { readonly format: 'text' }; readonly bump?: 'major' | 'minor' | 'patch';
}
export interface HarnessSummaryDto { readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: string; readonly pattern: HarnessPatternDto; readonly state: SerializedToolDto['metadata']['state']; }
export interface HarnessValidationDto { readonly valid: boolean; readonly issues: readonly { readonly path: string; readonly message: string }[] }
export interface HarnessRunDto {
  readonly runId: string; readonly scope: TenantScopeDto; readonly harness: { readonly internalId: string; readonly version: string; readonly displayName: string }; readonly mode: 'preview' | 'test';
  readonly status: 'running' | 'succeeded' | 'failed' | 'waiting-input' | 'waiting-approval' | 'cancelled'; readonly message: string; readonly startedAt: string; readonly completedAt?: string; readonly response?: string;
  readonly checkpoint?: HarnessRunCheckpointDto;
  readonly failure?: { readonly code: string; readonly message: string }; readonly events: readonly { readonly sequence: number; readonly kind: string; readonly at: string; readonly slotId?: string; readonly childRunId?: string; readonly message?: string }[];
}
export type HarnessRunCheckpointDto =
  | { readonly kind: 'handoff-input'; readonly activeSlotId: string; readonly expiresAt: string; readonly prompt: string }
  | { readonly kind: 'magentic-approval'; readonly managerSlotId: string; readonly selectedSlotId: string; readonly expiresAt: string; readonly plan: string };

export interface AnalysisConfigProposalDto { readonly nodeId: string; readonly nodeType: string; readonly config: Readonly<Record<string, unknown>>; readonly rationale: readonly string[]; readonly warnings: readonly string[] }

/** payloadや接続資格情報を含まない、Tool用データソースのカタログ表現。 */
export type DataSourceDto = FileDataSourceDto | DatabaseDataSourceDto;
export interface DataSourceBaseDto {
  readonly id: string;
  readonly tenant: TenantScopeDto;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface FileDataSourceDto extends DataSourceBaseDto {
  readonly kind: 'file';
  readonly format: 'csv' | 'json';
  readonly contentType: 'text/csv' | 'application/json';
  readonly sizeBytes: number;
}
export interface DatabaseDataSourceDto extends DataSourceBaseDto {
  readonly kind: 'database';
  readonly connectionId: string;
  readonly driver: 'postgresql';
  readonly defaultSchema?: string;
}
export interface DatabaseConnectionDto { readonly id: string; readonly driver: 'postgresql' }
export interface DatabaseConnectionStatusDto extends DatabaseConnectionDto { readonly available: boolean; readonly error?: string }

/** キーなどを含まない、Tool Builderで選択可能なWeb検索provider。 */
export interface SearchProviderDto {
  readonly id: 'tavily' | 'tinyfish' | 'google-custom-search';
  readonly label: string;
  readonly supportsDomainFilter: boolean;
}
export interface WebSearchFetchDto {
  readonly cacheKey: string;
  readonly provider: SearchProviderDto['id'];
  readonly query: string;
  readonly maxResults: number;
  readonly includeDomains: readonly string[];
  readonly rows: readonly Readonly<Record<string, JsonCell>>[];
  readonly retrievedAt: string;
  readonly expiresAt: string;
}

export type RunStatusDto = 'running' | 'succeeded' | 'failed' | 'waiting-approval';
export type RunPurposeDto = 'interactive' | 'scenario' | 'evaluation' | 'delegation';
export interface RunModelSnapshotDto { readonly provider: string; readonly model: string; readonly modelConfigHash: string }
export interface RunLatencyDto { readonly totalMs: number; readonly modelMs: number; readonly toolMs: number }
export interface RunEstimatedCostDto { readonly kind: 'estimated'; readonly amount: number; readonly currency: 'USD'; readonly price: { readonly currency: 'USD'; readonly inputPerMillionTokens: number; readonly outputPerMillionTokens: number; readonly effectiveAt: string } }

export interface RunAgentDto {
  readonly scope: TenantScopeDto;
  readonly tool: { readonly internalId: string; readonly version?: string };
  readonly systemPrompt: string;
  readonly message: string;
  readonly mode: 'preview' | 'test';
  readonly sessionId?: string;
  readonly images?: readonly RunImageAttachmentDto[];
}

export interface RunImageAttachmentDto {
  readonly name: string;
  readonly dataUrl: string;
}

/** 直前までの会話履歴の1件（マルチターン会話用）。 */
export interface AgentHistoryMessageDto {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface RunSavedAgentDto {
  readonly scope: TenantScopeDto;
  readonly agent: { readonly internalId: string; readonly version?: string };
  readonly message: string;
  readonly mode: 'preview' | 'test';
  /** 手動アタッチする Wiki ページ id（v21 M1）。 */
  readonly memoryPageIds?: readonly string[];
  readonly sessionId?: string;
  /** 直前までの会話履歴。system直後へ注入され、文脈参照(「さっきの件」等)を可能にする。 */
  readonly history?: readonly AgentHistoryMessageDto[];
  readonly images?: readonly RunImageAttachmentDto[];
}

/** POST /runs/:runId/resume の body。 */
export interface ResumeRunDto {
  readonly scope: TenantScopeDto;
  readonly decision: 'approve' | 'reject';
  /** reject のとき、モデルへ渡す理由（省略時は 'rejected by user'）。 */
  readonly feedback?: string;
}

export interface AgentSessionDto {
  readonly id: string;
  readonly scope: TenantScopeDto;
  readonly rootAgent: { readonly internalId: string; readonly version: string };
  readonly status: 'active' | 'closed' | 'expired';
  readonly createdAt: string;
  readonly lastAccessedAt: string;
  readonly expiresAt: string;
  readonly closedAt?: string;
  readonly quota: { readonly maxBytes: number; readonly maxArtifactBytes: number; readonly maxArtifacts: number };
}
export type SessionArtifactKindDto = 'table' | 'json' | 'chart' | 'graph' | 'blob';
export interface SessionArtifactDto {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly kind: SessionArtifactKindDto;
  readonly revision: number;
  readonly contentType: string;
  readonly schema?: SchemaDto;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly counts?: { readonly rows?: number; readonly nodes?: number; readonly edges?: number };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly preview?: unknown;
}

/** GET /runs / GET /runs/:runId/trace が返す、承認判断に必要なcheckpointの公開部分。 */
export interface RunCheckpointSummaryDto {
  readonly kind: 'tool-approval';
  readonly prompt: string;
  readonly expiresAt: string;
  readonly pendingCalls: readonly { readonly id: string; readonly name: string }[];
}

export interface RunSummaryDto {
  readonly runId: string;
  readonly sessionId?: string;
  readonly status: RunStatusDto;
  readonly mode: 'preview' | 'test';
  readonly purpose?: RunPurposeDto;
  readonly model?: RunModelSnapshotDto;
  readonly agent?: { readonly internalId: string; readonly version?: string; readonly publishName?: string };
  readonly tool?: { readonly internalId: string; readonly version?: string; readonly publishName?: string };
  readonly tools?: readonly { readonly internalId: string; readonly version?: string; readonly publishName?: string }[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly usage?: AgentPreviewRunDto['usage'];
  readonly latency?: RunLatencyDto;
  readonly estimatedCost?: RunEstimatedCostDto;
  /** status === 'waiting-approval' のときだけ設定される。 */
  readonly checkpoint?: RunCheckpointSummaryDto;
  readonly traceEventCount: number;
}

export interface RunRecordDto extends Omit<RunSummaryDto, 'traceEventCount'> {
  readonly scope: TenantScopeDto;
  readonly trace: readonly RunTraceEventDto[];
}

export type PersonaArchetypeDto = 'novice' | 'expert' | 'busy' | 'vague' | 'skeptical' | 'custom';
export type PersonaLevelDto = 'low' | 'mid' | 'high';
export type PersonaVerbosityDto = 'terse' | 'normal' | 'chatty';
export type PersonaLanguageDto = 'ja' | 'en';
export interface SerializedPersonaDto {
  readonly metadata: SerializedAgentDto['metadata'];
  readonly archetype: PersonaArchetypeDto;
  readonly knowledgeLevel: PersonaLevelDto;
  readonly patience: PersonaLevelDto;
  readonly tone: string;
  readonly verbosity: PersonaVerbosityDto;
  readonly language: PersonaLanguageDto;
  readonly extraInstructions?: string;
  readonly promptOverride?: string;
}
export interface SavePersonaDto {
  readonly scope: TenantScopeDto; readonly internalId: string; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly owner: string;
  readonly archetype: PersonaArchetypeDto;
  readonly knowledgeLevel: PersonaLevelDto;
  readonly patience: PersonaLevelDto;
  readonly tone: string;
  readonly verbosity: PersonaVerbosityDto;
  readonly language: PersonaLanguageDto;
  readonly extraInstructions?: string;
  readonly promptOverride?: string;
  readonly bump?: 'major' | 'minor' | 'patch';
}
export interface PersonaSummaryDto {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: string;
  readonly archetype: PersonaArchetypeDto;
  readonly state: SerializedAgentDto['metadata']['state'];
}

export type SurveyQuestionKindDto = 'scale' | 'boolean' | 'text';
export interface SurveyQuestionDto {
  readonly id: string;
  readonly textJa: string;
  readonly textEn: string;
  readonly kind: SurveyQuestionKindDto;
  readonly min?: number;
  readonly max?: number;
}
export interface SerializedScenarioDto {
  readonly metadata: SerializedAgentDto['metadata'];
  readonly target: { readonly agentId: string; readonly version: string };
  readonly persona?: { readonly personaId: string; readonly version: string };
  readonly pseudoUser?: { readonly agentId: string; readonly version: string };
  readonly goal: string;
  readonly context?: string;
  readonly maxUserTurns: number;
  readonly expectedTools?: readonly string[];
  readonly survey: readonly SurveyQuestionDto[];
}
export interface SaveScenarioDto {
  readonly scope: TenantScopeDto; readonly internalId: string; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly owner: string;
  readonly target: { readonly agentId: string; readonly version: string };
  readonly persona?: { readonly personaId: string; readonly version: string };
  readonly pseudoUser?: { readonly agentId: string; readonly version: string };
  readonly goal: string;
  readonly context?: string;
  readonly maxUserTurns: number;
  readonly expectedTools?: readonly string[];
  readonly survey: readonly SurveyQuestionDto[];
  readonly bump?: 'major' | 'minor' | 'patch';
}
export interface ScenarioSummaryDto {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: string;
  readonly state: SerializedAgentDto['metadata']['state'];
}

export type ScenarioRunStatusDto = 'completed' | 'max-turns' | 'error';
export interface ScenarioTurnDto { readonly speaker: 'user' | 'agent'; readonly message: string; readonly runId?: string }
export interface ScenarioRunDto {
  readonly id: string;
  readonly scope: TenantScopeDto;
  readonly scenario: { readonly id: string; readonly version: string };
  readonly pseudoUserRef?: { readonly type: 'persona' | 'agent'; readonly id: string; readonly version: string };
  readonly status: ScenarioRunStatusDto;
  readonly goalAchieved: boolean | null;
  readonly transcript: readonly ScenarioTurnDto[];
  readonly survey: readonly { readonly questionId: string; readonly value: number | boolean | string }[];
  readonly impressions: string;
  readonly metrics: {
    readonly userTurns: number; readonly agentRuns: number; readonly totalToolCalls: number;
    readonly expectedToolHit?: { readonly expected: readonly string[]; readonly called: readonly string[]; readonly hitRate: number };
    readonly durationMs: number;
    readonly usage: AgentPreviewRunDto['usage'];
  };
  readonly startedAt: string;
  readonly finishedAt: string;
}
export interface RunScenarioDto {
  readonly scope: TenantScopeDto;
  readonly version?: string;
  readonly mode: 'preview' | 'test';
}

export interface RunFeedbackDto {
  readonly id: string; readonly scope: TenantScopeDto; readonly runId: string;
  readonly agent: { readonly internalId: string; readonly version: string };
  readonly thumb: 'up' | 'down'; readonly rating?: number; readonly comment?: string; readonly issueTags: readonly string[];
  readonly createdAt: string; readonly updatedAt: string;
}
export interface SubmitRunFeedbackDto { readonly scope: TenantScopeDto; readonly thumb: 'up' | 'down'; readonly rating?: number; readonly comment?: string; readonly issueTags: readonly string[] }
export interface OperationsMetricPointDto { readonly bucketStart: string; readonly runCount: number; readonly failureRate: number; readonly p50LatencyMs: number; readonly p95LatencyMs: number; readonly totalTokens: number; readonly estimatedCost: number; readonly pricedRunCount: number; readonly feedbackRate: number }
export interface OperationsStatusDto { readonly from: string; readonly to: string; readonly summary: Omit<OperationsMetricPointDto, 'bucketStart'>; readonly points: readonly OperationsMetricPointDto[] }
export interface RetentionPolicyDto { readonly scope: TenantScopeDto; readonly payloadDays: number; readonly traceDays: number; readonly aggregateDays: number; readonly auditDays: number; readonly updatedAt: string }
export interface RetentionApplyResultDto { readonly payloadRedacted: number; readonly traceRedacted: number; readonly deleted: number; readonly feedbackDeleted: number; readonly aggregateBucketsDeleted: number; readonly auditDeleted: number }

/** 監査ログ1件（`GET /operations/audit`）。Operator / Workspace Admin だけが読める。 */
export interface AuditEntryDto {
  readonly at: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly action: 'read' | 'create' | 'edit' | 'execute' | 'approve' | 'publish' | 'operate' | 'manage-access' | 'delete';
  readonly resource: { readonly kind: string; readonly id?: string; readonly version?: string };
  readonly outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}
/** `GET /operations/audit` の絞り込み。 */
export interface AuditLogQueryDto { readonly outcome?: AuditEntryDto['outcome']; readonly subject?: string; readonly limit?: number }

/** バックアップ1件の自己記述メタデータ（`manifest.json` の中身）。 */
export interface BackupManifestDto {
  readonly formatVersion: number;
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly revision?: string;
  readonly node: string;
  readonly sourceDatabasePath: string;
  readonly database: { readonly file: string; readonly files: number; readonly bytes: number };
  readonly artifacts: { readonly directory: string; readonly files: number; readonly bytes: number };
  readonly secretKey: { readonly included: boolean; readonly file?: string };
}
/** 作成直後のバックアップ。`warnings` は失敗ではなく「気をつけること」。 */
export interface CreatedBackupDto { readonly name: string; readonly path: string; readonly manifest: BackupManifestDto; readonly warnings: readonly string[] }
/** 一覧の1件。マニフェストを読めなかった（＝作成途中で落ちた）ディレクトリは `problem` を持つ。 */
export interface BackupSummaryDto { readonly name: string; readonly path: string; readonly manifest?: BackupManifestDto; readonly problem?: string }
/** `GET /operations/backups` の応答。`root` はバックアップ置き場そのもの。 */
export interface BackupListDto { readonly root: string; readonly backups: readonly BackupSummaryDto[] }

export type EvaluationCaseSourceDto = 'manual' | 'import' | 'run-feedback';
export type EvaluationCaseDto =
  | { readonly id: string; readonly kind: 'turn'; readonly input: string; readonly reference?: string; readonly expectedTools?: readonly string[]; readonly tags: readonly string[]; readonly source: EvaluationCaseSourceDto }
  | { readonly id: string; readonly kind: 'scenario'; readonly scenario: { readonly id: string; readonly version: string }; readonly tags: readonly string[]; readonly source: EvaluationCaseSourceDto };
export interface SerializedEvaluationDatasetDto {
  readonly metadata: SerializedAgentDto['metadata'];
  readonly cases: readonly EvaluationCaseDto[];
}
export interface SaveEvaluationDatasetDto {
  readonly scope: TenantScopeDto;
  readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string;
  readonly cases: readonly EvaluationCaseDto[];
  readonly bump?: 'major' | 'minor' | 'patch';
}
export interface EvaluationDatasetSummaryDto {
  readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: string;
  readonly state: SerializedAgentDto['metadata']['state']; readonly caseCount: number;
}
export type CodeScorerDto = 'keyword-coverage' | 'completeness' | 'tone-consistency' | 'content-similarity';
export type EvaluatorMetricDefinitionDto =
  | { readonly id: string; readonly kind: 'code'; readonly weight: number; readonly required: boolean; readonly scorer: CodeScorerDto }
  | { readonly id: string; readonly kind: 'judge'; readonly weight: number; readonly required: boolean; readonly rubric: { readonly id: string; readonly version: string } };
export interface SerializedEvaluatorProfileDto { readonly metadata: SerializedAgentDto['metadata']; readonly metrics: readonly EvaluatorMetricDefinitionDto[] }
export interface SaveEvaluatorProfileDto {
  readonly scope: TenantScopeDto;
  readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string;
  readonly metrics: readonly EvaluatorMetricDefinitionDto[];
  readonly bump?: 'major' | 'minor' | 'patch';
}
export interface EvaluatorProfileSummaryDto {
  readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: string;
  readonly state: SerializedAgentDto['metadata']['state']; readonly metricCount: number;
}
export interface JudgeScoreLevelDto { readonly score: number; readonly label: string; readonly description: string }
export interface JudgeCriterionDto { readonly id: string; readonly label: string; readonly description: string; readonly weight: number; readonly levels: readonly JudgeScoreLevelDto[] }
export interface SerializedJudgeRubricDto { readonly metadata: SerializedAgentDto['metadata']; readonly instructions: string; readonly criteria: readonly JudgeCriterionDto[]; readonly referencePolicy: 'optional' | 'required' | 'forbidden'; readonly reasonRequired: true }
export interface SaveJudgeRubricDto { readonly scope: TenantScopeDto; readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string; readonly instructions: string; readonly criteria: readonly JudgeCriterionDto[]; readonly referencePolicy: SerializedJudgeRubricDto['referencePolicy']; readonly bump?: 'major' | 'minor' | 'patch' }
export interface JudgeRubricSummaryDto { readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: string; readonly state: SerializedAgentDto['metadata']['state']; readonly criterionCount: number }
export type ExperimentStatusDto = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ExperimentDto {
  readonly id: string; readonly scope: TenantScopeDto;
  readonly target: { readonly agentId: string; readonly version: string };
  readonly dataset: { readonly id: string; readonly version: string };
  readonly evaluatorProfile: { readonly id: string; readonly version: string };
  readonly repetitions: number; readonly status: ExperimentStatusDto;
  readonly snapshot: { readonly provider: string; readonly model: string; readonly modelConfigHash: string; readonly sourceRevision?: string };
  readonly progress: { readonly completed: number; readonly total: number };
  readonly createdAt: string; readonly startedAt?: string; readonly finishedAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface ExperimentCaseResultDto {
  readonly experimentId: string; readonly scope: TenantScopeDto; readonly caseId: string; readonly caseKind: 'turn' | 'scenario'; readonly repetition: number;
  readonly status: 'succeeded' | 'failed' | 'cancelled'; readonly runIds: readonly string[]; readonly output?: string;
  readonly scores: readonly EvaluationScoreDto[]; readonly latencyMs: number; readonly usage: AgentPreviewRunDto['usage'];
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly judgeEvaluations?: readonly { readonly scorer: 'llm-as-judge'; readonly metricId: string; readonly rubric: { readonly id: string; readonly version: string }; readonly required: boolean; readonly model: ExperimentDto['snapshot']; readonly status: 'succeeded' | 'failed'; readonly score?: number; readonly reason?: string; readonly error?: { readonly code: string; readonly message: string } }[];
}
export interface CreateExperimentDto {
  readonly scope: TenantScopeDto;
  readonly target: { readonly agentId: string; readonly version: string };
  readonly dataset: { readonly id: string; readonly version: string };
  readonly evaluatorProfile: { readonly id: string; readonly version: string };
  readonly repetitions?: number;
}
export interface MetricStatsDto { readonly count: number; readonly mean: number; readonly median: number; readonly p50: number; readonly p95: number; readonly stddev: number; readonly min: number; readonly max: number; readonly samples: readonly number[] }
export interface MetricComparisonDto { readonly metric: string; readonly preference: 'higher' | 'lower'; readonly baseline?: MetricStatsDto; readonly candidate?: MetricStatsDto; readonly delta?: number; readonly direction: 'improved' | 'regressed' | 'unchanged' | 'incomparable' }
export interface CaseComparisonDto { readonly caseId: string; readonly repetition: number; readonly baselineStatus?: ExperimentCaseResultDto['status']; readonly candidateStatus?: ExperimentCaseResultDto['status']; readonly baselineScore?: number; readonly candidateScore?: number; readonly delta?: number; readonly direction: MetricComparisonDto['direction'] }
export interface ExperimentComparisonDto { readonly baselineExperimentId: string; readonly candidateExperimentId: string; readonly baseline: { readonly experimentId: string; readonly caseCount: number; readonly metrics: Readonly<Record<string, MetricStatsDto>> }; readonly candidate: { readonly experimentId: string; readonly caseCount: number; readonly metrics: Readonly<Record<string, MetricStatsDto>> }; readonly metrics: readonly MetricComparisonDto[]; readonly cases: readonly CaseComparisonDto[] }
export type GateRuleDto =
  | { readonly id: string; readonly kind: 'metric-threshold'; readonly metric: string; readonly operator: 'gte' | 'lte'; readonly threshold: number }
  | { readonly id: string; readonly kind: 'max-regression'; readonly metric: string; readonly maxRegression: number }
  | { readonly id: string; readonly kind: 'required-case-pass'; readonly tags: readonly string[] };
export interface SerializedGatePolicyDto { readonly metadata: SerializedAgentDto['metadata']; readonly rules: readonly GateRuleDto[]; readonly reportTtlHours: number }
export interface GatePolicySummaryDto { readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: string; readonly state: SerializedAgentDto['metadata']['state']; readonly ruleCount: number }
export interface SaveGatePolicyDto { readonly scope: TenantScopeDto; readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string; readonly rules: readonly GateRuleDto[]; readonly reportTtlHours?: number; readonly bump?: 'major' | 'minor' | 'patch' }
export interface GateReportDto { readonly id: string; readonly scope: TenantScopeDto; readonly policy: { readonly id: string; readonly version: string }; readonly baselineExperimentId?: string; readonly candidateExperimentId: string; readonly status: 'pass' | 'fail'; readonly ruleResults: readonly { readonly ruleId: string; readonly passed: boolean; readonly observed?: number; readonly message: string }[]; readonly createdAt: string; readonly expiresAt: string }
export interface PromotionRequestDto { readonly id: string; readonly scope: TenantScopeDto; readonly agent: { readonly id: string; readonly version: string }; readonly gateReportId: string; readonly status: 'pending' | 'approved' | 'rejected'; readonly requestedBy: string; readonly requestedAt: string; readonly decidedBy?: string; readonly decidedAt?: string; readonly reason?: string }

// 長期記憶（v21・ADR-0016）
export interface WikiPageSummaryDto {
  readonly id: string;
  readonly wikiId?: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly version: number;
  readonly updatedAt: string;
}
export interface WikiPageDto extends WikiPageSummaryDto {
  readonly tenant: TenantScopeDto;
  readonly body: string;
  readonly sourceRuns: readonly string[];
}
export interface SaveWikiDto {
  readonly scope: TenantScopeDto;
  readonly id?: string;
  readonly wikiId?: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly sourceRunId?: string;
}
export interface WikiSpaceSummaryDto { readonly id: string; readonly name: string; readonly description: string; readonly updatedAt: string }
export interface WikiSpaceDto extends WikiSpaceSummaryDto { readonly tenant: TenantScopeDto; readonly createdAt: string }
export interface SaveWikiSpaceDto { readonly scope: TenantScopeDto; readonly id: string; readonly name: string; readonly description?: string }
export type MemoryProposalStateDto = 'draft' | 'approved' | 'rejected';
export type MemoryProposalTargetDto =
  | { readonly kind: 'wiki'; readonly wikiId?: string; readonly pageId: string; readonly isNewPage: boolean; readonly title: string; readonly tags: readonly string[]; readonly body: string }
  | { readonly kind: 'skill'; readonly skillId: string; readonly instructions: string };
export interface MemoryProposalDto {
  readonly id: string;
  readonly tenant: TenantScopeDto;
  readonly target: MemoryProposalTargetDto;
  readonly summary: string;
  readonly state: MemoryProposalStateDto;
  readonly sourceRun?: string;
  readonly createdAt: string;
}
export interface ReflectRunDto {
  readonly scope: TenantScopeDto;
  readonly input: string;
  readonly output: string;
  readonly sourceRunId?: string;
  readonly targetSkillId?: string;
  readonly existingWikiPageId?: string;
  readonly targetWikiId?: string;
}

// Agent Factory（v33・docs/16-agent-factory.md §6, §9）
export type FactoryRunStatusDto = 'queued' | 'running' | 'waiting-approval' | 'succeeded' | 'failed' | 'cancelled';
export type FactoryStageDto =
  | 'profiling' | 'planning' | 'generating-tools' | 'generating-skills'
  | 'assembling-agent' | 'generating-validation' | 'validating' | 'analyzing' | 'improving' | 'reporting';
export type FactoryEventKindDto =
  | 'stage_started' | 'stage_completed' | 'plan_proposed' | 'approval_requested' | 'approval_resolved'
  | 'tool_generated' | 'tool_reused' | 'tool_repair_attempted' | 'artifact_saved' | 'scenario_run_completed'
  | 'analysis_completed' | 'proposal_applied' | 'proposal_rejected' | 'iteration_completed'
  | 'budget_exceeded' | 'run_completed' | 'run_failed' | 'run_cancelled';
export interface FactoryVersionRefDto { readonly internalId: string; readonly version: string }
export interface FactoryEventDto {
  readonly sequence: number;
  readonly kind: FactoryEventKindDto;
  readonly at: string;
  readonly stage?: FactoryStageDto;
  readonly iteration?: number;
  readonly message?: string;
  readonly ref?: FactoryVersionRefDto;
}
export interface FactoryGoalInputDto {
  readonly goal: string;
  readonly targetUsers?: string;
  readonly constraints?: string;
  readonly language: 'ja' | 'en';
}
/**
 * 強化モードでの systemPrompt の扱い。`preserve` = 既存の役割文・実行規則を保ち、ガイド2節だけ差し替える。
 * `rewrite` = モデル（Assembler）に役割文・実行規則を書き直させる。生成モード（0→1）では無関係。
 */
export type FactoryPromptStrategyDto = 'preserve' | 'rewrite';
export interface FactoryOptionsDto {
  readonly maxIterations: number;
  readonly personaCount: number;
  readonly scenarioCount: number;
  readonly requirePlanApproval: boolean;
  readonly promptStrategy: FactoryPromptStrategyDto;
  readonly targets: { readonly minGoalAchievedRate: number; readonly minAvgSatisfaction: number };
  readonly budget: { readonly maxDurationMs: number; readonly maxRoleCalls: number; readonly maxScenarioRuns: number; readonly maxRepairAttempts: number; readonly maxProposalsPerIteration: number };
}
export interface FactoryToolPlanDto {
  readonly key: string;
  readonly displayName: string;
  readonly purpose: string;
  readonly dataSourceId: string;
  readonly sideEffect: SideEffectDto;
  readonly outputShape?: string;
  readonly argumentSummary?: string;
}
export interface FactorySkillPlanDto {
  readonly key: string;
  readonly displayName: string;
  readonly responsibility: string;
  readonly activationCondition: string;
  readonly toolKeys: readonly string[];
}
export type FactoryPersonaArchetypeDto = 'novice' | 'expert' | 'busy' | 'vague' | 'skeptical' | 'custom';
export interface FactoryPersonaPlanDto {
  readonly key: string;
  readonly archetype: FactoryPersonaArchetypeDto;
  readonly knowledgeLevel: 'low' | 'mid' | 'high';
  readonly patience: 'low' | 'mid' | 'high';
  readonly tone: string;
  readonly verbosity: 'terse' | 'normal' | 'chatty';
  readonly language: 'ja' | 'en';
  readonly extraInstructions?: string;
}
export interface FactoryScenarioPlanDto {
  readonly key: string;
  readonly goal: string;
  readonly context?: string;
  readonly personaKey: string;
  readonly expectedToolKeys: readonly string[];
  readonly maxUserTurns: number;
}
export interface FactoryPlanDto {
  readonly agentBrief: { readonly displayName: string; readonly role: string };
  readonly tools: readonly FactoryToolPlanDto[];
  readonly skills: readonly FactorySkillPlanDto[];
  readonly personas: readonly FactoryPersonaPlanDto[];
  readonly scenarios: readonly FactoryScenarioPlanDto[];
}
export interface FactoryPlanCheckpointDto {
  readonly kind: 'plan-approval';
  readonly expiresAt: string;
  readonly prompt: string;
  readonly plan: FactoryPlanDto;
}
export type FactoryFindingSeverityDto = 'info' | 'warning' | 'critical';
export interface FactoryFindingDto { readonly id: string; readonly severity: FactoryFindingSeverityDto; readonly area: string; readonly detail: string }
export interface FactoryIterationMetricsDto {
  readonly iteration: number;
  readonly goalAchievedRate: number;
  readonly avgSatisfaction: number;
  readonly toolHitRate: number;
  readonly errorRate: number;
  readonly avgUserTurns: number;
  readonly scenarioCount: number;
  readonly usage: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number };
  readonly durationMs: number;
}
export interface FactoryIterationDto {
  readonly index: number;
  readonly agentVersion: string;
  readonly scenarioRunIds: readonly string[];
  readonly metrics: FactoryIterationMetricsDto;
  readonly analysis?: { readonly findings: readonly FactoryFindingDto[]; readonly applied: readonly unknown[]; readonly rejected: readonly unknown[] };
}
export interface FactoryArtifactsDto {
  readonly tools: readonly FactoryVersionRefDto[];
  readonly skills: readonly FactoryVersionRefDto[];
  readonly agentVersions: readonly FactoryVersionRefDto[];
  readonly personas: readonly FactoryVersionRefDto[];
  readonly pseudoUsers: readonly FactoryVersionRefDto[];
  readonly scenarios: readonly FactoryVersionRefDto[];
}
export interface FactoryReportDto {
  readonly bestIteration: number;
  readonly candidate: { readonly agentId: string; readonly version: string };
  readonly summary: string;
  readonly openFindings: readonly FactoryFindingDto[];
  readonly metricsByIteration: readonly FactoryIterationMetricsDto[];
}
/**
 * 強化対象の既存Agent。設定されているRunは「既存Agentの強化モード」で走る
 * （新しいAgentを作らず、このAgentへTool/Skillを追加した新版を作る）。`version` 省略時は最新版が起点。
 */
export interface FactoryBaseAgentDto {
  readonly internalId: string;
  readonly version?: string;
}
export interface FactoryRunDto {
  readonly id: string;
  readonly scope: TenantScopeDto;
  readonly input: {
    readonly goal: FactoryGoalInputDto;
    readonly dataSourceIds: readonly string[];
    readonly options: FactoryOptionsDto;
    /** 未設定なら0→1生成モードのRun。 */
    readonly baseAgent?: FactoryBaseAgentDto;
  };
  readonly status: FactoryRunStatusDto;
  readonly stage: FactoryStageDto;
  readonly plan?: FactoryPlanDto;
  readonly artifacts: FactoryArtifactsDto;
  readonly iterations: readonly FactoryIterationDto[];
  readonly report?: FactoryReportDto;
  readonly checkpoint?: FactoryPlanCheckpointDto;
  readonly budget: { readonly consumed: { readonly roleCalls: number; readonly scenarioRuns: number; readonly elapsedMs: number }; readonly limits: FactoryOptionsDto['budget'] };
  readonly failure?: { readonly stage: FactoryStageDto; readonly reason: string };
  readonly events: readonly FactoryEventDto[];
  readonly startedAt: string;
  readonly finishedAt?: string;
}
export interface CreateFactoryRunDto {
  readonly scope: TenantScopeDto;
  readonly goal: FactoryGoalInputDto;
  /** 指定すると既存Agent強化モード。このとき `dataSourceIds` は空配列でよい（生成モードは1件以上必須）。 */
  readonly baseAgent?: FactoryBaseAgentDto;
  readonly dataSourceIds: readonly string[];
  readonly options?: {
    readonly maxIterations?: number;
    readonly personaCount?: number;
    readonly scenarioCount?: number;
    readonly requirePlanApproval?: boolean;
    /** 強化モード（`baseAgent` 指定）でのみ効く。省略時はサーバー既定の `preserve`。 */
    readonly promptStrategy?: FactoryPromptStrategyDto;
    readonly targets?: { readonly minGoalAchievedRate: number; readonly minAvgSatisfaction: number };
    readonly budget?: FactoryOptionsDto['budget'];
  };
}
export interface ResolveFactoryRunDto {
  readonly scope: TenantScopeDto;
  readonly response: { readonly kind: 'plan-approval'; readonly decision: 'approve' | 'revise' | 'reject'; readonly feedback?: string };
}

/**
 * MCPクライアント: 外部MCPサーバー接続設定。
 * transport は kind による判別union（stdio = 子プロセス / http = streamable-http）。
 */
export type McpTransportDto =
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly kind: 'http'; readonly url: string; readonly headers: Readonly<Record<string, string>> };
export interface McpServerDto {
  readonly scope: TenantScopeDto;
  readonly name: string;
  readonly transport: McpTransportDto;
  readonly disabled: boolean;
  readonly updatedAt: string;
}
/** POST /mcp-servers の body。 */
export interface SaveMcpServerDto {
  readonly scope: TenantScopeDto;
  readonly server: { readonly name: string; readonly transport: McpTransportDto; readonly disabled?: boolean };
}
/** PUT /mcp-servers の body。標準 `mcpServers` JSON の mcpServers 部をそのまま送る。 */
export interface ReplaceMcpServersDto {
  readonly scope: TenantScopeDto;
  readonly mcpServers: Readonly<Record<string, unknown>>;
}
/** POST /mcp-servers/:name/test の結果。接続失敗も ok:false として200で返る。 */
export interface McpServerTestResultDto {
  readonly ok: boolean;
  readonly tools?: readonly { readonly name: string; readonly description?: string }[];
  readonly error?: string;
}

/**
 * モデル設定（main / judge の切替）。
 *
 * **APIキーは応答に決して含まれない**。設定済みかどうか（configured）と、
 * 末尾4文字（hint）だけがマスク表示のために返る。保存時は平文を書き込み専用で送る:
 *   文字列 → 保存 / 省略 → 既存維持 / 空文字・null → クリア。
 * スロット（main / judge）が未設定なら、サーバーは環境変数の既定モデルを使う。
 */
export type ModelSettingsSourceDto = 'registry' | 'openai-compatible';
export type ModelSlotNameDto = 'main' | 'judge';
export interface MaskedApiKeyDto {
  readonly configured: boolean;
  readonly hint?: string;
}
export type ModelSlotSettingsDto =
  | { readonly source: 'registry'; readonly model: string; readonly apiKey: MaskedApiKeyDto }
  | { readonly source: 'openai-compatible'; readonly baseUrl: string; readonly model: string; readonly apiKey: MaskedApiKeyDto };
/**
 * 設定の保存先。`ephemeral` は再起動で設定が消える（サーバーが `:memory:` DBで動いている）。
 * UIは「揮発ストレージのため再起動で消えます」と警告する。
 */
export type ModelSettingsStorageDto = 'persistent' | 'ephemeral';
/** GET/PUT /model-settings の `settings`。スロット省略 = env 既定を使用中。 */
export interface ModelSettingsDto {
  readonly scope: TenantScopeDto;
  readonly main?: ModelSlotSettingsDto;
  readonly judge?: ModelSlotSettingsDto;
  readonly updatedAt?: string;
  /** GET のみ。PUT の応答には付かない。 */
  readonly storage?: ModelSettingsStorageDto;
}
/** PUT /model-settings の body のスロット部（apiKey は write-only）。 */
export interface ModelSlotSettingsInputDto {
  readonly source: ModelSettingsSourceDto;
  readonly baseUrl?: string;
  readonly model: string;
  readonly apiKey?: string | null;
}
/** PUT /model-settings の body。null を渡したスロットは設定を消して env 既定へ戻す。 */
export interface SaveModelSettingsDto {
  readonly scope: TenantScopeDto;
  readonly main?: ModelSlotSettingsInputDto | null;
  readonly judge?: ModelSlotSettingsInputDto | null;
}
/** POST /model-settings/test の body。candidate 省略で保存済み（無ければenv既定）設定を試す。 */
export interface TestModelSettingsDto {
  readonly scope: TenantScopeDto;
  readonly slot: ModelSlotNameDto;
  readonly candidate?: ModelSlotSettingsInputDto;
}
/**
 * 疎通テストの結果。接続失敗も ok:false として200で返る（入力不正は 400）。
 * `usedStoredKey` が false のとき、candidate の宛先が保存済み設定と異なるため
 * 保存済みキーを使わずに試している（UIは「キーを入力してください」と促せる）。
 */
export type ModelSettingsTestResultDto =
  | { readonly ok: true; readonly latencyMs: number; readonly reply: string; readonly usedStoredKey: boolean }
  | { readonly ok: false; readonly error: string; readonly usedStoredKey: boolean };
/**
 * GET /model-catalog は**接続先の見出しだけ**を返す（モデル名は含まない）。
 * モデルは提供元で頻繁に入れ替わり、Azure / Bedrock / Vertex ではデプロイ済みのものしか
 * 使えないため、選べるモデルは手入力か実エンドポイントへの問い合わせでしか決まらない。
 */
export interface ModelCatalogProviderDto {
  readonly id: string;
  readonly name: string;
  /** この見出しを選んだときに保存される設定の形式。 */
  readonly source: ModelSettingsSourceDto;
  /** APIキーを与える環境変数名（registry のみ）。 */
  readonly envVar?: string;
  /** 利用可能なモデルの一次情報（提供元のドキュメント）。 */
  readonly docUrl?: string;
  /** openai-compatible の baseUrl 雛形。`<resource>` のような穴は利用者が埋める。 */
  readonly baseUrlTemplate?: string;
  /** 保存済み baseUrl からこの見出しを引き当てるためのホスト接尾辞。 */
  readonly baseUrlHosts?: readonly string[];
}
export interface ModelCatalogDto {
  readonly providers: readonly ModelCatalogProviderDto[];
}
/** POST /model-catalog/openai-compatible-models の body（GETは廃止・CSRF緩和）。 */
export interface ListOpenAiCompatibleModelsDto {
  readonly scope: TenantScopeDto;
  readonly baseUrl: string;
  /** 指定時、保存済みキーは**保存済み baseUrl と一致するときだけ**使われる。 */
  readonly slot?: ModelSlotNameDto;
}
/** POST /model-catalog/openai-compatible-models の応答。 */
export interface OpenAiCompatibleModelsResultDto {
  readonly models: readonly string[];
  /** 保存済みキーを実際に使ったか（宛先不一致なら false）。 */
  readonly usedStoredKey: boolean;
}
/**
 * POST /sample-data の応答。オンボーディングの「サンプルを読み込む」で投入された資産の一覧。
 * `created` は今回新しく作成した件数（0 なら既に投入済みで、何も変更していない＝冪等）。
 */
export interface SampleDataSummaryDto {
  readonly dataSources: readonly string[];
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly wikis: readonly string[];
  readonly created: number;
}
