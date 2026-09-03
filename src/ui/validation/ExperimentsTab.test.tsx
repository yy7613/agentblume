// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { RunTraceEventDto } from '../api/types';
import { I18nProvider, type Language } from '../i18n';
import { ExperimentsTab } from './ExperimentsTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

// 完了済みにしておく（queued / running は 750ms ポーリングが走る）。
const experiment = {
  id: 'exp-1', scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' },
  repetitions: 1, status: 'completed', snapshot: { provider: 'scripted', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 1, total: 1 }, createdAt: 'now', finishedAt: 'done',
};
const caseResult = {
  experimentId: 'exp-1', scope, caseId: 'case', caseKind: 'turn', repetition: 1, status: 'failed', runIds: ['run-1'], output: '', scores: [], latencyMs: 15, usage: {},
  error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: year' },
};

function makeClient(trace: readonly RunTraceEventDto[], overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listAgents: vi.fn().mockResolvedValue([]),
    listEvaluationDatasets: vi.fn().mockResolvedValue([]),
    listEvaluatorProfiles: vi.fn().mockResolvedValue([]),
    listExperiments: vi.fn().mockResolvedValue([experiment]),
    listExperimentResults: vi.fn().mockResolvedValue([caseResult]),
    getRunTrace: vi.fn().mockResolvedValue({ runId: 'run-1', scope, status: 'failed', mode: 'test', startedAt: 'now', trace }),
    ...overrides,
  } as unknown as ToolApiClient;
}

async function openTrace(client: ToolApiClient, language?: Language): Promise<void> {
  const tab = <ExperimentsTab client={client} scope={scope} />;
  render(language === undefined ? tab : <I18nProvider initialLanguage={language}>{tab}</I18nProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /agent@1\.0\.0/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'run-1' }));
  await waitFor(() => expect(client.getRunTrace).toHaveBeenCalledWith('run-1', scope));
}

const mixedTrace: readonly RunTraceEventDto[] = [
  { sequence: 1, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: year (retrying 1/1)' },
  { sequence: 2, kind: 'mcp-server-skipped', server: 'files', reason: 'not-found' },
  { sequence: 3, kind: 'model-response', content: 'answer' },
];

describe('ExperimentsTab のトレース表示', () => {
  it('error / mcp-server-skipped の行は言語化し、それ以外は種別名だけ（従来どおり）', async () => {
    await openTrace(makeClient(mixedTrace));
    expect(await screen.findByText("1 · TOOL_ARGUMENTS: the model omitted the required tool argument 'year'. Describe that argument more concretely in the tool, or state its value in your request (retrying 1/1)")).toBeTruthy();
    expect(screen.getByText("2 · The tools of MCP server 'files' were not loaded (server not registered). Register and enable the server in MCP settings, then test the connection")).toBeTruthy();
    expect(screen.getByText('3 · model-response')).toBeTruthy();
    expect(screen.queryByText(/required argument missing: year/)).toBeNull();
  });

  it('空のトレースは見出しだけを出し、行は描かない', async () => {
    await openTrace(makeClient([]));
    expect(await screen.findByText('Run trace · run-1')).toBeTruthy();
    expect(document.querySelectorAll('.trace-event')).toHaveLength(0);
  });

  it('トレースの取得失敗はアラートで出す', async () => {
    await openTrace(makeClient([], { getRunTrace: vi.fn().mockRejectedValue(new Error('trace unavailable')) }));
    expect((await screen.findByRole('alert')).textContent).toBe('trace unavailable');
    expect(screen.queryByText(/Run trace/)).toBeNull();
  });

  it('日本語UIでは error / mcp-server-skipped の行が日本語になる', async () => {
    await openTrace(makeClient(mixedTrace), 'ja');
    expect(await screen.findByText('1 · TOOL_ARGUMENTS: モデルがツールの必須引数「year」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください（再試行 1/1）')).toBeTruthy();
    expect(screen.getByText('2 · MCPサーバー「files」のツールを読み込めませんでした（未登録）。MCP設定画面でサーバーを登録・有効化し、接続をテストしてください')).toBeTruthy();
    expect(screen.getByText('3 · model-response')).toBeTruthy();
  });
});
