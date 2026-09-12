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

  it('正常・境界: judgeSamples は 1〜5 の整数（0 / 6 / 1.5 は拒否）、省略時 1、古い JSON も 1 として読む', () => {
    expect(base().judgeSamples).toBe(1);
    expect(createExperiment({ ...base(), judgeSamples: 5 }).judgeSamples).toBe(5);
    for (const judgeSamples of [0, 6, 1.5]) expect(() => createExperiment({ ...base(), judgeSamples })).toThrow(/judgeSamples must be an integer between 1 and 5/);
    const { judgeSamples: _omitted, ...legacy } = serializeExperiment(base()); expect(deserializeExperiment(legacy).judgeSamples).toBe(1);
    const sampled = createExperiment({ ...base(), judgeSamples: 3 }); expect(serializeExperiment(sampled).judgeSamples).toBe(3); expect(deserializeExperiment(serializeExperiment(sampled))).toEqual(sampled);
    expect(() => deserializeExperiment({ ...serializeExperiment(base()), judgeSamples: 9 })).toThrow(/judgeSamples/);
  });

  it('正常: 判定レコードの基準別・自己一貫性・契約の詳細を検証して往復する（null スコア含む）', () => {
    const record = { scorer: 'llm-as-judge' as const, metricId: 'judge', rubric: { id: 'rubric', version: SemVer.of(1, 0, 0) }, required: true, model: { provider: 'judge', model: 'm', modelConfigHash: 'h' }, status: 'succeeded' as const, score: 0.5, reason: 'ok', criteria: [{ id: 'a', score: 1, reason: 'good' }, { id: 'b', score: null, reason: 'cannot assess' }], samples: 2, dispersion: { min: 0.25, max: 0.75, stddev: 0.25 }, uncertain: true, usage: { totalTokens: 12 }, contract: { promptHash: 'abcdef0123456789', rubricId: 'rubric', rubricVersion: '1.0.0' } };
    const make = (patch: Partial<typeof record>) => createExperimentCaseResult({ experimentId: 'exp-1', scope: { tenantId: 't', workspaceId: 'w' }, caseId: 'case-1', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: [], scores: [], latencyMs: 1, usage: {}, judgeEvaluations: [{ ...record, ...patch }] });
    const result = make({});
    expect(result.judgeEvaluations?.[0]).toEqual(record); expect(deserializeExperimentCaseResult(serializeExperimentCaseResult(result))).toEqual(result);
    // 防御的複製: 入力配列を後から変えても結果は変わらない。
    const mutable = { ...record, criteria: [...record.criteria] }; const copied = make(mutable); mutable.criteria.push({ id: 'c', score: 0, reason: 'x' }); expect(copied.judgeEvaluations?.[0]?.criteria).toHaveLength(2);
    expect(() => make({ criteria: [{ id: 'a', score: 1.5, reason: 'r' }] })).toThrow(/criteria.0.score/);
    expect(() => make({ criteria: [{ id: 'a', score: 1, reason: '' }] })).toThrow(/criteria.0.reason/);
    expect(() => make({ criteria: [{ id: 'a', score: 1, reason: 'r' }, { id: 'a', score: 0, reason: 'r' }] })).toThrow(/duplicate id/);
    expect(() => make({ samples: 0 })).toThrow(/samples/);
    expect(() => make({ dispersion: { min: 1, max: 0, stddev: 0 } })).toThrow(/dispersion/);
    expect(() => make({ contract: { promptHash: '', rubricId: 'r', rubricVersion: '1.0.0' } })).toThrow(/promptHash/);
    // 失敗レコードにも契約と usage は残せる。
    const failed = createExperimentCaseResult({ experimentId: 'exp-1', scope: { tenantId: 't', workspaceId: 'w' }, caseId: 'c', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: [], scores: [], latencyMs: 1, usage: {}, judgeEvaluations: [{ scorer: 'llm-as-judge', metricId: 'judge', rubric: record.rubric, required: false, model: record.model, status: 'failed', error: { code: 'JUDGE_UNASSESSABLE', message: 'Judge could not assess any criterion' }, contract: record.contract, usage: { totalTokens: 3 } }] });
    expect(deserializeExperimentCaseResult(serializeExperimentCaseResult(failed))).toEqual(failed);
  });

  it('CaseResultを検証し防御的に往復する', () => {
    const result = createExperimentCaseResult({ experimentId: 'exp-1', scope: { tenantId: 't', workspaceId: 'w' }, caseId: 'case-1', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: ['run-1'], output: 'ok', scores: [{ metric: 'quality', score: 1 }], latencyMs: 10, usage: { totalTokens: 3 }, judgeEvaluations: [{ scorer: 'llm-as-judge', metricId: 'judge-quality', rubric: { id: 'rubric', version: SemVer.of(1, 2, 0) }, required: true, model: { provider: 'judge', model: 'judge-model', modelConfigHash: 'hash' }, status: 'succeeded', score: 0.9, reason: 'correct' }] });
    expect(deserializeExperimentCaseResult(serializeExperimentCaseResult(result))).toEqual(result);
    // 基準別判定より前の JSON（criteria 等が無い）はそのまま読める。
    expect(deserializeExperimentCaseResult(JSON.parse(JSON.stringify(serializeExperimentCaseResult(result)))).judgeEvaluations?.[0]).not.toHaveProperty('criteria');
    expect(() => createExperimentCaseResult({ ...result, status: 'failed', error: undefined })).toThrow(/requires error/);
  });
});
