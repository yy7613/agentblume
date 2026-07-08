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
export type SideEffectDto = 'read-only' | 'write' | 'external-action';
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
export interface AgentToolRefDto { readonly internalId: string; readonly version: string }
export interface AgentSubAgentRefDto { readonly internalId: string; readonly version: string; readonly usage: string }
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
  readonly mode: 'preview' | 'test';
  readonly agent?: { readonly internalId: string; readonly publishName?: string; readonly version?: string };
  readonly tool?: { readonly internalId: string; readonly publishName?: string; readonly version?: string };
  readonly tools?: readonly { readonly internalId: string; readonly publishName?: string; readonly version?: string }[];
  readonly response: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEventDto[];
  readonly usage: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number };
}

export interface RunAgentDto {
  readonly scope: TenantScopeDto;
  readonly tool: { readonly internalId: string; readonly version?: string };
  readonly systemPrompt: string;
  readonly message: string;
  readonly mode: 'preview' | 'test';
}

export interface RunSavedAgentDto {
  readonly scope: TenantScopeDto;
  readonly agent: { readonly internalId: string; readonly version?: string };
  readonly message: string;
  readonly mode: 'preview' | 'test';
}

export interface RunSummaryDto {
  readonly runId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly mode: 'preview' | 'test';
  readonly agent?: { readonly internalId: string; readonly version?: string; readonly publishName?: string };
  readonly tool?: { readonly internalId: string; readonly version?: string; readonly publishName?: string };
  readonly tools?: readonly { readonly internalId: string; readonly version?: string; readonly publishName?: string }[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly usage?: AgentPreviewRunDto['usage'];
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
  readonly persona: { readonly personaId: string; readonly version: string };
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
  readonly persona: { readonly personaId: string; readonly version: string };
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
