// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { useToolBuilderStore } from '../tool-builder/store';
import { backupFailureHint, formatBytes, StatusPage } from './StatusPage';

beforeEach(() => useToolBuilderStore.getState().reset());
afterEach(cleanup);

describe('StatusPage', () => {
  it('run一覧から失敗trace詳細を開く', async () => {
    const summary = { runId: 'run-1', status: 'failed', mode: 'preview', tool: { internalId: 'tool', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', failure: { code: 'MODEL_PROVIDER', message: 'offline' }, traceEventCount: 2 };
    const record = { ...summary, scope: { tenantId: 'local', workspaceId: 'default' }, trace: [
      { sequence: 1, kind: 'model-request', step: 1, toolNames: ['tool'] },
      { sequence: 2, kind: 'error', code: 'MODEL_PROVIDER', message: 'offline' },
    ] };
    const client = { listRuns: vi.fn().mockResolvedValue([summary]), getRunTrace: vi.fn().mockResolvedValue(record) } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /tool/ }));
    await waitFor(() => expect(client.getRunTrace).toHaveBeenCalledWith('run-1', { tenantId: 'local', workspaceId: 'default' }));
    expect(screen.getAllByText(/MODEL_PROVIDER/).length).toBeGreaterThan(0);
    expect(screen.getByText('run-1')).toBeTruthy();
  });

  it('Agent runのstructured responseを整形表示する', async () => {
    const summary = { runId: 'run-json', status: 'succeeded', mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: '{"answer":"done"}', traceEventCount: 1 };
    const record = { ...summary, scope: { tenantId: 'local', workspaceId: 'default' }, structuredResponse: { answer: 'done' }, trace: [{ sequence: 1, kind: 'model-response', content: '{"answer":"done"}' }] };
    const client = { listRuns: vi.fn().mockResolvedValue([summary]), getRunTrace: vi.fn().mockResolvedValue(record) } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /agent/ }));
    expect(await screen.findByText(/"answer": "done"/)).toBeTruthy();
  });

  it('agent_callイベントのchild runボタンから子Runトレースへ辿る', async () => {
    const parentSummary = { runId: 'run-parent', status: 'succeeded', mode: 'preview', agent: { internalId: 'coordinator', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: 'ok', traceEventCount: 2 };
    const parent = { ...parentSummary, scope: { tenantId: 'local', workspaceId: 'default' }, trace: [
      { sequence: 1, kind: 'agent_call', toolName: 'ask_scorer', agentRef: { internalId: 'scorer', version: '1.0.0' }, childRunId: 'run-child', ok: true, summary: 'scored 42' },
      { sequence: 2, kind: 'model-response', content: 'ok' },
    ] };
    const child = { runId: 'run-child', status: 'succeeded', mode: 'preview', scope: { tenantId: 'local', workspaceId: 'default' }, agent: { internalId: 'scorer', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: 'scored 42', trace: [{ sequence: 1, kind: 'model-response', content: 'scored 42' }] };
    const getRunTrace = vi.fn().mockResolvedValueOnce(parent).mockResolvedValueOnce(child);
    const client = { listRuns: vi.fn().mockResolvedValue([parentSummary]), getRunTrace } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /coordinator/ }));
    expect(await screen.findByText(/ask_scorer/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'child run' }));
    await waitFor(() => expect(getRunTrace).toHaveBeenLastCalledWith('run-child', { tenantId: 'local', workspaceId: 'default' }));
    expect(await screen.findByText('run-child')).toBeTruthy();
  });

  it('運用メトリクスを表示しAgent runへfeedbackを保存する', async () => {
    const summary = { runId: 'run-observed', status: 'succeeded', mode: 'preview', purpose: 'interactive', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: 'answer', traceEventCount: 1 };
    const record = { ...summary, scope: { tenantId: 'local', workspaceId: 'default' }, model: { provider: 'scripted', model: 'scripted', modelConfigHash: 'hash' }, latency: { totalMs: 20, modelMs: 18, toolMs: 0 }, estimatedCost: { kind: 'estimated', amount: 0.0002, currency: 'USD', price: { currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '1970-01-01T00:00:00Z' } }, trace: [{ sequence: 1, kind: 'model-response', content: 'answer' }] };
    const operations = { from: '2026-07-01T00:00:00Z', to: '2026-07-03T00:00:00Z', summary: { runCount: 1, failureRate: 0, p50LatencyMs: 20, p95LatencyMs: 20, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 0 }, points: [{ bucketStart: '2026-07-03T00:00:00Z', runCount: 1, failureRate: 0, p50LatencyMs: 20, p95LatencyMs: 20, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 0 }] };
    const submitRunFeedback = vi.fn().mockResolvedValue({ id: 'feedback', scope: record.scope, runId: record.runId, agent: record.agent, thumb: 'down', rating: 2, comment: 'wrong', issueTags: ['incorrect'], createdAt: 'now', updatedAt: 'now' });
    const client = { listRuns: vi.fn().mockResolvedValue([summary]), getRunTrace: vi.fn().mockResolvedValue(record), getOperationsStatus: vi.fn().mockResolvedValue(operations), getRunFeedback: vi.fn().mockResolvedValue(null), submitRunFeedback } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    expect((await screen.findAllByText('20.0 ms')).length).toBe(2);
    await userEvent.click(screen.getByRole('button', { name: /agent/ }));
    expect(await screen.findByText('scripted / scripted')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Needs work|要改善/ }));
    await userEvent.selectOptions(screen.getByLabelText(/Rating|評価/), '2');
    await userEvent.type(screen.getByLabelText(/Issue tags|課題タグ/), 'incorrect');
    await userEvent.type(screen.getByLabelText(/Comment|コメント/), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /Save feedback|フィードバックを保存/ }));
    await waitFor(() => expect(submitRunFeedback).toHaveBeenCalledWith('run-observed', expect.objectContaining({ thumb: 'down', rating: 2, comment: 'wrong', issueTags: ['incorrect'] })));
    expect((await screen.findByRole('status')).textContent).toMatch(/Saved|保存しました/);

    // コメント再編集で「保存しました」表示がリセットされ、誤って最新扱いされない。
    await userEvent.type(screen.getByLabelText(/Comment|コメント/), '!');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('トレース選択に失敗した後、別の選択が成功すると前回のエラーが消える（role=alertの誤通知防止）', async () => {
    const summaryA = { runId: 'run-a', status: 'failed', mode: 'preview', tool: { internalId: 'tool-a', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', traceEventCount: 0 };
    const summaryB = { runId: 'run-b', status: 'succeeded', mode: 'preview', tool: { internalId: 'tool-b', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', traceEventCount: 1 };
    const recordB = { ...summaryB, scope: { tenantId: 'local', workspaceId: 'default' }, trace: [{ sequence: 1, kind: 'model-response', content: 'ok' }] };
    const getRunTrace = vi.fn().mockRejectedValueOnce(new Error('trace unavailable')).mockResolvedValueOnce(recordB);
    const client = { listRuns: vi.fn().mockResolvedValue([summaryA, summaryB]), getRunTrace } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /tool-a/ }));
    expect(await screen.findByText('trace unavailable')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /tool-b/ }));
    await waitFor(() => expect(screen.queryByText('trace unavailable')).toBeNull());
    expect(await screen.findByText('run-b')).toBeTruthy();
  });
});

const manifest = {
  formatVersion: 1, createdAt: '2026-07-28T09:30:12.345Z', schemaVersion: 2, node: 'v22.19.0',
  sourceDatabasePath: '/home/.agentblume/agentblume.db',
  database: { file: 'agentblume.db', files: 1, bytes: 1_048_576 },
  artifacts: { directory: 'session-artifacts', files: 2, bytes: 1024 },
  secretKey: { included: false },
};

/** バックアップ・retention操作を持つ最小クライアント（listRuns はStatusPageの初期表示に要る）。 */
function maintenanceClient(overrides: Partial<Record<string, unknown>> = {}): ToolApiClient {
  return {
    listRuns: vi.fn().mockResolvedValue([]),
    listBackups: vi.fn().mockResolvedValue({ root: '/home/.agentblume/agentblume.db.backups', backups: [] }),
    createBackup: vi.fn().mockResolvedValue({ name: 'backup-20260728-093012345', path: '/home/.agentblume/agentblume.db.backups/backup-20260728-093012345', manifest, warnings: ['The secret key file is NOT included.'] }),
    applyRetention: vi.fn().mockResolvedValue({ payloadRedacted: 1, traceRedacted: 2, deleted: 3, feedbackDeleted: 4, aggregateBucketsDeleted: 5, auditDeleted: 6 }),
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('StatusPage 監査ログ', () => {
  const entry = {
    at: '2026-07-28T09:30:12.345Z', subject: 'alice', tenantId: 'local', workspaceId: 'default',
    action: 'delete', resource: { kind: 'tool', id: 'scores' }, outcome: 'denied',
  };

  it('読める権限があれば直近の記録を並べる', async () => {
    const client = maintenanceClient({ listAuditLog: vi.fn().mockResolvedValue([entry]) });
    render(<StatusPage client={client} />);
    expect(await screen.findByLabelText(/Audit log|監査ログ/)).toBeTruthy();
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText(/delete · tool\/scores/)).toBeTruthy();
    expect(screen.getByText('denied')).toBeTruthy();
    await waitFor(() => expect(client.listAuditLog).toHaveBeenCalledWith({ tenantId: 'local', workspaceId: 'default' }, { limit: 20 }));
  });

  it('権限が無ければパネルごと消す（できることが無い相手にエラーを見せない）', async () => {
    const client = maintenanceClient({ listAuditLog: vi.fn().mockRejectedValue(new Error("FORBIDDEN: this operation requires the 'audit-log:read' permission")) });
    render(<StatusPage client={client} />);
    await screen.findByRole('button', { name: /Create backup|バックアップを作成/ });
    await waitFor(() => expect(screen.queryByLabelText(/Audit log|監査ログ/)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('権限以外の失敗は原因を出す', async () => {
    const client = maintenanceClient({ listAuditLog: vi.fn().mockRejectedValue(new Error('database is locked')) });
    render(<StatusPage client={client} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/database is locked/);
  });

  it('記録がまだ無いときは空である旨を出す', async () => {
    const client = maintenanceClient({ listAuditLog: vi.fn().mockResolvedValue([]) });
    render(<StatusPage client={client} />);
    expect(await screen.findByText(/No audit entries yet|監査ログはまだありません/)).toBeTruthy();
  });

  it('監査APIを持たないクライアントでは表示しない', async () => {
    render(<StatusPage client={maintenanceClient()} />);
    await screen.findByRole('button', { name: /Create backup|バックアップを作成/ });
    expect(screen.queryByLabelText(/Audit log|監査ログ/)).toBeNull();
  });
});

describe('StatusPage メンテナンス操作', () => {
  it('バックアップ置き場と一覧を表示し、作成すると保存先パスと注意書きを出す', async () => {
    const client = maintenanceClient({
      listBackups: vi.fn()
        .mockResolvedValueOnce({ root: '/backups', backups: [] })
        .mockResolvedValue({ root: '/backups', backups: [{ name: 'backup-20260728-093012345', path: '/backups/backup-20260728-093012345', manifest }] }),
    });
    render(<StatusPage client={client} />);
    expect(await screen.findByText('/backups')).toBeTruthy();
    expect(screen.getByText(/No backups yet|バックアップはまだありません/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Create backup|バックアップを作成/ }));
    await waitFor(() => expect(client.createBackup).toHaveBeenCalledWith(false));
    expect((await screen.findByRole('status')).textContent).toMatch(/backup-20260728-093012345/);
    expect(screen.getByText('The secret key file is NOT included.')).toBeTruthy();
    // 一覧が再取得され、規模とスキーマ版が読める形で並ぶ。
    expect(await screen.findByText(/1.0 MB · schema v2/)).toBeTruthy();
  });

  it('鍵を含める選択では警告を出し、その旨をサーバーへ伝える', async () => {
    const client = maintenanceClient();
    render(<StatusPage client={client} />);
    await screen.findByRole('button', { name: /Create backup|バックアップを作成/ });
    await userEvent.click(screen.getByLabelText(/Include the secret key file|暗号鍵ファイルも含める/));
    expect(screen.getByText(/decrypt every stored API key|保存済みAPIキーをすべて復号/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Create backup|バックアップを作成/ }));
    await waitFor(() => expect(client.createBackup).toHaveBeenCalledWith(true));
  });

  it('保持期限の手動適用は削除件数を表示する', async () => {
    const client = maintenanceClient();
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Apply retention now|保持期限をいま適用/ }));
    await waitFor(() => expect(client.applyRetention).toHaveBeenCalledWith({ tenantId: 'local', workspaceId: 'default' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/3[\s\S]*1[\s\S]*2[\s\S]*4[\s\S]*5/);
  });

  it('ディスク不足・権限エラーは原因と次の一手を添えて出す', async () => {
    const client = maintenanceClient({ createBackup: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device, write')) });
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /Create backup|バックアップを作成/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/ENOSPC/);
    expect(alert.textContent).toMatch(/AGENTCONTEXT_BACKUP_DIR/);
  });

  it('未完成のバックアップ（manifestなし）は削除してよいと伝える', async () => {
    const client = maintenanceClient({
      listBackups: vi.fn().mockResolvedValue({ root: '/backups', backups: [{ name: 'backup-broken', path: '/backups/backup-broken', problem: 'missing manifest.json' }] }),
    });
    render(<StatusPage client={client} />);
    expect(await screen.findByText(/Incomplete backup|未完成のバックアップ/)).toBeTruthy();
  });

  it('バックアップ非対応のクライアント（古いサーバー）ではパネルごと出さない', async () => {
    const client = { listRuns: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await waitFor(() => expect(client.listRuns).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Create backup|バックアップを作成/ })).toBeNull();
  });
});

describe('バックアップ表示のヘルパー', () => {
  it('バイト数を読める単位へ落とす', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('原因ごとに違う対処を返し、心当たりが無ければ何も足さない', () => {
    const text = (english: string): string => english;
    expect(backupFailureHint('EACCES: permission denied', text)).toMatch(/permissions/);
    expect(backupFailureHint('EROFS: read-only file system', text)).toMatch(/writable path/);
    expect(backupFailureHint('the database is in-memory (:memory:)', text)).toMatch(/AGENTCONTEXT_DB_PATH/);
    expect(backupFailureHint('something else went wrong', text)).toBeUndefined();
  });
});
