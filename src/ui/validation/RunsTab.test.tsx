// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { RunTraceEventDto } from '../api/types';
import { I18nProvider, type Language } from '../i18n';
import { RunsTab } from './RunsTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

const scenarioRun = {
  id: 'srun-1', scope, scenario: { id: 'sc', version: '1.0.0' }, status: 'completed', goalAchieved: null,
  transcript: [{ speaker: 'agent', message: 'Here you go.', runId: 'run-agent-1' }],
  survey: [], impressions: '',
  metrics: { userTurns: 1, agentRuns: 1, totalToolCalls: 1, durationMs: 10, usage: {} },
  startedAt: '2026-07-03T00:00:00Z', finishedAt: '2026-07-03T00:00:01Z',
};

function makeClient(trace: readonly RunTraceEventDto[], overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listScenarioRuns: vi.fn().mockResolvedValue([scenarioRun]),
    listScenarios: vi.fn().mockResolvedValue([{ internalId: 'sc', displayName: 'Sales scenario', publishName: 'sc', latestVersion: '1.0.0', state: 'draft' }]),
    // 設問文の取得失敗は値のみ表示へ落ちるだけ（トレース表示には関係しない）。
    getScenario: vi.fn().mockRejectedValue(new Error('no scenario')),
    getRunTrace: vi.fn().mockResolvedValue({ runId: 'run-agent-1', scope, status: 'failed', mode: 'test', startedAt: 'now', trace }),
    ...overrides,
  } as unknown as ToolApiClient;
}

async function openTrace(client: ToolApiClient, language?: Language): Promise<void> {
  const tab = <RunsTab client={client} scope={scope} />;
  render(language === undefined ? tab : <I18nProvider initialLanguage={language}>{tab}</I18nProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /Sales scenario/ }));
  await userEvent.click(await screen.findByRole('button', { name: /run-agent-1/ }));
  await waitFor(() => expect(client.getRunTrace).toHaveBeenCalledWith('run-agent-1', scope));
}

const mixedTrace: readonly RunTraceEventDto[] = [
  { sequence: 1, kind: 'model-request', step: 1, toolNames: ['sales_lookup'] },
  { sequence: 2, kind: 'tool-call', name: 'sales_lookup', arguments: { month: '2026-06' } },
  { sequence: 3, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: year (retrying 1/1)' },
  { sequence: 4, kind: 'mcp-server-skipped', server: 'files', reason: 'disabled' },
  { sequence: 5, kind: 'model-response', content: 'Here you go.' },
];

describe('RunsTab のトレース表示', () => {
  it('error / mcp-server-skipped の行は code を残して言語化し、生メッセージは出さない', async () => {
    await openTrace(makeClient(mixedTrace));
    expect(await screen.findByText("TOOL_ARGUMENTS: the model omitted the required tool argument 'year'. Describe that argument more concretely in the tool, or state its value in your request (retrying 1/1)")).toBeTruthy();
    expect(screen.getByText("The tools of MCP server 'files' were not loaded (server disabled). Enable the server in MCP settings, then test the connection")).toBeTruthy();
    expect(screen.queryByText(/required argument missing: year/)).toBeNull();
  });

  it('error 以外の行は従来どおり（種別名・応答本文・ツール呼び出しの引数）', async () => {
    await openTrace(makeClient(mixedTrace));
    expect(await screen.findByText('model-request')).toBeTruthy();
    expect(screen.getByText('sales_lookup {"month":"2026-06"}')).toBeTruthy();
    // model-response は本文をそのまま出す（transcript の同文と合わせて2箇所）。
    expect(screen.getAllByText('Here you go.')).toHaveLength(2);
  });

  it('空のトレースは見出しだけを出し、行は描かない', async () => {
    await openTrace(makeClient([]));
    expect(await screen.findByText('Run trace · run-agent-1')).toBeTruthy();
    expect(document.querySelectorAll('.trace-event')).toHaveLength(0);
  });

  it('トレースの取得失敗はアラートで出す', async () => {
    const client = makeClient([], { getRunTrace: vi.fn().mockRejectedValue(new Error('trace unavailable')) });
    await openTrace(client);
    expect((await screen.findByRole('alert')).textContent).toBe('trace unavailable');
    expect(screen.queryByText(/Run trace/)).toBeNull();
  });

  it('日本語UIでは error / mcp-server-skipped の行が日本語になる', async () => {
    await openTrace(makeClient(mixedTrace), 'ja');
    expect(await screen.findByText('TOOL_ARGUMENTS: モデルがツールの必須引数「year」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください（再試行 1/1）')).toBeTruthy();
    expect(screen.getByText('MCPサーバー「files」のツールを読み込めませんでした（無効化中）。MCP設定画面でサーバーを有効化し、接続をテストしてください')).toBeTruthy();
  });
});
