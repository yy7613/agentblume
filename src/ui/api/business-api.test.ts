import { describe, expect, it, vi } from 'vitest';
import { contractApi } from './contract-api';
import { expenseApi } from './expense-api';
import { receivablesApi } from './receivables-api';
import { scopeQuery, type ApiTransport } from './business-api';
import { ApiError, ToolApiClient } from './tool-api';

/** 業務の API クライアントの規約（ADR-0039）: 送信口・scope のクエリ・業務が足したエラー項目の受け渡し。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('業務の API クライアントの規約', () => {
  it('正常: scope は tenantId / workspaceId のクエリになる', () => {
    expect(scopeQuery({ tenantId: 'acme', workspaceId: 'ops 1' }).toString()).toBe('tenantId=acme&workspaceId=ops+1');
  });

  it('正常: ToolApiClient は送信口を満たし、認証ヘッダ付きで JSON を返す', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { items: [1] }));
    const client = new ToolApiClient('http://api', fetcher as unknown as typeof fetch);
    client.setAuthTokenProvider(() => 'token-1');
    const transport: ApiTransport = client;
    await expect(transport.request<{ items: number[] }>('/expense/claims?tenantId=t')).resolves.toEqual({ items: [1] });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/expense/claims?tenantId=t');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer token-1');
  });

  it('異常: 業務が error 本文へ足した項目は ApiError.details に載る（共通の項目は載せない）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(400, { error: { code: 'EXPENSE_POLICY', message: 'over the limit', row: 3, lineId: 'l-2', limit: 5000 } }));
    const client = new ToolApiClient('', fetcher as unknown as typeof fetch);
    const error = await client.request('/expense/claims').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).row).toBe(3);
    expect((error as ApiError).details).toEqual({ lineId: 'l-2', limit: 5000 });
  });

  it('境界: 足した項目が無ければ details のキー自体を作らない', async () => {
    const fetcher = vi.fn(async () => jsonResponse(404, { error: { code: 'TOOL_NOT_FOUND', message: 'missing', nodeId: 'n1' } }));
    const error = await new ToolApiClient('', fetcher as unknown as typeof fetch).request('/tools/x').catch((cause: unknown) => cause) as ApiError;
    expect('details' in error).toBe(false);
    expect(error.nodeId).toBe('n1');
  });

  it('例外: 未実装の業務クライアントも送信口を受け取って組み立てられる', () => {
    const transport: ApiTransport = { request: vi.fn() };
    for (const api of [expenseApi(transport), receivablesApi(transport), contractApi(transport)]) expect(typeof api).toBe('object');
    expect(transport.request).not.toHaveBeenCalled();
  });
});
