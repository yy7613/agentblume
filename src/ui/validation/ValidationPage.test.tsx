// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('ValidationPage', () => {
  it('Personas/Scenarios/Runsの3タブを切り替えて表示する', async () => {
    const client = stubClient();
    render(<ValidationPage client={client} />);
    expect(screen.getByRole('tab', { name: 'Personas' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No saved personas.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    expect(await screen.findByText('No saved scenarios.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('No scenario runs yet.')).toBeTruthy();
    await waitFor(() => expect(client.listScenarioRuns).toHaveBeenCalledWith(scope));
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

  it('Scenarioフォーム（survey編集含む）を保存DTOへ写像し、実行でRunsタブへ遷移する', async () => {
    const saveScenario = vi.fn().mockResolvedValue({ metadata: { internalId: 'sales-summary-scenario', version: '1.0.0' } });
    const runScenario = vi.fn().mockResolvedValue({ id: 'srun-1', status: 'completed' });
    const client = stubClient({
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]),
      listAgentVersions: vi.fn().mockResolvedValue(['1.0.0', '2.0.0']),
      listPersonas: vi.fn().mockResolvedValue([{ internalId: 'novice-user', displayName: 'Novice user', publishName: 'novice_user', latestVersion: '1.2.0', archetype: 'novice', state: 'draft' }]),
      saveScenario, runScenario,
    });
    render(<ValidationPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    await screen.findByText('No saved scenarios.');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scenario target agent' }), 'agent');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Scenario agent version' }) as HTMLSelectElement).value).toBe('2.0.0'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scenario agent version' }), '1.0.0');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scenario persona' }), 'novice-user');
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
      target: unknown; persona: unknown; goal: string; context: string; maxUserTurns: number;
      expectedTools: string[]; survey: { id: string }[]; bump: string;
    };
    expect(dto).toMatchObject({
      scope, internalId: 'sales-summary-scenario', publishName: 'sales_summary_scenario', owner: 'local-user',
      target: { agentId: 'agent', version: '1.0.0' },
      persona: { personaId: 'novice-user', version: '1.2.0' },
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
