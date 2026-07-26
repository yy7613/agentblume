import type { ToolId, TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { AgentValidationError } from './errors';
import { createStructuredOutput, type StructuredOutputDefinition } from './structured-output';

export const AGENT_KINDS = ['normal', 'pseudo-user', 'evaluator'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: SemVer;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

export interface AgentToolRef {
  readonly internalId: ToolId;
  readonly version: SemVer;
}

export interface AgentSkillRef {
  readonly internalId: string;
  readonly version: SemVer;
}

export interface AgentSubAgentRef {
  readonly internalId: string;
  readonly version: SemVer;
  /** 委譲基準（非空）。LLMへ提示するサブエージェント委譲ツールの説明文になる。 */
  readonly usage: string;
}

export interface AgentPersonaRef {
  readonly personaId: string;
  readonly version: SemVer;
}

export interface AgentWikiRef { readonly wikiId: string }

/**
 * 単一Agent実行のランタイムハーネス設定（Agent単位のopt-in）。
 *
 * マルチエージェント機能（domain/harness）の `Harness*` 型とは別物で、こちらは
 * 1エージェント実行のループそのものへ組み込む機能スイッチ。
 */
export interface AgentRuntimeHarness {
  /** Wikiベースの永続メモツール（memory_list / memory_read / memory_write）を注入する。 */
  readonly fileMemory: boolean;
  /** todos_add / todos_complete ツールを注入する。 */
  readonly todoProvider: boolean;
  /** 予算超過時に文脈を自動圧縮する。 */
  readonly compaction: boolean;
  /** web_search ツールを注入する。 */
  readonly webSearch: boolean;
  /** 書き込み系ツールの実行前承認（実行系は後続Wave。現状は設定の保存のみ）。 */
  readonly toolApproval: boolean;
  /** ツール自動実行ループ。false ならモデルへツールを一切渡さない。 */
  readonly functionInvocation: boolean;
}

/** harness 未指定Agentと同じ挙動を表す既定値（functionInvocation だけが有効）。 */
export const DEFAULT_AGENT_RUNTIME_HARNESS: AgentRuntimeHarness = {
  fileMemory: false,
  todoProvider: false,
  compaction: false,
  webSearch: false,
  toolApproval: false,
  functionInvocation: true,
};

const AGENT_RUNTIME_HARNESS_FIELDS = ['fileMemory', 'todoProvider', 'compaction', 'webSearch', 'toolApproval', 'functionInvocation'] as const;

function normalizeHarness(harness: AgentRuntimeHarness): AgentRuntimeHarness {
  if (harness === null || typeof harness !== 'object') {
    throw new AgentValidationError('createAgent: harness must be an object');
  }
  for (const field of AGENT_RUNTIME_HARNESS_FIELDS) {
    if (typeof harness[field] !== 'boolean') {
      throw new AgentValidationError(`createAgent: harness.${field} must be a boolean`);
    }
  }
  return {
    fileMemory: harness.fileMemory,
    todoProvider: harness.todoProvider,
    compaction: harness.compaction,
    webSearch: harness.webSearch,
    toolApproval: harness.toolApproval,
    functionInvocation: harness.functionInvocation,
  };
}

/** 1Agentが参照できるMCPサーバー数の上限（Run開始時のツール一覧取得を有界にする）。 */
export const AGENT_MAX_MCP_SERVERS = 8;
/** MCPサーバー名の最大長（domain/mcp の MCP_SERVER_NAME_MAX_LENGTH と同値）。 */
export const AGENT_MCP_SERVER_NAME_MAX_LENGTH = 64;

/**
 * MCPサーバー名の参照リストを検証しつつ複製する。
 * 実在チェックはここでは行わない（設定は別集約であり、実行時に解決してスキップできる）。
 */
function normalizeMcpServers(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new AgentValidationError('createAgent: mcpServers must be an array');
  if (value.length > AGENT_MAX_MCP_SERVERS) {
    throw new AgentValidationError(`createAgent: mcpServers must have at most ${AGENT_MAX_MCP_SERVERS} entries`);
  }
  const seen = new Set<string>();
  return value.map((name, index) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed === '' || trimmed.length > AGENT_MCP_SERVER_NAME_MAX_LENGTH) {
      throw new AgentValidationError(`createAgent: mcpServers.${index} must be a non-empty string of at most ${AGENT_MCP_SERVER_NAME_MAX_LENGTH} characters`);
    }
    if (seen.has(trimmed)) throw new AgentValidationError(`createAgent: duplicate MCP server reference: ${trimmed}`);
    seen.add(trimmed);
    return trimmed;
  });
}

export interface Agent {
  readonly metadata: AgentMetadata;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly skills: readonly AgentSkillRef[];
  readonly tools: readonly AgentToolRef[];
  readonly agents: readonly AgentSubAgentRef[];
  /** 利用可能な名前付きWikiのallowlist。旧Agentでは未指定。 */
  readonly wikis?: readonly AgentWikiRef[];
  /** ツールを注入する保存済みMCPサーバー名（同一スコープ）。旧Agentでは未指定。 */
  readonly mcpServers?: readonly string[];
  /** ランタイムハーネス設定。未指定は従来動作（DEFAULT_AGENT_RUNTIME_HARNESS 相当）。 */
  readonly harness?: AgentRuntimeHarness;
  /** kind==='pseudo-user' のときのみ許可。由来Personaを指す（v18）。 */
  readonly persona?: AgentPersonaRef;
  readonly output?: StructuredOutputDefinition;
}

export interface CreateAgentProps {
  readonly metadata: AgentMetadata;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly skills?: readonly AgentSkillRef[];
  readonly tools: readonly AgentToolRef[];
  readonly agents?: readonly AgentSubAgentRef[];
  readonly wikis?: readonly AgentWikiRef[];
  readonly mcpServers?: readonly string[];
  readonly harness?: AgentRuntimeHarness;
  readonly persona?: AgentPersonaRef;
  readonly output?: StructuredOutputDefinition;
}

/** サブエージェント委譲ツールの名前。LLMへは ask_{publishName} として提示する。 */
export function subAgentToolName(publishName: string): string {
  return `ask_${publishName}`;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentValidationError(`createAgent: ${field} must be a non-empty string`);
  }
}

export function createAgent(props: CreateAgentProps): Agent {
  const { metadata } = props;
  if (metadata === null || typeof metadata !== 'object') {
    throw new AgentValidationError('createAgent: metadata is required');
  }
  nonEmpty(metadata.internalId, 'metadata.internalId');
  nonEmpty(metadata.workingName, 'metadata.workingName');
  nonEmpty(metadata.displayName, 'metadata.displayName');
  nonEmpty(metadata.publishName, 'metadata.publishName');
  nonEmpty(metadata.owner, 'metadata.owner');
  nonEmpty(metadata.tenant?.tenantId, 'metadata.tenant.tenantId');
  nonEmpty(metadata.tenant?.workspaceId, 'metadata.tenant.workspaceId');
  if (!(metadata.version instanceof SemVer)) {
    throw new AgentValidationError('createAgent: metadata.version must be a SemVer instance');
  }
  if (!isPublishState(metadata.state)) {
    throw new AgentValidationError(`createAgent: invalid state: ${String(metadata.state)}`);
  }
  if (!(AGENT_KINDS as readonly unknown[]).includes(props.kind)) {
    throw new AgentValidationError(`createAgent: invalid kind: ${String(props.kind)}`);
  }
  nonEmpty(props.systemPrompt, 'systemPrompt');

  const seenSkills = new Set<string>();
  const skills = (props.skills ?? []).map((skill, index) => {
    nonEmpty(skill.internalId, `skills.${index}.internalId`);
    if (!(skill.version instanceof SemVer)) {
      throw new AgentValidationError(`createAgent: skills.${index}.version must be a SemVer instance`);
    }
    const key = `${skill.internalId}@${skill.version.toString()}`;
    if (seenSkills.has(key)) throw new AgentValidationError(`createAgent: duplicate skill reference: ${key}`);
    seenSkills.add(key);
    return { internalId: skill.internalId, version: skill.version };
  });

  const seen = new Set<string>();
  const tools = props.tools.map((tool, index) => {
    nonEmpty(tool.internalId, `tools.${index}.internalId`);
    if (!(tool.version instanceof SemVer)) {
      throw new AgentValidationError(`createAgent: tools.${index}.version must be a SemVer instance`);
    }
    const key = `${tool.internalId}@${tool.version.toString()}`;
    if (seen.has(key)) throw new AgentValidationError(`createAgent: duplicate tool reference: ${key}`);
    seen.add(key);
    return { internalId: tool.internalId, version: tool.version };
  });

  const seenSubAgents = new Set<string>();
  const agents = (props.agents ?? []).map((sub, index) => {
    nonEmpty(sub.internalId, `agents.${index}.internalId`);
    if (!(sub.version instanceof SemVer)) {
      throw new AgentValidationError(`createAgent: agents.${index}.version must be a SemVer instance`);
    }
    nonEmpty(sub.usage, `agents.${index}.usage`);
    if (sub.internalId === metadata.internalId) {
      throw new AgentValidationError(`createAgent: agent cannot reference itself as a sub-agent: ${sub.internalId}`);
    }
    // 同一 internalId は（バージョン違いでも）1参照に限る。
    if (seenSubAgents.has(sub.internalId)) {
      throw new AgentValidationError(`createAgent: duplicate sub-agent reference: ${sub.internalId}`);
    }
    seenSubAgents.add(sub.internalId);
    return { internalId: sub.internalId, version: sub.version, usage: sub.usage };
  });

  const seenWikis = new Set<string>();
  const wikis = (props.wikis ?? []).map((wiki, index) => {
    nonEmpty(wiki.wikiId, `wikis.${index}.wikiId`);
    if (seenWikis.has(wiki.wikiId)) throw new AgentValidationError(`createAgent: duplicate wiki reference: ${wiki.wikiId}`);
    seenWikis.add(wiki.wikiId);
    return { wikiId: wiki.wikiId };
  });

  const mcpServers = normalizeMcpServers(props.mcpServers ?? []);

  // v18: Persona由来の疑似ユーザーAgentは persona 参照を持ち、能力（tools/skills/agents）を持たない。
  if (props.persona !== undefined) {
    nonEmpty(props.persona.personaId, 'persona.personaId');
    if (!(props.persona.version instanceof SemVer)) {
      throw new AgentValidationError('createAgent: persona.version must be a SemVer instance');
    }
    if (props.kind !== 'pseudo-user') {
      throw new AgentValidationError('createAgent: persona is only allowed for kind "pseudo-user"');
    }
  }
  if (props.kind === 'pseudo-user' && (skills.length > 0 || tools.length > 0 || agents.length > 0 || wikis.length > 0)) {
    throw new AgentValidationError('createAgent: pseudo-user agents must have no skills, tools, sub-agents, or wikis (v18 constraint)');
  }

  return {
    metadata: {
      internalId: metadata.internalId,
      workingName: metadata.workingName,
      displayName: metadata.displayName,
      publishName: metadata.publishName,
      version: metadata.version,
      owner: metadata.owner,
      state: metadata.state,
      tenant: { tenantId: metadata.tenant.tenantId, workspaceId: metadata.tenant.workspaceId },
    },
    kind: props.kind,
    systemPrompt: props.systemPrompt,
    skills,
    tools,
    agents,
    ...(wikis.length > 0 ? { wikis } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(props.harness !== undefined ? { harness: normalizeHarness(props.harness) } : {}),
    ...(props.persona !== undefined ? { persona: { personaId: props.persona.personaId, version: props.persona.version } } : {}),
    ...(props.output !== undefined ? { output: createStructuredOutput(props.output) } : {}),
  };
}
