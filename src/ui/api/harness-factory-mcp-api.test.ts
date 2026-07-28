import { describe, expect, it, vi } from 'vitest';
import { ToolApiClient } from './tool-api';
import type { CreateFactoryRunDto, ReplaceMcpServersDto, ResolveFactoryRunDto, SaveHarnessDto, SaveMcpServerDto, SaveModelSettingsDto } from './types';

const scope = { tenantId: 'tenant a', workspaceId: 'workspace/1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const harnessInput: SaveHarnessDto = {
  scope, internalId: 'support/bot', workingName: 'w', displayName: 'Support bot', publishName: 'support_bot', owner: 'owner',
  pattern: 'handoff',
  slots: [
    { id: 'writer', label: 'Writer', purpose: 'Draft', assignment: { internalId: 'writer', version: '1.0.0' } },
    { id: 'reviewer', label: 'Reviewer', purpose: 'Review', assignment: { internalId: 'reviewer', version: '1.0.0' } },
  ],
  topology: { pattern: 'handoff', startSlotId: 'writer', transitions: [{ fromSlotId: 'writer', toSlotId: 'reviewer', condition: 'needs review' }], autonomous: false },
};

describe('ToolApiClient multi-agent harness contract', () => {
  it('Harnessの保存・一覧・version固定取得・削除のwire contractを扱う', async () => {
    const harness = { metadata: { internalId: 'support/bot', version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ harness }, 201))
      .mockResolvedValueOnce(jsonResponse({ harnesses: [{ internalId: 'support/bot', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ harness }))
      .mockResolvedValueOnce(jsonResponse({ harness }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);

    await expect(client.saveHarness(harnessInput)).resolves.toMatchObject({ metadata: { version: '1.0.0' } });
    await expect(client.listHarnesses(scope)).resolves.toHaveLength(1);
    await client.getHarness('support/bot', scope, '1.0.0');
    await client.getHarness('support/bot', scope);
    await client.deleteHarness('support/bot', scope);

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/harnesses', expect.objectContaining({ method: 'POST', body: JSON.stringify(harnessInput) }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/harnesses?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/harnesses/support%2Fbot?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('version=1.0.0');
    expect(fetcher.mock.calls[3]?.[0]).not.toContain('version=');
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('Draft検証は保存せず検証結果だけを返す', async () => {
    const validation = { valid: false, issues: [{ path: 'slots.0.assignment', message: 'Assigned agent not found: writer@1.0.0' }] };
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ validation }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);

    await expect(client.validateHarness(harnessInput)).resolves.toEqual(validation);
    expect(fetcher).toHaveBeenCalledWith('/api/harness-drafts/validate', expect.objectContaining({
      method: 'POST', body: JSON.stringify(harnessInput),
    }));
  });

  it('Harness Runの起票・応答・キャンセルをrunIdエンコード付きで呼ぶ', async () => {
    const run = { runId: 'harness/run-1', status: 'waiting-input', events: [] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ run: { ...run, status: 'waiting-approval' } }))
      .mockResolvedValueOnce(jsonResponse({ run: { ...run, status: 'succeeded' } }))
      .mockResolvedValueOnce(jsonResponse({ run: { ...run, status: 'cancelled' } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const runInput = { scope, harness: { internalId: 'support/bot', version: '1.0.0' }, message: 'Prepare the announcement.', mode: 'preview' as const };

    await expect(client.runHarness(runInput, controller.signal)).resolves.toMatchObject({ status: 'waiting-input' });
    await client.respondToHarnessRun('harness/run-1', { scope, response: { kind: 'input', message: 'Enterprise administrators.' } });
    await client.respondToHarnessRun('harness/run-1', { scope, response: { kind: 'approval', decision: 'revise', feedback: 'shorten it' } });
    await expect(client.cancelHarnessRun('harness/run-1', scope, controller.signal)).resolves.toMatchObject({ status: 'cancelled' });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/harness-runs', expect.objectContaining({
      method: 'POST', body: JSON.stringify(runInput), signal: controller.signal,
    }));
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/harness-runs/harness%2Frun-1/responses');
    expect(JSON.parse(String((fetcher.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      scope, response: { kind: 'approval', decision: 'revise', feedback: 'shorten it' },
    });
    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/harness-runs/harness%2Frun-1/cancel');
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope }) });
  });

  it('ツール承認待ちRunの再開はfeedback有無で本文を変える', async () => {
    const run = { runId: 'run-1', response: 'done', trace: [] };
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ run })));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();

    await expect(client.resumeRun('run/1', scope, 'approve', undefined, controller.signal)).resolves.toMatchObject(run);
    await client.resumeRun('run/1', scope, 'reject', 'not allowed');

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/runs/run%2F1/resume');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope, decision: 'approve' }), signal: controller.signal });
    expect(JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ scope, decision: 'reject', feedback: 'not allowed' });
  });
});

describe('ToolApiClient agent factory contract', () => {
  it('Factory Runの作成・一覧・詳細・イベント取得を扱う', async () => {
    const run = { id: 'factory/run-1', status: 'running', stage: 'planning' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run }, 202))
      .mockResolvedValueOnce(jsonResponse({ runs: [run] }))
      .mockResolvedValueOnce(jsonResponse({ runs: [run] }))
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ events: [{ sequence: 1, kind: 'factory_started', at: 'now' }] }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const input: CreateFactoryRunDto = {
      scope, goal: { goal: 'Answer refund questions', language: 'ja' }, dataSourceIds: ['file-1'],
      options: { maxIterations: 2, requirePlanApproval: true },
    };

    await expect(client.createFactoryRun(input, controller.signal)).resolves.toMatchObject({ id: 'factory/run-1' });
    await expect(client.listFactoryRuns(scope, { limit: 5, status: 'running' })).resolves.toHaveLength(1);
    await client.listFactoryRuns(scope);
    await client.getFactoryRun(scope, 'factory/run-1', controller.signal);
    await expect(client.getFactoryRunEvents(scope, 'factory/run-1')).resolves.toHaveLength(1);

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/factory-runs', expect.objectContaining({ method: 'POST', body: JSON.stringify(input), signal: controller.signal }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('limit=5');
    expect(fetcher.mock.calls[1]?.[0]).toContain('status=running');
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('limit=');
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('status=');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/api/factory-runs/factory%2Frun-1?');
    expect(fetcher.mock.calls[4]?.[0]).toContain('/api/factory-runs/factory%2Frun-1/events?');
  });

  it('計画承認・キャンセル・再実行のwire contractを扱う（再実行は新しいRunを返す）', async () => {
    const run = { id: 'factory/run-1', status: 'failed' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run: { ...run, status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ run: { ...run, status: 'cancelled' } }))
      .mockResolvedValueOnce(jsonResponse({ run: { id: 'factory/run-2', status: 'running' } }, 202));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const resolve: ResolveFactoryRunDto = { scope, response: { kind: 'plan-approval', decision: 'revise', feedback: 'add a refund persona' } };

    await client.respondToFactoryRun('factory/run-1', resolve);
    await expect(client.cancelFactoryRun('factory/run-1', scope)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(client.retryFactoryRun('factory/run-1', scope)).resolves.toMatchObject({ id: 'factory/run-2' });

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/factory-runs/factory%2Frun-1/responses');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(resolve) });
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/factory-runs/factory%2Frun-1/cancel');
    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/factory-runs/factory%2Frun-1/retry');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope }) });
  });
});

describe('ToolApiClient MCP client contract', () => {
  it('設定の一覧・upsert・一括置換・削除・接続テストを扱う', async () => {
    const server = { scope, name: 'files', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: {} }, disabled: false, updatedAt: 'now' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ servers: [server] }))
      .mockResolvedValueOnce(jsonResponse({ server }))
      .mockResolvedValueOnce(jsonResponse({ servers: [server] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, tools: [{ name: 'read_file' }] }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const saveInput: SaveMcpServerDto = { scope, server: { name: 'files', transport: { kind: 'http', url: 'https://mcp.example.com', headers: {} } } };
    const replaceInput: ReplaceMcpServersDto = { scope, mcpServers: { files: { command: 'npx', args: ['-y', 'server'] } } };

    await expect(client.listMcpServers(scope, controller.signal)).resolves.toHaveLength(1);
    await expect(client.saveMcpServer(saveInput)).resolves.toMatchObject({ name: 'files' });
    await expect(client.replaceMcpServers(replaceInput)).resolves.toHaveLength(1);
    await client.deleteMcpServer('files/local', scope);
    await expect(client.testMcpServer('files/local', scope, controller.signal)).resolves.toEqual({ ok: true, tools: [{ name: 'read_file' }] });

    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/mcp-servers?');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(saveInput) });
    // 版を持たない設定なので、JSONタブのApplyはPUTの全置換になる。
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify(replaceInput) });
    expect(fetcher.mock.calls[3]?.[0]).toContain('/api/mcp-servers/files%2Flocal?');
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(fetcher.mock.calls[4]?.[0]).toBe('/api/mcp-servers/files%2Flocal/test');
  });

  it('接続失敗は例外ではなくok:falseの結果として返る', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'spawn npx ENOENT' }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    await expect(client.testMcpServer('files', scope)).resolves.toEqual({ ok: false, error: 'spawn npx ENOENT' });
  });
});

describe('ToolApiClient model settings contract', () => {
  it('設定の取得・保存・スロットnullでのenv既定戻しを扱う（応答のapiKeyはマスク済み）', async () => {
    const settings = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } }, updatedAt: 'now' };
    const fetcher = vi.fn()
      // GET だけが storage（persistent / ephemeral）を返す。
      .mockResolvedValueOnce(jsonResponse({ settings: { ...settings, storage: 'ephemeral' } }))
      .mockResolvedValueOnce(jsonResponse({ settings }))
      .mockResolvedValueOnce(jsonResponse({ settings: { scope } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    // apiKey は write-only の平文（応答には決して現れない）。
    const saveInput: SaveModelSettingsDto = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-secret-abcd' } };

    await expect(client.getModelSettings(scope, controller.signal)).resolves.toMatchObject({ main: { apiKey: { configured: true, hint: 'abcd' } }, storage: 'ephemeral' });
    await expect(client.saveModelSettings(saveInput)).resolves.toMatchObject({ main: { model: 'openai/gpt-4o' } });
    await expect(client.saveModelSettings({ scope, judge: null })).resolves.toEqual({ scope });

    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/model-settings?');
    expect(fetcher.mock.calls[0]?.[0]).toContain('tenantId=tenant+a');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/model-settings');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify(saveInput) });
    expect(JSON.parse(String((fetcher.mock.calls[2]?.[1] as RequestInit).body))).toEqual({ scope, judge: null });
  });

  it('疎通テストはcandidate有無で本文を変え、失敗も例外ではなくok:falseで返る', async () => {
    // usedStoredKey は必須フィールド（宛先不一致で保存済みキーを使わなかったことをUIへ伝える）。
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, latencyMs: 1234, reply: 'pong', usedStoredKey: false }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'HTTP 401', usedStoredKey: true }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const candidate = { source: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b' };

    await expect(client.testModelSettings(scope, 'main', candidate, controller.signal)).resolves.toEqual({ ok: true, latencyMs: 1234, reply: 'pong', usedStoredKey: false });
    await expect(client.testModelSettings(scope, 'judge')).resolves.toEqual({ ok: false, error: 'HTTP 401', usedStoredKey: true });

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/model-settings/test');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope, slot: 'main', candidate }), signal: controller.signal });
    expect(JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ scope, slot: 'judge' });
  });

  it('カタログは接続先の見出しだけを取得する（モデル名は含まない）', async () => {
    const providers = [
      { id: 'openai', name: 'OpenAI', source: 'registry', envVar: 'OPENAI_API_KEY', docUrl: 'https://platform.openai.com/docs/models' },
      { id: 'openai-compatible', name: 'OpenAI-compatible endpoint', source: 'openai-compatible', baseUrlTemplate: 'http://127.0.0.1:1234/v1' },
    ];
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ providers }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();

    await expect(client.getModelCatalog(controller.signal)).resolves.toEqual(providers);

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/model-catalog');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('OpenAI互換モデル一覧はPOST + JSON本文で送る（GETは廃止・キーは本文にも載せない）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ models: ['qwen/qwen3-4b'], usedStoredKey: true }))
      .mockResolvedValueOnce(jsonResponse({ models: [], usedStoredKey: false }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();

    await expect(client.listOpenAiCompatibleModels(scope, 'http://127.0.0.1:1234/v1', 'judge', controller.signal))
      .resolves.toEqual({ models: ['qwen/qwen3-4b'], usedStoredKey: true });
    await expect(client.listOpenAiCompatibleModels(scope, 'http://127.0.0.1:1234/v1')).resolves.toEqual({ models: [], usedStoredKey: false });

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/model-catalog/openai-compatible-models');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', signal: controller.signal });
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'judge' });
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('apiKey');
    // slot 省略時は本文にも載せない（保存済みキーを一切使わない問い合わせ）。
    expect(JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ scope, baseUrl: 'http://127.0.0.1:1234/v1' });
  });
});

describe('ToolApiClient remaining tool builder endpoints', () => {
  it('分析設定補助の可否と設定案取得を扱う', async () => {
    const proposal = { nodeId: 'summary-1', nodeType: 'summary-statistics', config: { columns: ['amount'] }, rationale: ['numeric'], warnings: [] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ analysisAssistant: { enabled: true } }))
      .mockResolvedValueOnce(jsonResponse({ proposal }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const input = { graph: { nodes: [{ id: 'summary-1', type: 'summary-statistics', config: {} }], edges: [] }, nodeId: 'summary-1', intent: 'trend', scope };

    await expect(client.analysisAssistantCapability()).resolves.toBe(true);
    await expect(client.suggestAnalysisConfig(input)).resolves.toEqual(proposal);

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/runtime/capabilities');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/tool-drafts/suggest-analysis-config');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
  });

  it('Skillの版指定取得と削除、Agent削除のwire contractを扱う', async () => {
    const skill = { metadata: { internalId: 'analysis', version: '1.2.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ skill }))
      .mockResolvedValueOnce(jsonResponse({ skill }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);

    await expect(client.getSkill('analysis/a', scope, '1.2.0')).resolves.toMatchObject({ metadata: { version: '1.2.0' } });
    await client.getSkill('analysis/a', scope);
    await client.deleteSkill('analysis/a', scope);
    await client.deleteAgent('agent/a', scope);

    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/skills/analysis%2Fa?');
    expect(fetcher.mock.calls[0]?.[0]).toContain('version=1.2.0');
    expect(fetcher.mock.calls[1]?.[0]).not.toContain('version=');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(fetcher.mock.calls[3]?.[0]).toContain('/api/agents/agent%2Fa?');
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('評価・検証アセットとWikiの削除はすべてscopeクエリ付きDELETEになる', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);

    await client.deletePersona('persona/a', scope);
    await client.deleteScenario('scenario/a', scope);
    await client.deleteEvaluationDataset('dataset/a', scope);
    await client.deleteEvaluatorProfile('profile/a', scope);
    await client.deleteJudgeRubric('rubric/a', scope);
    await client.deleteGatePolicy('policy/a', scope);
    await client.deleteWiki('page/a', scope);
    await client.deleteWikiSpace('wiki/a', scope);

    expect(fetcher.mock.calls.map((call) => String(call[0]).split('?')[0])).toEqual([
      '/api/personas/persona%2Fa', '/api/scenarios/scenario%2Fa', '/api/evaluation-datasets/dataset%2Fa',
      '/api/evaluator-profiles/profile%2Fa', '/api/judge-rubrics/rubric%2Fa', '/api/gate-policies/policy%2Fa',
      '/api/wiki/page%2Fa', '/api/wikis/wiki%2Fa',
    ]);
    for (const call of fetcher.mock.calls) {
      expect(String(call[0])).toContain('tenantId=tenant+a');
      expect(call[1]).toMatchObject({ method: 'DELETE' });
    }
  });
});
