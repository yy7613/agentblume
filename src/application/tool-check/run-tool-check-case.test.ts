import { describe, expect, it } from 'vitest';
import { InMemoryToolCheckCaseRepository } from '../../adapters/storage/in-memory-tool-check-case-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import type { Row, Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { ToolGraph } from '../../domain/etl/graph';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { ToolCheckNotFoundError } from '../../domain/tool-check/errors';
import { createToolCheckCase, type CreateToolCheckCaseProps } from '../../domain/tool-check/tool-check-case';
import { EtlEngine } from '../etl/engine';
import { RunToolCheckUseCase } from './run-tool-check';
import { RunToolCheckCaseUseCase } from './run-tool-check-case';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const otherScope = { tenantId: 'tenant', workspaceId: 'other' };
const checkedAt = new Date('2026-09-12T09:00:00.000Z');
const searchSchema: Schema = { columns: [{ name: 'region', type: 'string', nullable: false }] };
const rows: Row[] = [{ region: 'Tokyo', amount: 120 }, { region: 'Tokyo', amount: 30 }, { region: 'Osaka', amount: 80 }];

function graph(extra: ToolGraph['nodes'] = [], extraEdges: ToolGraph['edges'] = []): ToolGraph {
  return {
    nodes: [
      { id: 'data', type: 'json-source', config: { rows } },
      { id: 'filter', type: 'filter', config: { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'region' } } },
      { id: 'arguments', type: 'agent-input', config: { schema: searchSchema, sample: { region: 'Osaka' } } },
      ...extra,
    ],
    edges: [{ from: 'data', to: 'filter' }, ...extraEdges],
  };
}

function tool(version: string, toolGraph: ToolGraph = graph()) {
  return createTool({
    metadata: { internalId: 'sales', workingName: 'sales', displayName: 'Sales', publishName: 'sales_search', version: SemVer.parse(version), owner: 'owner', state: 'draft', tenant: scope },
    sideEffect: 'read-only', inputSchema: searchSchema, graph: toolGraph,
  });
}

function caseOf(id: string, overrides: Partial<CreateToolCheckCaseProps> = {}) {
  const at = overrides.updatedAt ?? '2026-09-12T00:00:00.000Z';
  return createToolCheckCase({
    scope, id, toolId: 'sales', name: id, arguments: { region: 'Tokyo' }, expectations: { rowCount: { op: 'eq', value: 2 } },
    createdAt: at, updatedAt: at, ...overrides,
  });
}

async function harness(versions: readonly string[] = ['1.0.0']) {
  const tools = new InMemoryToolRepository();
  for (const version of versions) await tools.save(tool(version));
  const cases = new InMemoryToolCheckCaseRepository();
  const runToolCheck = new RunToolCheckUseCase(tools, new EtlEngine(createDefaultRegistry()), undefined, { now: () => checkedAt });
  const useCase = new RunToolCheckCaseUseCase(cases, runToolCheck, () => checkedAt);
  return { tools, cases, useCase };
}

describe('RunToolCheckCaseUseCase.execute', () => {
  it('正常: ケースの引数・期待で実行し、lastResult（状態・時刻・実行した版・要約）を更新して保存する', async () => {
    const { cases, useCase } = await harness(['1.0.0', '2.0.0']);
    await cases.save(caseOf('c1'));

    const { case: updated, result } = await useCase.execute(scope, 'c1');

    expect(result.status).toBe('passed');
    expect(result.tool.version).toBe('2.0.0');
    expect(updated.lastResult).toEqual({ status: 'passed', checkedAt: '2026-09-12T09:00:00.000Z', toolVersion: '2.0.0', summary: 'passed 1/1' });
    expect(updated.updatedAt).toBe('2026-09-12T00:00:00.000Z');
    expect(await cases.find(scope, 'c1')).toEqual(updated);
  });

  it('正常: 版を固定したケースはその版で実行し、要約に最初に落ちた期待を書く', async () => {
    const { cases, useCase } = await harness(['1.0.0', '2.0.0']);
    await cases.save(caseOf('pinned', { toolVersion: '1.0.0', expectations: { rowCount: { op: 'eq', value: 3 }, columns: ['region'] } }));

    const { case: updated, result } = await useCase.execute(scope, 'pinned');

    expect(result.tool.version).toBe('1.0.0');
    expect(result.status).toBe('failed');
    expect(updated.lastResult?.summary).toBe('failed 1/2: row count == 3 → row count 2');
  });

  it('異常: 引数不正のケースは status error で要約に理由を残し、例外にしない', async () => {
    const { cases, useCase } = await harness();
    await cases.save(caseOf('bad', { arguments: {} }));

    const { case: updated, result } = await useCase.execute(scope, 'bad');

    expect(result.status).toBe('error');
    expect(result.error).toEqual({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: region' });
    expect(updated.lastResult).toMatchObject({ status: 'error', summary: 'error: required argument missing: region' });
  });

  it("正常: outcome 'error' の異常系ケースは失敗して合格になり、要約に期待どおりの失敗理由を残す", async () => {
    const { cases, useCase } = await harness();
    await cases.save(caseOf('rejects', { arguments: {}, expectations: { outcome: 'error' } }));

    const { case: updated, result } = await useCase.execute(scope, 'rejects');

    expect(result.status).toBe('passed');
    expect(updated.lastResult).toMatchObject({ status: 'passed', summary: 'passed 1/1 (expected error: required argument missing: region)' });
  });

  it('異常: 固定した版が消えていても status error（TOOL_NOT_FOUND）の結果として保存する', async () => {
    const { cases, useCase } = await harness(['2.0.0']);
    await cases.save(caseOf('stale', { toolVersion: '1.0.0' }));

    const { case: updated, result } = await useCase.execute(scope, 'stale');

    expect(result.status).toBe('error');
    expect(result.error).toEqual({ code: 'TOOL_NOT_FOUND', message: 'tool not found: sales@1.0.0' });
    expect(result.tool).toEqual({ internalId: 'sales', version: '1.0.0', publishName: '' });
    expect(result.checkedAt).toBe('2026-09-12T09:00:00.000Z');
    expect(updated.lastResult).toEqual({ status: 'error', checkedAt: '2026-09-12T09:00:00.000Z', toolVersion: '1.0.0', summary: 'error: tool not found: sales@1.0.0' });
    expect((await cases.find(scope, 'stale'))?.lastResult?.status).toBe('error');
  });

  it('例外: 未知の id・別スコープの id は ToolCheckNotFoundError', async () => {
    const { cases, useCase } = await harness();
    await cases.save(caseOf('c1'));
    await expect(useCase.execute(scope, 'missing')).rejects.toThrow(new ToolCheckNotFoundError('tool check case not found: missing'));
    await expect(useCase.execute(otherScope, 'c1')).rejects.toThrow(ToolCheckNotFoundError);
  });

  it('例外: 想定外の失敗（リポジトリ障害）はそのまま伝播し、lastResult は書かない', async () => {
    const { tools, cases, useCase } = await harness();
    await cases.save(caseOf('c1'));
    tools.findLatest = async () => { throw new Error('storage offline'); };
    await expect(useCase.execute(scope, 'c1')).rejects.toThrow('storage offline');
    expect((await cases.find(scope, 'c1'))?.lastResult).toBeUndefined();
  });
});

describe('RunToolCheckCaseUseCase.runAll', () => {
  it('正常: 一覧順（新しい定義が先）に逐次実行し、全ケースの lastResult を更新する', async () => {
    const { cases, useCase } = await harness();
    await cases.save(caseOf('old', { updatedAt: '2026-09-12T00:00:00.000Z', createdAt: '2026-09-12T00:00:00.000Z' }));
    await cases.save(caseOf('new', { updatedAt: '2026-09-12T01:00:00.000Z', createdAt: '2026-09-12T01:00:00.000Z' }));

    const runs = await useCase.runAll(scope);

    expect(runs.map((run) => run.case.id)).toEqual(['new', 'old']);
    expect(runs.map((run) => run.result.status)).toEqual(['passed', 'passed']);
    expect((await cases.list(scope)).every((item) => item.lastResult?.status === 'passed')).toBe(true);
  });

  it('正常: error になるケースがあっても止まらず、後続も実行して結果を返す', async () => {
    const { cases, useCase } = await harness(['2.0.0']);
    await cases.save(caseOf('a-stale', { toolVersion: '1.0.0', updatedAt: '2026-09-12T02:00:00.000Z', createdAt: '2026-09-12T02:00:00.000Z' }));
    await cases.save(caseOf('b-bad', { arguments: {}, updatedAt: '2026-09-12T01:00:00.000Z', createdAt: '2026-09-12T01:00:00.000Z' }));
    await cases.save(caseOf('c-ok'));

    const runs = await useCase.runAll(scope);

    expect(runs.map((run) => [run.case.id, run.result.status])).toEqual([['a-stale', 'error'], ['b-bad', 'error'], ['c-ok', 'passed']]);
    expect(runs.map((run) => run.result.error?.code)).toEqual(['TOOL_NOT_FOUND', 'TOOL_ARGUMENTS', undefined]);
    expect((await cases.find(scope, 'c-ok'))?.lastResult?.status).toBe('passed');
  });

  it('正常: toolId で絞ると、その Tool のケースだけを実行する', async () => {
    const { tools, cases, useCase } = await harness();
    await tools.save(createTool({ ...tool('1.0.0'), metadata: { ...tool('1.0.0').metadata, internalId: 'inventory' } }));
    await cases.save(caseOf('sales-case'));
    await cases.save(caseOf('inventory-case', { toolId: 'inventory' }));

    const runs = await useCase.runAll(scope, { toolId: 'inventory' });

    expect(runs.map((run) => run.case.id)).toEqual(['inventory-case']);
    expect((await cases.find(scope, 'sales-case'))?.lastResult).toBeUndefined();
  });

  it('境界: ケースが無ければ空配列（例外にしない）', async () => {
    const { useCase } = await harness();
    expect(await useCase.runAll(scope)).toEqual([]);
    expect(await useCase.runAll(scope, { toolId: 'none' })).toEqual([]);
  });

  it('境界: 別スコープのケースは対象にならない', async () => {
    const { cases, useCase } = await harness();
    await cases.save(caseOf('c1'));
    expect(await useCase.runAll(otherScope)).toEqual([]);
    expect((await cases.find(scope, 'c1'))?.lastResult).toBeUndefined();
  });
});
