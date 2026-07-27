import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { EtlEngine } from '../etl/engine';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { SuggestAnalysisConfigUseCase } from './suggest-analysis-config';

const graph = { nodes: [
  { id: 'source', type: 'json-source', config: { rows: [{ x: 1, y: 2 }, { x: 2, y: 4 }] } },
  { id: 'analysis', type: 'correlation-analysis', config: { configVersion: 1, columns: ['x', 'y'], method: 'pearson', missing: 'pairwise', minPairs: 2, includeDiagonal: false } },
], edges: [{ from: 'source', to: 'analysis' }] };

describe('SuggestAnalysisConfigUseCase', () => {
  it('requires structured local model output, validates it, and never mutates the graph', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ nodeId: 'analysis', nodeType: 'correlation-analysis', config: { configVersion: 1, columns: ['x', 'y'], method: 'spearman', missing: 'pairwise', minPairs: 2, includeDiagonal: false }, rationale: ['Ranks handle monotonic data.'], warnings: [] }) }, finishReason: 'stop' });
    const usecase = new SuggestAnalysisConfigUseCase(new EtlEngine(createDefaultRegistry()), model, () => true);
    const proposal = await usecase.execute({ graph, nodeId: 'analysis', intent: 'rank correlation' });
    expect(proposal.config).toMatchObject({ method: 'spearman' });
    expect(graph.nodes[1]?.config).toMatchObject({ method: 'pearson' });
    expect(model.requests[0]?.responseFormat?.strict).toBe(true);
  });

  it('hides the capability when not configured and rejects invalid proposals', async () => {
    const model = new ScriptedModelProvider();
    const disabled = new SuggestAnalysisConfigUseCase(new EtlEngine(createDefaultRegistry()), model, () => false);
    expect(await disabled.available()).toBe(false);
    await expect(disabled.execute({ graph, nodeId: 'analysis', intent: 'correlation' })).rejects.toThrow(/not configured/);
  });

  it('モデル設定が後から入れば有効になる（起動時のenvで固定しない）', async () => {
    const model = new ScriptedModelProvider();
    let configured = false;
    const usecase = new SuggestAnalysisConfigUseCase(new EtlEngine(createDefaultRegistry()), model, async () => configured);
    expect(await usecase.available()).toBe(false);
    configured = true;
    expect(await usecase.available()).toBe(true);
  });

  it('rejects blank intents, malformed JSON, mismatched targets, and schema-invalid configurations', async () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const model = new ScriptedModelProvider();
    const usecase = new SuggestAnalysisConfigUseCase(engine, model, () => true);
    await expect(usecase.execute({ graph, nodeId: 'analysis', intent: '   ' })).rejects.toThrow(/requires an intent/);

    model.enqueue({ message: { role: 'assistant', content: '{invalid' }, finishReason: 'stop' });
    await expect(usecase.execute({ graph, nodeId: 'analysis', intent: 'correlation' })).rejects.toThrow(/invalid JSON/);

    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ nodeId: 'other', nodeType: 'correlation-analysis', config: {}, rationale: [], warnings: [] }) }, finishReason: 'stop' });
    await expect(usecase.execute({ graph, nodeId: 'analysis', intent: 'correlation' })).rejects.toThrow(/does not match/);

    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ nodeId: 'analysis', nodeType: 'correlation-analysis', config: { configVersion: 1, columns: ['missing'], method: 'pearson', missing: 'pairwise', minPairs: 2, includeDiagonal: false }, rationale: [], warnings: [] }) }, finishReason: 'stop' });
    await expect(usecase.execute({ graph, nodeId: 'analysis', intent: 'correlation' })).rejects.toThrow(/schema validation/);
  });
});
