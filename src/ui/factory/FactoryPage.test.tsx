// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, DataSourceDto, FactoryPlanDto, FactoryRunDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { FactoryPage } from './FactoryPage';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

const dataSources: readonly DataSourceDto[] = [
  { id: 'ds-sales', tenant: scope, name: 'Sales CSV', createdAt: 'now', updatedAt: 'now', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 100 },
];

const agents: readonly AgentSummaryDto[] = [
  { internalId: 'agent-sales', displayName: 'Sales Assistant', publishName: 'sales_assistant', latestVersion: '1.2.0', kind: 'normal', state: 'draft' },
];

function baseRun(overrides: Partial<FactoryRunDto> = {}): FactoryRunDto {
  return {
    id: 'run-1',
    scope,
    input: {
      goal: { goal: 'Answer sales questions', language: 'ja' },
      dataSourceIds: ['ds-sales'],
      options: {
        maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false, promptStrategy: 'preserve', toolGeneration: 'staged',
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
    listAgents: vi.fn().mockResolvedValue(agents),
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
      options: { maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false, toolGeneration: 'staged' },
    }));
    expect(await screen.findByText('run-1')).toBeTruthy();
  });

  it('ツールの作り方は既定で段階的で、一括を選ぶと options に載る', async () => {
    const created = baseRun();
    const createFactoryRun = vi.fn().mockResolvedValue(created);
    const client = stubClient({
      createFactoryRun,
      getFactoryRun: vi.fn().mockResolvedValue(created),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');

    // 生成モードでも強化モードでも効く設定なので、詳細オプションに常に出す。
    const generation = await screen.findByLabelText('Factory tool generation');
    expect((generation as HTMLSelectElement).value).toBe('staged');
    expect(screen.getByRole('option', { name: 'Staged (recommended)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'One-shot' })).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Factory goal'), 'Answer sales questions');
    await userEvent.click(screen.getByRole('checkbox', { name: /Sales CSV/ }));
    await userEvent.selectOptions(generation, 'one-shot');
    await userEvent.click(screen.getByRole('button', { name: 'Start factory run' }));

    await waitFor(() => expect(createFactoryRun).toHaveBeenCalledWith(expect.objectContaining({
      options: { maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false, toolGeneration: 'one-shot' },
    })));
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
    await screen.findByText('Plan approval required');
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
    await screen.findByText('Plan approval required');
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
          { iteration: 1, goalAchievedRate: 0, avgSatisfaction: 2, toolHitRate: 0, errorRate: 0, avgUserTurns: 1, scenarioCount: 1, surveyMissingCount: 0, usage: { totalTokens: 15 }, durationMs: 250 },
          { iteration: 2, goalAchievedRate: 1, avgSatisfaction: 5, toolHitRate: 1, errorRate: 0, avgUserTurns: 1, scenarioCount: 1, surveyMissingCount: 0, usage: { totalTokens: 15 }, durationMs: 250 },
        ],
        quality: 'met-targets',
        qualityReasons: [],
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

  it('既定は生成モードで対象Agentセレクタを出さず、強化モードに切り替えると出す', async () => {
    const client = stubClient();
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');
    expect(screen.queryByLabelText('Factory base agent')).toBeNull();
    expect(screen.queryByText('Optional — add data sources only if the agent needs new tools.')).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: 'Enhance an existing agent' }));
    const select = await screen.findByLabelText('Factory base agent');
    expect(select).toBeTruthy();
    // データソースが任意である旨を注記し、goalの説明も強化向けに変わる。
    expect(screen.getByText('Optional — add data sources only if the agent needs new tools.')).toBeTruthy();
    expect(screen.getByText('Describe how the existing agent should improve.')).toBeTruthy();
    // 選択肢は displayName + 最新バージョン。
    expect(screen.getByRole('option', { name: 'Sales Assistant (1.2.0)' })).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: 'Create a new agent' }));
    expect(screen.queryByLabelText('Factory base agent')).toBeNull();
    expect(screen.getByText('Describe what kind of agent you want to create.')).toBeTruthy();
  });

  it('Agent一覧の取得だけが失敗しても、データソースと実行履歴は表示できる', async () => {
    const client = stubClient({ listAgents: vi.fn().mockRejectedValue(new Error('agents unavailable')) });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');
    expect(screen.queryByText('agents unavailable')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Enhance an existing agent' }));
    expect(screen.getByText('No agents to enhance. Create one first.')).toBeTruthy();
  });

  it('強化モードではAgentが0件のとき説明を出し、モード切替自体は無効化しない', async () => {
    const client = stubClient({ listAgents: vi.fn().mockResolvedValue([]) });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');
    const enhanceRadio = screen.getByRole('radio', { name: 'Enhance an existing agent' });
    expect((enhanceRadio as HTMLInputElement).disabled).toBe(false);

    await userEvent.click(enhanceRadio);
    expect(await screen.findByText('No agents to enhance. Create one first.')).toBeTruthy();
    expect(screen.queryByLabelText('Factory base agent')).toBeNull();
    expect((screen.getByRole('button', { name: 'Start factory run' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('強化モードはデータソース未選択でも開始でき、baseAgent付きでcreateFactoryRunを呼ぶ', async () => {
    const created = baseRun({ input: { ...baseRun().input, dataSourceIds: [], baseAgent: { internalId: 'agent-sales' } } });
    const createFactoryRun = vi.fn().mockResolvedValue(created);
    const client = stubClient({
      createFactoryRun,
      getFactoryRun: vi.fn().mockResolvedValue(created),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');

    await userEvent.click(screen.getByRole('radio', { name: 'Enhance an existing agent' }));
    await userEvent.type(screen.getByLabelText('Factory goal'), 'Improve totals accuracy');
    await userEvent.selectOptions(await screen.findByLabelText('Factory base agent'), 'agent-sales');

    const startButton = screen.getByRole('button', { name: 'Start factory run' }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    await userEvent.click(startButton);

    await waitFor(() => expect(createFactoryRun).toHaveBeenCalledWith({
      scope,
      goal: { goal: 'Improve totals accuracy', language: 'ja' },
      baseAgent: { internalId: 'agent-sales' },
      dataSourceIds: [],
      // 強化モードでは systemPrompt の扱いも送る（既定は既存プロンプトを保つ側）。
      options: { maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false, toolGeneration: 'staged', promptStrategy: 'preserve' },
    }));
  });

  it('systemPromptの扱いは強化モードでのみ選べ、rewriteを選ぶとoptionsに載る', async () => {
    const created = baseRun({ input: { ...baseRun().input, dataSourceIds: [], baseAgent: { internalId: 'agent-sales' } } });
    const createFactoryRun = vi.fn().mockResolvedValue(created);
    const client = stubClient({
      createFactoryRun,
      getFactoryRun: vi.fn().mockResolvedValue(created),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');

    // 生成モード（0→1）では無関係なので出さない。
    expect(screen.queryByLabelText('Factory prompt strategy')).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: 'Enhance an existing agent' }));
    const strategy = await screen.findByLabelText('Factory prompt strategy');
    expect((strategy as HTMLSelectElement).value).toBe('preserve');
    expect(screen.getByText('Rewriting uses one extra model call and may change wording you wrote by hand.')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Factory goal'), 'Improve totals accuracy');
    await userEvent.selectOptions(await screen.findByLabelText('Factory base agent'), 'agent-sales');
    await userEvent.selectOptions(strategy, 'rewrite');
    await userEvent.click(screen.getByRole('button', { name: 'Start factory run' }));

    await waitFor(() => expect(createFactoryRun).toHaveBeenCalledWith(expect.objectContaining({
      options: { maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: false, toolGeneration: 'staged', promptStrategy: 'rewrite' },
    })));
  });

  it('強化モードで対象Agent未選択なら開始できず理由を表示する', async () => {
    const client = stubClient();
    render(<FactoryPage client={client} />);
    await screen.findByText('Sales CSV');

    await userEvent.click(screen.getByRole('radio', { name: 'Enhance an existing agent' }));
    expect(screen.getByText('Select the agent to enhance and enter what to improve.')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Factory goal'), 'Improve totals accuracy');
    const startButton = screen.getByRole('button', { name: 'Start factory run' }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    expect(screen.getByText('Select the agent to enhance.')).toBeTruthy();

    await userEvent.selectOptions(await screen.findByLabelText('Factory base agent'), 'agent-sales');
    expect(startButton.disabled).toBe(false);
    expect(screen.queryByText('Select the agent to enhance.')).toBeNull();
  });

  it('一覧ラベルと詳細バッジが強化モードのRunで変わる', async () => {
    const enhanceRun = baseRun({
      status: 'running',
      input: { ...baseRun().input, dataSourceIds: [], baseAgent: { internalId: 'agent-sales' } },
    });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([enhanceRun]),
      getFactoryRun: vi.fn().mockResolvedValue(enhanceRun),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);

    // 一覧ラベルは goal ではなく対象Agent名で表示される。
    const listItem = await screen.findByRole('button', { name: /Enhance: Sales Assistant/ });
    await userEvent.click(listItem);
    await screen.findByText(/Stage:/);
    expect(screen.getByText('Enhance')).toBeTruthy();
    expect(screen.queryByText('Create')).toBeNull();
  });

  it('生成モードのRunの詳細では新規作成バッジを出す', async () => {
    const running = baseRun({ status: 'running' });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([running]),
      getFactoryRun: vi.fn().mockResolvedValue(running),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText(/Stage:/);
    expect(screen.getByText('Create')).toBeTruthy();
    expect(screen.queryByText('Enhance')).toBeNull();
  });

  it('強化モードの承認カードは既存Agentへの変更計画として追加Tool/Skill/検証シナリオ件数を出す', async () => {
    const waiting = baseRun({
      status: 'waiting-approval',
      stage: 'planning',
      input: { ...baseRun().input, dataSourceIds: [], baseAgent: { internalId: 'agent-sales' } },
      plan,
      checkpoint: { kind: 'plan-approval', expiresAt: '2026-07-21T00:00:00.000Z', prompt: 'Approve this change?', plan },
    });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([waiting]),
      getFactoryRun: vi.fn().mockResolvedValue(waiting),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Enhance: Sales Assistant/ }));
    await screen.findByText('Change plan approval required');

    expect(screen.getByText('Change plan approval required')).toBeTruthy();
    expect(screen.getByText(/Change plan for existing agent/).textContent).toContain('Sales Assistant');
    expect(screen.getByText('Tools to add: 1')).toBeTruthy();
    expect(screen.getByText('Skills to add: 1')).toBeTruthy();
    expect(screen.getByText('Validation scenarios: 1')).toBeTruthy();
    // 生成モード向けの見出し・ペルソナ件数は出さない。
    expect(screen.queryByText('Plan approval required')).toBeNull();
    expect(screen.queryByText('Personas: 1')).toBeNull();
  });

  it('強化モードのレポートは追加Tool/Skillが0件でも「コンテキスト改善のみ」と説明する', async () => {
    const succeeded = baseRun({
      status: 'succeeded',
      stage: 'reporting',
      input: { ...baseRun().input, dataSourceIds: [], baseAgent: { internalId: 'agent-sales' } },
      artifacts: { tools: [], skills: [], agentVersions: [{ internalId: 'agent-sales', version: '1.2.0' }], personas: [], pseudoUsers: [], scenarios: [] },
      report: {
        bestIteration: 1,
        candidate: { agentId: 'agent-sales', version: '1.2.0' },
        summary: 'Enhanced existing agent Sales Assistant@1.2.0.',
        openFindings: [],
        metricsByIteration: [
          { iteration: 1, goalAchievedRate: 1, avgSatisfaction: 5, toolHitRate: 1, errorRate: 0, avgUserTurns: 1, scenarioCount: 1, surveyMissingCount: 0, usage: { totalTokens: 15 }, durationMs: 250 },
        ],
        quality: 'met-targets',
        qualityReasons: [],
      },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeeded]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Enhance: Sales Assistant/ }));
    await screen.findByText('Report');

    expect(screen.getByText('Added tools / skills (drafts)')).toBeTruthy();
    expect(screen.queryByText('Generated assets (drafts)')).toBeNull();
    expect(screen.getByText('No new capabilities were added; the agent context was improved.')).toBeTruthy();
  });

  it('強化Runの対象Agentが一覧に無ければ internalId をラベルに使う', async () => {
    const enhanceRun = baseRun({
      status: 'succeeded',
      input: { ...baseRun().input, dataSourceIds: [], baseAgent: { internalId: 'agent-removed' } },
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([enhanceRun]) });
    render(<FactoryPage client={client} />);
    expect(await screen.findByRole('button', { name: /Enhance: agent-removed/ })).toBeTruthy();
  });

  it('正常: 日本語表示では計画承認の説明文がサーバー生成の英文のまま出ず、日本語で組み立て直される', async () => {
    const waiting = baseRun({
      status: 'waiting-approval',
      stage: 'planning',
      plan,
      checkpoint: {
        kind: 'plan-approval', expiresAt: '2026-07-21T00:00:00.000Z',
        prompt: 'Review the proposed plan for "Answer sales questions": agent "Sales Assistant" with 1 tool(s), 1 skill(s), 1 persona(s), 1 scenario(s).',
        plan,
      },
    });
    const client = stubClient({
      listFactoryRuns: vi.fn().mockResolvedValue([waiting]),
      getFactoryRun: vi.fn().mockResolvedValue(waiting),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Sales Assistant/ }));
    await screen.findByText('計画の承認が必要です');
    // サーバーが生成した英文そのままは出ない。
    expect(screen.queryByText(/Review the proposed plan for/)).toBeNull();
    // goal・エージェント名・件数を含む日本語文になっている。
    expect(screen.getByText(/「Answer sales questions」の計画案です/).textContent).toContain('Sales Assistant');
  });

  it('正常: レポート総括がFactory側の決定的フォールバック文なら日本語にする（Analyst生成の自由文はそのまま）', async () => {
    const succeeded = baseRun({
      status: 'succeeded',
      stage: 'reporting',
      report: {
        bestIteration: 1,
        candidate: { agentId: 'asset-3', version: '1.0.1' },
        summary: 'Factory run stopped after 2 iteration(s); latest goalAchievedRate=0.50, avgSatisfaction=3.00.',
        openFindings: [],
        metricsByIteration: [],
        quality: 'unverified',
        qualityReasons: [],
      },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeeded]) });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('レポート');
    expect(screen.queryByText(/Factory run stopped after/)).toBeNull();
    expect(screen.getByText(/2 回のイテレーション後にFactory runが停止しました/)).toBeTruthy();
  });

  it('境界: レポートの候補がAgent一覧に見つかれば表示名で出す（見つからなければ内部IDのまま）', async () => {
    const succeeded = baseRun({
      status: 'succeeded',
      stage: 'reporting',
      report: {
        bestIteration: 1,
        candidate: { agentId: 'agent-sales', version: '1.2.0' },
        summary: 'Enhanced.',
        openFindings: [],
        metricsByIteration: [],
        quality: 'met-targets',
        qualityReasons: [],
      },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeeded]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    expect(screen.getByText(/Candidate/).textContent).toContain('Sales Assistant@1.2.0');
    expect(screen.queryByText(/agent-sales@1.2.0/)).toBeNull();
  });
});

describe('FactoryPage（v54: マニュアル撮影で見つかった残り）', () => {
  function succeededWith(report: Partial<NonNullable<FactoryRunDto['report']>>): FactoryRunDto {
    return baseRun({
      status: 'succeeded',
      stage: 'reporting',
      report: {
        bestIteration: 1,
        candidate: { agentId: 'agent-new', version: '1.0.0' },
        summary: 'Done.',
        openFindings: [],
        metricsByIteration: [],
        quality: 'met-targets',
        qualityReasons: [],
        ...report,
      },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
  }
  const newAgent: AgentSummaryDto = { internalId: 'agent-new', displayName: 'New Sales Bot', publishName: 'new_sales_bot', latestVersion: '1.0.0', kind: 'normal', state: 'draft' };

  it('正常: 候補が画面を開いたときの一覧に無ければ一覧を読み直し、表示名で出す（G1）', async () => {
    const listAgents = vi.fn().mockResolvedValueOnce(agents).mockResolvedValue([...agents, newAgent]);
    const client = stubClient({ listAgents, listFactoryRuns: vi.fn().mockResolvedValue([succeededWith({})]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    await waitFor(() => expect(screen.getByText(/Candidate/).textContent).toContain('New Sales Bot@1.0.0'));
    expect(screen.queryByText(/agent-new@1.0.0/)).toBeNull();
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('正常: 開いたまま Run が完了して候補が現れたときも読み直す（G1）', async () => {
    const running = baseRun({ status: 'running', stage: 'validating' });
    const done = succeededWith({});
    const listAgents = vi.fn().mockResolvedValueOnce(agents).mockResolvedValue([...agents, newAgent]);
    const client = stubClient({
      listAgents,
      listFactoryRuns: vi.fn().mockResolvedValue([running]),
      getFactoryRun: vi.fn().mockResolvedValue(done),
      getFactoryRunEvents: vi.fn().mockResolvedValue([]),
    });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    await waitFor(() => expect(screen.getByText(/Candidate/).textContent).toContain('New Sales Bot@1.0.0'));
  });

  it('境界: 読み直しても見つからなければ内部IDのまま出し、同じ id で繰り返し取りに行かない（G1）', async () => {
    const listAgents = vi.fn().mockResolvedValue(agents);
    const other = { ...succeededWith({}), id: 'run-2' };
    const client = stubClient({ listAgents, listFactoryRuns: vi.fn().mockResolvedValue([succeededWith({}), other]) });
    render(<FactoryPage client={client} />);
    const [first, second] = await screen.findAllByRole('button', { name: /Answer sales questions/ });
    await userEvent.click(first!);
    await screen.findByText('Report');
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));
    // 同じ候補 id の別の Run を開き直しても、もう取りに行かない。
    await userEvent.click(second!);
    await userEvent.click(first!);
    expect(screen.getByText(/Candidate/).textContent).toContain('agent-new@1.0.0');
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('従来どおり: 候補が最初の一覧にあれば読み直さない（G1）', async () => {
    const listAgents = vi.fn().mockResolvedValue([...agents, newAgent]);
    const client = stubClient({ listAgents, listFactoryRuns: vi.fn().mockResolvedValue([succeededWith({})]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    expect(screen.getByText(/Candidate/).textContent).toContain('New Sales Bot@1.0.0');
    expect(listAgents).toHaveBeenCalledTimes(1);
  });

  it('例外: 読み直しが失敗しても画面は落ちず、内部IDのまま出す（G1）', async () => {
    const listAgents = vi.fn().mockResolvedValueOnce(agents).mockRejectedValue(new Error('agents unavailable'));
    const client = stubClient({ listAgents, listFactoryRuns: vi.fn().mockResolvedValue([succeededWith({})]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Candidate/).textContent).toContain('agent-new@1.0.0');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  function runWithEvents(events: FactoryRunDto['events']): FactoryRunDto {
    return { ...succeededWith({}), events };
  }

  it('正常: タイムラインの承認依頼の行も、計画承認カードと同じ日本語文で出す（G2）', async () => {
    const run = runWithEvents([
      { sequence: 1, kind: 'approval_requested', at: '2026-07-20T00:00:00.000Z', stage: 'planning', message: 'Review the proposed plan for "Answer sales questions": agent "Sales Assistant" with 2 tool(s), 1 skill(s), 2 persona(s), 4 scenario(s).' },
      { sequence: 2, kind: 'approval_requested', at: '2026-07-20T00:00:01.000Z', stage: 'planning', message: 'Review the proposed enhancement for "Improve totals": add 1 tool(s) and 0 skill(s) to the existing agent "Sales (v2)" (Sales (v2)@1.2.0), then validate it with 3 scenario(s) across 2 persona(s).' },
    ]);
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([run]) });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('タイムライン');
    expect(screen.queryByText(/Review the proposed/)).toBeNull();
    expect(screen.getByText(/「Answer sales questions」の計画案です: エージェント「Sales Assistant」、Tool 2 件、Skill 1 件、ペルソナ 2 件、シナリオ 4 件。/)).toBeTruthy();
    expect(screen.getByText(/「Improve totals」に対する変更計画です: 既存エージェント「Sales \(v2\)」に Tool 1 件・Skill 0 件を追加し、ペルソナ 2 件・シナリオ 3 件で検証します。/)).toBeTruthy();
  });

  it('従来どおり: 定型文に合わないイベント文と、承認依頼以外のイベント文は原文のまま（G2）', async () => {
    const run = runWithEvents([
      { sequence: 1, kind: 'approval_requested', at: '2026-07-20T00:00:00.000Z', stage: 'planning', message: 'Please review.' },
      { sequence: 2, kind: 'stage_started', at: '2026-07-20T00:00:01.000Z', stage: 'profiling', message: 'enhancing agent Sales@1.0.0' },
    ]);
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([run]) });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('タイムライン');
    expect(screen.getByText(/Please review\./)).toBeTruthy();
    expect(screen.getByText(/enhancing agent Sales@1\.0\.0/)).toBeTruthy();
  });

  const allReasons = [
    'no scenario was validated',
    'every scenario ended in an error, so no behaviour was actually observed',
    'no satisfaction survey could be collected, so avgSatisfaction is missing rather than low',
    'goalAchievedRate 0.50 is below the target 0.75',
    'avgSatisfaction 3.00 is below the target 4',
    '1 of 4 scenario(s) returned no satisfaction survey',
    'some future reason',
  ];

  it('正常: 目標未達の理由（run-factory.ts の定型文）を日本語の画面では日本語で出す（G2）', async () => {
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeededWith({ quality: 'below-targets', qualityReasons: allReasons })]) });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('レポート');
    const items = [...document.querySelectorAll('.factory-quality-reasons li')].map((item) => item.textContent);
    expect(items).toEqual([
      'シナリオを1件も検証できませんでした。',
      'すべてのシナリオがエラーで終わったため、エージェントの実際の振る舞いを確認できていません。',
      '満足度アンケートを1件も回収できなかったため、平均満足度は「低い」のではなく「未計測」です。',
      '目標達成率 0.50 が目標値 0.75 を下回っています。',
      '平均満足度 3.00 が目標値 4 を下回っています。',
      '4 件中 1 件のシナリオで満足度アンケートを回収できませんでした。',
      // 訳の無い文は原文のまま。
      'some future reason',
    ]);
  });

  it('従来どおり: 英語の画面では理由を原文のまま出す（G2）', async () => {
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([succeededWith({ quality: 'below-targets', qualityReasons: allReasons })]) });
    render(<FactoryPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    await screen.findByText('Report');
    const items = [...document.querySelectorAll('.factory-quality-reasons li')].map((item) => item.textContent);
    expect(items).toEqual(allReasons);
  });

  it('異常: 計画でデータソースが空のまま補えず失敗した Run は、日本語の画面で直し方つきの理由を出す（G3）', async () => {
    const failed = baseRun({
      status: 'failed',
      stage: 'planning',
      failure: {
        stage: 'planning',
        reason: 'Planning failed: the plan left the data source empty for the new tool(s) "Lookup Sales", "Lookup Costs" and it could not be filled in automatically because the run has 2 data sources. To fix it, start the run again with only the data source those tools should read, or state in the goal which data source each tool should use. Data sources: ds-1 (Sales), ds-2 (Costs).',
      },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([failed]) });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('計画で新しいツール "Lookup Sales", "Lookup Costs" のデータソースが空のままで');
    expect(alert.textContent).toContain('直し方: そのツールが読むデータソースだけを選んで開始し直す');
    expect(alert.textContent).toContain('ds-1 (Sales), ds-2 (Costs)');
    expect(alert.textContent).not.toContain('Planning failed');
  });

  it('境界: データソースの無い Run の失敗も、データソースを選び直すよう日本語で案内する（G3）', async () => {
    const failed = baseRun({
      status: 'failed',
      stage: 'planning',
      failure: { stage: 'planning', reason: 'Planning failed: the plan needs new tool(s) "Lookup Sales", but the run has no data sources for them to read. To fix it, start the run again and select the data source those tools should read.' },
      finishedAt: '2026-07-20T00:00:00.500Z',
    });
    const client = stubClient({ listFactoryRuns: vi.fn().mockResolvedValue([failed]) });
    render(<I18nProvider initialLanguage="ja"><FactoryPage client={client} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /Answer sales questions/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('直し方: 開始し直すときに、そのツールが読むデータソースを選んでください。');
  });
});
