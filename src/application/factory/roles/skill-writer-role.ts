/**
 * application層: Agent Factory Stage 3 SkillWriterロール（v33 実装契約 §3 / docs/16-agent-factory.md §3, §4 Stage 3）。
 *
 * Skill計画1件のresponsibility/activationCondition/入出力説明/instructionsを起草する。入力（skillPlan・
 * toolContracts）はいずれもPlanner/ToolSmithの検証済み出力（アプリ管理のデータ）であり、v25 Judgeのような
 * untrusted-data隔離は不要（温度0のみ維持する）。
 */
import { FactoryValidationError } from '../../../domain/factory/errors';
import type { FactorySkillPlan } from '../../../domain/factory/factory-plan';
import type { JsonSchemaObject, ModelProviderPort } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';

/**
 * この役割がモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/skill-writer.md` にあり、
 * 条件で入れ替わる行は無いので節は 1 つだけ。
 */
export const SKILL_WRITER_PROMPT: PromptSpec = { id: 'factory/skill-writer', sections: ['system'] };

const SKILL_WRITER_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['responsibility', 'activationCondition', 'inputDescription', 'outputDescription', 'instructions'],
  properties: {
    responsibility: { type: 'string' },
    activationCondition: { type: 'string' },
    inputDescription: { type: 'string' },
    outputDescription: { type: 'string' },
    instructions: { type: 'string' },
  },
};

export interface SkillWriterToolContract {
  readonly name: string;
  readonly description: string;
}

export interface SkillWriterRoleInput {
  readonly skillPlan: FactorySkillPlan;
  readonly toolContracts: readonly SkillWriterToolContract[];
}

export interface SkillWriterProposal {
  readonly responsibility: string;
  readonly activationCondition: string;
  readonly inputDescription: string;
  readonly outputDescription: string;
  readonly instructions: string;
}

const PROPOSAL_FIELDS = ['responsibility', 'activationCondition', 'inputDescription', 'outputDescription', 'instructions'] as const;

export class SkillWriterRole {
  constructor(private readonly model: ModelProviderPort, private readonly prompts: PromptCatalogPort) {}

  available(): boolean {
    return this.model.capabilities().includes('structured-output');
  }

  async propose(input: SkillWriterRoleInput, signal?: AbortSignal): Promise<SkillWriterProposal> {
    if (!this.available()) throw new FactoryValidationError('SkillWriterRole: model does not support structured output');
    const system = this.prompts.get(SKILL_WRITER_PROMPT.id).render('system');
    const payload = { skillPlan: input.skillPlan, toolContracts: input.toolContracts };
    const completion = await this.model.complete({
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      responseFormat: { name: 'factory_skill_proposal', strict: true, schema: SKILL_WRITER_SCHEMA },
    }, signal);
    return parseProposal(completion.message.content);
  }
}

function parseProposal(content: string | null): SkillWriterProposal {
  if (content === null) throw new FactoryValidationError('SkillWriterRole: model returned empty content');
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw new FactoryValidationError(`SkillWriterRole: invalid JSON: ${String(error)}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FactoryValidationError('SkillWriterRole: response is not a JSON object');
  const record = value as Record<string, unknown>;
  for (const field of PROPOSAL_FIELDS) {
    if (typeof record[field] !== 'string') throw new FactoryValidationError(`SkillWriterRole: response is missing string field: ${field}`);
  }
  return {
    responsibility: record['responsibility'] as string,
    activationCondition: record['activationCondition'] as string,
    inputDescription: record['inputDescription'] as string,
    outputDescription: record['outputDescription'] as string,
    instructions: record['instructions'] as string,
  };
}
