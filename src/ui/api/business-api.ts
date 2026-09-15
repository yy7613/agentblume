/**
 * ui/api層: 業務の API クライアントの規約（ADR-0039）。
 *
 * 業務の HTTP 呼び出しは `api/<業務>-api.ts`（`<業務>Api(transport)` がメソッドの束を返す）に、
 * DTO は `api/<業務>-types.ts` に、エラーの見出しは `api/<業務>-error-messages.ts` に置き、
 * 共有の tool-api.ts / types.ts / error-messages.ts を触らない。
 *
 * 送信は `ToolApiClient.request`（認証ヘッダ・JSON 解析・`ApiError` への変換）を構造的に受ける。
 * 画面は受け取った `client` をそのまま渡せばよく、テストは `request` だけの偽物を渡せばよい。
 */
import type { TenantScopeDto } from './types';

/** 業務の API クライアントが使う送信口（`ToolApiClient` が満たす）。 */
export interface ApiTransport {
  /** 2xx なら JSON 本文（204 は `{}`）、それ以外は `ApiError` を投げる。 */
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

/** scope をクエリ文字列にする（GET / DELETE 用）。 */
export function scopeQuery(scope: TenantScopeDto): URLSearchParams {
  return new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
}
