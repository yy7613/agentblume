import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 't', workspaceId: 'w' };

function planJson(dataSourceId: string, displayName = 'Sales Assistant'): string {
  return JSON.stringify({
    agentBrief: { displayName, role: 'Answers sales questions using the sales data source.' },
    tools: [{ key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId, sideEffect: 'read-only' }],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 3 }],
  });
}

/** M2: Stage 2（ToolSmith）が消費する台本。dataSourceIdはアップロード済みdata sourceのidに合わせる。 */
function toolProposalJson(dataSourceId: string): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
}

/** M2: Stage 3（SkillWriter）が消費する台本。 */
function skillProposalJson(): string {
  return JSON.stringify({
    responsibility: 'Summarize sales trends.',
    activationCondition: 'user asks for a summary',
    inputDescription: 'A question about sales.',
    outputDescription: 'A concise summary of sales rows.',
    instructions: 'Use the lookup_sales tool to fetch sales rows, then summarize the trend.',
  });
}

/** M2: Stage 4（Assembler）が消費する台本。 */
function assemblerProposalJson(): string {
  return JSON.stringify({
    role: '# Role\nYou are the Sales Assistant, helping accountants understand sales data.',
    rules: '# Extra rules\nAlways cite the rows returned by the lookup tool.',
  });
}

async function waitFor(server: FastifyInstance, runId: string, statuses: readonly string[]): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = (await server.inject({ method: 'GET', url: `/factory-runs/${runId}`, query: scope })).json().run as Record<string, unknown>;
    if (statuses.includes(String(body['status']))) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`factory run did not reach one of ${statuses.join(', ')}`);
}

describe('factory routes', () => {
  let app: App; let server: FastifyInstance; let model: ScriptedModelProvider;
  beforeEach(() => { model = new ScriptedModelProvider(); app = createApp({ profile: 'test', modelProvider: model }); server = buildServer(app); });
  afterEach(async () => { await server.close(); app.close(); });

  async function seedDataSource(): Promise<string> {
    const uploaded = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'sales.csv', format: 'csv', content: 'id,amount\n1,100\n2,200' } });
    return uploaded.json().source.id as string;
  }

  it('202で作成し、requirePlanApproval:trueならqueued→running→waiting-approval→(approve後)running/succeededへ進む', async () => {
    const sourceId = await seedDataSource();
    model.enqueue(
      { message: { role: 'assistant', content: planJson(sourceId) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: toolProposalJson(sourceId) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: skillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: assemblerProposalJson() }, finishReason: 'stop' },
    );

    // maxIterations:1で、疑似ユーザー会話の台本を積まなくても改善ループ本体（Analyst呼び出し）を経由せず、
    // イテレーション1の結果（各ScenarioRunはstatus:'error'）だけで停止条件(c)が成立してsucceededに到達する。
    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: [sourceId], options: { requirePlanApproval: true, maxIterations: 1 } } });
    expect(created.statusCode).toBe(202);
    expect(created.json().run.status).toBe('queued');
    const runId = created.json().run.id as string;

    const waiting = await waitFor(server, runId, ['waiting-approval']);
    expect(waiting['stage']).toBe('planning');
    expect((waiting['plan'] as Record<string, unknown>)['agentBrief']).toMatchObject({ displayName: 'Sales Assistant' });

    const list = await server.inject({ method: 'GET', url: '/factory-runs', query: scope });
    expect((list.json().runs as unknown[]).map((run) => (run as Record<string, unknown>)['id'])).toContain(runId);

    const events = await server.inject({ method: 'GET', url: `/factory-runs/${runId}/events`, query: scope });
    expect((events.json().events as unknown[]).map((event) => (event as Record<string, unknown>)['kind'])).toContain('approval_requested');

    const approved = await server.inject({ method: 'POST', url: `/factory-runs/${runId}/responses`, payload: { scope, response: { kind: 'plan-approval', decision: 'approve' } } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().run.status).toBe('running');

    // M2: Stage 2-4（Tool/Skill/Agent生成）が完了する。M3: Stage 5（Persona/pseudo-user/Scenario draft保存）+
    // 検証実行（疑似ユーザー会話の台本は積んでいないため各ScenarioRunはstatus:'error'で終わるが、Factory側の
    // 集計・イテレーション記録は正常に進む）。M4: maxIterations:1のため改善ループ本体（Analyst）は実行されず、
    // イテレーション1のレポートを添えてsucceededで終わる（生成資産はdraftのまま・昇格はしない）。
    const succeeded = await waitFor(server, runId, ['succeeded']);
    expect(succeeded['failure']).toBeUndefined();
    expect(succeeded['report']).toBeDefined();
    expect((succeeded['report'] as Record<string, unknown>)['bestIteration']).toBe(1);
    const artifacts = succeeded['artifacts'] as Record<string, unknown>;
    expect((artifacts['tools'] as unknown[])).toHaveLength(1);
    expect((artifacts['skills'] as unknown[])).toHaveLength(1);
    expect((artifacts['agentVersions'] as unknown[])).toHaveLength(1);
    expect((artifacts['personas'] as unknown[])).toHaveLength(1);
    expect((artifacts['pseudoUsers'] as unknown[])).toHaveLength(1);
    expect((artifacts['scenarios'] as unknown[])).toHaveLength(1);
    expect((succeeded['iterations'] as unknown[])).toHaveLength(1);
  });

  it('POST /factory-runs/:id/cancelはキャンセル済みRunを返し、後続のworker処理で上書きされない', async () => {
    const sourceId = await seedDataSource();
    model.enqueue({ message: { role: 'assistant', content: planJson(sourceId) }, finishReason: 'stop' });
    // requirePlanApproval:true にして、workerが自然停止する waiting-approval より先（terminal）へ進まないようにする
    // （そうしないと、続行に必要なTool/Skill/Assembler台本を積んでいないため生成段でModelProviderErrorとなり
    // 　cancel 呼び出し前に failed へ到達し、terminalへのcancelがharness cancel同様500になる）。
    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: [sourceId], options: { requirePlanApproval: true } } });
    const runId = created.json().run.id as string;

    const cancelled = await server.inject({ method: 'POST', url: `/factory-runs/${runId}/cancel`, payload: { scope } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('cancelled');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await server.inject({ method: 'GET', url: `/factory-runs/${runId}`, query: scope });
    expect(after.json().run.status).toBe('cancelled');
  });

  it('未存在Runは404、不正bodyは400', async () => {
    const missing = await server.inject({ method: 'GET', url: '/factory-runs/missing', query: scope });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('FACTORY_NOT_FOUND');

    const invalid = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: { goal: 'x', language: 'ja' }, dataSourceIds: [] } });
    expect(invalid.statusCode).toBe(400);
  });
});
