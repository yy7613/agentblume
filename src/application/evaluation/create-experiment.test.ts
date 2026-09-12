import { describe, expect, it, vi } from 'vitest';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { JudgeModelNotConfiguredError, JudgeRubricNotFoundError, JudgeTraceUnavailableError } from '../../domain/evaluation/errors';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository, JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { createEvaluationDataset, type EvaluationCase } from '../../domain/evaluation/evaluation-dataset';
import { createEvaluatorProfile, type EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { Experiment } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { createJudgeRubric, type JudgeRubric, type JudgeTracePolicy } from '../../domain/evaluation/judge-rubric';
import { SemVer } from '../../domain/tool/semver';
import type { LoggerPort } from '../operations/logger';
import { CreateExperimentUseCase, type CreateExperimentJudgeGuards } from './create-experiment';
import type { ExperimentWorkerPort } from './experiment-worker';
import type { JudgeReadiness } from './judge-readiness';

const scope = { tenantId: 't', workspaceId: 'w' }; const v = SemVer.of(1, 0, 0);
const metadata = { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft' as const, tenant: scope };
const turnCase: EvaluationCase = { id: 'turn-case', kind: 'turn', input: 'hello', tags: [], source: 'manual' };
const scenarioCase: EvaluationCase = { id: 'scenario-case', kind: 'scenario', scenario: { id: 'scenario', version: v }, tags: [], source: 'manual' };
const codeProfile = createEvaluatorProfile({ metadata: { ...metadata, internalId: 'profile' }, metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] });
const judgeProfile = createEvaluatorProfile({ metadata: { ...metadata, internalId: 'profile' }, metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }, { id: 'quality', kind: 'judge', rubric: { id: 'rubric', version: v }, weight: 1, required: true }] });
const CONFIGURED: JudgeReadiness = { configured: true, provider: 'openai-compatible', model: 'judge' };
const UNCONFIGURED: JudgeReadiness = { configured: false };
const input = { scope, target: { agentId: 'agent', version: v }, dataset: { id: 'set', version: v }, evaluatorProfile: { id: 'profile', version: v } };

function rubricWith(tracePolicy: JudgeTracePolicy): JudgeRubric {
  return createJudgeRubric({ metadata: { ...metadata, internalId: 'rubric' }, instructions: 'Judge.', referencePolicy: 'optional', tracePolicy, reasonRequired: true, criteria: [{ id: 'q', label: 'Q', description: 'Quality', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] });
}

function build(options: { readonly cases?: readonly EvaluationCase[]; readonly profile?: EvaluatorProfile; readonly guards?: CreateExperimentJudgeGuards } = {}) {
  const dataset = createEvaluationDataset({ metadata, cases: options.cases ?? [turnCase] });
  const created: Experiment[] = []; const enqueue = vi.fn();
  const experiments = { create: async (experiment: Experiment) => { created.push(experiment); } } as unknown as ExperimentRepository;
  const useCase = new CreateExperimentUseCase(
    experiments,
    { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository,
    { findVersion: async () => options.profile ?? codeProfile } as unknown as EvaluatorProfileRepository,
    { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository,
    { enqueue } as unknown as ExperimentWorkerPort,
    () => ({ provider: 'main', model: 'main-model', modelConfigHash: 'main-hash' }),
    () => 'exp-1', () => new Date('2026-09-13T00:00:00Z'),
    ...(options.guards === undefined ? [] : [options.guards]),
  );
  return { useCase, created, enqueue };
}

function rubrics(rubric: JudgeRubric | null): JudgeRubricRepository { return { findVersion: async () => rubric } as unknown as JudgeRubricRepository; }

describe('CreateExperimentUseCase', () => {
  describe('judge モデル未設定のガード', () => {
    it('異常: judge 指標があり judge が未設定なら JUDGE_MODEL_NOT_CONFIGURED で起票せず、原因と対象プロファイルを message に含める', async () => {
      const { useCase, created, enqueue } = build({ profile: judgeProfile, guards: { judgeReadiness: async () => UNCONFIGURED } });
      const error = await useCase.execute(input).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(JudgeModelNotConfiguredError);
      expect((error as JudgeModelNotConfiguredError).code).toBe('JUDGE_MODEL_NOT_CONFIGURED');
      expect((error as Error).message).toBe("CreateExperiment: evaluator profile 'profile@1.0.0' has judge metrics but no judge model is configured");
      expect(created).toHaveLength(0); expect(enqueue).not.toHaveBeenCalled();
    });

    it('[回帰固定] 正常: judge 指標があり judge が設定済みなら起票して worker へ渡す', async () => {
      const { useCase, created, enqueue } = build({ profile: judgeProfile, guards: { judgeReadiness: async () => CONFIGURED, rubrics: rubrics(rubricWith('optional')) } });
      const experiment = await useCase.execute(input);
      expect(experiment).toMatchObject({ id: 'exp-1', status: 'queued', progress: { completed: 0, total: 1 } });
      expect(created).toEqual([experiment]); expect(enqueue).toHaveBeenCalledWith(scope, 'exp-1');
    });

    it('[回帰固定] 境界: judge 指標が無いプロファイルは judge 未設定でも起票できる（ガードは judge 指標にだけ効く）', async () => {
      const judgeReadiness = vi.fn().mockResolvedValue(UNCONFIGURED);
      const { useCase, created } = build({ profile: codeProfile, guards: { judgeReadiness } });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
      expect(created).toHaveLength(1); expect(judgeReadiness).not.toHaveBeenCalled();
    });

    it('例外: 設定状態の解決が失敗しても起票は止めず、原因を logger に残す', async () => {
      const warns: { message: string; context?: Record<string, unknown> }[] = [];
      const logger: LoggerPort = { info: () => {}, warn: (message, context) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); }, error: () => {} };
      const { useCase, created } = build({ profile: judgeProfile, guards: { judgeReadiness: async () => { throw new Error('key file changed'); }, logger } });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
      expect(created).toHaveLength(1);
      expect(warns).toEqual([{ message: 'judge readiness could not be resolved; creating the experiment without the guard', context: { reason: 'key file changed' } }]);
    });

    it('境界: 解決器が未配線なら従来どおりガードしない（既存の呼び出し元との後方互換）', async () => {
      const { useCase } = build({ profile: judgeProfile });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
    });
  });

  describe('tracePolicy と事例種別のガード', () => {
    it('異常: tracePolicy=required のルーブリックと scenario 事例の組み合わせは JUDGE_TRACE_UNAVAILABLE で起票せず、直すべきルーブリックを rubric で返す', async () => {
      const { useCase, created } = build({ profile: judgeProfile, cases: [turnCase, scenarioCase], guards: { judgeReadiness: async () => CONFIGURED, rubrics: rubrics(rubricWith('required')) } });
      const error = await useCase.execute(input).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(JudgeTraceUnavailableError);
      expect(error).toMatchObject({ code: 'JUDGE_TRACE_UNAVAILABLE', rubric: { id: 'rubric', version: '1.0.0' } });
      expect((error as Error).message).toBe("CreateExperiment: judge rubric 'rubric@1.0.0' requires a tool trace, but dataset 'set@1.0.0' contains scenario cases which never produce one; set tracePolicy to 'optional'");
      expect(created).toHaveLength(0);
    });

    it('[回帰固定] 正常: tracePolicy=required でも turn 事例だけなら起票できる（turn 事例は軌跡を持つ）', async () => {
      const { useCase } = build({ profile: judgeProfile, cases: [turnCase], guards: { judgeReadiness: async () => CONFIGURED, rubrics: rubrics(rubricWith('required')) } });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
    });

    it('[回帰固定] 正常: tracePolicy=optional なら scenario 事例があっても起票できる', async () => {
      const { useCase } = build({ profile: judgeProfile, cases: [scenarioCase], guards: { judgeReadiness: async () => CONFIGURED, rubrics: rubrics(rubricWith('optional')) } });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
    });

    it('[回帰固定] 境界: tracePolicy=forbidden は軌跡を要求しないので scenario 事例と組み合わせられる', async () => {
      const { useCase } = build({ profile: judgeProfile, cases: [scenarioCase], guards: { judgeReadiness: async () => CONFIGURED, rubrics: rubrics(rubricWith('forbidden')) } });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
    });

    it('異常: 指標が参照するルーブリックが無ければ JUDGE_RUBRIC_NOT_FOUND（汎用の EVALUATION_DOMAIN にしない）', async () => {
      const { useCase, created } = build({ profile: judgeProfile, guards: { judgeReadiness: async () => CONFIGURED, rubrics: rubrics(null) } });
      const error = await useCase.execute(input).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(JudgeRubricNotFoundError);
      expect((error as Error).message).toBe('CreateExperiment: judge rubric not found: rubric@1.0.0');
      expect(created).toHaveLength(0);
    });

    it('[回帰固定] 境界: rubrics が未配線なら tracePolicy は検査しない（後方互換）', async () => {
      const { useCase } = build({ profile: judgeProfile, cases: [scenarioCase], guards: { judgeReadiness: async () => CONFIGURED } });
      await expect(useCase.execute(input)).resolves.toMatchObject({ status: 'queued' });
    });

    it('順序: judge 未設定と tracePolicy の矛盾が同時にあるときは未設定を先に返す（設定が無ければルーブリックを直しても走らない）', async () => {
      const findVersion = vi.fn().mockResolvedValue(rubricWith('required'));
      const { useCase } = build({ profile: judgeProfile, cases: [scenarioCase], guards: { judgeReadiness: async () => UNCONFIGURED, rubrics: { findVersion } as unknown as JudgeRubricRepository } });
      await expect(useCase.execute(input)).rejects.toBeInstanceOf(JudgeModelNotConfiguredError);
      expect(findVersion).not.toHaveBeenCalled();
    });
  });
});
