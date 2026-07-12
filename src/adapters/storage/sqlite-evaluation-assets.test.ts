import { describe, it } from 'vitest';
import { SqliteEvaluationDatasetRepository } from './sqlite-evaluation-dataset-repository';
import { SqliteEvaluatorProfileRepository } from './sqlite-evaluator-profile-repository';
import { evaluationAssetRepositoryContract } from './evaluation-asset-repository.contract';

describe('SQLite evaluation asset repositories', () => {
  it('共有契約を満たす', async () => {
    const datasets = new SqliteEvaluationDatasetRepository();
    const profiles = new SqliteEvaluatorProfileRepository();
    try { await evaluationAssetRepositoryContract(datasets, profiles); }
    finally { datasets.close(); profiles.close(); }
  });
});
