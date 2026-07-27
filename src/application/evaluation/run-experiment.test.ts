import { describe, expect, it, vi } from 'vitest';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository, JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { createEvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import { createEvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import { advanceExperiment, createExperiment, createExperimentCaseResult, interruptExperiment, resumeExperiment, startExperiment } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { SemVer } from '../../domain/tool/semver';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import type { RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import { RunFailedError } from '../agent/errors';
import { ModelProviderError } from '../model/model-provider';
import type { RunScenarioUseCase } from '../validation/run-scenario';
import type { AgentEvaluatorPort } from './evaluator';
import { RunExperimentUseCase } from './run-experiment';
import { createJudgeRubric } from '../../domain/evaluation/judge-rubric';
import { JudgeEvaluationError } from '../../domain/evaluation/errors';
import type { JudgeEvaluatorPort } from './judge-evaluator';

const scope = { tenantId: 't', workspaceId: 'w' }; const v = SemVer.of(1, 0, 0);
class Experiments implements ExperimentRepository {
  experiment = createExperiment({ id: 'exp', scope, target: { agentId: 'agent', version: v }, dataset: { id: 'set', version: v }, evaluatorProfile: { id: 'profile', version: v }, repetitions: 1, status: 'queued', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 0, total: 1 }, createdAt: 'created' });
  results: import('../../domain/evaluation/experiment').ExperimentCaseResult[] = [];
  async create(): Promise<void> {} async update(value: typeof this.experiment): Promise<void> { this.experiment = value; } async find(): Promise<typeof this.experiment> { return this.experiment; } async list(): Promise<typeof this.experiment[]> { return [this.experiment]; } async saveCaseResult(value: typeof this.results[number]): Promise<void> { this.results.push(value); } async listCaseResults(): Promise<typeof this.results> { return this.results; } interruptRunning(): number { return 0; }
}

describe('RunExperimentUseCase', () => {
  it('一時ModelProviderErrorを2回retryし完了済みRunも結果へ残す', async () => {
    const experiments = new Experiments();
    const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'hello', expectedTools: ['tool'], tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] });
    const executeSaved = vi.fn()
      .mockRejectedValueOnce(new RunFailedError('failed-1', new ModelProviderError('temporary timeout')))
      .mockRejectedValueOnce(new RunFailedError('failed-2', new ModelProviderError('503 temporarily unavailable')))
      .mockResolvedValue({ runId: 'success', response: 'hello', trace: [{ sequence: 1, kind: 'tool-call', name: 'tool', arguments: {} }], usage: { totalTokens: 3 } });
    const evaluator = { evaluate: vi.fn().mockResolvedValue([{ metric: 'keyword-coverage', score: 1 }]) } as unknown as AgentEvaluatorPort;
    let time = 0; const delay = vi.fn().mockResolvedValue(undefined);
    const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, { executeSaved } as unknown as RunAgentPreviewUseCase, {} as RunScenarioUseCase, evaluator, () => new Date(time += 10), delay);
    const result = await runner.execute(scope, 'exp');
    expect(result.status).toBe('completed'); expect(executeSaved).toHaveBeenCalledTimes(3); expect(delay).toHaveBeenCalledTimes(2);
    expect(executeSaved).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'evaluation' }), undefined);
    expect(experiments.results[0]).toMatchObject({ status: 'succeeded', runIds: ['failed-1', 'failed-2', 'success'], scores: [{ metric: 'coverage', score: 1 }, { metric: 'expected-tool-hit', score: 1 }] });
  });

  it('非retryable case失敗を保存してExperiment自体はcompletedにする', async () => {
    const experiments = new Experiments();
    const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'quality', kind: 'code', scorer: 'completeness', weight: 1, required: true }] });
    const executeSaved = vi.fn().mockRejectedValue(new RunFailedError('failed', new Error('invalid output')));
    const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, { executeSaved } as unknown as RunAgentPreviewUseCase, {} as RunScenarioUseCase, { evaluate: vi.fn() }, () => new Date(), vi.fn());
    expect((await runner.execute(scope, 'exp')).status).toBe('completed');
    expect(executeSaved).toHaveBeenCalledTimes(1); expect(experiments.results[0]).toMatchObject({ status: 'failed', runIds: ['failed'], error: { retryable: false } });
  });

  it('scenario caseを候補Agent overrideで実行しsurvey指標を正規化する', async () => {
    const experiments = new Experiments();
    const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'scenario-case', kind: 'scenario', scenario: { id: 'scenario', version: v }, tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'quality', kind: 'code', scorer: 'completeness', weight: 1, required: true }] });
    const scenario = { survey: [{ id: 'q1', kind: 'boolean' }, { id: 'q2', kind: 'scale', min: 1, max: 5 }] };
    const runScenario = vi.fn().mockResolvedValue({ id: 'srun', scope, scenario: { id: 'scenario', version: v }, status: 'completed', goalAchieved: true, transcript: [{ speaker: 'agent', message: 'done', runId: 'run-scenario' }], survey: [{ questionId: 'q1', value: true }, { questionId: 'q2', value: 3 }], impressions: 'ok', metrics: { userTurns: 1, agentRuns: 1, totalToolCalls: 0, expectedToolHit: { expected: ['tool'], called: [], hitRate: 0 }, durationMs: 10, usage: { totalTokens: 5 } }, startedAt: 'a', finishedAt: 'b' });
    const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, { findVersion: async () => scenario } as unknown as ScenarioRepository, {} as RunAgentPreviewUseCase, { execute: runScenario } as unknown as RunScenarioUseCase, { evaluate: vi.fn() }, () => new Date());
    expect((await runner.execute(scope, 'exp')).status).toBe('completed');
    expect(runScenario).toHaveBeenCalledWith(expect.objectContaining({ target: { agentId: 'agent', version: v } }), undefined);
    expect(experiments.results[0]).toMatchObject({ status: 'succeeded', output: 'done', runIds: ['run-scenario'], scores: [{ metric: 'scenario-completed', score: 1 }, { metric: 'goal-achieved', score: 1 }, { metric: 'expected-tool-hit', score: 0 }, { metric: 'survey:q1', score: 1 }, { metric: 'survey:q2', score: 0.5 }] });
  });

  it('開始前abortはcancelled、固定資産消失はfailedにする', async () => {
    const experiments = new Experiments(); const controller = new AbortController(); controller.abort();
    const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'x', tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'q', kind: 'code', scorer: 'completeness', weight: 1, required: true }] });
    const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, {} as RunAgentPreviewUseCase, {} as RunScenarioUseCase, { evaluate: vi.fn() });
    expect((await runner.execute(scope, 'exp', controller.signal)).status).toBe('cancelled');
    const missing = new Experiments(); const missingRunner = new RunExperimentUseCase(missing, { findVersion: async () => null } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, {} as RunAgentPreviewUseCase, {} as RunScenarioUseCase, { evaluate: vi.fn() });
    expect((await missingRunner.execute(scope, 'exp')).status).toBe('failed'); expect(missing.experiment.error?.message).toMatch(/fixed asset/);
  });

  it('resume時は保存済みCaseResultを再実行しない', async () => {
    const experiments = new Experiments();
    experiments.experiment = resumeExperiment(interruptExperiment(advanceExperiment(startExperiment(experiments.experiment, 'start')), 'stop'));
    experiments.results.push(createExperimentCaseResult({ experimentId: 'exp', scope, caseId: 'case', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: ['existing-run'], scores: [], latencyMs: 1, usage: {} }));
    const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'x', tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'q', kind: 'code', scorer: 'completeness', weight: 1, required: true }] });
    const executeSaved = vi.fn();
    const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, { executeSaved } as unknown as RunAgentPreviewUseCase, {} as RunScenarioUseCase, { evaluate: vi.fn() });
    expect((await runner.execute(scope, 'exp')).status).toBe('completed'); expect(executeSaved).not.toHaveBeenCalled(); expect(experiments.results).toHaveLength(1);
  });

  it('Judge成功をscore+snapshotへ保存し、optional障害を欠損として記録する', async () => {
    const experiments = new Experiments(); const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'question', reference: 'reference', tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'judge-required', kind: 'judge', rubric: { id: 'rubric', version: v }, weight: 1, required: true }, { id: 'judge-optional', kind: 'judge', rubric: { id: 'rubric', version: v }, weight: 1, required: false }] });
    const rubric = createJudgeRubric({ metadata: { ...dataset.metadata, internalId: 'rubric' }, instructions: 'Judge.', referencePolicy: 'required', reasonRequired: true, criteria: [{ id: 'q', label: 'Q', description: 'Quality', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] });
    const snapshot = { provider: 'scripted-judge', model: 'judge', modelConfigHash: 'judge-hash' }; const evaluate = vi.fn().mockResolvedValueOnce({ score: 0.9, reason: 'correct', model: snapshot }).mockRejectedValueOnce(new JudgeEvaluationError('JUDGE_SCHEMA', 'broken schema'));
    const judge = { snapshot: () => snapshot, evaluate, compare: vi.fn() } as JudgeEvaluatorPort; const runAgent = { executeSaved: vi.fn().mockResolvedValue({ runId: 'run', response: 'answer', trace: [], usage: {} }) } as unknown as RunAgentPreviewUseCase;
    const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, runAgent, {} as RunScenarioUseCase, { evaluate: vi.fn().mockResolvedValue([]) }, () => new Date(), vi.fn(), { rubrics: { findVersion: async () => rubric } as unknown as JudgeRubricRepository, evaluator: judge });
    expect((await runner.execute(scope, 'exp')).status).toBe('completed'); expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ input: 'question', output: 'answer', reference: 'reference' }), undefined);
    expect(experiments.results[0]).toMatchObject({ scores: [{ metric: 'judge-required', score: 0.9, reason: 'correct' }], judgeEvaluations: [{ metricId: 'judge-required', required: true, status: 'succeeded', model: snapshot, score: 0.9, reason: 'correct' }, { metricId: 'judge-optional', required: false, status: 'failed', error: { code: 'JUDGE_SCHEMA', message: 'broken schema' } }] });
  });

  describe('judge指紋の事前解決', () => {
    /** judge メトリクス1件だけのプロファイルで RunExperimentUseCase を組む。 */
    function judgeRunner(judge: JudgeEvaluatorPort, resolveSnapshot?: () => Promise<{ provider: string; model: string; modelConfigHash: string }>) {
      const experiments = new Experiments();
      const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'question', tags: [], source: 'manual' }] });
      const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'judge-optional', kind: 'judge', rubric: { id: 'rubric', version: v }, weight: 1, required: false }] });
      const rubric = createJudgeRubric({ metadata: { ...dataset.metadata, internalId: 'rubric' }, instructions: 'Judge.', referencePolicy: 'optional', reasonRequired: true, criteria: [{ id: 'q', label: 'Q', description: 'Quality', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] });
      const runAgent = { executeSaved: vi.fn().mockResolvedValue({ runId: 'run', response: 'answer', trace: [], usage: {} }) } as unknown as RunAgentPreviewUseCase;
      const runner = new RunExperimentUseCase(experiments, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, {} as ScenarioRepository, runAgent, {} as RunScenarioUseCase, { evaluate: vi.fn().mockResolvedValue([]) }, () => new Date(), vi.fn(), { rubrics: { findVersion: async () => rubric } as unknown as JudgeRubricRepository, evaluator: judge, ...(resolveSnapshot === undefined ? {} : { resolveSnapshot }) });
      return { runner, experiments };
    }

    it('失敗レコードにも「実際に使う設定」の指紋を残す（env既定の古い指紋を残さない）', async () => {
      // UIで judge を切り替えた直後、evaluator.snapshot() はまだ env 既定（model:''）を返す。
      const stale = { provider: 'openai-compatible', model: '', modelConfigHash: 'stale' };
      const fresh = { provider: 'openai-compatible', model: 'switched-judge', modelConfigHash: 'fresh' };
      const judge = { snapshot: () => stale, evaluate: vi.fn().mockRejectedValue(new JudgeEvaluationError('JUDGE_PROVIDER', 'judge is down')), compare: vi.fn() } as JudgeEvaluatorPort;
      const { runner, experiments } = judgeRunner(judge, async () => fresh);

      expect((await runner.execute(scope, 'exp')).status).toBe('completed');

      expect(experiments.results[0]?.judgeEvaluations?.[0]).toMatchObject({ status: 'failed', model: fresh, error: { code: 'JUDGE_PROVIDER' } });
      // env既定の指紋（model:''）のままだと domain の検証に落ちて judge の失敗が
      // ケースごと失敗へ化ける。事前解決はその二次被害も同時に消す。
      expect(experiments.results[0]?.status).toBe('succeeded');
    });

    it('事前解決が失敗しても評価は止めず、同期の指紋へフォールバックする', async () => {
      // 鍵ファイル差し替え等で設定を開封できないケース。Run側と同じく観測情報の欠落で実行は止めない。
      const last = { provider: 'openai-compatible', model: 'last-resolved-judge', modelConfigHash: 'last' };
      const judge = { snapshot: () => last, evaluate: vi.fn().mockRejectedValue(new JudgeEvaluationError('JUDGE_PROVIDER', 'judge is down')), compare: vi.fn() } as JudgeEvaluatorPort;
      const { runner, experiments } = judgeRunner(judge, async () => { throw new Error('key file changed'); });

      expect((await runner.execute(scope, 'exp')).status).toBe('completed');

      expect(experiments.results[0]?.judgeEvaluations?.[0]).toMatchObject({ status: 'failed', model: last });
    });

    it('事前解決が配線されていなければ従来どおり同期の指紋を使う', async () => {
      const snapshot = { provider: 'scripted-judge', model: 'judge', modelConfigHash: 'judge-hash' };
      const judge = { snapshot: () => snapshot, evaluate: vi.fn().mockRejectedValue(new JudgeEvaluationError('JUDGE_SCHEMA', 'broken')), compare: vi.fn() } as JudgeEvaluatorPort;
      const { runner, experiments } = judgeRunner(judge);

      await runner.execute(scope, 'exp');

      expect(experiments.results[0]?.judgeEvaluations?.[0]).toMatchObject({ status: 'failed', model: snapshot });
    });
  });
});
