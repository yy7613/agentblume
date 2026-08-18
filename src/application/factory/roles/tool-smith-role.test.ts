import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import { FILTER_OPS, ORDER_OPS, VALUELESS_OPS } from '../../../domain/etl/nodes/filter';
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import type { DataProfile } from '../profile-data-sources';
import { ToolSmithRole } from './tool-smith-role';

const toolPlan: FactoryToolPlan = { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' };
const profile: DataProfile = {
  dataSourceId: 'ds-1', name: 'Sales', kind: 'file', format: 'csv',
  columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'amount', type: 'number', nullable: false }],
  sampleRowCount: 2, sampleRows: [{ id: 1, amount: 100 }, { id: 2, amount: 200 }],
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
    const role = new ToolSmithRole(model);

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
    const role = new ToolSmithRole(model);

    await role.propose({ toolPlan, profile: { ...profile, format: 'json' } });

    const systemMessage = model.requests[0]?.messages.find((message) => message.role === 'system');
    expect(String(systemMessage?.content)).toContain('json-source');
  });

  it('検索条件をエージェント引数にするルールをsystemプロンプトへ含める', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new ToolSmithRole(model);

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
    const role = new ToolSmithRole(model);

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
    const role = new ToolSmithRole(model);

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
    const role = new ToolSmithRole(model);

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
    const role = new ToolSmithRole(model);

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
    const role = new ToolSmithRole(model);

    await role.propose({ toolPlan, profile, priorError: 'graph validation failed: out: column not found' });

    const userMessage = model.requests[0]?.messages.find((message) => message.role === 'user');
    expect(String(userMessage?.content)).toContain('priorValidationError');
    expect(String(userMessage?.content)).toContain('column not found');
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    const role = new ToolSmithRole(model);
    await expect(role.propose({ toolPlan, profile })).rejects.toThrow(/invalid JSON/);
  });

  it('graph/agentToolを欠く応答はFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ graph: { nodes: [], edges: [] } }) }, finishReason: 'stop' });
    const role = new ToolSmithRole(model);
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
      await expect(new ToolSmithRole(model).propose({ toolPlan, profile })).rejects.toThrow(expected);
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
    const role = new ToolSmithRole(model);
    expect(role.available()).toBe(false);
    await expect(role.propose({ toolPlan, profile })).rejects.toThrow(/does not support structured output/);
  });
});
