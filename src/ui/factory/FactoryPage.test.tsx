// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { DataSourceDto, FactoryPlanDto, FactoryRunDto } from '../api/types';
import { FactoryPage } from './FactoryPage';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

const dataSources: readonly DataSourceDto[] = [
  { id: 'ds-sales', tenant: scope, name: 'Sales CSV', createdAt: 'now', updatedAt: 'now', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 100 },
];

function baseRun(overrides: Partial<FactoryRunDto> = {}): FactoryRunDto {
  return {
    id: 'run-1',
    scope,
    input: {
      goal: { goal: 'Answer sales questions', language: 'ja' },
      dataSourceIds: ['ds-sales'],
      options: {
        maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false,
        targets: { minGoalAchievedRate: 0.75, minAvgSatisfaction: 4 },
        budget: { maxDurationMs: 1_800_000, maxRoleCalls: 40, maxScenarioRuns: 20, maxRepairAttempts: 2, maxProposalsPerIteration: 4 },
      },
    },
    status: 'queued',
    stage: 'profiling',
    artifacts: { tools: [], skills: [], agentVersions: [], personas: [], pseudoUsers: [], scenarios: [] },
    iterations: [],
    budget: { consumed: { roleCalls: 0, scenarioRuns: 0, elapsedMs: 0 }, limits: { maxDurationMs: 1_800_000, maxRoleCalls: 40, maxScenarioRuns: 20, maxRepairAttempts: 2, maxProposalsPerIteration: 4 } },
    events: [],
    startedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

const plan: FactoryPlanDto = {
  agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
  tools: [{ key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-sales', sideEffect: 'read-only' }],
  skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] }],
  personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
  scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 3 }],
};

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listDataSources: vi.fn().mockResolvedValue(dataSources),
    listFactoryRuns: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('FactoryPage', () => {
  it('入力フォームとデータソース一覧を表示し、goal・データソース未選択の間はStartを無効にする', async () => {
    const client = stubClient();
    render(<FactoryPage client={client} />);
    expect(await screen.findByText('Sales CSV')).toBeTruthy();
    const startButton = screen.getByRole('button', { name: 'Start factory run' });
    expect((startButton as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Factory goal'), 'Answer sales questions');
    expect((startButton as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('checkbox', { name: /Sales CSV/ }));
    expect((startButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('Startをクリックするとcreateが呼ばれ、生成されたrunが選択・表示される', async () => {
    const created = baseRun({ status: 'queued' });
    const createFactoryRun = vi.fn().mockResolvedValue(created);
    const getFactoryRun = vi.fn().mockResolvedValue(created);
    const getFactoryRunEvents = vi.fn().mockResolvedValue([]);
    const client = stubClient({ createFactoryRun, getFactoryRun, getFactoryRunEvents });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');

    await userEvent.type(screen.getByLabelText('Factory goal'), 'Answer sales questions');
    await userEvent.click(screen.getByRole('checkbox', { name: /Sales CSV/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start factory run' }));

    await waitFor(() => expect(createFactoryRun).toHaveBeenCalledWith({
      scope,
      goal: { goal: 'Answer sales questions', language: 'ja' },
      dataSourceIds: ['ds-sales'],
      options: { maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false },
    }));
    expect(await screen.findByText('run-1')).toBeTruthy();
  });

  it('waiting-approvalのrunで計画カードを表示し、Approveをクリックするとrespondが呼ばれる', async () => {
    const waiting = baseRun({
      status: 'waiting-approval',
      stage: 'planning',
      plan,
      checkpoint: { kind: 'plan-approval', expiresAt: '2026-07-21T00:00:00.000Z', prompt: 'Approve this plan?', plan },
      events: [{ sequence: 1, kind: 'approval_requested', at: '2026-07-20T00:00:00.020Z', stage: 'planning' }],
    });
    const approved: FactoryRunDto = { ...waiting, status: 'running', checkpoint: undefined };
    const getFactoryRun = vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue(approved);
    const getFactoryRunEvents = vi.fn().mockResolvedValue(waiting.events);
    const respondToFactoryRun = vi.fn().mockResolvedValue(approved);
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([waiting]),
      getFactoryRun, getFactoryRunEvents, respondToFactoryRun,
    });
    render(<FactoryPage client={client} />);

    await userEvent.click(await screen.findByRole('button', { name: /Sales Assistant/ }));
    await screen.findByText('Approve this plan?');
    expect(screen.getByText('Tools: 1')).toBeTruthy();
    expect(screen.getByText('Personas: 1')).toBeTruthy();
    expect(screen.getByText('Scenarios: 1')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(respondToFactoryRun).toHaveBeenCalledWith('run-1', {
      scope, response: { kind: 'plan-approval', decision: 'approve' },
    }));
  });

  it('waiting-approvalのrunでrevise feedbackを入力すると修正依頼としてrespondが呼ばれる', async () => {
    const waiting = baseRun({
      status: 'waiting-approval',
      stage: 'planning',
      plan,
      checkpoint: { kind: 'plan-approval', expiresAt: '2026-07-21T00:00:00.000Z', prompt: 'Approve this plan?', plan },
    });
    const revised: FactoryRunDto = { ...waiting, checkpoint: { ...waiting.checkpoint!, prompt: 'Revised plan?' } };
    const getFactoryRun = vi.fn().mockResolvedValue(waiting);
    const getFactoryRunEvents = vi.fn().mockResolvedValue([]);
    const respondToFactoryRun = vi.fn().mockResolvedValue(revised);
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([waiting]),
      getFactoryRun, getFactoryRunEvents, respondToFactoryRun,
    });
    render(<FactoryPage client={client} />);

    await userEvent.click(await screen.findByRole('button', { name: /Sales Assistant/ }));
    await screen.findByText('Approve this plan?');
    const reviseButton = screen.getByRole('button', { name: 'Request revision' });
    expect((reviseButton as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Factory plan revise feedback'), 'Add an expert persona too.');
    expect((reviseButton as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(reviseButton);
    await waitFor(() => expect(respondToFactoryRun).toHaveBeenCalledWith('run-1', {
      scope, response: { kind: 'plan-approval', decision: 'revise', feedback: 'Add an expert persona too.' },
    }));
  });

  it('succeededのrunでレポート（bestIteration・candidate・イテレーション別metrics）を表示する', async () => {
    const succeeded = baseRun({
      status: 'succeeded',
      stage: 'reporting',
      artifacts: { tools: [{ internalId: 'asset-1', version: '1.0.0' }], skills: [], agentVersions: [{ internalId: 'asset-3', version: '1.0.1' }], personas: [], pseudoUsers: [], scenarios: [] },
      report: {
        bestIteration: 2,
        candidate: { agentId: 'asset-3', version: '1.0.1' },
        summary: 'Iteration 1 missed the goal; revised skill instructions to double-check totals.',
        openFindings: [],
        metricsByIteration: [
          { iteration: 1, goalAchievedRate: 0, avgSatisfaction: 2, toolHitRate: 0, errorRate: 0, avgUserTurns: 1, scenarioCount: 1, usage: { totalTokens: 15 }, durationMs: 250 },
          { iteration: 2, goalAchievedRate: 1, avgSatisfaction: 5, toolHitRate: 1, errorRate: 0, avgUserTurns: 1, scenarioCount: 1, usage: { totalTokens: 15 }, durationMs: 250 },
        ],
      },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeeded]) });
    render(<FactoryPage client={client} />);

    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    expect(screen.getByText(/Best iteration/).textContent).toContain('2');
    expect(screen.getByText(/Candidate/).textContent).toContain('asset-3@1.0.1');
    expect(screen.getByText('Iteration 1 missed the goal; revised skill instructions to double-check totals.')).toBeTruthy();
    expect(screen.getByText('2.0')).toBeTruthy();
    expect(screen.getByText('5.0')).toBeTruthy();
    expect(screen.getAllByText('100%')).toHaveLength(2);
    expect(screen.getByText('No open findings.')).toBeTruthy();
    expect(screen.getByText('Tools: 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('goal・データソース未選択の間はStartボタン近傍に理由ヒントを出す', async () => {
    const client = stubClient();
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');
    expect(screen.getByText('Enter a goal and select at least one data source.')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Factory goal'), 'Answer sales questions');
    expect(screen.getByText('Select at least one data source.')).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox', { name: /Sales CSV/ }));
    expect(screen.queryByText('Select at least one data source.')).toBeNull();
    expect(screen.queryByText('Enter a goal and select at least one data source.')).toBeNull();
  });

  it('実行中のrunがある間はStartボタンを無効化し理由を表示する（多重起票防止）', async () => {
    const running = baseRun({ status: 'running' });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([running]),
      getFactoryRun: vi.fn().mockResolvedValue(running),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');
    await userEvent.type(screen.getByLabelText('Factory goal'), 'Another goal');
    await userEvent.click(screen.getByRole('checkbox', { name: /Sales CSV/ }));

    const startButton = screen.getByRole('button', { name: 'Start factory run' });
    expect((startButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('A factory run is already in progress. Wait for it to finish before starting another.')).toBeTruthy();
  });

  it('ポーリングが一時的に失敗しても、次の成功でエラーバナーが消える', async () => {
    const running = baseRun({ status: 'running' });
    const getFactoryRun = vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(running);
    const getFactoryRunEvents = vi.fn().mockResolvedValue([]);
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([running]), getFactoryRun, getFactoryRunEvents });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    expect(await screen.findByText('network blip')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('network blip')).toBeNull(), { timeout: 3000 });
  }, 8000);

  it('runのstatus・タイムラインのイベント名/ステージを翻訳ラベルで表示する', async () => {
    const waiting = baseRun({
      status: 'waiting-approval',
      stage: 'planning',
      plan,
      checkpoint: { kind: 'plan-approval', expiresAt: '2026-07-21T00:00:00.000Z', prompt: 'Approve this plan?', plan },
      events: [
        { sequence: 1, kind: 'stage_started', at: '2026-07-20T00:00:00.010Z', stage: 'planning' },
        { sequence: 2, kind: 'tool_reused', at: '2026-07-20T00:00:01.000Z', stage: 'generating-tools', message: 'today: current_datetime' },
      ],
    });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([waiting]),
      getFactoryRun: vi.fn().mockResolvedValue(waiting),
      getFactoryRunEvents: vi.fn().mockResolvedValue(waiting.events),
    });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Sales Assistant/ }));
    // status enumの生値ではなく翻訳ラベルで出す。
    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0);
    expect(screen.queryByText('waiting-approval')).toBeNull();
    // ステージも翻訳済み。
    expect(screen.getByText('Stage: Planning')).toBeTruthy();
    // タイムラインのイベント名も翻訳済み（既存Toolの再利用イベントを含む）。
    expect(screen.getByText('Stage started')).toBeTruthy();
    expect(screen.queryByText('stage_started')).toBeNull();
    expect(screen.getByText('Tool reused')).toBeTruthy();
    expect(screen.queryByText('tool_reused')).toBeNull();
  });

  it('実行中のrunはrun開始からの経過時間を表示する', async () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const running = baseRun({ status: 'running', startedAt });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([running]),
      getFactoryRun: vi.fn().mockResolvedValue(running),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    expect(await screen.findByText(/Elapsed: \d+s/)).toBeTruthy();
  });

  it('終了済みのrunでは経過時間を表示しない', async () => {
    const succeeded = baseRun({ status: 'succeeded' });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeeded]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText(/Stage:/);
    expect(screen.queryByText(/Elapsed:/)).toBeNull();
  });

  it('取消ボタンはConfirmDialogでの確認を経てからcancelFactoryRunを呼ぶ', async () => {
    const running = baseRun({ status: 'running' });
    const cancelled: FactoryRunDto = { ...running, status: 'cancelled' };
    const cancelFactoryRun = vi.fn().mockResolvedValue(cancelled);
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([running]),
      getFactoryRun: vi.fn().mockResolvedValue(running),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
      cancelFactoryRun,
    });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(cancelFactoryRun).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(cancelFactoryRun).toHaveBeenCalledWith('run-1', scope));
  });

  it('failedのrunでは再実行ボタンを表示し、クリックすると新しいrunへ切り替えて一覧を再読込する', async () => {
    const failed = baseRun({ status: 'failed', stage: 'generating-tools', failure: { stage: 'generating-tools', reason: 'model provider error' } });
    const retried = baseRun({ id: 'run-2', status: 'queued' });
    const retryFactoryRun = vi.fn().mockResolvedValue(retried);
    const listFactoryRuns = vi.fn().mockResolvedValueOnce([failed]).mockResolvedValue([retried, failed]);
    const client = stubClient({
      listFactoryRuns,
      getFactoryRun: vi.fn().mockResolvedValue(retried),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
      retryFactoryRun,
    });
    render(<FactoryPage client={client} />);

    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    expect(screen.getByText(/model provider error/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Retry run' }));
    await waitFor(() => expect(retryFactoryRun).toHaveBeenCalledWith('run-1', scope));
    // 新しいrunが選択され、一覧も再読込される。
    expect(await screen.findByText('run-2')).toBeTruthy();
    await waitFor(() => expect(listFactoryRuns).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Retry run' })).toBeNull();
  });

  it('failed以外のrunでは再実行ボタンを表示しない', async () => {
    const succeeded = baseRun({ status: 'succeeded' });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeeded]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText(/Stage:/);
    expect(screen.queryByRole('button', { name: 'Retry run' })).toBeNull();
  });
});
