import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { SkillValidationError } from './errors';
import { deserializeSkill, serializeSkill } from './serialization';
import { createSkill } from './skill';

function valid() {
  return {
    metadata: {
      internalId: 'analysis', workingName: 'Analysis draft', displayName: 'Data analysis',
      publishName: 'data_analysis', version: SemVer.of(1, 0, 0), owner: 'owner',
      state: 'draft' as const, tenant: { tenantId: 'tenant', workspaceId: 'workspace' },
    },
    responsibility: 'Analyze structured data.', activationCondition: 'Use for data questions.',
    inputDescription: 'A request and data.', outputDescription: 'A grounded answer.',
    instructions: 'Use fixed Tool versions.',
    tools: [{ internalId: 'scores', version: SemVer.of(2, 1, 0) }],
  };
}

describe('Skill aggregate', () => {
  it('生成・serialize・deserializeで値を維持し入力を複製する', () => {
    const input = valid();
    const skill = createSkill(input);
    input.metadata.tenant.tenantId = 'changed';
    input.tools[0]!.internalId = 'changed';
    expect(skill.metadata.tenant.tenantId).toBe('tenant');
    expect(skill.tools[0]?.internalId).toBe('scores');
    expect(serializeSkill(deserializeSkill(serializeSkill(skill)))).toEqual(serializeSkill(skill));
  });

  it('空instructions、重複Tool、不正serialized dataを拒否する', () => {
    expect(() => createSkill({ ...valid(), instructions: ' ' })).toThrow(SkillValidationError);
    const ref = { internalId: 'scores', version: SemVer.of(1, 0, 0) };
    expect(() => createSkill({ ...valid(), tools: [ref, ref] })).toThrow(/duplicate tool/);
    expect(() => deserializeSkill({ nope: true })).toThrow(SkillValidationError);
  });
});
