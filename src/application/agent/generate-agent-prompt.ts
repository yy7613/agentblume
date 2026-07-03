import type { AgentKind } from '../../domain/agent/agent';
import { AgentValidationError } from '../../domain/agent/errors';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import type { Schema } from '../../domain/data/types';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

export interface PromptToolRef { readonly internalId: string; readonly version: SemVer }
export interface AgentPromptDraft {
  readonly systemPromptDraft: string;
  readonly sections: { readonly role: string; readonly toolUsageGuide: string; readonly rules: string };
  readonly editable: true;
  readonly sources: readonly string[];
}

const KIND_GUIDE: Record<AgentKind, string> = {
  normal: '利用者の依頼を理解し、必要な場合だけToolを使用して回答してください。',
  'pseudo-user': '指定された利用者像を一貫して再現し、現実的な要求と反応を返してください。',
  evaluator: '対象の結果を根拠に基づいて評価し、判断理由を明示してください。',
};

export class GenerateAgentPromptUseCase {
  constructor(private readonly tools: ToolRepository) {}

  async execute(input: { readonly scope: TenantScope; readonly displayName: string; readonly kind: AgentKind; readonly tools: readonly PromptToolRef[]; readonly output?: StructuredOutputDefinition }): Promise<AgentPromptDraft> {
    if (input.displayName.trim().length === 0) throw new AgentValidationError('GenerateAgentPrompt: displayName is required');
    const loaded: Tool[] = [];
    for (const ref of input.tools) {
      const tool = await this.tools.findVersion(input.scope, ref.internalId, ref.version);
      if (tool === null) throw new AgentValidationError(`GenerateAgentPrompt: tool not found: ${ref.internalId}@${ref.version.toString()}`);
      loaded.push(tool);
    }
    const role = `# 役割\nあなたは「${input.displayName}」です。${KIND_GUIDE[input.kind]}`;
    const toolUsageGuide = loaded.length === 0
      ? '# Tool使用ガイド\n利用可能なToolはありません。'
      : `# Tool使用ガイド\n${loaded.map(toolGuide).join('\n')}`;
    const outputRule = input.output === undefined
      ? ''
      : `\n- 最終応答はJSON objectとし、次のfield契約を満たす: ${input.output.fields.map((field) => `${field.name}:${field.type}${field.required ? '' : '?'}`).join(', ')}。`;
    const rules = `# 実行規則\n- Tool名は公開名をそのまま使用する。\n- Toolの入力スキーマを満たす引数だけを渡す。\n- Tool結果を推測で補完せず、回答に使用した事実を区別する。\n- writeまたはexternal-actionのToolは明示的な承認なしに実行しない。${outputRule}`;
    return {
      systemPromptDraft: [role, toolUsageGuide, rules].join('\n\n'),
      sections: { role, toolUsageGuide, rules },
      editable: true,
      sources: loaded.map((tool) => `tool:${tool.metadata.publishName}@${tool.metadata.version.toString()} の入出力・副作用`),
    };
  }
}

function schemaLabel(schema?: Schema): string {
  if (schema === undefined || schema.columns.length === 0) return 'なし';
  return schema.columns.map((column) => `${column.name}:${column.type}${column.nullable ? '?' : ''}`).join(', ');
}

function toolGuide(tool: Tool): string {
  return `- ${tool.metadata.publishName}@${tool.metadata.version.toString()}（${tool.metadata.displayName}）: input [${schemaLabel(tool.inputSchema)}] / output [${schemaLabel(tool.outputSchema)}] / side-effect ${tool.sideEffect}`;
}
