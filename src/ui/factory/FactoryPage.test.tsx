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
});
