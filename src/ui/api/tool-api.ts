import type {
  PreviewResultDto,
  PropagationResultDto,
  SaveToolDto,
  SerializedToolDto,
  TenantScopeDto,
  ToolGraphDto,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Fetcher = typeof fetch;

export class ToolApiClient {
  constructor(
    private readonly baseUrl = '',
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async inferDraft(graph: ToolGraphDto, signal?: AbortSignal): Promise<PropagationResultDto> {
    const body = await this.request<{ propagation: PropagationResultDto }>(
      '/tool-drafts/infer-schema',
      { method: 'POST', body: JSON.stringify({ graph }), signal },
    );
    return body.propagation;
  }

  async previewDraft(graph: ToolGraphDto, rowLimit = 100, signal?: AbortSignal): Promise<PreviewResultDto> {
    const body = await this.request<{ result: PreviewResultDto }>(
      '/tool-drafts/preview',
      { method: 'POST', body: JSON.stringify({ graph, rowLimit }), signal },
    );
    return body.result;
  }

  async saveTool(input: SaveToolDto): Promise<SerializedToolDto> {
    return (await this.request<{ tool: SerializedToolDto }>('/tools', {
      method: 'POST',
      body: JSON.stringify(input),
    })).tool;
  }

  async listVersions(internalId: string, scope: TenantScopeDto): Promise<readonly string[]> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    return (await this.request<{ versions: string[] }>(`/tools/${encodeURIComponent(internalId)}/versions?${query}`)).versions;
  }

  async getTool(internalId: string, scope: TenantScopeDto, version?: string): Promise<SerializedToolDto> {
    const query = new URLSearchParams({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
    if (version !== undefined) query.set('version', version);
    return (await this.request<{ tool: SerializedToolDto }>(`/tools/${encodeURIComponent(internalId)}?${query}`)).tool;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const error = body as { error?: { code?: string; message?: string } };
      throw new ApiError(
        response.status,
        error.error?.code ?? 'HTTP_ERROR',
        error.error?.message ?? response.statusText,
      );
    }
    return body as T;
  }
}
