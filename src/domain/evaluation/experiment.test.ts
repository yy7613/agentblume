import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { advanceExperiment, cancelExperiment, completeExperiment, createExperiment, createExperimentCaseResult, interruptExperiment, resumeExperiment, startExperiment } from './experiment';
import { deserializeExperiment, deserializeExperimentCaseResult, serializeExperiment, serializeExperimentCaseResult } from './experiment-serialization';

const base = () => createExperiment({ id: 'exp-1', scope: { tenantId: 't', workspaceId: 'w' }, target: { agentId: 'agent', version: SemVer.of(1, 0, 0) }, dataset: { id: 'set', version: SemVer.of(2, 0, 0) }, evaluatorProfile: { id: 'profile', version: SemVer.of(1, 1, 0) }, repetitions: 1, status: 'queued', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 0, total: 1 }, createdAt: '2026-07-10T00:00:00Z' });

describe('Experiment domain', () => {
  it('queued→running→completed状態遷移とserialization往復を行う', () => {
    const running = startExperiment(base(), '2026-07-10T00:00:01Z');
    const completed = completeExperiment(advanceExperiment(running), '2026-07-10T00:00:02Z');
    expect(completed).toMatchObject({ status: 'completed', progress: { completed: 1, total: 1 } });
    expect(deserializeExperiment(serializeExperiment(completed))).toEqual(completed);
    expect(() => completeExperiment(running, 'now')).toThrow(/incomplete/);
    expect(() => startExperiment(completed, 'now')).toThrow(/completed/);
  });

  it('running→interrupted→queued resumeとcancelを検証する', () => {
    const interrupted = interruptExperiment(startExperiment(base(), 'start'), 'stop');
    expect(resumeExperiment(interrupted)).toMatchObject({ status: 'queued', progress: { completed: 0 } });
    expect(cancelExperiment(base(), 'cancelled')).toMatchObject({ status: 'cancelled' });
    expect(() => resumeExperiment(cancelExperiment(base(), 'cancelled'))).toThrow(/cancelled/);
  });

  it('CaseResultを検証し防御的に往復する', () => {
    const result = createExperimentCaseResult({ experimentId: 'exp-1', scope: { tenantId: 't', workspaceId: 'w' }, caseId: 'case-1', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: ['run-1'], output: 'ok', scores: [{ metric: 'quality', score: 1 }], latencyMs: 10, usage: { totalTokens: 3 }, judgeEvaluations: [{ scorer: 'llm-as-judge', metricId: 'judge-quality', rubric: { id: 'rubric', version: SemVer.of(1, 2, 0) }, required: true, model: { provider: 'judge', model: 'judge-model', modelConfigHash: 'hash' }, status: 'succeeded', score: 0.9, reason: 'correct' }] });
    expect(deserializeExperimentCaseResult(serializeExperimentCaseResult(result))).toEqual(result);
    expect(() => createExperimentCaseResult({ ...result, status: 'failed', error: undefined })).toThrow(/requires error/);
  });
});
