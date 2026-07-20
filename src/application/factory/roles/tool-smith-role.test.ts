import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
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
