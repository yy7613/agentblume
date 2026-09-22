import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledPrompts } from '../../../test-support/prompts';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import { FILTER_OPS, ORDER_OPS, VALUELESS_OPS } from '../../../domain/etl/nodes/filter';
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import type { DataProfile } from '../profile-data-sources';
import { PERIOD_GRANULARITIES } from '../../../domain/etl/nodes/parse-period';
import { MAX_TOOL_CALLS } from '../../agent/run-agent-preview';
import { SAFE_TRANSFORM_TYPES, supportsMultiValueFilterOps, TOOL_SMITH_PROMPT, ToolSmithRole } from './tool-smith-role';

const toolPlan: FactoryToolPlan = { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' };
const profile: DataProfile = {
  dataSourceId: 'ds-1', name: 'Sales', kind: 'file', format: 'csv',
  columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'amount', type: 'number', nullable: false }],
  sampleRowCount: 2, sampleRows: [{ id: 1, amount: 100 }, { id: 2, amount: 200 }], rowCount: 2, periodColumns: [], categoricalColumns: [], joinCandidates: [],
};

function validProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
}

/** 検索条件をエージェント引数として宣言する提案（未接続の agent-input + conditions内 valueBinding）。 */
function argumentProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' } },
        ], combine: 'and' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] }, sample: { minimumAmount: 100 } } },
      ],
      edges: [{ from: 'src', to: 'filter' }, { from: 'filter', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows at or above minimumAmount.' },
  });
}

describe('ToolSmithRole', () => {
  it('温度0・厳格な構造化出力でToolグラフを提案する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    const proposal = await role.propose({ toolPlan, profile });

    expect(proposal.graph.nodes).toHaveLength(2);
    expect(proposal.graph.edges).toEqual([{ from: 'src', to: 'out' }]);
    expect(proposal.agentTool).toEqual({ name: 'lookup_sales', description: 'Look up sales rows.' });
    expect(model.requests[0]?.temperature).toBe(0);
    expect(model.requests[0]?.responseFormat?.strict).toBe(true);
    // データソースの列名・サンプル行はuser message側でuntrusted dataとして隔離される。
    const userMessage = model.requests[0]?.messages.find((message) => message.role === 'user');
    expect(String(userMessage?.content)).toContain('<untrusted-data');
    expect(String(userMessage?.content)).toContain('ds-1');
    // sourceノード種別はprofile.formatから決定され、systemプロンプトへ明示される。
    const systemMessage = model.requests[0]?.messages.find((message) => message.role === 'system');
    expect(String(systemMessage?.content)).toContain('csv-source');
  });

  it('json形式のprofileではjson-sourceを指示する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    await role.propose({ toolPlan, profile: { ...profile, format: 'json' } });

    const systemMessage = model.requests[0]?.messages.find((message) => message.role === 'system');
    expect(String(systemMessage?.content)).toContain('json-source');
  });

  it('検索条件をエージェント引数にするルールをsystemプロンプトへ含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    await role.propose({ toolPlan: { ...toolPlan, argumentSummary: 'minimum amount to search for' }, profile });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    // agent-input は禁止語彙ではなく「Tool引数の宣言」として許可される。
    expect(system).not.toMatch(/parameter-free and always valid/);
    expect(system).toMatch(/EXACTLY ONE extra node of type 'agent-input' that stays unconnected/);
    expect(system).toContain('"valueBinding": { "source": "agent-input", "field": "<argument name>" }');
    expect(system).toContain('"conditions"');
    expect(system).toMatch(/omit the agent-input node entirely/);
    // 引数計画はuntrusted dataとしてuser messageへ渡る。
    expect(String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content)).toContain('minimum amount to search for');
  });

  it('任意の絞り込み引数をnullableで宣言するルールをsystemプロンプトへ含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    await role.propose({ toolPlan, profile });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    expect(system).toMatch(/narrowing is OPTIONAL .* MUST be declared with "nullable": true/);
    expect(system).toMatch(/the filter condition it feeds is then skipped and all rows pass that condition/);
    expect(system).toMatch(/Never expect the agent to send a magic catch-all value such as "all" or "\*"/);
    expect(system).toMatch(/agentTool\.description must say so explicitly/);
    // 2引数の例は required 1つ + nullable 1つ（sample は required の分だけ）。
    expect(system).toContain('{ "name": "region", "type": "string", "nullable": true }');
    expect(system).toContain('"sample": { "month": "2026-05" }');
  });

  it('演算子をエージェント引数で選ばせる opBinding ルールをsystemプロンプトへ含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    await role.propose({ toolPlan, profile });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    // 条件は opBinding で「比較の仕方そのもの」をエージェント引数に委ねられる。
    expect(system).toContain('"opBinding": { "source": "agent-input", "field": "<argument name>", "allowed": [ <operator strings> ] }');
    // 演算子引数は string 型で宣言し、非nullableならsampleはallowed内の演算子文字列。
    expect(system).toMatch(/consumed by an opBinding MUST be declared with "type": "string"/);
    expect(system).toMatch(/its "sample" value MUST be one of the operator strings in "allowed"/);
    // 設計時の op は allowed に含め、nullable引数が省略されたときの既定演算子になる。
    expect(system).toMatch(/design-time "op" MUST be listed in "allowed"/);
    expect(system).toMatch(/default operator applied when a nullable operator argument is omitted/);
    // allowed の語彙と順序演算子サブセットは domain の正準リスト（FILTER_OPS / ORDER_OPS）から導出される。
    // リテラルの逐語一致ではなく導出式との一致をピン留めし、演算子追加時にプロンプトが自動追随することを保証する。
    expect(system).toContain(`"allowed" may only contain ${FILTER_OPS.map((op) => `'${op}'`).join(', ')}.`);
    expect(system).toContain(`Include ${[...ORDER_OPS].map((op) => `'${op}'`).join('/')} only when the condition's "column" is a number or date column`);
    // 演算子引数は opBinding が消費する（valueBinding不要）。値と演算子は別引数。
    expect(system).toMatch(/consumed by its opBinding alone; it needs no valueBinding/);
    expect(system).toMatch(/two separate arguments \(two schema columns\)/);
    // nullable時の既定演算子は agentTool.description へ明記する（既存のnullableルールと整合）。
    expect(system).toMatch(/agentTool\.description must state the default operator used when they are omitted/);
  });

  it('save-toolの保存検証と対になるopBinding追加ルール4種をsystemプロンプトへ含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    await role.propose({ toolPlan, profile });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    // 同一引数を valueBinding と opBinding の両方にバインドしない（値引数と演算子引数は別々に宣言）。
    expect(system).toMatch(/Never bind the same argument to both a valueBinding and an opBinding/);
    // allowed に isNull/notNull を含めるなら、同じ条件の値引数は nullable で宣言する（語彙は VALUELESS_OPS から導出）。
    expect(system).toContain(`When "allowed" includes ${[...VALUELESS_OPS].map((op) => `'${op}'`).join('/')}, the value argument bound by that condition's valueBinding MUST be declared with "nullable": true`);
    // 同一の演算子引数を複数条件で使う場合、設計時 op（既定演算子）は全条件で同一。
    expect(system).toMatch(/their design-time "op" MUST be identical across those conditions/);
    // contains を allowed に含めるのは対象列が string のときだけ。
    expect(system).toMatch(/Include 'contains' in "allowed" only when the condition's "column" is a string column/);
  });

  it('agent-input付きの提案（引数宣言つきグラフ）をそのままパースする', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: argumentProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    const proposal = await role.propose({ toolPlan, profile });

    const args = proposal.graph.nodes.find((node) => node.type === 'agent-input');
    expect(args?.config).toEqual({ schema: { columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] }, sample: { minimumAmount: 100 } });
    expect(proposal.graph.edges.some((edge) => edge.from === 'args' || edge.to === 'args')).toBe(false);
    const filter = proposal.graph.nodes.find((node) => node.id === 'filter')?.config as { conditions: { valueBinding?: unknown }[] };
    expect(filter.conditions[0]?.valueBinding).toEqual({ source: 'agent-input', field: 'minimumAmount' });
  });

  it('priorErrorが渡された場合はuser messageへ検証エラーとして含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());

    await role.propose({ toolPlan, profile, priorError: 'graph validation failed: out: column not found' });

    const userMessage = model.requests[0]?.messages.find((message) => message.role === 'user');
    expect(String(userMessage?.content)).toContain('priorValidationError');
    expect(String(userMessage?.content)).toContain('column not found');
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());
    await expect(role.propose({ toolPlan, profile })).rejects.toThrow(/invalid JSON/);
  });

  it('graph/agentToolを欠く応答はFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ graph: { nodes: [], edges: [] } }) }, finishReason: 'stop' });
    const role = new ToolSmithRole(model, bundledPrompts());
    await expect(role.propose({ toolPlan, profile })).rejects.toThrow(/agentTool/);
  });

  it('形の壊れた応答（非object / graph欠落 / nodes非配列 / agentTool型違い）を個別に弾く', async () => {
    const cases: readonly (readonly [string, RegExp])[] = [
      ['[]', /not a JSON object/],
      [JSON.stringify({ agentTool: { name: 'a', description: 'b' } }), /missing graph/],
      [JSON.stringify({ graph: { nodes: {}, edges: [] }, agentTool: { name: 'a', description: 'b' } }), /nodes\/edges arrays/],
      [JSON.stringify({ graph: { nodes: [], edges: [] }, agentTool: { name: 'a' } }), /string name\/description/],
    ];
    for (const [content, expected] of cases) {
      const model = new ScriptedModelProvider();
      model.enqueue({ message: { role: 'assistant', content }, finishReason: 'stop' });
      await expect(new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan, profile })).rejects.toThrow(expected);
    }
  });

  it('structured-output capabilityがないモデルは利用不可', async () => {
    const capabilities: readonly ModelCapability[] = ['chat'];
    const model: ModelProviderPort = {
      capabilities: () => capabilities,
      complete: (_request: ModelCompletionRequest, _signal?: AbortSignal): Promise<ModelCompletion> => {
        throw new Error('should not be called');
      },
    };
    const role = new ToolSmithRole(model, bundledPrompts());
    expect(role.available()).toBe(false);
    await expect(role.propose({ toolPlan, profile })).rejects.toThrow(/does not support structured output/);
  });
});

// ─── ADR-0047: 期間・行数・値の列挙をToolSmithへ伝える ────────────────────────────────
describe('ToolSmithRole（期間列・出力の上限・引数の値域）', () => {
  /** e-Stat 実データに似せたプロファイル（粒度混在の期間列 + 列挙できる地域列 + 大量行）。 */
  const estatProfile: DataProfile = {
    dataSourceId: 'ds-estat', name: 'Unemployment', kind: 'file', format: 'csv',
    columns: [
      { name: '時点', type: 'string', nullable: false },
      { name: '地域', type: 'string', nullable: false },
      { name: '完全失業者（男女計）【万人】', type: 'number', nullable: true },
      { name: '注記', type: 'string', nullable: true },
    ],
    sampleRowCount: 2, sampleRows: [{ 時点: '1975年10月', 地域: '全国' }, { 時点: '2024年', 地域: '北海道' }],
    rowCount: 1191,
    periodColumns: [{ column: '時点', granularities: { month: 600, quarter: 200, year: 300, 'fiscal-year': 91 }, minStart: '1975-01-01', maxStart: '2024-04-01', mixed: true }],
    categoricalColumns: [{ column: '地域', distinctCount: 3, values: ['全国', '北海道', '青森県'] }],
    joinCandidates: [],
  };

  function systemPromptFor(profile: DataProfile): Promise<string> {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    return new ToolSmithRole(model, bundledPrompts())
      .propose({ toolPlan, profile })
      .then(() => String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content));
  }

  it('正常: 許可する変換ノードに parse-period と limit が入り、それぞれのconfig契約をカタログとして示す', async () => {
    const system = await systemPromptFor(estatProfile);

    expect(SAFE_TRANSFORM_TYPES).toContain('parse-period');
    expect(SAFE_TRANSFORM_TYPES).toContain('limit');
    expect(system).toContain('Node catalog (config contract of every transform node you may use):');
    expect(system).toContain('"count": <1..10000>');
    expect(system).toContain('"startColumn": "periodStart"');
    expect(system).toContain('"granularityColumn": "periodGranularity"');
    expect(system).toContain('"fiscalYearStartMonth": 4');
    expect(system).toContain('"keys": [{ "column": "<column>", "direction": "asc" | "desc"');
    // 粒度の語彙は domain の正準リストから導出する（プロンプト側でリテラルを複製しない）。
    for (const granularity of PERIOD_GRANULARITIES) expect(system).toContain(`'${granularity}'`);
  });

  it('正常: 期間の定石（parse-period → 粒度で絞る → 開始日で範囲指定 → 並べ替え）をプロンプトへ含める', async () => {
    const system = await systemPromptFor(estatProfile);

    expect(system).toMatch(/source → parse-period → filter \(periodGranularity eq/);
    expect(system).toMatch(/MUST also filter "periodGranularity"/);
    expect(system).toMatch(/"type": "date" and bound with valueBinding to the gte \/ lte conditions/);
  });

  it('正常: 既定呼び出しで溢れないよう出力を縛る規則と、説明文へ書くべき内容を指示する', async () => {
    const system = await systemPromptFor(estatProfile);

    expect(system).toMatch(/the tool MUST stay useful when the agent sends NO arguments at all/);
    expect(system).toMatch(/append a 'limit'|end the chain with a 'limit'/);
    expect(system).toContain('agentTool.description (what the agent reads before calling):');
    expect(system).toMatch(/List the valid values when the data has few of them/);
  });

  it('正常: プロファイルの期間列・値の列挙・総行数はuntrusted data側でモデルへ渡す', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });

    await new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan, profile: estatProfile });

    const user = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(user).toContain('<untrusted-data');
    expect(user).toContain('"rowCount":1191');
    expect(user).toContain('"mixed":true');
    expect(user).toContain('青森県');
  });

  it('境界: 期間列も列挙できる列も無いプロファイルでは、空配列として渡す（キーを落とさない）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });

    await new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan, profile });

    const user = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(user).toContain('"periodColumns":[]');
    expect(user).toContain('"categoricalColumns":[]');
  });
});

// ─── ADR-0047 round 2: 証拠列・範囲・1回で複数カテゴリ を ToolSmith へ教える ─────────────
describe('ToolSmithRole（証拠列の保全・範囲・カテゴリ引数）', () => {
  async function systemPrompt(): Promise<string> {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    await new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan, profile });
    return String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
  }

  it('正常: 期間ラベル列・値の列・注記列を落とさない規則を含む（注記はプロンプト規則）', async () => {
    const system = await systemPrompt();

    expect(system).toMatch(/MUST still contain that ORIGINAL label column/);
    expect(system).toMatch(/'periodStart' does not replace it/);
    expect(system).toMatch(/keep a note\/remark column \(注記, remarks, 備考\)/);
    expect(system).toMatch(/A 'select' is only worth adding when the source has many irrelevant columns/);
  });

  it('正常: 範囲は2つのnullable引数・date列はdate型・開始日で降順、をプロンプトで指示する', async () => {
    const system = await systemPrompt();

    expect(system).toMatch(/A date range needs TWO nullable arguments/);
    expect(system).toMatch(/NEVER bind the same argument to both a lower bound \(gt\/gte\) and an upper bound \(lt\/lte\)/);
    expect(system).toMatch(/MUST be declared "type": "date" \(not "string"\)/);
    expect(system).toMatch(/Dates always mean the START of the period/);
    expect(system).toMatch(/"direction": "desc"/);
  });

  it('正常: カテゴリ引数は in 演算子で複数値を受け、1回で複数カテゴリを返す設計を呼び出し上限つきで指示する', async () => {
    const system = await systemPrompt();

    expect(system).toContain(`the conversation has a budget of ${MAX_TOOL_CALLS} tool calls`);
    expect(system).toMatch(/MUST be bound with the 'in' operator, not 'eq'/);
    expect(system).toMatch(/COMMA-SEPARATED LIST/);
    expect(system).toMatch(/Never design a tool that accepts only one category value per call/);
    expect(system).toMatch(/never say "one region at a time" in the description/);
  });

  it('正常: 説明文には粒度・日付の意味・データが覆う範囲・省略時の挙動を書かせる', async () => {
    const system = await systemPrompt();

    expect(system).toMatch(/State which granularity the rows come back as/);
    expect(system).toMatch(/State the range the data actually covers \(dataSource.periodColumns gives minStart \/ maxStart\)/);
    expect(system).toMatch(/especially: omitting the category returns every category/);
  });
});

// ─── ADR-0047 round 3: 結合ノードのカタログ・複数ソースの型・複数値カテゴリ引数 ─────────────
describe('ToolSmithRole（複数データソースの結合）', () => {
  const hoursProfile: DataProfile = {
    dataSourceId: 'ds-hours', name: 'Hours', kind: 'file', format: 'csv',
    columns: [{ name: '時点', type: 'string', nullable: false }, { name: '地域コード', type: 'string', nullable: false }, { name: '総実労働時間【時間】', type: 'number', nullable: true }],
    sampleRowCount: 1, sampleRows: [{ 時点: '2023年', 地域コード: '13000' }], rowCount: 96,
    periodColumns: [], categoricalColumns: [], joinCandidates: [],
  };
  const wageProfile: DataProfile = {
    dataSourceId: 'ds-wage', name: 'Wage', kind: 'file', format: 'csv',
    columns: [{ name: '時点', type: 'string', nullable: false }, { name: '地域コード', type: 'string', nullable: false }, { name: '現金給与総額【円】', type: 'number', nullable: true }],
    sampleRowCount: 1, sampleRows: [{ 時点: '2023年', 地域コード: '13000' }], rowCount: 96,
    periodColumns: [], categoricalColumns: [],
    joinCandidates: [
      { leftDataSourceId: 'ds-wage', rightDataSourceId: 'ds-hours', keys: ['時点', '地域コード'], overlap: { 時点: 1, 地域コード: 1 }, uniqueLeft: true, uniqueRight: true },
      // このToolが束ねないソースの候補は渡してはならない（別の表を読みに行かせない）。
      { leftDataSourceId: 'ds-wage', rightDataSourceId: 'ds-other', keys: ['時点'], overlap: { 時点: 1 }, uniqueLeft: false, uniqueRight: false },
    ],
  };
  const joinPlan: FactoryToolPlan = {
    key: 'joined', displayName: 'Wage and hours', purpose: '同じ時点・同じ地域の賃金と労働時間を並べる。',
    dataSourceId: 'ds-wage', sideEffect: 'read-only', additionalDataSourceIds: ['ds-hours'],
  };

  async function joinedRequest(): Promise<{ system: string; user: string }> {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    await new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan: joinPlan, profile: wageProfile, additionalProfiles: [hoursProfile] });
    return {
      system: String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content),
      user: String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content),
    };
  }

  it('正常: join を許可ノード語彙へ入れ、config契約（keys / mode / toInput）をカタログに書く', async () => {
    const { system } = await joinedRequest();

    expect(SAFE_TRANSFORM_TYPES).toContain('join');
    expect(SAFE_TRANSFORM_TYPES).toContain('rename');
    expect(system).toMatch(/the ONLY node that takes TWO inputs/);
    expect(system).toMatch(/"toInput": 0 \(left\) and "toInput": 1 \(right\)/);
    expect(system).toMatch(/"mode": "inner" \| "left" \| "right" \| "full"/);
    expect(system).toMatch(/"rightSuffix"/);
    expect(system).toMatch(/- rename: \{ "renames": \[\{ "from"/);
  });

  it('正常: 結合するToolには全ソース分のsourceノードを要求し、木の形と結合の規律を教える', async () => {
    const { system } = await joinedRequest();

    expect(system).toMatch(/This is a JOINED tool. The graph MUST contain exactly 2 source nodes/);
    expect(system).toContain('"dataSourceId": "ds-wage"');
    expect(system).toContain('"dataSourceId": "ds-hours"');
    expect(system).toMatch(/The graph is a TREE, not a single chain/);
    expect(system).toMatch(/Join on ALL the key columns the sources share/);
    expect(system).toMatch(/Use "mode": "inner" unless/);
    expect(system).toMatch(/Do the select \/ rename BEFORE the join/);
    expect(system).toMatch(/Put the argument filters AFTER the last join/);
  });

  it('正常: 追加ソースのプロファイルと、このToolに関係する結合候補だけをuntrusted data側で渡す', async () => {
    const { user } = await joinedRequest();

    expect(user).toContain('"additionalDataSources"');
    expect(user).toContain('総実労働時間【時間】');
    expect(user).toContain('"joinCandidates"');
    expect(user).toContain('地域コード');
    // 束ねないソース（ds-other）の候補は落とす。
    expect(user).not.toContain('ds-other');
  });

  it('境界(回帰固定): 単一ソースのToolには、従来どおり結合の規律を出さない', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });

    await new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan, profile });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    const user = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(system).toMatch(/MUST contain exactly one source node/);
    expect(system).not.toMatch(/The graph is a TREE/);
    expect(user).not.toContain('"additionalDataSources"');
  });

  it('正常: カテゴリ引数の言い回しは、この配線の filter が複数値演算子を持つかで決まる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });

    await new ToolSmithRole(model, bundledPrompts()).propose({ toolPlan, profile });

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    if (supportsMultiValueFilterOps()) {
      // `in` を持つビルド: カンマ区切りの一覧で複数カテゴリを1回で頼ませる。
      expect(system).toMatch(/MUST be bound with the 'in' operator, not 'eq'/);
      expect(system).toMatch(/COMMA-SEPARATED LIST/);
      expect(system).toMatch(/Never use 'in' \/ 'notIn' inside an opBinding/);
    } else {
      // まだ持たないビルド: エンジンが受け付けない演算子を書かせず、round 2 の「省略して全件」に留める。
      expect(system).toMatch(/MUST stay nullable, and omitting it MUST return every category/);
      expect(system).not.toMatch(/'in' operator/);
    }
  });
});

// ---------------------------------------------------------------------------
// 移行の証明（v48 / ADR-0052）: 文を `prompts/factory/tool-smith.md` へ移す**前に**
// 組み立てた system 文を `__fixtures__/*.txt` へ固定してある。一字一句一致する限り等価変換である。
// ---------------------------------------------------------------------------

/** 移行前に固定した文。 */
function promptFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.txt`, import.meta.url)), 'utf8');
}

function fixtureProfile(id: string, name: string, format: 'csv' | 'json'): DataProfile {
  return {
    dataSourceId: id, name, kind: 'file', format,
    columns: [{ name: '時点', type: 'string', nullable: false }, { name: '値', type: 'number', nullable: false }],
    sampleRowCount: 1, sampleRows: [{ 時点: '2024年', 値: 1 }], rowCount: 1,
    periodColumns: [], categoricalColumns: [], joinCandidates: [],
  };
}

const fixtureToolPlan: FactoryToolPlan = { key: 'lookup', displayName: '賃金推移', purpose: '賃金を調べる', dataSourceId: 'ds-1', sideEffect: 'read-only' };

async function systemOf(input: Parameters<ToolSmithRole['propose']>[0]): Promise<string> {
  const model = new ScriptedModelProvider();
  model.enqueue({ message: { role: 'assistant', content: '{}' }, finishReason: 'stop' });
  await new ToolSmithRole(model, bundledPrompts()).propose(input).catch(() => undefined);
  return String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
}

describe('ToolSmithRole の system 文', () => {
  it('従来どおり: 単一の csv ソースでは、移行前と一字一句同じ system 文になる', async () => {
    expect(await systemOf({ toolPlan: fixtureToolPlan, profile: fixtureProfile('ds-1', 'Wage', 'csv') }))
      .toBe(promptFixture('tool-smith.single-csv'));
  });

  it('従来どおり: json ソースでは source ノード種別の 1 行だけが差し替わる', async () => {
    expect(await systemOf({ toolPlan: fixtureToolPlan, profile: fixtureProfile('ds-1', 'Wage', 'json') }))
      .toBe(promptFixture('tool-smith.single-json'));
  });

  it('従来どおり: 2 ソースの結合では結合の規則が足され、完成例は出ない', async () => {
    expect(await systemOf({
      toolPlan: fixtureToolPlan,
      profile: fixtureProfile('ds-1', 'Wage', 'csv'),
      additionalProfiles: [fixtureProfile('ds-2', 'Hours', 'json')],
    })).toBe(promptFixture('tool-smith.join-two'));
  });

  it('従来どおり: 3 ソースの結合では 3 ソースの完成例まで含めて移行前と同じ', async () => {
    expect(await systemOf({
      toolPlan: fixtureToolPlan,
      profile: fixtureProfile('ds-1', 'Wage', 'csv'),
      additionalProfiles: [fixtureProfile('ds-2', 'Hours', 'json'), fixtureProfile('ds-3', 'Jobs', 'csv')],
    })).toBe(promptFixture('tool-smith.join-three'));
  });

  it('従来どおり: 複数値演算子を持たないビルド向けの節も、移行前の文のまま残っている', () => {
    // このビルドでは `supportsMultiValueFilterOps()` が true なので propose からは出ない節。
    // 文が消えていないこと（死んだ文ではなく、`in` の無いビルドで使われる節であること）をここで固定する。
    expect(bundledPrompts().get(TOOL_SMITH_PROMPT.id).render('rules.category.omit'))
      .toBe(promptFixture('tool-smith.category-omit'));
  });
});
