import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import { DEFAULT_FACTORY_OPTIONS, type FactoryGoalInput } from '../../../domain/factory/factory-run';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import type { DataProfile } from '../profile-data-sources';
import type { ExistingToolCatalog } from '../tool-catalog';
import { inferAdditionalDataSources, normalizePlan, PlannerRole, planSchemaFor, repairDataSourceIds } from './planner-role';
import type { FactoryPlan } from '../../../domain/factory/factory-plan';

const goal: FactoryGoalInput = { goal: 'Answer sales questions and summarize trends.', language: 'ja' };
const profiles: readonly DataProfile[] = [{
  dataSourceId: 'ds-1', name: 'Sales', kind: 'file',
  columns: [{ name: 'amount', type: 'number', nullable: false }],
  sampleRowCount: 1, sampleRows: [{ amount: 100 }], rowCount: 1, periodColumns: [], categoricalColumns: [], joinCandidates: [],
}];

function validPlanJson(overrides?: { readonly dataSourceId?: string; readonly sideEffect?: string }): string {
  return JSON.stringify({
    agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
    tools: [{ key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: overrides?.dataSourceId ?? 'ds-1', sideEffect: overrides?.sideEffect ?? 'read-only' }],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 3 }],
  });
}

const existingTools: ExistingToolCatalog = {
  entries: [
    {
      internalId: 'builtin-current-datetime', latestVersion: '1.0.0', publishName: 'current_datetime', displayName: 'Current Datetime',
      toolName: 'current_datetime', description: 'Returns the current date and time.', inputs: [], sideEffect: 'read-only', owner: 'builtin',
    },
  ],
  totalCount: 23,
};

/** 既存の `current_datetime` を再利用し、新規Toolを1件だけ作る計画。 */
function reusePlanJson(internalId = 'builtin-current-datetime'): string {
  return JSON.stringify({
    agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
    tools: [
      { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' },
      { key: 'today', displayName: 'Current Datetime', purpose: 'Know what "this month" means.', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId, rationale: 'builtin tool already returns now/date/yearMonth' } },
    ],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup', 'today'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 3 }],
  });
}

describe('PlannerRole', () => {
  it('温度0・厳格な構造化出力でFactoryPlanを提案し、アプリ側で再検証する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    const plan = await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });

    expect(plan.agentBrief.displayName).toBe('Sales Assistant');
    expect(plan.tools).toHaveLength(1);
    expect(model.requests[0]?.temperature).toBe(0);
    expect(model.requests[0]?.responseFormat?.strict).toBe(true);
    // データ値（列名・サンプル行）はuser message側でuntrusted dataとして隔離される。
    const userMessage = model.requests[0]?.messages.find((message) => message.role === 'user');
    expect(String(userMessage?.content)).toContain('<untrusted-data');
    expect(String(userMessage?.content)).toContain('ds-1');
  });

  it('既存ツールカタログをプロンプトへ載せ、「新規作成の前に再利用を検討する」よう指示する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools });

    // 再利用の思考ステップはsystem命令側（データではなく指示）。
    const systemMessage = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    expect(systemMessage).toContain('Reuse before creating');
    expect(systemMessage).toContain('reuse.internalId');
    expect(systemMessage).toContain('current_datetime');
    // カタログ自体（利用者が書いた表示名・説明を含む）はuntrusted data側へ隔離する。
    const userMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(userMessage).toContain('builtin-current-datetime');
    expect(userMessage).toContain('Returns the current date and time.');
    // 上限で切り捨てた分は件数だけ伝える。
    expect(userMessage).toContain('existingToolsOmitted');
  });

  it('reuse付きの計画をそのままパースする（dataSourceId空でも再利用計画なら通る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    const plan = await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools });

    expect(plan.tools).toHaveLength(2);
    expect(plan.tools[0]?.reuse).toBeUndefined();
    expect(plan.tools[1]?.reuse).toEqual({ internalId: 'builtin-current-datetime', rationale: 'builtin tool already returns now/date/yearMonth' });
  });

  it('カタログ未指定でも従来どおり計画できる（existingToolsは空配列として渡る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });

    const userMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(userMessage).toContain('"existingTools":[]');
    expect(userMessage).not.toContain('existingToolsOmitted');
  });

  it('空のreuse(internalId空)は「reuse指定なし」へ正規化する — strictモデルがoptionalを埋める実測ケース', async () => {
    // 実測: gemmaは再利用しないツールにも reuse: {internalId: ''} を埋めて計画全体を落としていた。
    const plan = JSON.parse(reusePlanJson()) as { tools: Record<string, unknown>[] };
    plan.tools[0] = { ...plan.tools[0], reuse: { internalId: '', rationale: '' } };
    plan.tools[1] = { ...plan.tools[1], reuse: { internalId: 'builtin-current-datetime', rationale: 'keep' } };
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify(plan) }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    const parsed = await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools });
    expect(parsed.tools[0]?.reuse).toBeUndefined();
    expect(parsed.tools[1]?.reuse).toEqual({ internalId: 'builtin-current-datetime', rationale: 'keep' });
  });

  it('空のreuseを剥がした結果dataSourceIdが空なら、dataSourceIdエラーとして拒否する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson('  ') }, finishReason: 'stop' });
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson('  ') }, finishReason: 'stop' }); // 検証に落ちると理由つきで 1 回だけ再提案させるので、2 回とも不正な応答を返す
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools })).rejects.toThrow(/dataSourceId/);
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' }); // 検証に落ちると理由つきで 1 回だけ再提案させるので、2 回とも不正な応答を返す
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/invalid JSON/);
  });

  it.each([
    ['空応答', null, /empty content/],
    ['JSON配列', '[]', /not a JSON object/],
    ['agentBrief欠落', '{"tools":[],"skills":[],"personas":[],"scenarios":[]}', /missing agentBrief/],
    ['計画コレクション欠落', '{"agentBrief":{"displayName":"a","role":"b"}}', /missing tools\/skills\/personas\/scenarios/],
  ] as const)('構造化出力が計画の形をしていない場合（%s）はFactoryValidationErrorになる', async (_label, content, expected) => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content }, finishReason: 'stop' });
    model.enqueue({ message: { role: 'assistant', content }, finishReason: 'stop' }); // 検証に落ちると理由つきで 1 回だけ再提案させるので、2 回とも不正な応答を返す
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(expected);
  });

  it('入力にないdataSourceIdを参照する計画は拒否する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: 'ds-unknown' }) }, finishReason: 'stop' });
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: 'ds-unknown' }) }, finishReason: 'stop' }); // 検証に落ちると理由つきで 1 回だけ再提案させるので、2 回とも不正な応答を返す
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/unknown data source/);
  });

  it("write副作用のtool計画は拒否する（read-only/session-writeのみ許可）", async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ sideEffect: 'write' }) }, finishReason: 'stop' });
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ sideEffect: 'write' }) }, finishReason: 'stop' }); // 検証に落ちると理由つきで 1 回だけ再提案させるので、2 回とも不正な応答を返す
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/sideEffect must be/);
  });

  it('structured-output capabilityがないモデルは利用不可', async () => {
    const capabilities: readonly ModelCapability[] = ['chat'];
    const model: ModelProviderPort = {
      capabilities: () => capabilities,
      complete: (_request: ModelCompletionRequest, _signal?: AbortSignal): Promise<ModelCompletion> => {
        throw new Error('should not be called');
      },
    };
    const role = new PlannerRole(model);
    expect(role.available()).toBe(false);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/does not support structured output/);
  });
});

describe('PlannerRole: データソース id の写し間違い（e-Stat 実測: UUID の途中に `-` を足して Run ごと落ちた）', () => {
  const A = 'bf942594-d24e-4e1a-83fe-089d44647404';
  const B = '7a5bbcdb-78d6-43f1-b84f-1ac82748c9a0';
  const planWith = (dataSourceId: string) => JSON.parse(validPlanJson({ dataSourceId })) as Parameters<typeof repairDataSourceIds>[0];

  it('正常: 出力スキーマの tools[].dataSourceId を入力の id と空文字の enum に縛る', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: A }) }, finishReason: 'stop' });
    await new PlannerRole(model).propose({ goal, profiles, dataSourceIds: [A, B], options: DEFAULT_FACTORY_OPTIONS });
    const schema = model.requests[0]?.responseFormat?.schema;
    expect(schema?.properties['tools']?.items?.properties?.['dataSourceId']).toEqual({ type: 'string', enum: [A, B, ''] });
  });

  it('境界: id が 0 件なら enum を付けず素のスキーマを返す（強化モード。空の enum は不正なスキーマになる）', () => {
    expect(planSchemaFor([]).properties['tools']?.items?.properties?.['dataSourceId']).toEqual({ type: 'string' });
  });

  it('異常: enum を守らないモデルが 1 文字足した id を返しても、一意に最も近い入力 id へ直して計画を通す', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: 'bf942594-d24e-4e-1a-83fe-089d44647404' }) }, finishReason: 'stop' });
    const plan = await new PlannerRole(model).propose({ goal, profiles, dataSourceIds: [A, B], options: DEFAULT_FACTORY_OPTIONS });
    expect(plan.tools[0]?.dataSourceId).toBe(A);
  });

  it('異常: 近い id が無い（別物の id）なら直さず、従来どおり未知のデータソースとして落とす', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: 'totally-different-source' }) }, finishReason: 'stop' });
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: 'totally-different-source' }) }, finishReason: 'stop' }); // 検証に落ちると理由つきで 1 回だけ再提案させるので、2 回とも不正な応答を返す
    await expect(new PlannerRole(model).propose({ goal, profiles, dataSourceIds: [A, B], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/references unknown data source/);
  });

  it('境界: 同じ距離の候補が複数あるときは当て推量で選ばない（別の表を読ませない）', () => {
    const repaired = repairDataSourceIds(planWith('ds-x'), ['ds-1', 'ds-2']);
    expect(repaired.tools[0]?.dataSourceId).toBe('ds-x');
  });

  it('従来どおり: 既知の id と再利用計画の空文字には触らない', () => {
    expect(repairDataSourceIds(planWith(A), [A, B]).tools[0]?.dataSourceId).toBe(A);
    expect(repairDataSourceIds(planWith(''), [A, B]).tools[0]?.dataSourceId).toBe('');
  });
});

// ─── ADR-0047 round 3: 結合する追加データソースの計画 ───────────────────────────────────
describe('PlannerRole（複数データソースを結合するTool計画）', () => {
  const ids = ['ds-wage', 'ds-hours', 'ds-price'];

  it('正常: 追加データソースidも構造化出力の enum で縛る（写し間違いを起こさせない）', () => {
    const schema = planSchemaFor(ids);
    const additional = schema.properties?.['tools']?.items?.properties?.['additionalDataSourceIds'];

    expect(additional?.items?.enum).toEqual(ids);
    // 主idは「再利用計画（データソースを読まない）」のために空文字も選べるが、結合先は実在のidだけ。
    expect(schema.properties?.['tools']?.items?.properties?.['dataSourceId']?.enum).toEqual([...ids, '']);
    expect(additional?.items?.enum).not.toContain('');
  });

  it('正常: 結合先idの写し間違いも編集距離で直す（主idと同じ規則）', () => {
    const plan: FactoryPlan = {
      agentBrief: { displayName: 'A', role: 'r' },
      tools: [{ key: 't', displayName: 'T', purpose: 'p', dataSourceId: 'ds-wage', sideEffect: 'read-only', additionalDataSourceIds: ['ds-hour'] }],
      skills: [], personas: [], scenarios: [],
    };

    expect(repairDataSourceIds(plan, ids).tools[0]?.additionalDataSourceIds).toEqual(['ds-hours']);
  });

  it('境界(回帰固定): 候補が同距離で複数ある結合先idは、主idと従来どおり同じ規律で直さない（当て推量で別の表を読ませない）', () => {
    const plan: FactoryPlan = {
      agentBrief: { displayName: 'A', role: 'r' },
      tools: [{ key: 't', displayName: 'T', purpose: 'p', dataSourceId: 'ds-aaaa', sideEffect: 'read-only', additionalDataSourceIds: ['ds-xxxxx'] }],
      skills: [], personas: [], scenarios: [],
    };

    const repaired = repairDataSourceIds(plan, ['ds-aaaaa', 'ds-bbbbb']).tools[0];
    // 主idは一意に近いので直り、結合先は同距離の候補が2つあるので触らない（検証が「未知」として落とす）。
    expect(repaired?.dataSourceId).toBe('ds-aaaaa');
    expect(repaired?.additionalDataSourceIds).toEqual(['ds-xxxxx']);
  });

  it('境界(回帰固定): 結合先を持たない計画は、従来どおり主idだけが直される', () => {
    const plan: FactoryPlan = {
      agentBrief: { displayName: 'A', role: 'r' },
      tools: [{ key: 't', displayName: 'T', purpose: 'p', dataSourceId: 'ds-wag', sideEffect: 'read-only' }],
      skills: [], personas: [], scenarios: [],
    };

    const repaired = repairDataSourceIds(plan, ids).tools[0];
    expect(repaired?.dataSourceId).toBe('ds-wage');
    expect(repaired?.additionalDataSourceIds).toBeUndefined();
  });

  it('正常: 結合候補と「1ソース1Toolに割らない」規律をプロンプトへ含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const joined: DataProfile = {
      ...profiles[0]!,
      joinCandidates: [{ leftDataSourceId: 'ds-1', rightDataSourceId: 'ds-2', keys: ['時点', '地域コード'], overlap: { 時点: 1, 地域コード: 1 }, uniqueLeft: true, uniqueRight: false }],
    };

    await new PlannerRole(model).propose({ goal, profiles: [joined], dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    const user = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(system).toMatch(/plan ONE tool that joins them/);
    expect(system).toMatch(/Do NOT plan one tool per source/);
    expect(system).toMatch(/key is not unique on a side/);
    // 候補はuntrusted data側に1回だけ載る。
    expect(user).toContain('"joinCandidates"');
    expect(user).toContain('地域コード');
    expect(user).toContain('"uniqueRight":false');
  });
});

describe('PlannerRole: 計画の検証に落ちたら、理由を添えて 1 回だけ出し直させる', () => {
  const rejected = validPlanJson({ sideEffect: 'write' });

  it('正常: 1 回目が規則違反でも、2 回目が正しければ計画を返す（依頼には前回の応答と違反理由が入る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: rejected }, finishReason: 'stop' }, { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const plan = await new PlannerRole(model).propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });
    expect(plan.tools[0]?.sideEffect).toBe('read-only');
    expect(model.requests).toHaveLength(2);
    const retry = model.requests[1]?.messages ?? [];
    expect(retry.at(-2)).toEqual({ role: 'assistant', content: rejected });
    expect(String(retry.at(-1)?.content)).toMatch(/rejected by validation: .*sideEffect/);
    expect(model.requests[1]?.responseFormat).toEqual(model.requests[0]?.responseFormat);
  });

  it('異常: 2 回目も規則違反なら従来どおり FactoryValidationError（3 回目は呼ばない）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: rejected }, finishReason: 'stop' }, { message: { role: 'assistant', content: rejected }, finishReason: 'stop' });
    await expect(new PlannerRole(model).propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/sideEffect/);
    expect(model.requests).toHaveLength(2);
  });

  it('従来どおり: 1 回目が正しければ再提案はしない', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    await new PlannerRole(model).propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });
    expect(model.requests).toHaveLength(1);
  });
});

describe('normalizePlan: 任意項目を埋めてしまう癖を受け流す（実測: 再利用と結合先の併記で Run が計画段階で失敗）', () => {
  const base = JSON.parse(validPlanJson()) as Parameters<typeof normalizePlan>[0];
  const withTool = (tool: Record<string, unknown>) => ({ ...base, tools: [{ ...base.tools[0], ...tool }] }) as Parameters<typeof normalizePlan>[0];

  it('正常: カタログに無い Tool の再利用指定は「再利用なし」にする（結合先は残す）', () => {
    const plan = normalizePlan(withTool({ reuse: { internalId: 'ghost', rationale: 'x' }, additionalDataSourceIds: ['ds-2'] }), existingTools);
    expect(plan.tools[0]?.reuse).toBeUndefined();
    expect(plan.tools[0]?.additionalDataSourceIds).toEqual(['ds-2']);
  });

  it('正常: 実在する Tool の再利用計画に付いた結合先は落とす（再利用は既存のグラフをそのまま使う）', () => {
    const internalId = existingTools.entries[0]?.internalId ?? '';
    const plan = normalizePlan(withTool({ reuse: { internalId, rationale: 'x' }, additionalDataSourceIds: ['ds-2'] }), existingTools);
    expect(plan.tools[0]?.reuse?.internalId).toBe(internalId);
    expect(plan.tools[0]?.additionalDataSourceIds).toBeUndefined();
  });

  it('境界: カタログ未指定なら、どの再利用指定も実在しない扱いで外す', () => {
    expect(normalizePlan(withTool({ reuse: { internalId: 'any', rationale: 'x' } }), undefined).tools[0]?.reuse).toBeUndefined();
  });

  it('従来どおり: 再利用も結合先も無い計画には触らない', () => {
    expect(normalizePlan(base, existingTools)).toEqual(base);
  });
});

describe('inferAdditionalDataSources: 文章が別ソースの列を名指ししているのに結合先が無い計画を補う（実測: 給与総額を「円/時間」と誤答）', () => {
  const candidate = (left: string, right: string) => ({ leftDataSourceId: left, rightDataSourceId: right, keys: ['時点'], overlap: { 時点: 1 }, uniqueLeft: true, uniqueRight: true });
  const profileOf = (id: string, valueColumn: string, joinCandidates: DataProfile['joinCandidates']): DataProfile => ({
    dataSourceId: id, name: id, kind: 'file',
    columns: [{ name: '時点', type: 'string', nullable: false }, { name: valueColumn, type: 'number', nullable: false }],
    sampleRowCount: 0, sampleRows: [], rowCount: 0, periodColumns: [], categoricalColumns: [], joinCandidates,
  });
  const joins = [candidate('wage', 'hours'), candidate('wage', 'overtime')];
  const three = [profileOf('wage', '現金給与総額【円】', joins), profileOf('hours', '総実労働時間【時間】', joins), profileOf('overtime', '所定外労働時間【時間】', joins)];
  const base = JSON.parse(validPlanJson({ dataSourceId: 'wage' })) as FactoryPlan;
  const withTool = (tool: Record<string, unknown>) => ({ ...base, tools: [{ ...base.tools[0], ...tool }] }) as FactoryPlan;

  it('正常: purpose が別ソースにしか無い列を名指ししていれば、そのソースを結合先に補う', () => {
    const plan = inferAdditionalDataSources(withTool({ purpose: '現金給与総額【円】 ÷ 総実労働時間【時間】 で時給を出す' }), three);
    expect(plan.tools[0]?.additionalDataSourceIds).toEqual(['hours']);
  });

  it('正常: 単位の注記を外した列名でも照合する（計画の文章は単位抜きで列を呼ぶ）', () => {
    const plan = inferAdditionalDataSources(withTool({ purpose: '給与と所定外労働時間を並べる', argumentSummary: '総実労働時間も返す' }), three);
    expect(plan.tools[0]?.additionalDataSourceIds).toEqual(['hours', 'overtime']);
  });

  it('異常: 結合候補が無い相手は、名指しされていても補わない（結合できないソースを足すと生成が必ず落ちる）', () => {
    const unjoinable = [profileOf('wage', '現金給与総額【円】', []), profileOf('hours', '総実労働時間【時間】', [])];
    expect(inferAdditionalDataSources(withTool({ purpose: '総実労働時間で割る' }), unjoinable).tools[0]?.additionalDataSourceIds).toBeUndefined();
  });

  it('異常: 両方のソースにある列名（時点）だけの言及では補わない', () => {
    expect(inferAdditionalDataSources(withTool({ purpose: '時点を指定して給与を返す' }), three).tools[0]?.additionalDataSourceIds).toBeUndefined();
  });

  it('境界: 単位を外すと 3 文字未満になる列名は、完全一致のときだけ手掛かりにする（偶然の一致を避ける）', () => {
    const short = [profileOf('wage', '現金給与総額【円】', [candidate('wage', 'idx')]), profileOf('idx', '指数【%】', [candidate('wage', 'idx')])];
    expect(inferAdditionalDataSources(withTool({ purpose: '給与の指数的な伸びを見る' }), short).tools[0]?.additionalDataSourceIds).toBeUndefined();
    expect(inferAdditionalDataSources(withTool({ purpose: '給与と 指数【%】 を並べる' }), short).tools[0]?.additionalDataSourceIds).toEqual(['idx']);
  });

  it('従来どおり: モデルが結合先を書いた計画・再利用計画・ソースが 1 つの Run には触らない', () => {
    const written = withTool({ purpose: '総実労働時間と所定外労働時間', additionalDataSourceIds: ['overtime'] });
    expect(inferAdditionalDataSources(written, three)).toEqual(written);
    const reuse = withTool({ purpose: '総実労働時間', reuse: { internalId: 'x', rationale: 'y' } });
    expect(inferAdditionalDataSources(reuse, three)).toEqual(reuse);
    const single = withTool({ purpose: '総実労働時間' });
    expect(inferAdditionalDataSources(single, [three[0]!])).toEqual(single);
  });

  it('正常: PlannerRole は検証の前に補う（書き忘れた計画がそのまま通らない）', async () => {
    const model = new ScriptedModelProvider();
    const forgotten = JSON.parse(validPlanJson({ dataSourceId: 'wage' })) as { tools: Record<string, unknown>[] };
    forgotten.tools[0] = { ...forgotten.tools[0], purpose: '現金給与総額を総実労働時間で割る' };
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify(forgotten) }, finishReason: 'stop' });
    const plan = await new PlannerRole(model).propose({ goal, profiles: three.slice(0, 2), dataSourceIds: ['wage', 'hours'], options: DEFAULT_FACTORY_OPTIONS });
    expect(plan.tools[0]?.additionalDataSourceIds).toEqual(['hours']);
  });
});

describe('PlannerRole: 使えるツールテンプレートを材料に足す（v43 / ADR-0049）', () => {
  const templates = [
    { id: 'period-series', summary: '期間の範囲・粒度・カテゴリで絞って、値の推移を新しい順に返す。' },
    { id: 'ratio-of-two-sources', summary: '2 つのデータソースを同じ時点で結合し、分子 ÷ 分母 を計算して返す。' },
  ];

  it('正常: テンプレートの id と要約を untrusted data 側へ載せ、規則を 1 行だけ足す', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, templates });

    // 要約はテンプレートファイル（利用者が足せる外部ファイル）由来なので、材料側に置く。
    const userMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(userMessage).toContain('toolTemplates');
    expect(userMessage).toContain('period-series');
    expect(userMessage).toContain('ratio-of-two-sources');
    // 規則は system 側（指示）で、計画の形は変えない。
    const systemMessage = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    expect(systemMessage).toContain('toolTemplates in the user message');
    expect(systemMessage).toContain('additionalDataSourceIds');
    expect(systemMessage.split('\n').filter((line) => line.includes('toolTemplates'))).toHaveLength(1);
  });

  it('従来どおり: テンプレートが無い（未配線・0 件）なら材料も規則も足さない', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, templates: [] });

    expect(String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content)).not.toContain('toolTemplates');
    expect(String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content)).not.toContain('toolTemplates');
  });
});
