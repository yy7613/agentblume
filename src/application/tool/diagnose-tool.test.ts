/**
 * DiagnoseToolUseCase のテスト。
 *
 * 実 EtlEngine で、メモリ上の（未保存でもよい）Tool に対し、実行時に失敗する構成が
 * 「実行せずに」対応する検査項目のエラーとして報告されることを検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type CreateToolProps, type Tool } from '../../domain/tool/tool';
import { ConfigError, SchemaError } from '../../domain/etl/errors';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine, type PropagationResult } from '../etl/engine';
import { DiagnoseToolUseCase, nodeIdOf, worst, type DiagnosticCheck, type ToolDiagnostics } from './diagnose-tool';
import type { ResolveAiJudgmentsUseCase } from './resolve-ai-judgments';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const inputSchema: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };

function makeTool(overrides?: Partial<CreateToolProps> & { readonly state?: PublishState; readonly publishName?: string }): Tool {
  const { state, publishName, ...rest } = overrides ?? {};
  return createTool({
    // 未保存 draft と同じ 0.0.0 で組む: 診断は保存済みであることを要求しない。
    metadata: { internalId: 'score-tool', workingName: 'w', displayName: 'Score', publishName: publishName ?? 'score_lookup', version: SemVer.of(0, 0, 0), owner: 'owner', state: state ?? 'draft', tenant: scope },
    sideEffect: 'read-only',
    graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } },
      { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } } },
      { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { minimumScore: 0 } } },
    ], edges: [{ from: 'data', to: 'filter' }] },
    inputSchema,
    ...rest,
  });
}

function check(diagnostics: ToolDiagnostics, id: string): DiagnosticCheck | undefined {
  return diagnostics.checks.find((candidate) => candidate.id === id);
}

function diagnose(tool: Tool, options?: { readonly engine?: EtlEngine; readonly resolveDataSources?: ResolveDataSourceGraphUseCase }): Promise<ToolDiagnostics> {
  const usecase = new DiagnoseToolUseCase(options?.engine ?? new EtlEngine(createDefaultRegistry()), options?.resolveDataSources);
  return usecase.execute(scope, tool);
}

/** ドライラン（preview）だけを差し替え、ノード実行エラーの伝わり方を検証するためのエンジン。 */
class FailingPreviewEngine extends EtlEngine {
  constructor(private readonly failure: unknown) { super(createDefaultRegistry()); }
  override preview(): never { throw this.failure; }
}

describe('DiagnoseToolUseCase', () => {
  it('健全な未保存 Tool は全項目 ok で、function 名と版（0.0.0）を報告する', async () => {
    const diagnostics = await diagnose(makeTool());
    expect(diagnostics).toMatchObject({ internalId: 'score-tool', version: '0.0.0', source: 'direct', functionName: 'score_lookup', status: 'ok' });
    expect(diagnostics.checks.map((item) => item.id)).toEqual(['state', 'function-definition', 'agent-input', 'data-sources', 'graph', 'execution']);
    expect(diagnostics.checks.every((item) => item.status === 'ok')).toBe(true);
    // 参照解決（resolved）は Agent 診断だけが出す。read-only・outputSchema 無し・opBinding 無しなら該当項目も出ない。
    for (const id of ['resolved', 'side-effect', 'output-schema', 'operator-arguments']) expect(check(diagnostics, id)).toBeUndefined();
  });

  it('公開状態を state 検査として報告する（archived は error、deprecated は warning）', async () => {
    const archived = await diagnose(makeTool({ state: 'archived' }));
    expect(check(archived, 'state')).toEqual({ id: 'state', status: 'error', detail: 'tool is archived, so it should not be attached to an agent' });
    expect(archived.status).toBe('error');

    const deprecated = await diagnose(makeTool({ state: 'deprecated' }));
    expect(check(deprecated, 'state')).toEqual({ id: 'state', status: 'warning', detail: 'tool is deprecated and may be archived later' });
    expect(deprecated.status).toBe('warning');

    for (const state of ['draft', 'in-review', 'published'] as const) {
      expect(check(await diagnose(makeTool({ state })), 'state')).toEqual({ id: 'state', status: 'ok' });
    }
  });

  it('function 名として公開できない名前は function-definition のエラーになり、functionName を持たない', async () => {
    const diagnostics = await diagnose(makeTool({ publishName: 'bad name' }));
    expect(check(diagnostics, 'function-definition')).toMatchObject({ status: 'error', detail: 'tool name is not a valid function name: bad name' });
    expect(diagnostics.functionName).toBeUndefined();
    expect(diagnostics.status).toBe('error');
  });

  it('inputSchema と agent-input ノードの不整合を実行時と同じメッセージで報告する', async () => {
    const drifted = await diagnose(makeTool({ inputSchema: { columns: [{ name: 'other', type: 'string', nullable: false }] } }));
    expect(check(drifted, 'agent-input')).toMatchObject({ status: 'error', detail: "tool inputSchema does not match agent-input node 'arguments'" });

    const missingNode = await diagnose(makeTool({ graph: { nodes: [{ id: 'data', type: 'json-source', config: { rows: [{ score: 1 }] } }], edges: [] } }));
    expect(check(missingNode, 'agent-input')).toMatchObject({ status: 'error', detail: 'tool declares inputSchema but has no agent-input node' });
  });

  it('グラフのスキーマエラーは graph 検査として報告し、nodeId は根本原因（最初のエラーノード）を指す', async () => {
    const unknownColumn = await diagnose(makeTool({ graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice' }] } },
      { id: 'sel', type: 'select', config: { columns: ['missing'] } },
    ], edges: [{ from: 'data', to: 'sel' }] }, inputSchema: undefined }));
    expect(check(unknownColumn, 'graph')).toMatchObject({ status: 'error', nodeId: 'sel' });
    expect(check(unknownColumn, 'graph')?.detail).toContain('missing');
    // 伝播できなかったグラフはドライランも出力整合も検査しない。
    expect(check(unknownColumn, 'execution')).toBeUndefined();

    // config 不正のノードの下流には派生 issue（upstream node has invalid config）が付くが、nodeId は根本原因側。
    const invalidConfig = await diagnose(makeTool({ graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ score: 1 }] } },
      { id: 'filter', type: 'filter', config: { column: 'score', op: 'bogus', value: 0 } },
      { id: 'sel', type: 'select', config: { columns: ['score'] } },
    ], edges: [{ from: 'data', to: 'filter' }, { from: 'filter', to: 'sel' }] }, inputSchema: undefined }));
    expect(check(invalidConfig, 'graph')).toMatchObject({ status: 'error', nodeId: 'filter' });
    expect(check(invalidConfig, 'graph')?.detail).toContain("upstream node 'filter' has invalid config");
  });

  it('構造違反（GraphError）は graph 検査のエラーになり、ノードを特定しない', async () => {
    const dangling = await diagnose(makeTool({ graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ score: 1 }] } },
    ], edges: [{ from: 'data', to: 'nowhere' }] }, inputSchema: undefined }));
    expect(check(dangling, 'graph')?.status).toBe('error');
    expect(check(dangling, 'graph')?.nodeId).toBeUndefined();
    expect(check(dangling, 'execution')).toBeUndefined();
  });

  it('ドライランのノード実行エラーは execution 検査になり、例外に nodeId が付いていれば引き継ぐ', async () => {
    const tagged = Object.assign(new Error('cannot compare number with string'), { nodeId: 'filter' });
    const located = await diagnose(makeTool(), { engine: new FailingPreviewEngine(tagged) });
    expect(check(located, 'execution')).toEqual({ id: 'execution', status: 'error', detail: 'cannot compare number with string', nodeId: 'filter' });
    expect(check(located, 'graph')?.status).toBe('ok');
    expect(located.status).toBe('error');

    // nodeId の無い例外（または文字列でない nodeId）はノードを特定しない。
    const untagged = await diagnose(makeTool(), { engine: new FailingPreviewEngine(new Error('boom')) });
    expect(check(untagged, 'execution')).toEqual({ id: 'execution', status: 'error', detail: 'boom' });
  });

  it('データソース解決の失敗を報告し、依存する後段の検査は行わない', async () => {
    const failing = { execute: async () => { throw new Error('data source is unavailable or not a file: ds-1'); } } as unknown as ResolveDataSourceGraphUseCase;
    const diagnostics = await diagnose(makeTool(), { resolveDataSources: failing });
    expect(check(diagnostics, 'data-sources')).toMatchObject({ status: 'error', detail: 'data source is unavailable or not a file: ds-1' });
    expect(check(diagnostics, 'graph')).toBeUndefined();
    expect(check(diagnostics, 'execution')).toBeUndefined();
  });

  it('宣言 outputSchema の不整合と非 read-only の副作用を報告する', async () => {
    const legacy = await diagnose(makeTool({ outputSchema: { columns: [{ name: 'only', type: 'string', nullable: false }] }, sideEffect: 'write' }));
    expect(check(legacy, 'output-schema')?.status).toBe('error');
    expect(check(legacy, 'output-schema')?.detail).toContain('column count mismatch: expected 1, received 2');
    expect(check(legacy, 'side-effect')).toMatchObject({ status: 'warning', detail: "side effect 'write' pauses the run for approval before this tool executes" });
    expect(legacy.status).toBe('error');
  });

  it('opBinding の引数が inputSchema に宣言されていなければ warning（実行時は不活性）', async () => {
    const graph: ToolGraph = { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } },
      { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input', field: 'undeclaredOp', allowed: ['gte', 'lte'] } } },
    ], edges: [{ from: 'data', to: 'filter' }] };
    const diagnostics = await diagnose(makeTool({ graph, inputSchema: undefined }));
    expect(check(diagnostics, 'operator-arguments')).toMatchObject({ status: 'warning' });
    expect(check(diagnostics, 'operator-arguments')?.detail).toContain('undeclaredOp');
    expect(diagnostics.status).toBe('warning');
  });
});

describe('nodeIdOf', () => {
  it('Error に文字列の nodeId が付いているときだけ返す', () => {
    expect(nodeIdOf(Object.assign(new Error('x'), { nodeId: 'filter' }))).toBe('filter');
    expect(nodeIdOf(Object.assign(new Error('x'), { nodeId: 42 }))).toBeUndefined();
    expect(nodeIdOf(Object.assign(new Error('x'), { nodeId: '' }))).toBeUndefined();
    expect(nodeIdOf(new Error('x'))).toBeUndefined();
    expect(nodeIdOf({ nodeId: 'filter' })).toBeUndefined();
    expect(nodeIdOf('filter')).toBeUndefined();
  });
});

describe('worst', () => {
  it('error > warning > ok で集約し、空なら ok', () => {
    expect(worst([])).toBe('ok');
    expect(worst(['ok', 'ok'])).toBe('ok');
    expect(worst(['ok', 'warning', 'ok'])).toBe('warning');
    expect(worst(['warning', 'error', 'ok'])).toBe('error');
  });
});

describe('DiagnoseToolUseCase 境界・異常系', () => {
  /** propagateSchemas だけを差し替え、伝播結果の形（終端欠落など）を制御するエンジン。preview は実エンジン。 */
  class StubPropagationEngine extends EtlEngine {
    constructor(private readonly result: PropagationResult) { super(createDefaultRegistry()); }
    override propagateSchemas(): PropagationResult { return this.result; }
  }
  const source = { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } };

  describe('graph', () => {
    it('複数ノードがエラーのとき nodeId はトポロジカル順で最初（上流）のノードを指し、detail も同じ順に並ぶ', async () => {
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [
        source,
        { id: 'first', type: 'select', config: { columns: ['x'] } },
        { id: 'second', type: 'select', config: { columns: ['y'] } },
      ], edges: [{ from: 'data', to: 'first' }, { from: 'first', to: 'second' }] }, inputSchema: undefined }));
      expect(check(diagnostics, 'graph')).toMatchObject({ status: 'error', nodeId: 'first' });
      expect(check(diagnostics, 'graph')?.detail).toMatch(/^first: .*; second: /);
    });

    it('整数風のノード id（"10" と "2"）でも JS のキー並べ替えに引きずられず、根本原因（上流）を nodeId にする', async () => {
      // Object.values は整数風キーを挿入順ではなく数値昇順で先に並べる（'2' → '10'）。
      // 伝播順は data → 10 → 2 なので根本原因は '10'。
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [
        source,
        { id: '10', type: 'select', config: { columns: ['x'] } },
        { id: '2', type: 'select', config: { columns: ['y'] } },
      ], edges: [{ from: 'data', to: '10' }, { from: '10', to: '2' }] }, inputSchema: undefined }));
      expect(check(diagnostics, 'graph')).toMatchObject({ status: 'error', nodeId: '10' });
      expect(check(diagnostics, 'graph')?.detail).toMatch(/^10: /);
    });

    it('warning しか無い伝播結果は graph ok で、ドライランへ進む', async () => {
      // agent-input の未宣言 sample フィールドは warning issue（hasErrors は false のまま）。
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [
        source,
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } } },
        { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { minimumScore: 0, extra: 1 } } },
      ], edges: [{ from: 'data', to: 'filter' }] } }));
      expect(check(diagnostics, 'graph')).toEqual({ id: 'graph', status: 'ok' });
      expect(check(diagnostics, 'execution')).toEqual({ id: 'execution', status: 'ok' });
      expect(diagnostics.status).toBe('ok');
    });
  });

  describe('execution', () => {
    it('EtlError に nodeId が付いていれば引き継ぎ、無ければ・Error 以外なら detail だけを報告する', async () => {
      const located = new SchemaError('cannot compare number with string');
      located.nodeId = 'filter';
      expect(check(await diagnose(makeTool(), { engine: new FailingPreviewEngine(located) }), 'execution'))
        .toEqual({ id: 'execution', status: 'error', detail: 'cannot compare number with string', nodeId: 'filter' });
      expect(check(await diagnose(makeTool(), { engine: new FailingPreviewEngine(new SchemaError('untagged')) }), 'execution'))
        .toEqual({ id: 'execution', status: 'error', detail: 'untagged' });
      // Error 以外（文字列）を投げる実装でも落ちず、String 化して報告する。
      expect(check(await diagnose(makeTool(), { engine: new FailingPreviewEngine('boom') }), 'execution'))
        .toEqual({ id: 'execution', status: 'error', detail: 'boom' });
    });

    it('ドライランが失敗しても伝播結果は得られているので output-schema は検査する', async () => {
      const outputSchema: Schema = { columns: [{ name: 'name', type: 'string', nullable: false }, { name: 'score', type: 'number', nullable: false }] };
      const diagnostics = await diagnose(makeTool({ outputSchema }), { engine: new FailingPreviewEngine('boom') });
      expect(check(diagnostics, 'execution')?.status).toBe('error');
      expect(check(diagnostics, 'output-schema')).toEqual({ id: 'output-schema', status: 'ok' });
    });
  });

  describe('output-schema', () => {
    const inferred: Schema = { columns: [{ name: 'name', type: 'string', nullable: false }, { name: 'score', type: 'number', nullable: false }] };

    it('列順が違っても・宣言側だけ nullable でも整合とみなし、型違いは mismatch を報告する', async () => {
      const reordered = await diagnose(makeTool({ outputSchema: { columns: [...inferred.columns].reverse() } }));
      expect(check(reordered, 'output-schema')).toEqual({ id: 'output-schema', status: 'ok' });
      const looser = await diagnose(makeTool({ outputSchema: { columns: inferred.columns.map((column) => ({ ...column, nullable: true })) } }));
      expect(check(looser, 'output-schema')).toEqual({ id: 'output-schema', status: 'ok' });
      const typed = await diagnose(makeTool({ outputSchema: { columns: [{ name: 'name', type: 'string', nullable: false }, { name: 'score', type: 'string', nullable: false }] } }));
      expect(check(typed, 'output-schema')).toMatchObject({ status: 'error' });
      expect(check(typed, 'output-schema')?.detail).toContain("mismatch at 'score'");
    });

    it('outputSchema 未宣言なら項目を出さず、伝播結果に終端が無ければ検証不能として ok にする', async () => {
      expect(check(await diagnose(makeTool()), 'output-schema')).toBeUndefined();
      const engine = new StubPropagationEngine({
        order: ['data'], terminalId: 'missing', hasErrors: false,
        nodes: { data: { nodeId: 'data', schema: inferred, state: 'inferred', issues: [] } },
      });
      const diagnostics = await diagnose(makeTool({ outputSchema: { columns: [{ name: 'only', type: 'string', nullable: false }] } }), { engine });
      expect(check(diagnostics, 'graph')).toEqual({ id: 'graph', status: 'ok' });
      expect(check(diagnostics, 'output-schema')).toEqual({ id: 'output-schema', status: 'ok' });
    });
  });

  describe('data-sources', () => {
    it('resolver が Error 以外で reject しても文字列化して報告する', async () => {
      const failing = { execute: async () => { throw 'ds exploded'; } } as unknown as ResolveDataSourceGraphUseCase;
      const diagnostics = await diagnose(makeTool(), { resolveDataSources: failing });
      expect(check(diagnostics, 'data-sources')).toEqual({ id: 'data-sources', status: 'error', detail: 'ds exploded' });
      expect(diagnostics.status).toBe('error');
    });

    it('後段の graph / execution は Tool のグラフではなく resolver が返した解決済みグラフを検査する', async () => {
      const resolved: ToolGraph = { nodes: [source, { id: 'sel', type: 'select', config: { columns: ['missing'] } }], edges: [{ from: 'data', to: 'sel' }] };
      const resolver = { execute: async () => resolved } as unknown as ResolveDataSourceGraphUseCase;
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [source], edges: [] }, inputSchema: undefined }), { resolveDataSources: resolver });
      expect(check(diagnostics, 'data-sources')).toEqual({ id: 'data-sources', status: 'ok' });
      expect(check(diagnostics, 'graph')).toMatchObject({ status: 'error', nodeId: 'sel' });
    });
  });

  describe('operator-arguments', () => {
    const filterWith = (conditions: readonly unknown[]): ToolGraph => ({
      nodes: [source, { id: 'filter', type: 'filter', config: { conditions, combine: 'and' } }],
      edges: [{ from: 'data', to: 'filter' }],
    });
    const opBinding = (field: string, allowed: readonly string[] = ['gt', 'gte', 'lt', 'lte'], op = 'gte') =>
      ({ column: 'score', op, value: 0, opBinding: { source: 'agent-input', field, allowed } });

    it('filter ノードが無ければ項目自体を出さない', async () => {
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [source], edges: [] }, inputSchema: undefined }));
      expect(check(diagnostics, 'operator-arguments')).toBeUndefined();
    });

    it('宣言済みの string 引数へのバインドは ok', async () => {
      const declared: Schema = { columns: [{ name: 'scoreOp', type: 'string', nullable: false }] };
      const graph = filterWith([opBinding('scoreOp')]);
      const diagnostics = await diagnose(makeTool({
        graph: { ...graph, nodes: [...graph.nodes, { id: 'arguments', type: 'agent-input', config: { schema: declared, sample: { scoreOp: 'gte' } } }] },
        inputSchema: declared,
      }));
      expect(check(diagnostics, 'operator-arguments')).toEqual({ id: 'operator-arguments', status: 'ok' });
      expect(diagnostics.status).toBe('ok');
    });

    it('string でない引数へのバインドは error、未宣言は warning、両方あれば error に束ねて error を先に並べる', async () => {
      // makeTool の inputSchema は minimumScore:number。
      const diagnostics = await diagnose(makeTool({ graph: filterWith([opBinding('minimumScore'), opBinding('undeclaredOp')]) }));
      expect(check(diagnostics, 'operator-arguments')).toEqual({
        id: 'operator-arguments', status: 'error',
        detail: "operator argument 'minimumScore' must be declared as a string argument, but it is 'number'; operator argument 'undeclaredOp' is not declared in the input schema, so the binding is inactive at run time",
      });
      expect(diagnostics.status).toBe('error');
    });

    it('許可演算子の積集合が空・既定演算子の不一致は error', async () => {
      const declared: Schema = { columns: [{ name: 'op', type: 'string', nullable: false }] };
      const empty = await diagnose(makeTool({ graph: filterWith([opBinding('op', ['gt'], 'gt'), opBinding('op', ['lt'], 'lt')]), inputSchema: declared }));
      expect(check(empty, 'operator-arguments')).toMatchObject({ status: 'error' });
      expect(check(empty, 'operator-arguments')?.detail).toContain("operator argument 'op' has no operator that every condition allows");
      const mixed = await diagnose(makeTool({ graph: filterWith([opBinding('op', ['gt', 'lt'], 'gt'), opBinding('op', ['gt', 'lt'], 'lt')]), inputSchema: declared }));
      expect(check(mixed, 'operator-arguments')).toMatchObject({ status: 'error' });
      expect(check(mixed, 'operator-arguments')?.detail).toContain("operator argument 'op' has conflicting default operators across conditions");
    });
  });

  describe('agent-input', () => {
    it('inputSchema が空列で agent-input ノードも無ければ ok', async () => {
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [source], edges: [] }, inputSchema: { columns: [] } }));
      expect(check(diagnostics, 'agent-input')).toEqual({ id: 'agent-input', status: 'ok' });
    });

    it('config が null / schema を持たない agent-input ノードは TypeError にならず不一致 error になる', async () => {
      const nullConfig = await diagnose(makeTool({ graph: { nodes: [source, { id: 'broken', type: 'agent-input', config: null }], edges: [] } }));
      expect(check(nullConfig, 'agent-input')).toEqual({ id: 'agent-input', status: 'error', detail: "tool inputSchema does not match agent-input node 'broken'" });
      const bare = await diagnose(makeTool({ graph: { nodes: [source, { id: 'bare', type: 'agent-input', config: {} }], edges: [] } }));
      expect(check(bare, 'agent-input')).toEqual({ id: 'agent-input', status: 'error', detail: "tool inputSchema does not match agent-input node 'bare'" });
    });

    it('agent-input ノードが2つあり片方だけ不一致なら、そのノードを名指しする', async () => {
      const diagnostics = await diagnose(makeTool({ graph: { nodes: [
        source,
        { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { minimumScore: 0 } } },
        { id: 'stale', type: 'agent-input', config: { schema: { columns: [{ name: 'other', type: 'string', nullable: false }] }, sample: { other: 'x' } } },
      ], edges: [] } }));
      expect(check(diagnostics, 'agent-input')).toEqual({ id: 'agent-input', status: 'error', detail: "tool inputSchema does not match agent-input node 'stale'" });
    });
  });
});

describe('DiagnoseToolUseCase: AI 判定の解決', () => {
  function diagnoseWith(resolver: { execute: ReturnType<typeof vi.fn> }, tool: Tool = makeTool()): Promise<ToolDiagnostics> {
    const usecase = new DiagnoseToolUseCase(new EtlEngine(createDefaultRegistry()), undefined, resolver as unknown as ResolveAiJudgmentsUseCase);
    return usecase.execute(scope, tool);
  }

  it('ドライランの前に AI 判定を解く（解けたグラフで execution を検査する）', async () => {
    const resolver = { execute: vi.fn(async (graph: ToolGraph) => graph) };
    const diagnostics = await diagnoseWith(resolver);
    expect(resolver.execute).toHaveBeenCalledTimes(1);
    expect(check(diagnostics, 'execution')).toEqual({ id: 'execution', status: 'ok' });
  });

  it('解決器の ConfigError は execution 検査の error として nodeId つきで載る', async () => {
    const failure = Object.assign(new ConfigError('ai-judge: the model is not configured; set the main model slot in Settings > Models'), { nodeId: 'judge' });
    const diagnostics = await diagnoseWith({ execute: vi.fn(async () => { throw failure; }) });
    expect(check(diagnostics, 'execution')).toEqual({
      id: 'execution', status: 'error', nodeId: 'judge',
      detail: 'ai-judge: the model is not configured; set the main model slot in Settings > Models',
    });
    // グラフ（スキーマ伝播）の検査自体は通る: 壊れているのは実行であってスキーマではない。
    expect(check(diagnostics, 'graph')).toEqual({ id: 'graph', status: 'ok' });
    expect(diagnostics.status).toBe('error');
  });

  it('解決器が落ちても他の検査は続く（出力スキーマ・演算子引数まで報告する）', async () => {
    const diagnostics = await diagnoseWith({ execute: vi.fn(async () => { throw new ConfigError('ai-judge: 200 distinct rows to judge exceed the limit of 50'); }) });
    expect(check(diagnostics, 'execution')?.detail).toContain('exceed the limit of 50');
    expect(check(diagnostics, 'execution')?.nodeId).toBeUndefined();
    expect(check(diagnostics, 'agent-input')).toEqual({ id: 'agent-input', status: 'ok' });
    expect(check(diagnostics, 'function-definition')).toEqual({ id: 'function-definition', status: 'ok' });
  });

  it('スキーマ伝播が壊れていれば graph 検査で止まり、execution 検査は出さない', async () => {
    // 解決自体はグラフ検査より前に済ませる（checkGraph が同期のため）が、伝播エラーならドライランは検査しない。
    const resolver = { execute: vi.fn(async (graph: ToolGraph) => graph) };
    const broken = makeTool({ graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice' }] } },
      { id: 'filter', type: 'filter', config: { column: 'missing', op: 'eq', value: 1 } },
    ], edges: [{ from: 'data', to: 'filter' }] }, inputSchema: { columns: [] } });
    const diagnostics = await diagnoseWith(resolver, broken);
    expect(resolver.execute).toHaveBeenCalledTimes(1);
    expect(check(diagnostics, 'graph')).toMatchObject({ status: 'error', nodeId: 'filter' });
    expect(check(diagnostics, 'execution')).toBeUndefined();
  });
});
