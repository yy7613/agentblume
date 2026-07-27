// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { ValidationPage } from './ValidationPage';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listPersonas: vi.fn().mockResolvedValue([]),
    listScenarios: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    listScenarioRuns: vi.fn().mockResolvedValue([]),
    listEvaluationDatasets: vi.fn().mockResolvedValue([]),
    listEvaluatorProfiles: vi.fn().mockResolvedValue([]),
    listJudgeRubrics: vi.fn().mockResolvedValue([]),
    listExperiments: vi.fn().mockResolvedValue([]),
    listGatePolicies: vi.fn().mockResolvedValue([]),
    listPromotionRequests: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('ValidationPage', () => {
  it('Personas/Scenarios/Datasets/Experiments/Quality/Runsの6タブを切り替えて表示する', async () => {
    const client = stubClient();
    render(<ValidationPage client={client} />);
    expect(screen.getByRole('tab', { name: 'Personas' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No saved personas.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    expect(await screen.findByText('No saved scenarios.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Datasets' }));
    expect(await screen.findByText('No evaluation datasets.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Experiments' }));
    expect(await screen.findByText('No experiments yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Quality gates' }));
    expect(await screen.findByText('No pending requests.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('No scenario runs yet.')).toBeTruthy();
    await waitFor(() => expect(client.listScenarioRuns).toHaveBeenCalledWith(scope));
  });

  it('品質比較、gate判定、昇格申請、承認を操作する（承認は確認ダイアログ経由）', async () => {
    const completed = (id: string, version: string) => ({ id, scope, target: { agentId: 'agent', version }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 2, status: 'completed', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 2, total: 2 }, createdAt: 'now' });
    const comparison = { baselineExperimentId: 'baseline', candidateExperimentId: 'candidate', baseline: { experimentId: 'baseline', caseCount: 2, metrics: {} }, candidate: { experimentId: 'candidate', caseCount: 2, metrics: {} }, metrics: [{ metric: 'quality', preference: 'higher', baseline: { count: 2, mean: 0.5, median: 0.5, p50: 0.5, p95: 0.5, stddev: 0, min: 0.5, max: 0.5, samples: [0.5, 0.5] }, candidate: { count: 2, mean: 0.9, median: 0.9, p50: 0.9, p95: 0.9, stddev: 0, min: 0.9, max: 0.9, samples: [0.9, 0.9] }, delta: 0.4, direction: 'improved' }], cases: [{ caseId: 'critical', repetition: 1, baselineStatus: 'succeeded', candidateStatus: 'succeeded', baselineScore: 0.5, candidateScore: 0.9, delta: 0.4, direction: 'improved' }] };
    const report = { id: 'report', scope, policy: { id: 'release', version: '1.0.0' }, baselineExperimentId: 'baseline', candidateExperimentId: 'candidate', status: 'pass', ruleResults: [{ ruleId: 'threshold', passed: true, observed: 0.9, message: 'quality meets threshold' }], createdAt: 'now', expiresAt: 'later' };
    const promotion = { id: 'promotion', scope, agent: { id: 'agent', version: '2.0.0' }, gateReportId: 'report', status: 'pending', requestedBy: 'reviewer', requestedAt: 'now' };
    const compareExperiments = vi.fn().mockResolvedValue(comparison); const evaluateGate = vi.fn().mockResolvedValue(report); const requestPromotion = vi.fn().mockResolvedValue(promotion); const decidePromotion = vi.fn().mockResolvedValue({ ...promotion, status: 'approved' });
    const getGatePolicy = vi.fn().mockResolvedValue({ metadata: { internalId: 'release', version: '1.0.0' }, reportTtlHours: 24, rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }, { id: 'regression', kind: 'max-regression', metric: 'quality', maxRegression: 0.05 }] });
    const client = stubClient({
      listExperiments: vi.fn().mockResolvedValue([completed('candidate', '2.0.0'), completed('baseline', '1.0.0')]),
      listGatePolicies: vi.fn().mockResolvedValue([{ internalId: 'release', displayName: 'Release', publishName: 'release', latestVersion: '1.0.0', state: 'draft', ruleCount: 2 }]),
      listPromotionRequests: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([promotion]), compareExperiments, evaluateGate, requestPromotion, decidePromotion, getGatePolicy,
    });
    render(<ValidationPage client={client} />); await userEvent.click(screen.getByRole('tab', { name: 'Quality gates' }));
    await screen.findByRole('button', { name: 'Compare' }); await userEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(compareExperiments).toHaveBeenCalledWith(scope, 'baseline', 'candidate')); expect(await screen.findAllByText('improved')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate gate' })); await waitFor(() => expect(evaluateGate).toHaveBeenCalledWith(scope, { id: 'release', version: '1.0.0' }, 'candidate', 'baseline'));
    expect(await screen.findByText('PASS')).toBeTruthy(); await userEvent.click(screen.getByRole('button', { name: 'Request promotion' }));
    await waitFor(() => expect(requestPromotion).toHaveBeenCalledWith('agent', '2.0.0', scope, 'report', 'reviewer'));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const decisionDialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(decisionDialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decidePromotion).toHaveBeenCalledWith('promotion', 'approve', scope, 'reviewer'));
  });

  it('Gate policyを切り替えるとgetGatePolicyでルール編集フィールドが復元される', async () => {
    const getGatePolicy = vi.fn()
      .mockResolvedValueOnce({ metadata: { internalId: 'release', version: '1.0.0' }, reportTtlHours: 24, rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }, { id: 'regression', kind: 'max-regression', metric: 'quality', maxRegression: 0.05 }] })
      .mockResolvedValueOnce({ metadata: { internalId: 'staging', version: '2.0.0' }, reportTtlHours: 24, rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'latency', operator: 'lte', threshold: 500 }, { id: 'regression', kind: 'max-regression', metric: 'latency', maxRegression: 0.1 }, { id: 'required-tags', kind: 'required-case-pass', tags: ['critical', 'p0'] }] });
    const client = stubClient({
      listGatePolicies: vi.fn().mockResolvedValue([
        { internalId: 'release', displayName: 'Release', publishName: 'release', latestVersion: '1.0.0', state: 'draft', ruleCount: 2 },
        { internalId: 'staging', displayName: 'Staging', publishName: 'staging', latestVersion: '2.0.0', state: 'draft', ruleCount: 3 },
      ]),
      getGatePolicy,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Quality gates' }));

    await waitFor(() => expect(getGatePolicy).toHaveBeenCalledWith('release', scope, '1.0.0'));
    expect((await screen.findByLabelText('Gate metric') as HTMLInputElement).value).toBe('quality');
    expect((screen.getByLabelText('Threshold') as HTMLInputElement).value).toBe('0.8');
    expect((screen.getByLabelText('Maximum regression') as HTMLInputElement).value).toBe('0.05');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Gate policy' }), 'staging');
    await waitFor(() => expect(getGatePolicy).toHaveBeenCalledWith('staging', scope, '2.0.0'));
    expect((screen.getByLabelText('Gate policy ID') as HTMLInputElement).value).toBe('staging');
    expect((screen.getByLabelText('Gate metric') as HTMLInputElement).value).toBe('latency');
    expect((screen.getByLabelText('Gate threshold operator') as HTMLSelectElement).value).toBe('lte');
    expect((screen.getByLabelText('Threshold') as HTMLInputElement).value).toBe('500');
    expect((screen.getByLabelText('Maximum regression') as HTMLInputElement).value).toBe('0.1');
    expect((screen.getByLabelText('Required tags (comma-separated)') as HTMLInputElement).value).toBe('critical, p0');
  });

  it('Delete policyでdeleteGatePolicyを呼び、一覧を再取得する（確認ダイアログ経由）', async () => {
    const deleteGatePolicy = vi.fn().mockResolvedValue(undefined);
    const getGatePolicy = vi.fn().mockResolvedValue({ metadata: { internalId: 'release', version: '1.0.0' }, reportTtlHours: 24, rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }] });
    const listGatePolicies = vi.fn()
      .mockResolvedValueOnce([{ internalId: 'release', displayName: 'Release', publishName: 'release', latestVersion: '1.0.0', state: 'draft', ruleCount: 1 }])
      .mockResolvedValueOnce([]);
    const client = stubClient({ listGatePolicies, getGatePolicy, deleteGatePolicy });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Quality gates' }));
    await waitFor(() => expect(getGatePolicy).toHaveBeenCalledWith('release', scope, '1.0.0'));

    await userEvent.click(screen.getByRole('button', { name: 'Delete policy' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Release');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(deleteGatePolicy).toHaveBeenCalledWith('release', scope);
    expect(listGatePolicies).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('combobox', { name: 'Gate policy' }) as HTMLSelectElement).value).toBe('');
  });

  it('Experimentを作成して進捗・CaseResult・Run traceを表示する', async () => {
    const queued = { id: 'exp-1', scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 2, status: 'queued', snapshot: { provider: 'scripted', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 0, total: 2 }, createdAt: 'now' };
    const completed = { ...queued, status: 'completed', progress: { completed: 2, total: 2 }, finishedAt: 'done' };
    const result = { experimentId: 'exp-1', scope, caseId: 'case', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: ['run-1'], output: 'answer', scores: [{ metric: 'coverage', score: 1 }], latencyMs: 15, usage: { totalTokens: 4 }, judgeEvaluations: [{ scorer: 'llm-as-judge', metricId: 'judge-quality', rubric: { id: 'rubric', version: '1.0.0' }, required: true, model: { provider: 'judge', model: 'judge-model', modelConfigHash: 'hash' }, status: 'succeeded', score: 0.9, reason: 'correct' }] };
    const createExperiment = vi.fn().mockResolvedValue(queued);
    const getExperiment = vi.fn().mockResolvedValue(completed);
    const listExperimentResults = vi.fn().mockResolvedValue([result]);
    const getRunTrace = vi.fn().mockResolvedValue({ runId: 'run-1', scope, status: 'succeeded', mode: 'test', startedAt: 'now', trace: [{ sequence: 1, kind: 'model-response', content: 'answer' }] });
    const client = stubClient({
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }]),
      listEvaluationDatasets: vi.fn().mockResolvedValue([{ internalId: 'set', displayName: 'Set', publishName: 'set', latestVersion: '1.0.0', state: 'draft', caseCount: 1 }]),
      listEvaluatorProfiles: vi.fn().mockResolvedValue([{ internalId: 'profile', displayName: 'Profile', publishName: 'profile', latestVersion: '1.0.0', state: 'draft', metricCount: 1 }]),
      listExperiments: vi.fn().mockResolvedValue([]), createExperiment, getExperiment, listExperimentResults, getRunTrace,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Experiments' }));
    await screen.findByText('No experiments yet.');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Experiment repetitions' }), { target: { value: '2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Run experiment' }));
    await waitFor(() => expect(createExperiment).toHaveBeenCalledWith({ scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 2 }));
    expect((await screen.findByRole('progressbar', { name: 'Experiment progress' })).getAttribute('aria-valuenow')).toBe('2');
    expect(await screen.findByText('coverage 1.00')).toBeTruthy();
    expect(screen.getByText(/judge-quality · succeeded · rubric@1.0.0 · judge\/judge-model · correct/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'run-1' }));
    await waitFor(() => expect(getRunTrace).toHaveBeenCalledWith('run-1', scope));
    expect(await screen.findByText('1 · model-response')).toBeTruthy();
    expect(screen.getByText(/scripted\/model/)).toBeTruthy();
  });

  it('モデル設定を解決できずに起票された実験は unresolved を平文で説明する', async () => {
    // 起票は通す仕様（指紋は観測情報）なので、UIは 'unresolved/unresolved' ではなく理由を出す。
    const unresolved = { id: 'exp-x', scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 1, status: 'queued', snapshot: { provider: 'unresolved', model: 'unresolved', modelConfigHash: 'unresolved' }, progress: { completed: 0, total: 1 }, createdAt: 'now' };
    const client = stubClient({
      listExperiments: vi.fn().mockResolvedValue([unresolved]),
      getExperiment: vi.fn().mockResolvedValue(unresolved),
      listExperimentResults: vi.fn().mockResolvedValue([]),
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Experiments' }));
    await userEvent.click(await screen.findByRole('button', { name: /agent@1.0.0/ }));
    expect(await screen.findByText(/model settings unresolved/)).toBeTruthy();
    expect(screen.queryByText(/unresolved\/unresolved/)).toBeNull();
  });

  it('Experimentの版選択・cancel・interrupted resumeを操作する（cancelは確認ダイアログ経由）', async () => {
    const base = { scope, dataset: { id: 'set-a', version: '1.0.0' }, evaluatorProfile: { id: 'profile-a', version: '1.0.0' }, repetitions: 1, snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 0, total: 1 }, createdAt: 'now' };
    const running = { ...base, id: 'running', target: { agentId: 'agent-run', version: '1.0.0' }, status: 'running' };
    const interrupted = { ...base, id: 'interrupted', target: { agentId: 'agent-stop', version: '1.0.0' }, status: 'interrupted', error: { code: 'PROCESS_INTERRUPTED', message: 'stopped' } };
    const cancelExperiment = vi.fn().mockResolvedValue({ ...running, status: 'cancelled' });
    const resumeExperiment = vi.fn().mockResolvedValue({ ...interrupted, status: 'queued', error: undefined });
    const client = stubClient({
      listAgents: vi.fn().mockResolvedValue([
        { internalId: 'agent-run', displayName: 'Agent Run', publishName: 'run', latestVersion: '1.0.0', kind: 'normal', state: 'draft' },
        { internalId: 'agent-stop', displayName: 'Agent Stop', publishName: 'stop', latestVersion: '2.0.0', kind: 'normal', state: 'draft' },
      ]),
      listEvaluationDatasets: vi.fn().mockResolvedValue([
        { internalId: 'set-a', displayName: 'Set A', publishName: 'a', latestVersion: '1.0.0', state: 'draft', caseCount: 1 },
        { internalId: 'set-b', displayName: 'Set B', publishName: 'b', latestVersion: '2.0.0', state: 'draft', caseCount: 1 },
      ]),
      listEvaluatorProfiles: vi.fn().mockResolvedValue([
        { internalId: 'profile-a', displayName: 'Profile A', publishName: 'a', latestVersion: '1.0.0', state: 'draft', metricCount: 1 },
        { internalId: 'profile-b', displayName: 'Profile B', publishName: 'b', latestVersion: '2.0.0', state: 'draft', metricCount: 1 },
      ]),
      listExperiments: vi.fn().mockResolvedValue([running, interrupted]), listExperimentResults: vi.fn().mockResolvedValue([]),
      listAgentVersions: vi.fn().mockResolvedValue(['1.0.0', '2.0.0']), listEvaluationDatasetVersions: vi.fn().mockResolvedValue(['1.0.0', '2.0.0']), listEvaluatorProfileVersions: vi.fn().mockResolvedValue(['1.0.0', '2.0.0']),
      cancelExperiment, resumeExperiment, getExperiment: vi.fn(async (id: string) => id === 'running' ? running : { ...interrupted, status: 'completed', progress: { completed: 1, total: 1 } }),
    });
    render(<ValidationPage client={client} />); await userEvent.click(screen.getByRole('tab', { name: 'Experiments' }));
    await screen.findByRole('button', { name: /agent-run@1.0.0/ });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Experiment target agent' }), 'agent-stop');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Experiment dataset' }), 'set-b');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Experiment evaluator profile' }), 'profile-b');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Experiment agent version' }), '1.0.0');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Experiment dataset version' }), '1.0.0');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Experiment profile version' }), '1.0.0');
    await userEvent.click(screen.getByRole('button', { name: /agent-run@1.0.0/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const cancelDialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(cancelDialog).getByRole('button', { name: 'Cancel experiment' }));
    await waitFor(() => expect(cancelExperiment).toHaveBeenCalledWith('running', scope));
    await userEvent.click(screen.getByRole('button', { name: /agent-stop@1.0.0/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resumeExperiment).toHaveBeenCalledWith('interrupted', scope));
  });

  it('DatasetとEvaluatorProfileを編集して保存DTOへ写像する', async () => {
    const saveEvaluationDataset = vi.fn().mockResolvedValue({ metadata: { internalId: 'quality-regression', version: '1.0.0' } });
    const saveEvaluatorProfile = vi.fn().mockResolvedValue({ metadata: { internalId: 'default-code-evaluator', version: '1.0.0' } });
    const client = stubClient({
      listEvaluationDatasets: vi.fn().mockResolvedValue([]), listEvaluatorProfiles: vi.fn().mockResolvedValue([]),
      saveEvaluationDataset, saveEvaluatorProfile,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Datasets' }));
    await screen.findByText('No evaluation datasets.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Case 1 input' }), 'Summarize monthly sales.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Case 1 reference' }), 'Sales were 42.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Case 1 expected tools' }), 'sales, search');
    await userEvent.type(screen.getByRole('textbox', { name: 'Case 1 tags' }), 'critical, en');
    await userEvent.click(screen.getByRole('button', { name: 'Save dataset' }));
    await waitFor(() => expect(saveEvaluationDataset).toHaveBeenCalledWith({
      scope, internalId: 'quality-regression', workingName: 'Quality regression draft', displayName: 'Quality regression', publishName: 'quality_regression', owner: 'local-user', bump: 'patch',
      cases: [{ id: 'case-1', kind: 'turn', input: 'Summarize monthly sales.', reference: 'Sales were 42.', expectedTools: ['sales', 'search'], tags: ['critical', 'en'], source: 'manual' }],
    }));
    expect(await screen.findByText('saved 1.0.0')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add metric' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Metric 2 ID' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Metric 2 ID' }), 'completeness');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(saveEvaluatorProfile).toHaveBeenCalledWith(expect.objectContaining({
      scope, internalId: 'default-code-evaluator', bump: 'patch',
      metrics: [
        { id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true },
        { id: 'completeness', kind: 'code', scorer: 'completeness', weight: 1, required: false },
      ],
    })));
  });

  it('JudgeRubricを保存しEvaluatorProfileのjudge metricへ固定参照する', async () => {
    const rubricSummary = { internalId: 'quality-rubric', displayName: 'Quality rubric', publishName: 'quality_rubric', latestVersion: '1.0.0', state: 'draft', criterionCount: 1 };
    const savedRubric = { metadata: { internalId: 'quality-rubric', workingName: 'Saved draft', displayName: 'Quality rubric', publishName: 'quality_rubric', owner: 'owner', version: '1.0.0' }, instructions: 'Judge accuracy.', referencePolicy: 'optional', reasonRequired: true, criteria: [{ id: 'accuracy', label: 'Accuracy', description: 'Factual correctness', weight: 1, levels: [{ score: 0, label: 'Wrong', description: 'Incorrect' }, { score: 1, label: 'Correct', description: 'Fully correct' }] }] };
    const saveJudgeRubric = vi.fn().mockResolvedValue({ metadata: { internalId: 'quality-rubric', version: '1.0.1' } }); const saveEvaluatorProfile = vi.fn().mockResolvedValue({ metadata: { internalId: 'default-code-evaluator', version: '1.0.0' } }); const getJudgeRubric = vi.fn().mockResolvedValue(savedRubric);
    const client = stubClient({ listJudgeRubrics: vi.fn().mockResolvedValue([rubricSummary]), getJudgeRubric, saveJudgeRubric, saveEvaluatorProfile });
    render(<ValidationPage client={client} />); await userEvent.click(screen.getByRole('tab', { name: 'Datasets' })); const rubricButton = await screen.findByRole('button', { name: /Quality rubric/ }); await userEvent.click(rubricButton); await waitFor(() => expect(getJudgeRubric).toHaveBeenCalledWith('quality-rubric', scope));
    fireEvent.change(screen.getByRole('textbox', { name: 'Judge rubric internal ID' }), { target: { value: 'quality-rubric-next' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Judge rubric working name' }), { target: { value: 'Next draft' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Judge rubric display name' }), { target: { value: 'Next rubric' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Judge rubric publish name' }), { target: { value: 'next_rubric' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Judge rubric owner' }), { target: { value: 'reviewer' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Judge rubric instructions' }), { target: { value: 'Judge accuracy and safety.' } });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Judge reference policy' }), 'required'); await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Judge rubric version bump' }), 'minor');
    fireEvent.change(screen.getByRole('textbox', { name: 'Criterion 1 ID' }), { target: { value: 'accuracy-next' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Criterion 1 label' }), { target: { value: 'Accuracy next' } }); fireEvent.change(screen.getByRole('spinbutton', { name: 'Criterion 1 weight' }), { target: { value: '2' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Criterion 1 description' }), { target: { value: 'Updated correctness' } }); fireEvent.change(screen.getByRole('spinbutton', { name: 'Criterion 1 level 1 score' }), { target: { value: '0' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Criterion 1 level 1 label' }), { target: { value: 'Bad' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Criterion 1 level 1 description' }), { target: { value: 'Bad answer' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add criterion' })); await userEvent.click(screen.getByRole('button', { name: 'Remove criterion 2' })); await userEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
    await waitFor(() => expect(saveJudgeRubric).toHaveBeenCalledWith(expect.objectContaining({ scope, internalId: 'quality-rubric-next', workingName: 'Next draft', displayName: 'Next rubric', publishName: 'next_rubric', owner: 'reviewer', instructions: 'Judge accuracy and safety.', referencePolicy: 'required', bump: 'minor', criteria: [expect.objectContaining({ id: 'accuracy-next', label: 'Accuracy next', description: 'Updated correctness', weight: 2, levels: [expect.objectContaining({ score: 0, label: 'Bad', description: 'Bad answer' }), expect.objectContaining({ score: 1 })] })] })));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Metric 1 kind' }), 'judge'); await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(saveEvaluatorProfile).toHaveBeenCalledWith(expect.objectContaining({ metrics: [{ id: 'coverage', kind: 'judge', rubric: { id: 'quality-rubric', version: '1.0.0' }, weight: 1, required: true }] })));
  });

  it('保存済み評価資産の編集・scenario case・import/export操作を扱う', async () => {
    const getEvaluationDataset = vi.fn().mockResolvedValue({
      metadata: { internalId: 'set', workingName: 'Set draft', displayName: 'Set', publishName: 'set', owner: 'owner', version: '1.2.0' },
      cases: [{ id: 'scenario-case', kind: 'scenario', scenario: { id: 'scenario-a', version: '1.0.0' }, tags: ['flow'], source: 'manual' }],
    });
    const getEvaluatorProfile = vi.fn().mockResolvedValue({
      metadata: { internalId: 'profile', workingName: 'Profile draft', displayName: 'Profile', publishName: 'profile', owner: 'owner', version: '2.0.0' },
      metrics: [
        { id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true },
        { id: 'tone', kind: 'code', scorer: 'tone-consistency', weight: 1, required: false },
      ],
    });
    const importEvaluationCases = vi.fn().mockResolvedValue([{ id: 'imported', kind: 'turn', input: 'Imported input', tags: ['import'], source: 'import' }]);
    const exportEvaluationDataset = vi.fn().mockResolvedValue('{"exported":true}');
    const client = stubClient({
      listEvaluationDatasets: vi.fn().mockResolvedValue([{ internalId: 'set', displayName: 'Set', publishName: 'set', latestVersion: '1.2.0', state: 'draft', caseCount: 1 }]),
      listEvaluatorProfiles: vi.fn().mockResolvedValue([{ internalId: 'profile', displayName: 'Profile', publishName: 'profile', latestVersion: '2.0.0', state: 'draft', metricCount: 2 }]),
      listScenarios: vi.fn().mockResolvedValue([
        { internalId: 'scenario-a', displayName: 'Scenario A', publishName: 'a', latestVersion: '1.0.0', state: 'draft' },
        { internalId: 'scenario-b', displayName: 'Scenario B', publishName: 'b', latestVersion: '2.0.0', state: 'draft' },
      ]),
      getEvaluationDataset, getEvaluatorProfile, importEvaluationCases, exportEvaluationDataset,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Datasets' }));
    await userEvent.click(await screen.findByRole('button', { name: /Set/ }));
    await waitFor(() => expect(getEvaluationDataset).toHaveBeenCalledWith('set', scope));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Dataset version bump' }), 'minor');
    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset internal ID' }), { target: { value: 'set-next' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset working name' }), { target: { value: 'Next draft' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset display name' }), { target: { value: 'Next' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset publish name' }), { target: { value: 'next' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset owner' }), { target: { value: 'next-owner' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Case 1 ID' }), { target: { value: 'scenario-next' } });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Case 1 scenario' }), 'scenario-b@2.0.0');
    fireEvent.change(screen.getByRole('textbox', { name: 'Case 1 tags' }), { target: { value: 'flow, critical' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add turn' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove case 2' }));

    await userEvent.click(screen.getByRole('button', { name: 'Export saved version' }));
    await waitFor(() => expect(exportEvaluationDataset).toHaveBeenCalledWith('set-next', scope, 'json', '1.2.0'));
    expect((screen.getByRole('textbox', { name: 'Dataset transfer content' }) as HTMLTextAreaElement).value).toBe('{"exported":true}');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Dataset transfer format' }), 'csv');
    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset transfer content' }), { target: { value: 'id,input\na,hello' } });
    await userEvent.click(screen.getByRole('button', { name: 'Import cases' }));
    await waitFor(() => expect(importEvaluationCases).toHaveBeenCalledWith(scope, 'csv', 'id,input\na,hello'));
    expect(await screen.findByDisplayValue('Imported input')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Profile/ }));
    await waitFor(() => expect(getEvaluatorProfile).toHaveBeenCalledWith('profile', scope));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Evaluator profile version bump' }), 'major');
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluator profile internal ID' }), { target: { value: 'profile-next' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluator profile working name' }), { target: { value: 'Profile next draft' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluator profile display name' }), { target: { value: 'Profile next' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluator profile publish name' }), { target: { value: 'profile_next' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluator profile owner' }), { target: { value: 'next-owner' } });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Metric 1 scorer' }), 'completeness');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Metric 1 weight' }), { target: { value: '2.5' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Metric 1 required' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove metric 2' }));
    expect(screen.queryByRole('textbox', { name: 'Metric 2 ID' })).toBeNull();
  });

  it('Datasets/Profiles/RubricsそれぞれのDeleteでdeleteXを呼び、一覧を再取得する（確認ダイアログ経由）', async () => {
    const deleteEvaluationDataset = vi.fn().mockResolvedValue(undefined);
    const deleteEvaluatorProfile = vi.fn().mockResolvedValue(undefined);
    const deleteJudgeRubric = vi.fn().mockResolvedValue(undefined);
    const listEvaluationDatasets = vi.fn()
      .mockResolvedValueOnce([{ internalId: 'set', displayName: 'Set', publishName: 'set', latestVersion: '1.0.0', state: 'draft', caseCount: 1 }])
      .mockResolvedValueOnce([]);
    const listEvaluatorProfiles = vi.fn()
      .mockResolvedValueOnce([{ internalId: 'profile', displayName: 'Profile', publishName: 'profile', latestVersion: '1.0.0', state: 'draft', metricCount: 1 }])
      .mockResolvedValueOnce([]);
    const listJudgeRubrics = vi.fn()
      .mockResolvedValueOnce([{ internalId: 'rubric', displayName: 'Rubric', publishName: 'rubric', latestVersion: '1.0.0', state: 'draft', criterionCount: 1 }])
      .mockResolvedValueOnce([]);
    const client = stubClient({ deleteEvaluationDataset, deleteEvaluatorProfile, deleteJudgeRubric, listEvaluationDatasets, listEvaluatorProfiles, listJudgeRubrics });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Datasets' }));

    await userEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]!);
    let dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteEvaluationDataset).toHaveBeenCalledWith('set', scope));
    expect(await screen.findByText('No evaluation datasets.')).toBeTruthy();

    await userEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]!);
    dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteEvaluatorProfile).toHaveBeenCalledWith('profile', scope));
    expect(await screen.findByText('No evaluator profiles.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteJudgeRubric).toHaveBeenCalledWith('rubric', scope));

    expect(listEvaluationDatasets).toHaveBeenCalledTimes(2);
    expect(listEvaluatorProfiles).toHaveBeenCalledTimes(2);
    expect(listJudgeRubrics).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No evaluator profiles.')).toBeTruthy();
    expect(await screen.findByText('No judge rubrics.')).toBeTruthy();
  });

  it('Personaフォームの入力を保存POSTのDTO形へ写像する', async () => {
    const savePersona = vi.fn().mockResolvedValue({ metadata: { internalId: 'novice-user', version: '1.1.0' } });
    const client = stubClient({ savePersona });
    render(<ValidationPage client={client} />);
    await screen.findByText('No saved personas.');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Persona archetype' }), 'expert');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Persona knowledge level' }), 'high');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Persona verbosity' }), 'terse');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Persona language' }), 'en');
    const tone = screen.getByRole('textbox', { name: 'Persona tone' });
    await userEvent.clear(tone);
    await userEvent.type(tone, 'blunt');
    await userEvent.type(screen.getByRole('textbox', { name: 'Persona extra instructions' }), 'Ask hard questions.');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Persona version bump' }), 'minor');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(savePersona).toHaveBeenCalledWith({
      scope,
      internalId: 'novice-user', workingName: 'Novice user draft', displayName: 'Novice user', publishName: 'novice_user', owner: 'local-user',
      archetype: 'expert', knowledgeLevel: 'high', patience: 'mid', tone: 'blunt', verbosity: 'terse', language: 'en',
      extraInstructions: 'Ask hard questions.',
      bump: 'minor',
    }));
    expect(await screen.findByText('saved 1.1.0')).toBeTruthy();
  });

  it('保存済みPersonaを疑似ユーザーAgentとして登録する（v18）', async () => {
    const savePersona = vi.fn().mockResolvedValue({ metadata: { internalId: 'novice-user', version: '1.0.0' } });
    const registerPseudoUserAgent = vi.fn().mockResolvedValue({ metadata: { internalId: 'pseudo-novice-user', version: '1.0.0' } });
    const client = stubClient({ savePersona, registerPseudoUserAgent });
    render(<ValidationPage client={client} />);
    await screen.findByText('No saved personas.');
    // 保存前は登録ボタンは無効。
    expect((screen.getByRole('button', { name: 'Register pseudo-user agent' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await screen.findByText('saved 1.0.0');
    await userEvent.click(screen.getByRole('button', { name: 'Register pseudo-user agent' }));
    await waitFor(() => expect(registerPseudoUserAgent).toHaveBeenCalledWith('novice-user', { scope }));
    expect(await screen.findByText(/pseudo-novice-user@1\.0\.0/)).toBeTruthy();
  });

  it('Deleteでdeletepersonaを呼び、一覧を再取得する（確認ダイアログ経由、キャンセルでは呼ばれない）', async () => {
    const deletePersona = vi.fn().mockResolvedValue(undefined);
    const listPersonas = vi.fn()
      .mockResolvedValueOnce([{ internalId: 'novice-user', displayName: 'Novice user', publishName: 'novice_user', latestVersion: '1.0.0', archetype: 'novice', state: 'draft' }])
      .mockResolvedValueOnce([]);
    const client = stubClient({ deletePersona, listPersonas });
    render(<ValidationPage client={client} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deletePersona).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    expect(deletePersona).toHaveBeenCalledWith('novice-user', scope);
    expect(listPersonas).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('No saved personas.')).toBeTruthy();
  });

  it('Scenarioフォーム（survey編集含む）を保存DTOへ写像し、実行でRunsタブへ遷移する', async () => {
    const saveScenario = vi.fn().mockResolvedValue({ metadata: { internalId: 'sales-summary-scenario', version: '1.0.0' } });
    const runScenario = vi.fn().mockResolvedValue({ id: 'srun-1', status: 'completed' });
    const client = stubClient({
      listAgents: vi.fn().mockResolvedValue([
        { internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' },
        { internalId: 'pseudo-novice', displayName: 'Pseudo Novice', publishName: 'novice_pseudo', latestVersion: '1.0.0', kind: 'pseudo-user', state: 'draft' },
      ]),
      listAgentVersions: vi.fn().mockResolvedValue(['1.0.0', '2.0.0']),
      saveScenario, runScenario,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    await screen.findByText('No saved scenarios.');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scenario target agent' }), 'agent');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Scenario agent version' }) as HTMLSelectElement).value).toBe('2.0.0'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scenario agent version' }), '1.0.0');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scenario pseudo-user agent' }), 'pseudo-novice');
    await userEvent.type(screen.getByRole('textbox', { name: 'Scenario goal' }), 'Get the monthly sales summary.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Scenario context' }), 'Before the accounting deadline.');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Scenario max user turns' }), { target: { value: '3' } });
    await userEvent.type(screen.getByRole('textbox', { name: 'Scenario expected tools' }), 'summary_tool, score_tool');
    // survey編集: 既定8問から1問削除→1問追加→追加分の型をtextへ切替（min/maxが落ちる）。
    await userEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Question 8 text (Japanese)' }), '追加設問');
    await userEvent.type(screen.getByRole('textbox', { name: 'Question 8 text (English)' }), 'Added question');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Question 8 kind' }), 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(saveScenario).toHaveBeenCalledTimes(1));
    const dto = saveScenario.mock.calls[0]?.[0] as {
      target: unknown; pseudoUser: unknown; goal: string; context: string; maxUserTurns: number;
      expectedTools: string[]; survey: { id: string }[]; bump: string;
    };
    expect(dto).toMatchObject({
      scope, internalId: 'sales-summary-scenario', publishName: 'sales_summary_scenario', owner: 'local-user',
      target: { agentId: 'agent', version: '1.0.0' },
      pseudoUser: { agentId: 'pseudo-novice', version: '1.0.0' },
      goal: 'Get the monthly sales summary.', context: 'Before the accounting deadline.',
      maxUserTurns: 3, expectedTools: ['summary_tool', 'score_tool'], bump: 'patch',
    });
    expect(dto.survey.map((question) => question.id)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'impressions', 'q8']);
    expect(dto.survey[0]).toEqual({ id: 'q2', textJa: '総合満足度', textEn: 'Overall satisfaction', kind: 'scale', min: 1, max: 5 });
    expect(dto.survey[7]).toEqual({ id: 'q8', textJa: '追加設問', textEn: 'Added question', kind: 'text' });

    // 実行: POST /scenarios/:id/run 相当の呼び出しと、完了後のRunsタブ遷移。
    await screen.findByText('saved 1.0.0');
    await userEvent.click(screen.getByRole('button', { name: 'Run scenario' }));
    await waitFor(() => expect(runScenario).toHaveBeenCalledWith('sales-summary-scenario', { scope, version: '1.0.0', mode: 'test' }));
    expect(await screen.findByText('No scenario runs yet.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Runs' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Deleteでdeletescenarioを呼び、一覧を再取得する（確認ダイアログ経由）', async () => {
    const deleteScenario = vi.fn().mockResolvedValue(undefined);
    const listScenarios = vi.fn()
      .mockResolvedValueOnce([{ internalId: 'sales-summary-scenario', displayName: 'Sales summary scenario', publishName: 'sales_summary_scenario', latestVersion: '1.0.0', state: 'draft' }])
      .mockResolvedValueOnce([]);
    const client = stubClient({ deleteScenario, listScenarios });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Sales summary scenario');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(deleteScenario).toHaveBeenCalledWith('sales-summary-scenario', scope);
    expect(listScenarios).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('No saved scenarios.')).toBeTruthy();
  });

  it('Runs詳細でtranscript・surveyバー・感想・metrics・runIdトレースを表示する', async () => {
    const run = {
      id: 'srun-1', scope, scenario: { id: 'sc', version: '1.2.0' }, status: 'completed', goalAchieved: true,
      transcript: [
        { speaker: 'user', message: 'I need the monthly sales summary.' },
        { speaker: 'agent', message: 'Here is the summary.', runId: 'run-agent-1' },
      ],
      survey: [
        { questionId: 'q1', value: true },
        { questionId: 'q2', value: 4 },
        { questionId: 'q7', value: 'A bit slow.' },
        { questionId: 'impressions', value: 'Smooth overall.' },
      ],
      impressions: 'Smooth overall.',
      metrics: {
        userTurns: 2, agentRuns: 2, totalToolCalls: 3,
        expectedToolHit: { expected: ['summary_tool'], called: ['summary_tool'], hitRate: 1 },
        durationMs: 1234, usage: { totalTokens: 500 },
      },
      startedAt: '2026-07-03T00:00:00Z', finishedAt: '2026-07-03T00:00:05Z',
    };
    const getScenario = vi.fn().mockResolvedValue({
      metadata: { internalId: 'sc', version: '1.2.0' },
      target: { agentId: 'agent', version: '1.0.0' }, persona: { personaId: 'novice-user', version: '1.0.0' },
      goal: 'goal', maxUserTurns: 4,
      survey: [
        { id: 'q1', textJa: '目的を達成できましたか', textEn: 'Did you achieve your goal?', kind: 'boolean' },
        { id: 'q2', textJa: '総合満足度', textEn: 'Overall satisfaction', kind: 'scale', min: 1, max: 5 },
        { id: 'q7', textJa: '不満・困った点', textEn: 'What was frustrating or unclear?', kind: 'text' },
        { id: 'impressions', textJa: '感想（自由記述）', textEn: 'Overall impressions (free text)', kind: 'text' },
      ],
    });
    const getRunTrace = vi.fn().mockResolvedValue({
      runId: 'run-agent-1', scope, status: 'succeeded', mode: 'test', startedAt: '2026-07-03T00:00:01Z',
      response: 'Here is the summary.',
      trace: [{ sequence: 1, kind: 'tool-call', name: 'summary_tool', arguments: { month: '2026-06' } }],
    });
    const client = stubClient({
      listScenarioRuns: vi.fn().mockResolvedValue([run]),
      listScenarios: vi.fn().mockResolvedValue([{ internalId: 'sc', displayName: 'Sales scenario', publishName: 'sc', latestVersion: '1.2.0', state: 'draft' }]),
      getScenario, getRunTrace,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const item = await screen.findByRole('button', { name: /Sales scenario/ });
    expect(item.textContent).toContain('completed');
    expect(item.textContent).toContain('goal achieved');
    expect(item.textContent).toContain('satisfaction 4');
    await userEvent.click(item);
    await waitFor(() => expect(getScenario).toHaveBeenCalledWith('sc', scope, '1.2.0'));
    // transcript吹き出し（user/agent）。
    expect(await screen.findByText('I need the monthly sales summary.')).toBeTruthy();
    expect(screen.getByText('Here is the summary.')).toBeTruthy();
    // survey: scale=水平バー、boolean=○×、text=ブロック。
    expect(await screen.findByRole('img', { name: 'Overall satisfaction: 4/5' })).toBeTruthy();
    expect(screen.getByText('○')).toBeTruthy();
    expect(screen.getByText('A bit slow.')).toBeTruthy();
    // 感想（独立フィールド）とsurveyのtext回答で計2回表示される。
    expect(screen.getAllByText('Smooth overall.')).toHaveLength(2);
    // metrics表。
    expect(screen.getByText('100% (summary_tool / summary_tool)')).toBeTruthy();
    expect(screen.getByText('1234 ms')).toBeTruthy();
    expect(screen.getByText('500')).toBeTruthy();
    // agentターンのrunIdから既存Runトレースを開く。
    await userEvent.click(screen.getByRole('button', { name: 'Open run trace run-agent-1' }));
    await waitFor(() => expect(getRunTrace).toHaveBeenCalledWith('run-agent-1', scope));
    expect(await screen.findByText(/summary_tool \{"month":"2026-06"\}/)).toBeTruthy();
  });
});
