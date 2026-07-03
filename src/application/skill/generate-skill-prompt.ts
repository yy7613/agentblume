import { SkillValidationError } from '../../domain/skill/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

export interface SkillPromptInput { readonly scope: TenantScope; readonly displayName: string; readonly responsibility: string; readonly activationCondition: string; readonly inputDescription: string; readonly outputDescription: string; readonly tools: readonly { readonly internalId: string; readonly version: SemVer }[] }
export interface SkillPromptDraft { readonly promptDraft: string; readonly sections: { readonly responsibility: string; readonly activation: string; readonly ioContract: string; readonly toolGuide: string }; readonly editable: true; readonly sources: readonly string[] }
export class GenerateSkillPromptUseCase {
  constructor(private readonly tools: ToolRepository) {}
  async execute(input: SkillPromptInput): Promise<SkillPromptDraft> {
    for (const [name, value] of Object.entries({ displayName: input.displayName, responsibility: input.responsibility, activationCondition: input.activationCondition, inputDescription: input.inputDescription, outputDescription: input.outputDescription })) if (value.trim().length === 0) throw new SkillValidationError(`GenerateSkillPrompt: ${name} is required`);
    const loaded: Tool[] = [];
    for (const ref of input.tools) { const tool = await this.tools.findVersion(input.scope, ref.internalId, ref.version); if (tool === null) throw new SkillValidationError(`GenerateSkillPrompt: tool not found: ${ref.internalId}@${ref.version.toString()}`); loaded.push(tool); }
    const responsibility = `# Skill: ${input.displayName}\n責務: ${input.responsibility}`;
    const activation = `# 発火条件\n${input.activationCondition}`;
    const ioContract = `# 入出力\n入力: ${input.inputDescription}\n出力: ${input.outputDescription}`;
    const toolGuide = `# 使用Tool\n${loaded.length === 0 ? '依存Toolなし' : loaded.map((tool) => `- ${tool.metadata.publishName}@${tool.metadata.version.toString()}: ${tool.metadata.displayName}`).join('\n')}`;
    return { promptDraft: [responsibility, activation, ioContract, toolGuide].join('\n\n'), sections: { responsibility, activation, ioContract, toolGuide }, editable: true, sources: loaded.map((tool) => `tool:${tool.metadata.publishName}@${tool.metadata.version.toString()}`) };
  }
}
