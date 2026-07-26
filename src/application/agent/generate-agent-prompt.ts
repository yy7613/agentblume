import type { AgentKind, AgentSubAgentRef } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentValidationError } from '../../domain/agent/errors';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import type { Schema } from '../../domain/data/types';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { resolveAgentCapabilities } from './resolve-agent-capabilities';

export interface PromptToolRef { readonly internalId: string; readonly version: SemVer }
export interface AgentPromptDraft {
  readonly systemPromptDraft: string;
  readonly sections: { readonly role: string; readonly skillGuide: string; readonly toolUsageGuide: string; readonly collaboratorGuide: string; readonly rules: string };
  readonly editable: true;
  readonly sources: readonly string[];
}

const KIND_GUIDE: Record<AgentKind, string> = {
  normal: '利用者の依頼を理解し、必要な場合だけToolを使用して回答してください。',
  'pseudo-user': '指定された利用者像を一貫して再現し、現実的な要求と反応を返してください。',
  evaluator: '対象の結果を根拠に基づいて評価し、判断理由を明示してください。',
};

export class GenerateAgentPromptUseCase {
  constructor(private readonly tools: ToolRepository, private readonly skills?: SkillRepository, private readonly agents?: AgentRepository) {}

  async execute(input: { readonly scope: TenantScope; readonly displayName: string; readonly kind: AgentKind; readonly skills?: readonly PromptToolRef[]; readonly tools: readonly PromptToolRef[]; readonly agents?: readonly AgentSubAgentRef[]; readonly output?: StructuredOutputDefinition }): Promise<AgentPromptDraft> {
    if (input.displayName.trim().length === 0) throw new AgentValidationError('GenerateAgentPrompt: displayName is required');
    let resolved;
    try { resolved = await resolveAgentCapabilities(input.scope, input.skills ?? [], input.tools, this.tools, this.skills, input.agents ?? [], this.agents); }
    catch (error) { throw error instanceof AgentValidationError ? new AgentValidationError(`GenerateAgentPrompt: ${error.message}`) : error; }
    const loaded = resolved.tools;
    const role = `# 役割\nあなたは「${input.displayName}」です。${KIND_GUIDE[input.kind]}`;
    const skillGuide = resolved.skills.length === 0
      ? '# Skillガイド\n適用するSkillはありません。'
      : `# Skillガイド\n${resolved.skills.map((skill) => `- ${skill.metadata.publishName}@${skill.metadata.version.toString()}: ${skill.responsibility}\n  発火条件: ${skill.activationCondition}\n  instructions: ${skill.instructions}`).join('\n')}`;
    // nullable な引数を持つToolがあるときだけ、省略可能引数の意味を1行で補足する。
    const optionalArgumentNote = loaded.some((tool) => (tool.inputSchema?.columns ?? []).some((column) => column.nullable))
      ? '\n- `?` 付きの引数は省略可能。省略するとその条件での絞り込みを行わない（全件が対象になる）。'
      : '';
    const toolUsageGuide = loaded.length === 0
      ? '# Tool使用ガイド\n利用可能なToolはありません。'
      : `# Tool使用ガイド\n${loaded.map(toolGuide).join('\n')}${optionalArgumentNote}`;
    const collaboratorGuide = resolved.subAgents.length === 0
      ? '# 協働者ガイド\n委譲できるサブエージェントはありません。'
      : `# 協働者ガイド\n委譲は ${resolved.subAgents.map((sub) => sub.toolName).join(' / ')} ツールで行う。\n${resolved.subAgents.map((sub) => `- ${sub.toolName}（${sub.agent.metadata.displayName}@${sub.agent.metadata.version.toString()}）: ${sub.ref.usage}`).join('\n')}`;
    const outputRule = input.output === undefined
      ? ''
      : `\n- 最終応答はJSON objectとし、次のfield契約を満たす: ${input.output.fields.map((field) => `${field.name}:${field.type}${field.required ? '' : '?'}`).join(', ')}。`;
    const rules = `# 実行規則\n- Tool名は公開名をそのまま使用する。\n- Toolの入力スキーマを満たす引数だけを渡す。\n- Tool結果を推測で補完せず、回答に使用した事実を区別する。\n- writeまたはexternal-actionのToolは明示的な承認なしに実行しない。\n- サブエージェントへの委譲は上記の協働者ガイドの基準に従い、messageに具体的な指示を渡す。${outputRule}`;
    return {
      systemPromptDraft: [role, skillGuide, toolUsageGuide, collaboratorGuide, rules].join('\n\n'),
      sections: { role, skillGuide, toolUsageGuide, collaboratorGuide, rules },
      editable: true,
      sources: [
        ...resolved.skills.map((skill) => `skill:${skill.metadata.publishName}@${skill.metadata.version.toString()} の責務・発火条件・instructions`),
        ...loaded.map((tool) => `tool:${tool.metadata.publishName}@${tool.metadata.version.toString()} の入出力・副作用`),
        ...resolved.subAgents.map((sub) => `agent:${sub.agent.metadata.publishName}@${sub.agent.metadata.version.toString()} の委譲基準`),
      ],
    };
  }
}

function schemaLabel(schema?: Schema): string {
  if (schema === undefined || schema.columns.length === 0) return 'なし';
  return schema.columns.map((column) => `${column.name}:${column.type}${column.nullable ? '?' : ''}`).join(', ');
}

/**
 * Tool引数の表記。nullable な引数は「省略できる」ことが要点なので、値がnull許容であることを示す
 * output 側の `name:type?` ではなく、TypeScript 風の `name?:type` で省略可能性を前に出す。
 */
function argumentLabel(schema?: Schema): string {
  if (schema === undefined || schema.columns.length === 0) return 'なし';
  return schema.columns.map((column) => `${column.name}${column.nullable ? '?' : ''}:${column.type}`).join(', ');
}

function toolGuide(tool: Tool): string {
  const name = tool.agentTool?.name ?? tool.metadata.publishName;
  const description = tool.agentTool?.description ?? tool.metadata.displayName;
  return `- ${name}@${tool.metadata.version.toString()}（${description}）: input [${argumentLabel(tool.inputSchema)}] / output [${schemaLabel(tool.outputSchema)}] / side-effect ${tool.sideEffect}`;
}
