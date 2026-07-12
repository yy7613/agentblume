import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { deserializeEvaluationDataset, deserializeEvaluatorProfile, serializeEvaluationDataset, serializeEvaluatorProfile } from './assets-serialization';
import { createEvaluationDataset } from './evaluation-dataset';
import { createEvaluatorProfile } from './evaluator-profile';

const metadata = { internalId: 'quality-set', workingName: 'Quality draft', displayName: 'Quality set', publishName: 'quality_set', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft' as const, tenant: { tenantId: 't', workspaceId: 'w' } };

describe('evaluation assets domain', () => {
  it('turn/scenario caseを防御的コピーしserialization往復する', () => {
    const tags = ['critical'];
    const dataset = createEvaluationDataset({ metadata, cases: [
      { id: 'turn-1', kind: 'turn', input: 'Summarize sales', reference: 'Sales were 42.', expectedTools: ['sales'], tags, source: 'manual' },
      { id: 'scenario-1', kind: 'scenario', scenario: { id: 'sales-flow', version: SemVer.of(2, 1, 0) }, tags: ['multi-turn'], source: 'manual' },
    ] });
    tags[0] = 'changed';
    expect(dataset.cases[0]?.tags).toEqual(['critical']);
    expect(deserializeEvaluationDataset(serializeEvaluationDataset(dataset))).toEqual(dataset);
  });

  it('case id重複、空input、重複tag、SemVerでないScenario参照を拒否する', () => {
    expect(() => createEvaluationDataset({ metadata, cases: [] })).toThrow(/at least one/);
    expect(() => createEvaluationDataset({ metadata, cases: [
      { id: 'same', kind: 'turn', input: 'x', tags: [], source: 'manual' },
      { id: 'same', kind: 'turn', input: 'y', tags: [], source: 'manual' },
    ] })).toThrow(/duplicate case id/);
    expect(() => createEvaluationDataset({ metadata, cases: [{ id: 'x', kind: 'turn', input: ' ', tags: [], source: 'manual' }] })).toThrow(/input/);
    expect(() => createEvaluationDataset({ metadata, cases: [{ id: 'x', kind: 'turn', input: 'x', tags: ['a', 'a'], source: 'manual' }] })).toThrow(/duplicate/);
    expect(() => createEvaluationDataset({ metadata, cases: [{ id: 'x', kind: 'scenario', scenario: { id: 's', version: '1.0.0' as unknown as SemVer }, tags: [], source: 'manual' }] })).toThrow(/SemVer/);
  });

  it('code scorer profileを検証してserialization往復する', () => {
    const profile = createEvaluatorProfile({ metadata: { ...metadata, internalId: 'default-evaluator' }, metrics: [
      { id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 2, required: true },
      { id: 'tone', kind: 'code', scorer: 'tone-consistency', weight: 1, required: false },
    ] });
    expect(deserializeEvaluatorProfile(serializeEvaluatorProfile(profile))).toEqual(profile);
    expect(() => createEvaluatorProfile({ metadata, metrics: [{ id: 'x', kind: 'code', scorer: 'unknown' as 'completeness', weight: 1, required: true }] })).toThrow(/unknown scorer/);
    expect(() => createEvaluatorProfile({ metadata, metrics: [{ id: 'x', kind: 'code', scorer: 'completeness', weight: 0, required: true }] })).toThrow(/positive/);
  });
});
