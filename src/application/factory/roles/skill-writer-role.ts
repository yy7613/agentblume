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
  constructor(private readonly model: ModelProviderPort) {}

  available(): boolean {
    return this.model.capabilities().includes('structured-output');
  }

  async propose(input: SkillWriterRoleInput, signal?: AbortSignal): Promise<SkillWriterProposal> {
    if (!this.available()) throw new FactoryValidationError('SkillWriterRole: model does not support structured output');
    const system = [
      'You are the SkillWriter role of an internal Agent Factory generation pipeline.',
      'Draft the responsibility, activation condition, input/output descriptions, and instructions for one skill plan.',
      'Rules:',
      '- Base the draft only on the given skill plan and the tool contracts it depends on.',
      '- instructions must tell the agent exactly how and when to use the listed tools to fulfill the responsibility.',
      '- If no tool contracts are given, write instructions that do not reference any tool.',
      '- Keep all fields concise and actionable.',
      'Return only the JSON object matching the provided schema. Do not include any prose outside the JSON.',
    ].join('\n');
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
