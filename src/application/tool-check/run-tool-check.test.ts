import { describe, expect, it } from 'vitest';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import type { Row, Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { ToolGraph } from '../../domain/etl/graph';
import { ToolNotFoundError } from '../../domain/tool/errors';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type Tool } from '../../domain/tool/tool';
import type { ToolCheckExpectations } from '../../domain/tool-check/tool-check-case';
import { EtlEngine } from '../etl/engine';
import { RunToolCheckUseCase, type RunToolCheckInput } from './run-tool-check';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const checkedAt = new Date('2026-09-12T09:00:00.000Z');

const searchSchema: Schema = { columns: [
  { name: 'region', type: 'string', nullable: false },
  { name: 'minimum', type: 'number', nullable: true },
] };

const salesRows: Row[] = [
  { region: 'Tokyo', amount: 120, soldAt: new Date('2026-01-05T00:00:00.000Z'), note: 'first' },
  { region: 'Tokyo', amount: 30, soldAt: new Date('2026-01-06T00:00:00.000Z'), note: null },
  { region: 'Osaka', amount: 80, soldAt: new Date('2026-01-07T00:00:00.000Z'), note: 'osaka' },
];

/** json-source → filter（region / minimum を Agent 引数へバインド）→ select の Tool。 */
function salesGraph(rows: Row[] = salesRows, extraNodes: ToolGraph['nodes'] = [], extraEdges: ToolGraph['edges'] = []): ToolGraph {
  return {
    nodes: [
      { id: 'data', type: 'json-source', config: { rows } },
      { id: 'filter', type: 'filter', config: { conditions: [
        { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'region' } },
        { column: 'amount', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimum' } },
      ], combine: 'and' } },
      { id: 'projection', type: 'select', config: { columns: ['region', 'amount', 'soldAt', 'note'] } },
      { id: 'arguments', type: 'agent-input', config: { schema: searchSchema, sample: { region: 'Osaka', minimum: 0 } } },
      ...extraNodes,
    ],
    edges: [{ from: 'data', to: 'filter' }, { from: 'filter', to: 'projection' }, ...extraEdges],
  };
}

function makeTool(overrides: { version?: string; graph?: ToolGraph; inputSchema?: Schema; sideEffect?: 'read-only' | 'write' } = {}): Tool {
  return createTool({
    metadata: { internalId: 'sales', workingName: 'sales', displayName: 'Sales', publishName: 'sales_search', version: SemVer.parse(overrides.version ?? '1.0.0'), owner: 'owner', state: 'draft', tenant: scope },
    sideEffect: overrides.sideEffect ?? 'read-only',
    graph: overrides.graph ?? salesGraph(),
    inputSchema: overrides.inputSchema ?? searchSchema,
  });
}

interface Harness { readonly useCase: RunToolCheckUseCase; readonly repo: InMemoryToolRepository }

async function harness(tools: readonly Tool[] = [makeTool()], clock?: { ticks?: number[] }): Promise<Harness> {
  const repo = new InMemoryToolRepository();
  for (const tool of tools) await repo.save(tool);
  const ticks = clock?.ticks;
  let index = 0;
  const monotonicNow = ticks === undefined ? undefined : () => ticks[Math.min(index++, ticks.length - 1)]!;
  const useCase = new RunToolCheckUseCase(repo, new EtlEngine(createDefaultRegistry()), undefined, { now: () => checkedAt, ...(monotonicNow === undefined ? {} : { monotonicNow }) });
  return { useCase, repo };
}

function input(overrides: Partial<RunToolCheckInput> = {}): RunToolCheckInput {
  return { scope, toolId: 'sales', arguments: { region: 'Tokyo', minimum: 0 }, ...overrides };
}

async function run(expectations: ToolCheckExpectations, overrides: Partial<RunToolCheckInput> = {}) {
  const { useCase } = await harness();
  return useCase.execute(input({ expectations, ...overrides }));
}

describe('RunToolCheckUseCase', () => {
  describe('正常: 実行と結果の形', () => {
    it('引数で絞った全行を出力し、ノード別行数・所要時間・checkedAt・Tool 参照を返す', async () => {
      const { useCase } = await harness();
      const result = await useCase.execute(input());
      expect(result.status).toBe('passed');
      expect(result.assertions).toEqual([]);
      expect(result.tool).toEqual({ internalId: 'sales', version: '1.0.0', publishName: 'sales_search' });
      expect(result.rowCount).toBe(2);
      expect(result.output.rows.map((row) => row['amount'])).toEqual([120, 30]);
      expect(result.output.schema.columns.map((column) => column.name)).toEqual(['region', 'amount', 'soldAt', 'note']);
      expect(result.nodes).toEqual(expect.arrayContaining([{ nodeId: 'data', rowCount: 3 }, { nodeId: 'filter', rowCount: 2 }, { nodeId: 'projection', rowCount: 2 }]));
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.checkedAt).toBe('2026-09-12T09:00:00.000Z');
      expect(result.error).toBeUndefined();
    });

    it('nullable 引数を省くと条件がスキップされる（Agent 経路と同じ束縛規則）', async () => {
      const { useCase } = await harness();
      const result = await useCase.execute(input({ arguments: { region: 'Osaka' } }));
      expect(result.rowCount).toBe(1);
      expect(result.output.rows[0]?.['region']).toBe('Osaka');
    });

    it('version 指定は固定版、省略は最新版を実行する', async () => {
      const { useCase } = await harness([makeTool({ version: '1.0.0' }), makeTool({ version: '2.0.0', graph: salesGraph([salesRows[0]!]) })]);
      expect((await useCase.execute(input())).tool.version).toBe('2.0.0');
      expect((await useCase.execute(input())).rowCount).toBe(1);
      const pinned = await useCase.execute(input({ version: SemVer.parse('1.0.0') }));
      expect(pinned.tool.version).toBe('1.0.0');
      expect(pinned.rowCount).toBe(2);
    });

    it('write の Tool（workspace-output 終端）も出力ディスパッチ無しで全行実行できる', async () => {
      const graph = salesGraph(salesRows, [{ id: 'sink', type: 'workspace-output', config: { name: 'sales-table', artifactKind: 'table', writeMode: 'create', onConflict: 'fail', previewRows: 10 } }], [{ from: 'projection', to: 'sink' }]);
      const { useCase } = await harness([makeTool({ graph, sideEffect: 'write' })]);
      const result = await useCase.execute(input({ expectations: { rowCount: { op: 'eq', value: 2 } } }));
      expect(result.status).toBe('passed');
      expect(result.nodes).toEqual(expect.arrayContaining([{ nodeId: 'sink', rowCount: 2 }]));
    });
  });

  describe('期待: rowCount', () => {
    it.each([
      ['eq 合格', { op: 'eq', value: 2 }, true, 'row count == 2'],
      ['eq 不合格', { op: 'eq', value: 3 }, false, 'row count == 3'],
      ['gte 境界（等しい）', { op: 'gte', value: 2 }, true, 'row count >= 2'],
      ['gte 不合格', { op: 'gte', value: 3 }, false, 'row count >= 3'],
      ['lte 境界（等しい）', { op: 'lte', value: 2 }, true, 'row count <= 2'],
      ['lte 不合格', { op: 'lte', value: 1 }, false, 'row count <= 1'],
    ] as const)('%s', async (_label, rowCount, passed, expected) => {
      const result = await run({ rowCount });
      expect(result.status).toBe(passed ? 'passed' : 'failed');
      expect(result.assertions).toEqual([{ kind: 'rowCount', passed, expected, actual: 'row count 2' }]);
    });

    it('rowCount 0 の期待は 0 行の出力で合格する（境界）', async () => {
      const result = await run({ rowCount: { op: 'eq', value: 0 } }, { arguments: { region: 'Nagoya', minimum: 0 } });
      expect(result.status).toBe('passed');
      expect(result.assertions[0]).toMatchObject({ passed: true, actual: 'row count 0' });
    });
  });

  describe('期待: columns', () => {
    it('存在する列は合格、無い列は不合格で、actual は出力の列名一覧', async () => {
      const result = await run({ columns: ['region', 'missing'] });
      expect(result.status).toBe('failed');
      expect(result.assertions).toEqual([
        { kind: 'column', passed: true, expected: "column 'region' exists", actual: 'columns: region, amount, soldAt, note' },
        { kind: 'column', passed: false, expected: "column 'missing' exists", actual: 'columns: region, amount, soldAt, note' },
      ]);
    });
  });

  describe('期待: cells', () => {
    it('any: 1行でも一致すれば合格、all: 全行一致が必要', async () => {
      const result = await run({ cells: [
        { column: 'amount', op: 'gte', value: 100, mode: 'any' },
        { column: 'amount', op: 'gte', value: 100, mode: 'all' },
      ] });
      expect(result.status).toBe('failed');
      expect(result.assertions).toEqual([
        { kind: 'cell', passed: true, expected: 'some row has amount >= 100', actual: '1 of 2 rows match' },
        { kind: 'cell', passed: false, expected: 'every row has amount >= 100', actual: '1 of 2 rows match' },
      ]);
    });

    it('文字列の eq / neq / contains は JSON 表現と部分一致で判定する', async () => {
      const result = await run({ cells: [
        { column: 'region', op: 'eq', value: 'Tokyo', mode: 'all' },
        { column: 'region', op: 'neq', value: 'Osaka', mode: 'all' },
        { column: 'region', op: 'contains', value: 'oky', mode: 'all' },
        { column: 'note', op: 'contains', value: 'irst', mode: 'any' },
      ] });
      expect(result.status).toBe('passed');
      expect(result.assertions.map((assertion) => assertion.expected)).toEqual([
        'every row has region == "Tokyo"', 'every row has region != "Osaka"', 'every row has region contains "oky"', 'some row has note contains "irst"',
      ]);
    });

    it('数値と文字列は eq で別物（型違いは不一致）', async () => {
      const result = await run({ cells: [{ column: 'amount', op: 'eq', value: '120', mode: 'any' }] });
      expect(result.assertions[0]).toMatchObject({ passed: false, actual: '0 of 2 rows match' });
    });

    it('null セルは eq null にだけ一致し、neq / contains / 不等号では一致しない', async () => {
      const result = await run({ cells: [
        { column: 'note', op: 'eq', value: null, mode: 'any' },
        { column: 'note', op: 'neq', value: 'x', mode: 'all' },
        { column: 'note', op: 'contains', value: '', mode: 'all' },
        { column: 'note', op: 'gte', value: 0, mode: 'any' },
      ] });
      expect(result.assertions.map((assertion) => [assertion.passed, assertion.actual])).toEqual([
        [true, '1 of 2 rows match'], [false, '1 of 2 rows match'], [false, '1 of 2 rows match'], [false, '0 of 2 rows match'],
      ]);
      expect(result.assertions[0]?.expected).toBe('some row has note == null');
    });

    it('Date セルは ISO 文字列へ寄せて比較する（eq / contains）', async () => {
      const result = await run({ cells: [
        { column: 'soldAt', op: 'eq', value: '2026-01-05T00:00:00.000Z', mode: 'any' },
        { column: 'soldAt', op: 'contains', value: '2026-01', mode: 'all' },
        { column: 'soldAt', op: 'gte', value: 0, mode: 'any' },
      ] });
      expect(result.assertions.map((assertion) => assertion.passed)).toEqual([true, true, false]);
    });

    it('gte / lte に数値でないセルは一致しない（境界: 等しい値は一致）', async () => {
      const result = await run({ cells: [
        { column: 'region', op: 'gte', value: 0, mode: 'any' },
        { column: 'amount', op: 'lte', value: 30, mode: 'any' },
        { column: 'amount', op: 'gte', value: 120, mode: 'any' },
        { column: 'amount', op: 'gte', value: 121, mode: 'any' },
      ] });
      expect(result.assertions.map((assertion) => assertion.passed)).toEqual([false, true, true, false]);
    });

    it('出力に無い列への期待は不合格で、actual が列の欠落を示す', async () => {
      const result = await run({ cells: [{ column: 'ghost', op: 'eq', value: 1, mode: 'any' }] });
      expect(result.status).toBe('failed');
      expect(result.assertions).toEqual([{ kind: 'cell', passed: false, expected: 'some row has ghost == 1', actual: "column 'ghost' not in output" }]);
    });

    it('0 行の出力では any は不合格、all は合格（空集合の全称）', async () => {
      const result = await run({ cells: [
        { column: 'amount', op: 'gte', value: 0, mode: 'any' },
        { column: 'amount', op: 'gte', value: 0, mode: 'all' },
      ] }, { arguments: { region: 'Nagoya', minimum: 0 } });
      expect(result.assertions.map((assertion) => [assertion.passed, assertion.actual])).toEqual([[false, '0 of 0 rows match'], [true, '0 of 0 rows match']]);
    });
  });

  describe('期待: duration', () => {
    it('計測した所要時間が上限以下なら合格、超えたら不合格（注入した時計で決定的に）', async () => {
      const slow = await harness([makeTool()], { ticks: [0, 1500] });
      const exceeded = await slow.useCase.execute(input({ expectations: { maxDurationMs: 1000 } }));
      expect(exceeded.status).toBe('failed');
      expect(exceeded.durationMs).toBe(1500);
      expect(exceeded.assertions).toEqual([{ kind: 'duration', passed: false, expected: 'duration <= 1000ms', actual: '1500ms' }]);

      const fast = await harness([makeTool()], { ticks: [0, 1000] });
      const within = await fast.useCase.execute(input({ expectations: { maxDurationMs: 1000 } }));
      expect(within.status).toBe('passed');
      expect(within.assertions[0]).toMatchObject({ passed: true, actual: '1000ms' });
    });
  });

  describe('境界: 表示スナップショットと全行', () => {
    const manyRows: Row[] = Array.from({ length: 500 }, (_, index) => ({ region: 'Tokyo', amount: index, soldAt: new Date(0), note: null }));

    it('500 行の出力: スナップショットは既定 100 行、rowCount と期待は全行で評価される', async () => {
      const { useCase } = await harness([makeTool({ graph: salesGraph(manyRows) })]);
      const result = await useCase.execute(input({ expectations: { rowCount: { op: 'eq', value: 500 }, cells: [{ column: 'amount', op: 'eq', value: 499, mode: 'any' }] } }));
      expect(result.output.rows).toHaveLength(100);
      expect(result.rowCount).toBe(500);
      expect(result.status).toBe('passed');
      expect(result.nodes).toEqual(expect.arrayContaining([{ nodeId: 'projection', rowCount: 500 }]));
    });

    it('rowLimit 0 はスナップショットを空にするが rowCount は全行のまま', async () => {
      const result = await run({ rowCount: { op: 'eq', value: 2 } }, { rowLimit: 0 });
      expect(result.output.rows).toEqual([]);
      expect(result.output.schema.columns).toHaveLength(4);
      expect(result.rowCount).toBe(2);
      expect(result.status).toBe('passed');
    });

    it('rowLimit 1 はスナップショットを 1 行に絞る', async () => {
      const result = await run({}, { rowLimit: 1 });
      expect(result.output.rows).toHaveLength(1);
      expect(result.rowCount).toBe(2);
    });
  });

  describe('期待: outcome（実行の結末）', () => {
    const outcomeError = { kind: 'outcome', passed: false, expected: 'outcome error', actual: 'outcome success' };

    it("正常: outcome 'success' を明示すると合格の結末 assertion が先頭に付き、他の期待も評価される", async () => {
      const result = await run({ outcome: 'success', rowCount: { op: 'eq', value: 2 } });
      expect(result.status).toBe('passed');
      expect(result.assertions).toEqual([
        { kind: 'outcome', passed: true, expected: 'outcome success', actual: 'outcome success' },
        { kind: 'rowCount', passed: true, expected: 'row count == 2', actual: 'row count 2' },
      ]);
    });

    it('境界: outcome 省略時は結末の assertion を出さない（従来の結果と同じ形）', async () => {
      const result = await run({ rowCount: { op: 'eq', value: 2 } });
      expect(result.assertions.map((assertion) => assertion.kind)).toEqual(['rowCount']);
      expect((await run({}, { arguments: {} })).assertions).toEqual([]);
    });

    it("正常: outcome 'error' を期待して実行が失敗すれば passed（error は表示用に残し、他の期待は評価しない）", async () => {
      const result = await run({ outcome: 'error', rowCount: { op: 'eq', value: 99 }, columns: ['nope'] }, { arguments: {} });
      expect(result.status).toBe('passed');
      expect(result.assertions).toEqual([{ kind: 'outcome', passed: true, expected: 'outcome error', actual: 'outcome error (TOOL_ARGUMENTS)' }]);
      expect(result.error).toEqual({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: region' });
      expect(result.output).toEqual({ schema: { columns: [] }, rows: [] });
    });

    it("異常: outcome 'error' を期待したのに成功すると failed で、残りの期待も評価して見せる", async () => {
      const result = await run({ outcome: 'error', rowCount: { op: 'eq', value: 2 }, columns: ['nope'] });
      expect(result.status).toBe('failed');
      expect(result.assertions).toEqual([
        outcomeError,
        { kind: 'rowCount', passed: true, expected: 'row count == 2', actual: 'row count 2' },
        { kind: 'column', passed: false, expected: "column 'nope' exists", actual: 'columns: region, amount, soldAt, note' },
      ]);
      expect(result.rowCount).toBe(2);
      expect(result.error).toBeUndefined();
    });

    it("異常: outcome 'success' を明示して実行が失敗すると status error のまま、不合格の結末 assertion を添える", async () => {
      const result = await run({ outcome: 'success', rowCount: { op: 'eq', value: 2 } }, { arguments: {} });
      expect(result.status).toBe('error');
      expect(result.assertions).toEqual([{ kind: 'outcome', passed: false, expected: 'outcome success', actual: 'outcome error (TOOL_ARGUMENTS)' }]);
      expect(result.error?.code).toBe('TOOL_ARGUMENTS');
    });

    it("境界: outcome 'error' はノード実行エラー（ETL_*）でも合格し、actual にそのコードを書く", async () => {
      const graph = salesGraph(salesRows, [{ id: 'broken', type: 'select', config: { columns: ['nope'] } }], [{ from: 'projection', to: 'broken' }]);
      const { useCase } = await harness([makeTool({ graph })]);
      const result = await useCase.execute(input({ expectations: { outcome: 'error' } }));
      expect(result.status).toBe('passed');
      expect(result.assertions[0]?.actual).toBe('outcome error (ETL_SCHEMA)');
      expect(result.error?.nodeId).toBe('broken');
    });
  });

  describe('異常: 実行の失敗は status error の結果になる（HTTP エラーにしない）', () => {
    it('必須引数の欠損は TOOL_ARGUMENTS', async () => {
      const result = await run({ rowCount: { op: 'eq', value: 1 } }, { arguments: {} });
      expect(result.status).toBe('error');
      expect(result.error).toEqual({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: region' });
      expect(result.assertions).toEqual([]);
      expect(result.output).toEqual({ schema: { columns: [] }, rows: [] });
      expect(result.rowCount).toBe(0);
      expect(result.nodes).toEqual([]);
      expect(result.checkedAt).toBe('2026-09-12T09:00:00.000Z');
    });

    it('型違い・未知の引数も TOOL_ARGUMENTS（受け取った値を描写する）', async () => {
      expect((await run({}, { arguments: { region: 42, minimum: 0 } })).error).toEqual({ code: 'TOOL_ARGUMENTS', message: "invalid argument 'region': expected string, received 42 (number)" });
      expect((await run({}, { arguments: { region: 'Tokyo', extra: 1 } })).error).toEqual({ code: 'TOOL_ARGUMENTS', message: 'unknown argument(s): extra' });
    });

    it('inputSchema と agent-input ノードの不整合は AGENT_RUN', async () => {
      const graph: ToolGraph = { nodes: [{ id: 'data', type: 'json-source', config: { rows: salesRows } }], edges: [] };
      const { useCase } = await harness([makeTool({ graph })]);
      const result = await useCase.execute(input());
      expect(result.status).toBe('error');
      expect(result.error).toEqual({ code: 'AGENT_RUN', message: 'tool declares inputSchema but has no agent-input node' });
    });

    it('ノードの実行エラーは ETL のコードと nodeId を持つ', async () => {
      const graph = salesGraph(salesRows, [{ id: 'broken', type: 'select', config: { columns: ['nope'] } }], [{ from: 'projection', to: 'broken' }]);
      const { useCase } = await harness([makeTool({ graph })]);
      const result = await useCase.execute(input());
      expect(result.status).toBe('error');
      expect(result.error).toMatchObject({ code: 'ETL_SCHEMA', nodeId: 'broken' });
      expect(result.error?.message).toContain('nope');
    });
  });

  describe('例外: 結果にできない失敗は投げる', () => {
    it('Tool が無ければ ToolNotFoundError（最新版・固定版どちらも）', async () => {
      const { useCase } = await harness([]);
      await expect(useCase.execute(input())).rejects.toThrow(new ToolNotFoundError('tool not found: sales'));
      await expect(useCase.execute(input({ version: SemVer.parse('9.9.9') }))).rejects.toThrow(new ToolNotFoundError('tool not found: sales@9.9.9'));
    });

    it('別スコープの Tool は見えない', async () => {
      const { useCase } = await harness();
      await expect(useCase.execute(input({ scope: { tenantId: 'other', workspaceId: 'workspace' } }))).rejects.toThrow(ToolNotFoundError);
    });

    it('想定外の例外（エンジンのクラッシュ）はそのまま伝播する', async () => {
      const repo = new InMemoryToolRepository();
      await repo.save(makeTool());
      const engine = { preview: () => { throw new TypeError('engine exploded'); } } as unknown as EtlEngine;
      const useCase = new RunToolCheckUseCase(repo, engine);
      await expect(useCase.execute(input())).rejects.toThrow(new TypeError('engine exploded'));
    });
  });
});
