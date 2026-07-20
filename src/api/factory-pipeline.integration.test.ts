/**
 * api層: Agent Factory 統合テスト（v33 実装契約 §8 / docs/16-agent-factory.md §11）。
 *
 * `factory-routes.test.ts` は `ScriptedModelProvider`（単純FIFOキュー）で配線・状態遷移だけを検証する
 * （疑似ユーザー会話の台本を積まないため各ScenarioRunは status:'error' で終わる）。本ファイルは同じ
 * `createApp({ profile: 'test', modelProvider })` + `buildServer(app)` のセットアップを踏襲しつつ、
 * 台本を「ロール名で振り分ける」`RoutingModelProvider` に差し替えることで、実際に疑似ユーザーが目標を
 * 達成する・生成Toolが実データ（サンプルCSV）を読む・改善ループが実際に1周する、という
 * 本物のE2Eパイプライン実行を検証する。
 *
 * 生成Toolは `sample-monthly-sales.csv`（本タスクで追加した `src/sample-data.ts` のFactory向け
 * サンプルデータソースと同種のCSV）を `POST /data-sources/files` で都度アップロードして使う
 * （テストごとに独立した `App` インスタンスを使うため、`sample-data.ts` 側のシードとは別に用意する）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';
import { SemVer } from '../domain/tool/semver';
import {
  ModelProviderError,
  type ModelCapability,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelProviderPort,
} from '../application/model/model-provider';

const scope = { tenantId: 't', workspaceId: 'w' };

type JsonRecord = Record<string, unknown>;

/** Factory向けの月次売上サンプルCSV（2リージョン × 3ヶ月 = 6行。集計・傾向要約に足る最小データ）。 */
const SALES_CSV = [
  'month,region,revenue,units',
  '2026-05,East,120000,400',
  '2026-05,West,98000,350',
  '2026-06,East,135000,420',
  '2026-06,West,101000,360',
  '2026-07,East,140000,430',
  '2026-07,West,110000,370',
].join('\n');

/** `csv-source` は数値列を number へ、'YYYY-MM' はISO日付にマッチしないため string のまま推論する。 */
const EXPECTED_SALES_ROWS: readonly JsonRecord[] = [
  { month: '2026-05', region: 'East', revenue: 120000, units: 400 },
  { month: '2026-05', region: 'West', revenue: 98000, units: 350 },
  { month: '2026-06', region: 'East', revenue: 135000, units: 420 },
  { month: '2026-06', region: 'West', revenue: 101000, units: 360 },
  { month: '2026-07', region: 'East', revenue: 140000, units: 430 },
  { month: '2026-07', region: 'West', revenue: 110000, units: 370 },
];

// ---- canned JSON builders（factory-routes.test.ts の形を踏襲し、月次売上ドメインへ差し替え） ----

function planJson(dataSourceId: string, displayName = 'Monthly Sales Assistant'): JsonRecord {
  return {
    agentBrief: { displayName, role: 'Answers questions about monthly sales and summarizes trends.' },
    tools: [{ key: 'lookup', displayName: 'Lookup Monthly Sales', purpose: 'Look up monthly sales rows.', dataSourceId, sideEffect: 'read-only' }],
    skills: [{ key: 'summarize', displayName: 'Summarize Sales', responsibility: 'Summarize monthly sales trends.', activationCondition: 'user asks for a total or a summary', toolKeys: ['lookup'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'Find the total monthly sales.', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 2 }],
  };
}

function toolProposalJson(dataSourceId: string): JsonRecord {
  return {
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'lookup_monthly_sales', description: 'Look up monthly sales rows.' },
  };
}

/** D: 常に存在しないdataSourceIdを参照する不正グラフ（resolveDataSources/propagateSchemasで必ず失敗する）。 */
function invalidToolProposalJson(): JsonRecord {
  return {
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'does-not-exist-ds' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'lookup_monthly_sales', description: 'Look up monthly sales rows.' },
  };
}

function skillProposalJson(): JsonRecord {
  return {
    responsibility: 'Summarize monthly sales trends.',
    activationCondition: 'user asks for a total or a summary',
    inputDescription: 'A question about monthly sales.',
    outputDescription: 'A concise summary of monthly sales rows.',
    instructions: 'Use the lookup_monthly_sales tool to fetch monthly sales rows, then summarize the trend.',
  };
}

function assemblerProposalJson(): JsonRecord {
  return {
    role: '# Role\nYou are the Monthly Sales Assistant, helping accountants understand monthly sales data.',
    rules: '# Extra rules\nAlways cite the rows returned by the lookup tool when answering.',
  };
}

/**
 * B: 改善提案（system-prompt-revision）。`agentId` は実行時にしか分からない生成Agentの internalId なので
 * プレースホルダ `__AGENT_ID__` を埋め込み、`RoutingModelProvider` が `factory_analyst_proposal` リクエストの
 * untrusted payload（`currentAgent.id`）から実値を読み取って置換する。
 */
function analystProposalJson(): JsonRecord {
  return {
    findings: [
      { id: 'unclear-total', severity: 'warning', area: 'agent-prompt', detail: 'The pseudo user could not find the requested total; the agent must state the number explicitly.' },
    ],
    proposals: [
      {
        kind: 'system-prompt-revision',
        agentId: '__AGENT_ID__',
        sections: {
          role: '# Role\nYou are the Monthly Sales Assistant (revised). You help accountants understand monthly sales data by answering questions directly and clearly.',
          rules: '# Extra rules\nAlways state the requested number explicitly in your first sentence. Always cite the rows returned by the lookup tool when answering.',
        },
        rationale: 'The pseudo user reported the previous answer was unclear; the agent must state totals explicitly.',
      },
    ],
    summary: 'Iteration 1 fell short of the goal-achievement and satisfaction targets; revised the system prompt to state totals explicitly.',
  };
}

function pseudoTurn(message: string, endConversation: boolean, goalAchieved: boolean): JsonRecord {
  return { message, endConversation, goalAchieved };
}

function surveyAnswers(overrides: Partial<Record<'q1' | 'q2' | 'q3' | 'q4' | 'q5' | 'q6' | 'q7' | 'impressions', unknown>> = {}): JsonRecord {
  return {
    q1: true, q2: 5, q3: 5, q4: 5, q5: 5, q6: '分かりやすかった', q7: '特になし', impressions: '満足しています',
    ...overrides,
  };
}

// ---- RoutingModelProvider（Deliverable 2） ----

interface RoutingModelConfig {
  readonly plan: JsonRecord;
  readonly toolProposal: JsonRecord;
  readonly skillProposal?: JsonRecord;
  readonly assemblerProposal?: JsonRecord;
  readonly analystProposal?: JsonRecord;
  readonly pseudoTurns?: readonly JsonRecord[];
  readonly surveys?: readonly JsonRecord[];
  readonly agentAnswer?: string;
  readonly agentToolCall?: { readonly name: string };
}

function jsonCompletion(value: unknown): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify(value) }, finishReason: 'stop' };
}

/** `wrapUntrusted`（roles/untrusted.ts）が組み立てた `<untrusted-data>...</untrusted-data>` からJSONを取り出す。 */
function extractUntrustedPayload(request: ModelCompletionRequest): unknown {
  const userMessage = [...request.messages].reverse().find((message) => message.role === 'user' && typeof message.content === 'string');
  if (userMessage === undefined) return undefined;
  const match = /<untrusted-data[^>]*>\n([\s\S]*?)\n<\/untrusted-data>/.exec(userMessage.content as string);
  if (match === null) return undefined;
  try { return JSON.parse(match[1] ?? ''); } catch { return undefined; }
}

/**
 * `request.responseFormat?.name`（または target agent turn の場合は `responseFormat` 不在 + `tools` 存在）で
 * 振り分ける `ModelProviderPort`。`ScriptedModelProvider` の単純FIFOと違い、Planner/ToolSmith/SkillWriter/
 * Assembler/Analystの各ロール提案は「Run内で1回だけ」呼ばれる固定値、疑似ユーザーターン・アンケートだけが
 * 「Scenario実行のたびに繰り返す」FIFOキューという、実際の呼び出しパターンに合わせた設計。
 *
 * Plan/Tool提案は生成対象データソースの `dataSourceId`（アップロード後にしか分からない）を参照する必要が
 * あるため、`configure()` で construct 後に設定する2段階セットアップを許す（`ScriptedModelProvider.enqueue`
 * が construct 後に呼ばれるのと同じ理由）。
 */
class RoutingModelProvider implements ModelProviderPort {
  private config: RoutingModelConfig | undefined;
  private pseudoTurns: JsonRecord[] = [];
  private surveys: JsonRecord[] = [];
  private agentToolCallServed = false;

  constructor(config?: RoutingModelConfig) {
    if (config !== undefined) this.configure(config);
  }

  configure(config: RoutingModelConfig): void {
    this.config = config;
    this.pseudoTurns = [...(config.pseudoTurns ?? [])];
    this.surveys = [...(config.surveys ?? [])];
    this.agentToolCallServed = false;
  }

  capabilities(): readonly ModelCapability[] {
    return ['chat', 'tool-calling', 'structured-output', 'vision'];
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (signal?.aborted === true) throw new ModelProviderError('RoutingModelProvider: request aborted');
    const config = this.config;
    if (config === undefined) throw new ModelProviderError('RoutingModelProvider: not configured yet (call configure() first)');

    const name = request.responseFormat?.name;
    switch (name) {
      case 'factory_plan': return jsonCompletion(config.plan);
      case 'factory_tool_proposal': return jsonCompletion(config.toolProposal);
      case 'factory_skill_proposal': {
        if (config.skillProposal === undefined) throw new ModelProviderError('RoutingModelProvider: no skillProposal configured');
        return jsonCompletion(config.skillProposal);
      }
      case 'factory_assembler_proposal': {
        if (config.assemblerProposal === undefined) throw new ModelProviderError('RoutingModelProvider: no assemblerProposal configured');
        return jsonCompletion(config.assemblerProposal);
      }
      case 'factory_analyst_proposal': return jsonCompletion(this.buildAnalystProposal(request));
      case 'pseudo_user_turn': {
        const turn = this.pseudoTurns.shift();
        if (turn === undefined) throw new ModelProviderError('RoutingModelProvider: no pseudo user turn queued');
        return jsonCompletion(turn);
      }
      case 'scenario_survey': {
        const survey = this.surveys.shift();
        if (survey === undefined) throw new ModelProviderError('RoutingModelProvider: no survey queued');
        return jsonCompletion(survey);
      }
      case undefined: {
        // target agent turn: RunAgentPreviewUseCase は responseFormat を付けず、tools を付けて呼ぶ。
        if (request.tools === undefined || request.tools.length === 0) {
          throw new ModelProviderError('RoutingModelProvider: unrecognized request (no responseFormat, no tools)');
        }
        if (config.agentToolCall !== undefined && !this.agentToolCallServed) {
          this.agentToolCallServed = true;
          return {
            message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: config.agentToolCall.name, arguments: {} }] },
            finishReason: 'tool_calls',
          };
        }
        return { message: { role: 'assistant', content: config.agentAnswer ?? '売上の合計をお答えします。' }, finishReason: 'stop' };
      }
      default:
        throw new ModelProviderError(`RoutingModelProvider: unrecognized responseFormat: ${String(name)}`);
    }
  }

  private buildAnalystProposal(request: ModelCompletionRequest): JsonRecord {
    const template = this.config?.analystProposal;
    if (template === undefined) throw new ModelProviderError('RoutingModelProvider: no analystProposal configured');
    const payload = extractUntrustedPayload(request) as { readonly currentAgent?: { readonly id?: string } } | undefined;
    const agentId = payload?.currentAgent?.id ?? '';
    return JSON.parse(JSON.stringify(template).split('__AGENT_ID__').join(agentId)) as JsonRecord;
  }
}

// ---- test helpers ----

/** `factory-routes.test.ts` の `waitFor` と同じポーリングヘルパー（workerが非同期のため）。 */
async function waitFor(server: FastifyInstance, runId: string, statuses: readonly string[]): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = (await server.inject({ method: 'GET', url: `/factory-runs/${runId}`, query: scope })).json().run as Record<string, unknown>;
    if (statuses.includes(String(body['status']))) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`factory run did not reach one of ${statuses.join(', ')}`);
}

async function seedSalesDataSource(server: FastifyInstance): Promise<string> {
  const uploaded = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'sample-monthly-sales.csv', format: 'csv', content: SALES_CSV } });
  return uploaded.json().source.id as string;
}

const GOAL = { goal: '月次売上について質問に答え、傾向を要約するアシスタントが欲しい', language: 'ja' as const };

describe('factory pipeline integration（実データ・実疑似ユーザー会話を通す本物のE2E実行）', () => {
  let app: App | undefined;
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server !== undefined) await server.close();
    if (app !== undefined) app.close();
    app = undefined;
    server = undefined;
  });

  it('A: 本物の成功（1イテレーション）— 疑似ユーザーが目標達成し、生成資産一式が実データに紐づく', async () => {
    const model = new RoutingModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    const sourceId = await seedSalesDataSource(server);

    model.configure({
      plan: planJson(sourceId),
      toolProposal: toolProposalJson(sourceId),
      skillProposal: skillProposalJson(),
      assemblerProposal: assemblerProposalJson(),
      pseudoTurns: [
        pseudoTurn('今月の売上合計はいくらですか？', false, false),
        pseudoTurn('ありがとうございます、助かりました。', true, true),
      ],
      surveys: [surveyAnswers({ q2: 5 })],
      agentAnswer: '2026年7月の売上合計は East 140,000 / West 110,000 です。',
    });

    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: GOAL, dataSourceIds: [sourceId] } });
    expect(created.statusCode).toBe(202);
    const runId = created.json().run.id as string;

    const succeeded = await waitFor(server, runId, ['succeeded']);
    expect(succeeded['failure']).toBeUndefined();

    const artifacts = succeeded['artifacts'] as Record<string, unknown[]>;
    for (const key of ['tools', 'skills', 'agentVersions', 'personas', 'pseudoUsers', 'scenarios'] as const) {
      expect(artifacts[key]).toHaveLength(1);
    }

    const iterations = succeeded['iterations'] as Array<Record<string, unknown>>;
    expect(iterations).toHaveLength(1);
    const metrics = iterations[0]?.['metrics'] as Record<string, unknown>;
    expect(metrics['goalAchievedRate']).toBe(1);
    expect(metrics['avgSatisfaction']).toBe(5);

    const report = succeeded['report'] as Record<string, unknown>;
    const agentRef = (artifacts['agentVersions'] as Array<{ internalId: string; version: string }>)[0]!;
    expect(report['bestIteration']).toBe(1);
    expect(report['candidate']).toMatchObject({ agentId: agentRef.internalId, version: agentRef.version });

    // 生成Agentをロードし、生成Tool・生成Skillへ版固定で紐づいていることを確認する。
    const toolRef = (artifacts['tools'] as Array<{ internalId: string; version: string }>)[0]!;
    const skillRef = (artifacts['skills'] as Array<{ internalId: string; version: string }>)[0]!;
    const agent = await app.queryAgents.get(scope, agentRef.internalId, SemVer.parse(agentRef.version));
    expect(agent.tools).toHaveLength(1);
    expect(agent.skills).toHaveLength(1);
    expect(agent.tools.map((ref) => ({ internalId: ref.internalId, version: ref.version.toString() }))).toEqual([toolRef]);
    expect(agent.skills.map((ref) => ({ internalId: ref.internalId, version: ref.version.toString() }))).toEqual([skillRef]);

    // 生成ScenarioのScenarioRunをロードし、疑似ユーザー会話が完走・目標達成したことを確認する。
    const scenarioRunId = (iterations[0]?.['scenarioRunIds'] as string[])[0]!;
    const scenarioRun = await app.queryScenarioRuns.get(scope, scenarioRunId);
    expect(scenarioRun.status).toBe('completed');
    expect(scenarioRun.goalAchieved).toBe(true);
  });

  it('B: 改善ループで成功（2イテレーション）— Analystのsystem-prompt-revisionが適用され2周目で目標達成する', async () => {
    const model = new RoutingModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    const sourceId = await seedSalesDataSource(server);

    model.configure({
      plan: planJson(sourceId),
      toolProposal: toolProposalJson(sourceId),
      skillProposal: skillProposalJson(),
      assemblerProposal: assemblerProposalJson(),
      analystProposal: analystProposalJson(),
      pseudoTurns: [
        // iteration 1: 目標未達（低満足度）
        pseudoTurn('今月の売上合計はいくらですか？', false, false),
        pseudoTurn('うーん、よくわからない…', true, false),
        // iteration 2（system prompt改訂後）: 目標達成
        pseudoTurn('今月の売上合計はいくらですか？', false, false),
        pseudoTurn('ありがとうございます、助かりました。', true, true),
      ],
      surveys: [
        surveyAnswers({ q1: false, q2: 2, q3: 2, q4: 2, q5: 2, q7: 'よくわからなかった', impressions: 'いまいち' }),
        surveyAnswers({ q2: 5 }),
      ],
      agentAnswer: '売上の合計をお答えします。',
    });

    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: GOAL, dataSourceIds: [sourceId], options: { maxIterations: 3 } } });
    const runId = created.json().run.id as string;

    const succeeded = await waitFor(server, runId, ['succeeded']);
    expect(succeeded['failure']).toBeUndefined();

    const iterations = succeeded['iterations'] as Array<Record<string, unknown>>;
    expect(iterations).toHaveLength(2);
    expect((iterations[0]?.['metrics'] as Record<string, unknown>)['goalAchievedRate']).toBe(0);
    expect((iterations[1]?.['metrics'] as Record<string, unknown>)['goalAchievedRate']).toBe(1);

    const analysis = iterations[0]?.['analysis'] as Record<string, unknown> | undefined;
    expect(analysis).toBeDefined();
    expect((analysis?.['applied'] as unknown[]).length).toBeGreaterThanOrEqual(1);

    const artifacts = succeeded['artifacts'] as Record<string, unknown[]>;
    const agentVersions = artifacts['agentVersions'] as Array<{ internalId: string; version: string }>;
    expect(agentVersions).toHaveLength(2);

    const report = succeeded['report'] as Record<string, unknown>;
    expect(report['bestIteration']).toBe(2);
    expect(report['candidate']).toMatchObject({ agentId: agentVersions[1]!.internalId, version: agentVersions[1]!.version });
  });

  it('C: 計画承認 → 承認後に本物の成功した会話でsucceededへ到達する', async () => {
    const model = new RoutingModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    const sourceId = await seedSalesDataSource(server);

    model.configure({
      plan: planJson(sourceId),
      toolProposal: toolProposalJson(sourceId),
      skillProposal: skillProposalJson(),
      assemblerProposal: assemblerProposalJson(),
      pseudoTurns: [
        pseudoTurn('今月の売上合計はいくらですか？', false, false),
        pseudoTurn('ありがとうございます、助かりました。', true, true),
      ],
      surveys: [surveyAnswers({ q2: 5 })],
      agentAnswer: '2026年7月の売上合計は East 140,000 / West 110,000 です。',
    });

    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: GOAL, dataSourceIds: [sourceId], options: { requirePlanApproval: true } } });
    const runId = created.json().run.id as string;

    const waiting = await waitFor(server, runId, ['waiting-approval']);
    expect(waiting['plan']).toBeDefined();
    expect((waiting['plan'] as Record<string, unknown>)['agentBrief']).toMatchObject({ displayName: 'Monthly Sales Assistant' });

    const approved = await server.inject({ method: 'POST', url: `/factory-runs/${runId}/responses`, payload: { scope, response: { kind: 'plan-approval', decision: 'approve' } } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().run.status).toBe('running');

    const succeeded = await waitFor(server, runId, ['succeeded']);
    expect(succeeded['failure']).toBeUndefined();
    expect(succeeded['report']).toBeDefined();
  });

  it('D: 生成失敗（全Toolが不合格）— 修復ループを尽くしてfailedへ落ちる', async () => {
    const model = new RoutingModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    const sourceId = await seedSalesDataSource(server);

    model.configure({
      plan: planJson(sourceId),
      // 常に存在しないdataSourceIdを参照する不正グラフ（maxRepairAttempts既定2 → 計3回とも失敗する）。
      toolProposal: invalidToolProposalJson(),
    });

    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: GOAL, dataSourceIds: [sourceId] } });
    const runId = created.json().run.id as string;

    const failed = await waitFor(server, runId, ['failed']);
    const failure = failed['failure'] as Record<string, unknown>;
    expect(String(failure['reason'])).toContain('no tools');
  });

  it('E: 生成Toolが実データを読む（動作確認）— previewが seed済みCSVの実データを返す', async () => {
    const model = new RoutingModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    const sourceId = await seedSalesDataSource(server);

    model.configure({
      plan: planJson(sourceId),
      toolProposal: toolProposalJson(sourceId),
      skillProposal: skillProposalJson(),
      assemblerProposal: assemblerProposalJson(),
      pseudoTurns: [
        pseudoTurn('今月の売上合計はいくらですか？', false, false),
        pseudoTurn('ありがとうございます、助かりました。', true, true),
      ],
      surveys: [surveyAnswers({ q2: 5 })],
      agentAnswer: '2026年7月の売上合計は East 140,000 / West 110,000 です。',
    });

    const created = await server.inject({ method: 'POST', url: '/factory-runs', payload: { scope, goal: GOAL, dataSourceIds: [sourceId] } });
    const runId = created.json().run.id as string;
    const succeeded = await waitFor(server, runId, ['succeeded']);

    const toolRef = ((succeeded['artifacts'] as Record<string, unknown[]>)['tools'] as Array<{ internalId: string; version: string }>)[0]!;
    const tool = await app.getTool.version(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool.metadata.state).toBe('draft');

    const preview = await app.previewTool.preview(scope, tool.metadata.internalId, { version: tool.metadata.version });
    expect(preview.result.output.rows).toEqual(EXPECTED_SALES_ROWS);
  });
});
