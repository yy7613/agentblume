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
export interface GraphNodeDto { readonly id: string; readonly type: string; readonly config: unknown }
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
  | { readonly sequence: number; readonly kind: 'error'; readonly code: string; readonly message: string };

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
}

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
}

export interface RunSavedAgentDto {
  readonly scope: TenantScopeDto;
  readonly agent: { readonly internalId: string; readonly version?: string };
  readonly message: string;
  readonly mode: 'preview' | 'test';
  /** 手動アタッチする Wiki ページ id（v21 M1）。 */
  readonly memoryPageIds?: readonly string[];
  readonly sessionId?: string;
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

export interface RunSummaryDto {
  readonly runId: string;
  readonly sessionId?: string;
  readonly status: 'running' | 'succeeded' | 'failed';
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
export interface RetentionPolicyDto { readonly scope: TenantScopeDto; readonly payloadDays: number; readonly traceDays: number; readonly aggregateDays: number; readonly updatedAt: string }
export interface RetentionApplyResultDto { readonly payloadRedacted: number; readonly traceRedacted: number; readonly deleted: number; readonly feedbackDeleted: number; readonly aggregateBucketsDeleted: number }

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
