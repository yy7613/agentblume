import { describe, expect, it } from 'vitest';
import type { EvaluationDatasetRepository, EvaluationDatasetSummary, EvaluatorProfileRepository, EvaluatorProfileSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import type { EvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import type { EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { TenantScope } from '../../domain/tool/ids';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import { SemVer } from '../../domain/tool/semver';
import { ExportEvaluationDatasetUseCase, ImportEvaluationCasesUseCase } from './evaluation-dataset-transfer';
import { SaveEvaluationDatasetUseCase } from './save-evaluation-dataset';
import { SaveEvaluatorProfileUseCase } from './save-evaluator-profile';

const scope = { tenantId: 't', workspaceId: 'w' };
const scenarios = { findVersion: async (_scope: unknown, id: string, version: SemVer) => id === 'scenario' && version.toString() === '1.0.0' ? {} : null } as ScenarioRepository;

class DatasetRepo implements EvaluationDatasetRepository {
  readonly values: EvaluationDataset[] = [];
  async save(value: EvaluationDataset): Promise<void> { this.values.push(value); }
  async findVersion(): Promise<EvaluationDataset | null> { return null; }
  async findLatest(): Promise<EvaluationDataset | null> { return null; }
  async listVersions(_scope: TenantScope, id: string): Promise<SemVer[]> { return this.values.filter((value) => value.metadata.internalId === id).map((value) => value.metadata.version); }
  async list(): Promise<EvaluationDatasetSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}
class ProfileRepo implements EvaluatorProfileRepository {
  readonly values: EvaluatorProfile[] = [];
  async save(value: EvaluatorProfile): Promise<void> { this.values.push(value); }
  async findVersion(): Promise<EvaluatorProfile | null> { return null; }
  async findLatest(): Promise<EvaluatorProfile | null> { return null; }
  async listVersions(_scope: TenantScope, id: string): Promise<SemVer[]> { return this.values.filter((value) => value.metadata.internalId === id).map((value) => value.metadata.version); }
  async list(): Promise<EvaluatorProfileSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

describe('evaluation asset use cases', () => {
  it('Dataset/ProfileをSemVer bumpで保存しScenario参照を検証する', async () => {
    const datasets = new DatasetRepo();
    const save = new SaveEvaluationDatasetUseCase(datasets, scenarios);
    const base = { scope, internalId: 'set', workingName: 'draft', displayName: 'Set', publishName: 'set', owner: 'o' };
    expect((await save.execute({ ...base, cases: [{ id: 't1', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] })).metadata.version.toString()).toBe('1.0.0');
    expect((await save.execute({ ...base, bump: 'minor', cases: [{ id: 's1', kind: 'scenario', scenario: { id: 'scenario', version: SemVer.of(1, 0, 0) }, tags: [], source: 'manual' }] })).metadata.version.toString()).toBe('1.1.0');
    await expect(save.execute({ ...base, cases: [{ id: 's2', kind: 'scenario', scenario: { id: 'missing', version: SemVer.of(1, 0, 0) }, tags: [], source: 'manual' }] })).rejects.toThrow(/scenario not found/);

    const profiles = new ProfileRepo();
    const profile = await new SaveEvaluatorProfileUseCase(profiles).execute({ ...base, internalId: 'profile', metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] });
    expect(profile.metadata.version.toString()).toBe('1.0.0');
  });

  it('stable JSONとquoted CSVをimport/exportし、scenario入りCSVを拒否する', async () => {
    const importer = new ImportEvaluationCasesUseCase();
    const exporter = new ExportEvaluationDatasetUseCase();
    const cases = importer.execute('csv', 'id,kind,input,reference,expectedTools,tags\r\na,turn,"hello, world","say ""hi""",sales|search,critical|en');
    expect(cases[0]).toMatchObject({ id: 'a', input: 'hello, world', reference: 'say "hi"', expectedTools: ['sales', 'search'], tags: ['critical', 'en'], source: 'import' });
    const datasets = new DatasetRepo();
    const dataset = await new SaveEvaluationDatasetUseCase(datasets, scenarios).execute({ scope, internalId: 'set', workingName: 'draft', displayName: 'Set', publishName: 'set', owner: 'o', cases });
    const json = exporter.execute(dataset, 'json');
    expect(exporter.execute(dataset, 'json')).toBe(json);
    expect(importer.execute('json', json)).toMatchObject([{ id: 'a', kind: 'turn', source: 'import' }]);
    const mixed = await new SaveEvaluationDatasetUseCase(datasets, scenarios).execute({ scope, internalId: 'mixed', workingName: 'draft', displayName: 'Mixed', publishName: 'mixed', owner: 'o', cases: [{ id: 's', kind: 'scenario', scenario: { id: 'scenario', version: SemVer.of(1, 0, 0) }, tags: [], source: 'manual' }] });
    expect(() => exporter.execute(mixed, 'csv')).toThrow(/turn cases/);
  });
});
