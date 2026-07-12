import { SemVer } from '../tool/semver';
import { validateEvaluationMetadata, evaluationNonEmpty, type EvaluationAssetMetadata } from './asset-metadata';
import { EvaluationDomainError } from './errors';

export const EVALUATION_CASE_SOURCES = ['manual', 'import', 'run-feedback'] as const;
export type EvaluationCaseSource = (typeof EVALUATION_CASE_SOURCES)[number];

interface EvaluationCaseBase {
  readonly id: string;
  readonly tags: readonly string[];
  readonly source: EvaluationCaseSource;
}

export interface TurnEvaluationCase extends EvaluationCaseBase {
  readonly kind: 'turn';
  readonly input: string;
  readonly reference?: string;
  readonly expectedTools?: readonly string[];
}

export interface ScenarioEvaluationCase extends EvaluationCaseBase {
  readonly kind: 'scenario';
  readonly scenario: { readonly id: string; readonly version: SemVer };
}

export type EvaluationCase = TurnEvaluationCase | ScenarioEvaluationCase;

export interface EvaluationDataset {
  readonly metadata: EvaluationAssetMetadata;
  readonly cases: readonly EvaluationCase[];
}

function uniqueStrings(values: readonly string[], field: string): readonly string[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    evaluationNonEmpty(value, `${field}.${index}`);
    if (seen.has(value)) throw new EvaluationDomainError(`${field} contains duplicate value: ${value}`);
    seen.add(value);
    return value;
  });
}

export function normalizeEvaluationCases(cases: readonly EvaluationCase[]): readonly EvaluationCase[] {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new EvaluationDomainError('EvaluationDataset: cases must contain at least one case');
  }
  const ids = new Set<string>();
  return cases.map((entry, index) => {
    evaluationNonEmpty(entry?.id, `EvaluationDataset: cases.${index}.id`);
    if (ids.has(entry.id)) throw new EvaluationDomainError(`EvaluationDataset: duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    if (!(EVALUATION_CASE_SOURCES as readonly unknown[]).includes(entry.source)) {
      throw new EvaluationDomainError(`EvaluationDataset: cases.${index}.source is invalid: ${String(entry.source)}`);
    }
    const tags = uniqueStrings(entry.tags, `EvaluationDataset: cases.${index}.tags`);
    if (entry.kind === 'turn') {
      evaluationNonEmpty(entry.input, `EvaluationDataset: cases.${index}.input`);
      if (entry.reference !== undefined && typeof entry.reference !== 'string') {
        throw new EvaluationDomainError(`EvaluationDataset: cases.${index}.reference must be a string`);
      }
      const expectedTools = entry.expectedTools === undefined
        ? undefined
        : uniqueStrings(entry.expectedTools, `EvaluationDataset: cases.${index}.expectedTools`);
      return {
        id: entry.id,
        kind: 'turn' as const,
        input: entry.input,
        ...(entry.reference !== undefined ? { reference: entry.reference } : {}),
        ...(expectedTools !== undefined ? { expectedTools } : {}),
        tags,
        source: entry.source,
      };
    }
    if (entry.kind === 'scenario') {
      evaluationNonEmpty(entry.scenario?.id, `EvaluationDataset: cases.${index}.scenario.id`);
      if (!(entry.scenario.version instanceof SemVer)) {
        throw new EvaluationDomainError(`EvaluationDataset: cases.${index}.scenario.version must be a SemVer instance`);
      }
      return {
        id: entry.id,
        kind: 'scenario' as const,
        scenario: { id: entry.scenario.id, version: entry.scenario.version },
        tags,
        source: entry.source,
      };
    }
    throw new EvaluationDomainError(`EvaluationDataset: cases.${index}.kind is invalid: ${String((entry as { kind?: unknown }).kind)}`);
  });
}

export function createEvaluationDataset(props: EvaluationDataset): EvaluationDataset {
  return {
    metadata: validateEvaluationMetadata(props.metadata, 'createEvaluationDataset'),
    cases: normalizeEvaluationCases(props.cases),
  };
}
