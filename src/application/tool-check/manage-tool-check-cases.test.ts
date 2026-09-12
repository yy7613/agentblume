import { describe, expect, it } from 'vitest';
import { InMemoryToolCheckCaseRepository } from '../../adapters/storage/in-memory-tool-check-case-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import type { Schema } from '../../domain/data/types';
import { ToolNotFoundError } from '../../domain/tool/errors';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { ToolCheckNotFoundError, ToolCheckValidationError } from '../../domain/tool-check/errors';
import { withToolCheckLastResult } from '../../domain/tool-check/tool-check-case';
import { DeleteToolCheckCaseUseCase, ListToolCheckCasesUseCase, SaveToolCheckCaseUseCase, type SaveToolCheckCaseInput } from './manage-tool-check-cases';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const otherScope = { tenantId: 'tenant', workspaceId: 'other' };
const inputSchema: Schema = { columns: [{ name: 'region', type: 'string', nullable: false }] };

function tool(internalId: string, version: string) {
  return createTool({
    metadata: { internalId, workingName: internalId, displayName: internalId, publishName: internalId, version: SemVer.parse(version), owner: 'owner', state: 'draft', tenant: scope },
    sideEffect: 'read-only', inputSchema,
    graph: { nodes: [{ id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { region: 'Tokyo' } } }], edges: [] },
  });
}

async function harness() {
  const tools = new InMemoryToolRepository();
  await tools.save(tool('sales', '1.0.0'));
  await tools.save(tool('sales', '2.0.0'));
  await tools.save(tool('inventory', '1.0.0'));
  const cases = new InMemoryToolCheckCaseRepository();
  let tick = 0;
  let ids = 0;
  const now = () => new Date(Date.UTC(2026, 8, 12, 0, 0, tick++));
  const save = new SaveToolCheckCaseUseCase(cases, tools, () => `id-${++ids}`, now);
  return { tools, cases, save, list: new ListToolCheckCasesUseCase(cases), remove: new DeleteToolCheckCaseUseCase(cases) };
}

function saveInput(overrides: Partial<SaveToolCheckCaseInput> = {}): SaveToolCheckCaseInput {
  return { scope, toolId: 'sales', name: 'Tokyo', arguments: { region: 'Tokyo' }, expectations: { rowCount: { op: 'gte', value: 1 } }, ...overrides };
}

describe('SaveToolCheckCaseUseCase', () => {
  it('正常: id 省略は生成 id で新規作成し、createdAt = updatedAt、lastResult 無しで保存する', async () => {
    const { save, cases } = await harness();
    const created = await save.execute(saveInput());
    expect(created).toEqual({
      scope, id: 'id-1', toolId: 'sales', name: 'Tokyo', arguments: { region: 'Tokyo' }, expectations: { rowCount: { op: 'gte', value: 1 } },
      createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(await cases.find(scope, 'id-1')).toEqual(created);
  });

  it('正常: 版を固定したケースは固定版の存在を確かめて保存する', async () => {
    const { save } = await harness();
    const created = await save.execute(saveInput({ toolVersion: '1.0.0' }));
    expect(created.toolVersion).toBe('1.0.0');
  });

  it('正常: id 指定の上書きは定義を差し替え、createdAt と lastResult を引き継ぎ、updatedAt を進める', async () => {
    const { save, cases } = await harness();
    const created = await save.execute(saveInput());
    const ran = withToolCheckLastResult(created, { status: 'failed', checkedAt: '2026-09-12T00:00:05.000Z', toolVersion: '2.0.0', summary: 'failed 1/1: row count >= 1 → row count 0' });
    await cases.save(ran);

    const overwritten = await save.execute(saveInput({ id: created.id, name: 'Osaka', arguments: { region: 'Osaka' }, expectations: {} }));

    expect(overwritten).toEqual({
      ...created, name: 'Osaka', arguments: { region: 'Osaka' }, expectations: {},
      lastResult: ran.lastResult, updatedAt: '2026-09-12T00:00:01.000Z',
    });
    expect(overwritten.createdAt).toBe(created.createdAt);
    expect(await cases.find(scope, created.id)).toEqual(overwritten);
    expect(await cases.list(scope)).toHaveLength(1);
  });

  it('境界: 未知の id を指定した保存は、その id で新規作成する（クライアント生成 id を許す）', async () => {
    const { save } = await harness();
    const created = await save.execute(saveInput({ id: 'client-id' }));
    expect(created.id).toBe('client-id');
    expect(created.lastResult).toBeUndefined();
  });

  it('異常: Tool が無い（最新版・固定版）なら ToolNotFoundError で保存しない', async () => {
    const { save, cases } = await harness();
    await expect(save.execute(saveInput({ toolId: 'ghost' }))).rejects.toThrow(new ToolNotFoundError('tool not found: ghost'));
    await expect(save.execute(saveInput({ toolVersion: '9.0.0' }))).rejects.toThrow(new ToolNotFoundError('tool not found: sales@9.0.0'));
    expect(await cases.list(scope)).toEqual([]);
  });

  it('異常: 別スコープの Tool は見えない', async () => {
    const { save } = await harness();
    await expect(save.execute(saveInput({ scope: otherScope }))).rejects.toThrow(ToolNotFoundError);
  });

  it('例外: ドメイン検証（名前・版の形・期待の境界）は Tool を探す前に ToolCheckValidationError', async () => {
    const { save } = await harness();
    await expect(save.execute(saveInput({ name: ' ' }))).rejects.toThrow(ToolCheckValidationError);
    await expect(save.execute(saveInput({ toolId: 'ghost', toolVersion: 'not-semver' }))).rejects.toThrow(ToolCheckValidationError);
    await expect(save.execute(saveInput({ expectations: { maxDurationMs: 0 } }))).rejects.toThrow(ToolCheckValidationError);
  });
});

describe('ListToolCheckCasesUseCase', () => {
  it('正常: 新しい定義が先で返し、toolId で絞り込める', async () => {
    const { save, list } = await harness();
    await save.execute(saveInput({ name: 'first' }));
    await save.execute(saveInput({ name: 'second', toolId: 'inventory' }));
    await save.execute(saveInput({ name: 'third' }));
    expect((await list.execute(scope)).map((item) => item.name)).toEqual(['third', 'second', 'first']);
    expect((await list.execute(scope, { toolId: 'sales' })).map((item) => item.name)).toEqual(['third', 'first']);
  });

  it('境界: 何も無いスコープ・一致しない toolId は空配列', async () => {
    const { save, list } = await harness();
    await save.execute(saveInput());
    expect(await list.execute(otherScope)).toEqual([]);
    expect(await list.execute(scope, { toolId: 'inventory' })).toEqual([]);
  });
});

describe('DeleteToolCheckCaseUseCase', () => {
  it('正常: 存在するケースを消す', async () => {
    const { save, remove, cases } = await harness();
    const created = await save.execute(saveInput());
    await remove.execute(scope, created.id);
    expect(await cases.find(scope, created.id)).toBeNull();
  });

  it('異常: 未知の id は ToolCheckNotFoundError（別スコープの id も見えない）', async () => {
    const { save, remove, cases } = await harness();
    const created = await save.execute(saveInput());
    await expect(remove.execute(scope, 'missing')).rejects.toThrow(new ToolCheckNotFoundError('tool check case not found: missing'));
    await expect(remove.execute(otherScope, created.id)).rejects.toThrow(ToolCheckNotFoundError);
    expect(await cases.find(scope, created.id)).not.toBeNull();
  });

  it('例外: 二度目の削除は ToolCheckNotFoundError', async () => {
    const { save, remove } = await harness();
    const created = await save.execute(saveInput());
    await remove.execute(scope, created.id);
    await expect(remove.execute(scope, created.id)).rejects.toThrow(ToolCheckNotFoundError);
  });
});
