import { describe, it } from 'vitest';
import { InMemoryEvaluationDatasetRepository } from './in-memory-evaluation-dataset-repository';
import { InMemoryEvaluatorProfileRepository } from './in-memory-evaluator-profile-repository';
import { evaluationAssetRepositoryContract } from './evaluation-asset-repository.contract';

describe('InMemory evaluation asset repositories', () => {
  it('共有契約を満たす', async () => evaluationAssetRepositoryContract(new InMemoryEvaluationDatasetRepository(), new InMemoryEvaluatorProfileRepository()));
});
