import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { deserializeJudgeRubric, serializeJudgeRubric } from './assets-serialization';
import { EvaluationDomainError } from './errors';
import { createJudgeRubric } from './judge-rubric';

const metadata = { internalId: 'quality', workingName: 'Quality', displayName: 'Quality', publishName: 'quality', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft' as const, tenant: { tenantId: 't', workspaceId: 'w' } };
const criterion = { id: 'accuracy', label: 'Accuracy', description: 'Judge factual correctness.', weight: 1, levels: [{ score: 1, label: 'Correct', description: 'Fully correct.' }, { score: 0, label: 'Wrong', description: 'Incorrect.' }, { score: 0.5, label: 'Partial', description: 'Partially correct.' }] };

describe('JudgeRubric', () => {
  it('0..1の採点基準を正規化してserialization round-tripする', () => {
    const rubric = createJudgeRubric({ metadata, instructions: 'Evaluate accuracy and safety.', criteria: [criterion], referencePolicy: 'optional', reasonRequired: true });
    expect(rubric.criteria[0]?.levels.map((level) => level.score)).toEqual([0, 0.5, 1]);
    expect(deserializeJudgeRubric(serializeJudgeRubric(rubric))).toEqual(rubric);
  });
  it('不正な基準、重複、理由任意化を拒否する', () => {
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, levels: criterion.levels.slice(1) }], referencePolicy: 'required', reasonRequired: true })).toThrow(/score 0 and 1/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [criterion, criterion], referencePolicy: 'optional', reasonRequired: true })).toThrow(/duplicate criterion/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [criterion], referencePolicy: 'forbidden', reasonRequired: false as true })).toThrow(EvaluationDomainError);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [], referencePolicy: 'optional', reasonRequired: true })).toThrow(/at least one/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, weight: 0 }], referencePolicy: 'optional', reasonRequired: true })).toThrow(/weight/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, levels: [criterion.levels[0]!] }], referencePolicy: 'optional', reasonRequired: true })).toThrow(/at least two/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, levels: [{ ...criterion.levels[0]!, score: -0.1 }, criterion.levels[1]!] }], referencePolicy: 'optional', reasonRequired: true })).toThrow(/between 0 and 1/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, levels: [criterion.levels[0]!, { ...criterion.levels[0]!, label: 'Duplicate' }] }], referencePolicy: 'optional', reasonRequired: true })).toThrow(/duplicate score/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [criterion], referencePolicy: 'invalid' as 'optional', reasonRequired: true })).toThrow(/referencePolicy/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, label: '' }], referencePolicy: 'optional', reasonRequired: true })).toThrow(/label/);
    expect(() => createJudgeRubric({ metadata, instructions: 'x', criteria: [{ ...criterion, levels: [{ ...criterion.levels[0]!, label: '' }, criterion.levels[1]!] }], referencePolicy: 'optional', reasonRequired: true })).toThrow(/label/);
  });
});
