import { describe, expect, it, vi } from 'vitest';
import { ToolApiClient } from './tool-api';
import type { ToolGraphDto } from './types';

const graph: ToolGraphDto = { nodes: [{ id: 'source', type: 'json-source', config: { rows: [] } }], edges: [] };
const scope = { tenantId: 'tenant a', workspaceId: 'workspace/1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ToolApiClient', () => {
  it('draft infer/preview を正しい body と AbortSignal で呼ぶ', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ propagation: { order: ['source'], nodes: {}, hasErrors: false } }))
      .mockResolvedValueOnce(jsonResponse({ result: { terminalId: 'source', output: { schema: { columns: [] }, rows: [] }, nodes: {} } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();

    await expect(client.inferDraft(graph, controller.signal)).resolves.toMatchObject({ hasErrors: false });
    await expect(client.previewDraft(graph, 25, controller.signal)).resolves.toMatchObject({ terminalId: 'source' });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/tool-drafts/infer-schema', expect.objectContaining({
      method: 'POST', signal: controller.signal, body: JSON.stringify({ graph }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/tool-drafts/preview', expect.objectContaining({
      body: JSON.stringify({ graph, rowLimit: 25 }),
    }));
  });

  it('save、versions、version固定取得の wire contract を扱う', async () => {
    const tool = { metadata: { version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tool }))
      .mockResolvedValueOnce(jsonResponse({ versions: ['1.0.0'] }))
      .mockResolvedValueOnce(jsonResponse({ tool }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const input = { scope, internalId: 'a/b', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o', sideEffect: 'read-only' as const, graph };

    await client.saveTool(input);
    await expect(client.listVersions('a/b', scope)).resolves.toEqual(['1.0.0']);
    await client.getTool('a/b', scope, '1.0.0');

    expect(fetcher.mock.calls[0]?.[0]).toBe('/tools');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/tools/a%2Fb/versions?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('version=1.0.0');
  });

  it('非2xxをApiErrorへ正規化する', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'ETL_GRAPH', message: 'broken graph' } }, 422));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const promise = client.inferDraft(graph);
    await expect(promise).rejects.toEqual(expect.objectContaining({ status: 422, code: 'ETL_GRAPH', message: 'broken graph', name: 'ApiError' }));
  });

  it('標準形式でないHTTPエラーにもfallbackを使う', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(new ToolApiClient('', fetcher as typeof fetch).inferDraft(graph)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });
});
