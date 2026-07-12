import type { EvaluationAssetMetadata } from '../../domain/evaluation/asset-metadata';
import { createEvaluationDataset, type EvaluationCase, type EvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import type { EvaluationDatasetRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { EvaluationDomainError } from '../../domain/evaluation/errors';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';

export interface SaveEvaluationDatasetInput {
  readonly scope: TenantScope;
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly cases: readonly EvaluationCase[];
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
}

function nextVersion(versions: readonly SemVer[], bump: 'major' | 'minor' | 'patch'): SemVer {
  return versions.length === 0
    ? SemVer.of(1, 0, 0)
    : versions.reduce((max, item) => (item.compare(max) > 0 ? item : max)).bump(bump);
}

export class SaveEvaluationDatasetUseCase {
  constructor(private readonly datasets: EvaluationDatasetRepository, private readonly scenarios: ScenarioRepository) {}

  async execute(input: SaveEvaluationDatasetInput): Promise<EvaluationDataset> {
    for (const entry of input.cases) {
      if (entry.kind === 'scenario' && await this.scenarios.findVersion(input.scope, entry.scenario.id, entry.scenario.version) === null) {
        throw new EvaluationDomainError(`SaveEvaluationDataset: scenario not found: ${entry.scenario.id}@${entry.scenario.version.toString()}`);
      }
    }
    const metadata: EvaluationAssetMetadata = {
      internalId: input.internalId,
      workingName: input.workingName,
      displayName: input.displayName,
      publishName: input.publishName,
      version: nextVersion(await this.datasets.listVersions(input.scope, input.internalId), input.bump ?? 'patch'),
      owner: input.owner,
      state: input.state ?? 'draft',
      tenant: input.scope,
    };
    const dataset = createEvaluationDataset({ metadata, cases: input.cases });
    await this.datasets.save(dataset);
    return dataset;
  }
}
