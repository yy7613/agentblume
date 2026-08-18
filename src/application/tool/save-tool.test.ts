/**
 * SaveToolUseCase のテスト（v2 実装契約 §10）
 *
 * Fake リポジトリ（テスト内インライン・Map ベース）+ 実 EtlEngine
 * （createDefaultRegistry）で検証する。adapters には依存しない。
 */
import { describe, expect, it } from 'vitest';
import { EtlEngine } from '../etl/engine';
import { GraphError } from '../../domain/etl/errors';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { ToolValidationError, VersionConflictError } from '../../domain/tool/errors';
import { tenantKey } from '../../domain/tool/ids';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { SaveToolUseCase } from './save-tool';
import type { SaveToolInput } from './save-tool';

/** テスト用インライン Fake（ToolRepository を満たす Map ベース最小実装）。 */
class FakeToolRepository implements ToolRepository {
  private readonly store = new Map<string, Tool>();

  private key(scope: TenantScope, internalId: ToolId, version: SemVer): string {
    return `${tenantKey(scope)} ${internalId} ${version.toString()}`;
  }

  /** 保存済み件数（未保存の検証用）。 */
  get size(): number {
    return this.store.size;
  }

  async save(tool: Tool): Promise<void> {
    const key = this.key(tool.metadata.tenant, tool.metadata.internalId, tool.metadata.version);
    if (this.store.has(key)) {
      throw new VersionConflictError(`duplicate version: ${key}`);
    }
    this.store.set(key, tool);
  }

  async findVersion(scope: TenantScope, internalId: ToolId, version: SemVer): Promise<Tool | null> {
    return this.store.get(this.key(scope, internalId, version)) ?? null;
  }

  async findLatest(scope: TenantScope, internalId: ToolId): Promise<Tool | null> {
    const versions = await this.listVersions(scope, internalId);
    const last = versions[versions.length - 1];
    if (last === undefined) return null;
    return this.findVersion(scope, internalId, last);
  }

  async listVersions(scope: TenantScope, internalId: ToolId): Promise<SemVer[]> {
    return [...this.store.values()]
      .filter(
        (tool) =>
          tenantKey(tool.metadata.tenant) === tenantKey(scope) &&
          tool.metadata.internalId === internalId,
      )
      .map((tool) => tool.metadata.version)
      .sort((a, b) => a.compare(b));
  }

  async list(_scope: TenantScope): Promise<ToolSummary[]> {
    // SaveToolUseCase では未使用。
    return [];
  }

  async delete(): Promise<boolean> { return false; }
}

const scopeA: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

/** 有効な最小グラフ（json-source 1ノード）。 */
const validGraph: ToolGraph = {
  nodes: [{ id: 'src', type: 'json-source', config: { rows: [{ a: 1, b: 'x' }] } }],
  edges: [],
};

/** スキーマエラーを含むグラフ（存在しない列の select）。 */
const invalidGraph: ToolGraph = {
  nodes: [
    { id: 'src', type: 'json-source', config: { rows: [{ a: 1 }] } },
    { id: 'sel', type: 'select', config: { columns: ['missing'] } },
  ],
  edges: [{ from: 'src', to: 'sel' }],
};

function makeInput(overrides?: Partial<SaveToolInput>): SaveToolInput {
  return {
    scope: scopeA,
    internalId: 'tool-1',
    workingName: 'working',
    displayName: 'Display',
    publishName: 'publish_name',
    owner: 'owner@example.com',
    sideEffect: 'read-only',
    graph: validGraph,
    ...overrides,
  };
}

function makeSut(): { usecase: SaveToolUseCase; repo: FakeToolRepository } {
  const repo = new FakeToolRepository();
  const engine = new EtlEngine(createDefaultRegistry());
  return { usecase: new SaveToolUseCase(repo, engine), repo };
}

describe('SaveToolUseCase', () => {
  it('初回保存は 1.0.0 になり、repo に保存される', async () => {
    const { usecase, repo } = makeSut();

    const tool = await usecase.execute(makeInput());

    expect(tool.metadata.version.toString()).toBe('1.0.0');
    const saved = await repo.findVersion(scopeA, 'tool-1', SemVer.of(1, 0, 0));
    expect(saved).not.toBeNull();
    expect(saved?.metadata.publishName).toBe('publish_name');
  });

  it('FilterのAgent input bindingは宣言済みinputSchemaだけを参照できる', async () => {
    const { usecase } = makeSut();
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } } },
        { id: 'arguments', type: 'agent-input', config: { schema: { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] }, sample: { minimumScore: 0 } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema: { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] } }))).resolves.toMatchObject({ inputSchema: { columns: [{ name: 'minimumScore' }] } });
    await expect(usecase.execute(makeInput({ internalId: 'invalid-binding', graph, inputSchema: { columns: [{ name: 'other', type: 'number', nullable: false }] } }))).rejects.toThrow(/unknown field 'minimumScore'/);
  });

  it('複数条件filterのconditions内Agent input bindingも同じ規則で検証する', async () => {
    const { usecase } = makeSut();
    const argumentSchema = { columns: [
      { name: 'minimumScore', type: 'number' as const, nullable: false },
      { name: 'region', type: 'string' as const, nullable: false },
    ] };
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42, region: 'Tokyo' }] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } },
          { column: 'region', op: 'eq', value: 'Tokyo', valueBinding: { source: 'agent-input', field: 'region' } },
        ], combine: 'and' } },
        { id: 'arguments', type: 'agent-input', config: { schema: argumentSchema, sample: { minimumScore: 0, region: 'Tokyo' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema: argumentSchema })))
      .resolves.toMatchObject({ inputSchema: { columns: [{ name: 'minimumScore' }, { name: 'region' }] } });
    await expect(usecase.execute(makeInput({ internalId: 'partial-schema', graph, inputSchema: { columns: [argumentSchema.columns[0]!] } })))
      .rejects.toThrow(/unknown field 'region'/);
    await expect(usecase.execute(makeInput({ internalId: 'no-schema', graph })))
      .rejects.toThrow(/Agent input bindings require an inputSchema/);
  });

  it('filterのopBindingが未知のfieldを参照したら保存を拒否する', async () => {
    const { usecase } = makeSut();
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input', field: 'scoreOp' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema: { columns: [{ name: 'other', type: 'string', nullable: false }] } })))
      .rejects.toThrow(/Agent input binding references unknown field 'scoreOp'/);
    await expect(usecase.execute(makeInput({ internalId: 'op-no-schema', graph })))
      .rejects.toThrow(/Agent input bindings require an inputSchema/);
  });

  it('string以外の型の引数へのopBindingは保存を拒否する', async () => {
    const { usecase, repo } = makeSut();
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input', field: 'scoreOp' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema: { columns: [{ name: 'scoreOp', type: 'number', nullable: false }] } })))
      .rejects.toThrow(/SaveTool: operator binding for argument 'scoreOp' requires a string argument, but it is declared as 'number'/);
    expect(repo.size).toBe(0);
  });

  it('同一fieldを複数条件がバインドしallowedの積集合が空なら保存を拒否する', async () => {
    const { usecase, repo } = makeSut();
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42, price: 10 }] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'score', op: 'gt', value: 0, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt'] } },
          { column: 'price', op: 'lt', value: 100, opBinding: { source: 'agent-input', field: 'op', allowed: ['lt'] } },
        ], combine: 'and' } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema: { columns: [{ name: 'op', type: 'string', nullable: false }] } })))
      .rejects.toThrow(/SaveTool: operator binding for argument 'op' has no operator that every condition allows/);
    expect(repo.size).toBe(0);
  });

  it('string型引数へのopBindingは保存できる', async () => {
    const { usecase } = makeSut();
    const inputSchema = { columns: [{ name: 'scoreOp', type: 'string' as const, nullable: false }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input', field: 'scoreOp', allowed: ['gt', 'gte', 'lt', 'lte'] } } },
        { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { scoreOp: 'gte' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema })))
      .resolves.toMatchObject({ inputSchema: { columns: [{ name: 'scoreOp' }] } });
  });

  it('opBindingのfieldが欠落または空文字なら保存を拒否する（F7）', async () => {
    const { usecase, repo } = makeSut();
    const inputSchema = { columns: [{ name: 'scoreOp', type: 'string' as const, nullable: false }] };
    const missingFieldGraph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    const emptyFieldGraph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input', field: '' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph: missingFieldGraph, inputSchema })))
      .rejects.toThrow('SaveTool: operator binding is missing its input field');
    await expect(usecase.execute(makeInput({ internalId: 'empty-field', graph: emptyFieldGraph, inputSchema })))
      .rejects.toThrow('SaveTool: operator binding is missing its input field');
    expect(repo.size).toBe(0);
  });

  it('valueBindingのfieldが空文字でも専用エラーで保存を拒否する（opBinding側と対称）', async () => {
    const { usecase, repo } = makeSut();
    const inputSchema = { columns: [{ name: 'minimumScore', type: 'number' as const, nullable: false }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: '' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph, inputSchema })))
      .rejects.toThrow('SaveTool: value binding is missing its input field');
    expect(repo.size).toBe(0);
  });

  it('同一fieldを比較値と演算子の両方にバインドしたら保存を拒否し、別fieldなら保存できる（F2）', async () => {
    const { usecase, repo } = makeSut();
    const sharedGraph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ region: 'Tokyo' }] } },
        { id: 'filter', type: 'filter', config: { column: 'region', op: 'eq', value: 'Tokyo', valueBinding: { source: 'agent-input', field: 'arg' }, opBinding: { source: 'agent-input', field: 'arg', allowed: ['eq', 'neq'] } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph: sharedGraph, inputSchema: { columns: [{ name: 'arg', type: 'string', nullable: false }] } })))
      .rejects.toThrow("SaveTool: argument 'arg' is bound as both a comparison value and an operator; declare two separate arguments");
    expect(repo.size).toBe(0);

    const separateSchema = { columns: [
      { name: 'regionValue', type: 'string' as const, nullable: false },
      { name: 'regionOp', type: 'string' as const, nullable: false },
    ] };
    const separateGraph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ region: 'Tokyo' }] } },
        { id: 'filter', type: 'filter', config: { column: 'region', op: 'eq', value: 'Tokyo', valueBinding: { source: 'agent-input', field: 'regionValue' }, opBinding: { source: 'agent-input', field: 'regionOp', allowed: ['eq', 'neq'] } } },
        { id: 'arguments', type: 'agent-input', config: { schema: separateSchema, sample: { regionValue: 'Tokyo', regionOp: 'eq' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ internalId: 'separate-fields', graph: separateGraph, inputSchema: separateSchema })))
      .resolves.toMatchObject({ inputSchema: { columns: [{ name: 'regionValue' }, { name: 'regionOp' }] } });
  });

  it('isNull/notNull許可のopBindingと同条件のvalue引数が非nullableなら保存を拒否する（F11）', async () => {
    const { usecase, repo } = makeSut();
    const graphWith = (allowed: readonly string[], schema: { columns: readonly { name: string; type: 'string'; nullable: boolean }[] }): ToolGraph => ({
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ region: 'Tokyo' }] } },
        { id: 'filter', type: 'filter', config: { column: 'region', op: 'eq', value: 'Tokyo', valueBinding: { source: 'agent-input', field: 'regionValue' }, opBinding: { source: 'agent-input', field: 'regionOp', allowed } } },
        { id: 'arguments', type: 'agent-input', config: { schema, sample: { regionValue: 'Tokyo', regionOp: 'eq' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    });
    const nonNullableValue = { columns: [
      { name: 'regionValue', type: 'string' as const, nullable: false },
      { name: 'regionOp', type: 'string' as const, nullable: false },
    ] };
    await expect(usecase.execute(makeInput({ graph: graphWith(['eq', 'isNull'], nonNullableValue), inputSchema: nonNullableValue })))
      .rejects.toThrow("SaveTool: operator binding allows isNull/notNull, so the value argument 'regionValue' must be nullable");
    expect(repo.size).toBe(0);

    // 境界1: valueField が nullable なら isNull/notNull を許可しても保存できる。
    const nullableValue = { columns: [
      { name: 'regionValue', type: 'string' as const, nullable: true },
      { name: 'regionOp', type: 'string' as const, nullable: false },
    ] };
    await expect(usecase.execute(makeInput({ internalId: 'nullable-value', graph: graphWith(['eq', 'isNull'], nullableValue), inputSchema: nullableValue })))
      .resolves.toMatchObject({ inputSchema: { columns: [{ name: 'regionValue', nullable: true }, { name: 'regionOp' }] } });

    // 境界2: allowed に isNull/notNull が無ければ valueField が非 nullable でも保存できる。
    await expect(usecase.execute(makeInput({ internalId: 'no-valueless-op', graph: graphWith(['eq', 'neq'], nonNullableValue), inputSchema: nonNullableValue })))
      .resolves.toMatchObject({ inputSchema: { columns: [{ name: 'regionValue', nullable: false }, { name: 'regionOp' }] } });
  });

  it('同一fieldの既定演算子が条件間で不一致なら保存を拒否し、全一致なら保存できる（F12）', async () => {
    const { usecase, repo } = makeSut();
    const inputSchema = { columns: [{ name: 'op', type: 'string' as const, nullable: false }] };
    const mixedGraph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42, price: 10 }] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'score', op: 'gt', value: 0, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
          { column: 'price', op: 'lt', value: 100, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
        ], combine: 'and' } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ graph: mixedGraph, inputSchema })))
      .rejects.toThrow("SaveTool: operator binding for argument 'op' must use the same default operator in every condition");
    expect(repo.size).toBe(0);

    // 境界: 既定演算子が全条件で一致すれば保存できる。
    const uniformGraph: ToolGraph = {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ score: 42, price: 10 }] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'score', op: 'gt', value: 0, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
          { column: 'price', op: 'gt', value: 100, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
        ], combine: 'and' } },
        { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { op: 'gt' } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    };
    await expect(usecase.execute(makeInput({ internalId: 'uniform-default', graph: uniformGraph, inputSchema })))
      .resolves.toMatchObject({ inputSchema: { columns: [{ name: 'op' }] } });
  });

  it('2回目の保存は既定 patch で 1.0.1', async () => {
    const { usecase } = makeSut();

    await usecase.execute(makeInput());
    const second = await usecase.execute(makeInput());

    expect(second.metadata.version.toString()).toBe('1.0.1');
  });

  it('bump: minor → 1.1.0 / major → 2.0.0', async () => {
    const { usecase } = makeSut();

    await usecase.execute(makeInput());
    const minor = await usecase.execute(makeInput({ bump: 'minor' }));
    expect(minor.metadata.version.toString()).toBe('1.1.0');

    const major = await usecase.execute(makeInput({ bump: 'major' }));
    expect(major.metadata.version.toString()).toBe('2.0.0');
  });

  it('bump は既存の最大バージョンを基準にする（major 後の patch → 2.0.1）', async () => {
    const { usecase } = makeSut();

    await usecase.execute(makeInput());
    await usecase.execute(makeInput({ bump: 'major' }));
    const third = await usecase.execute(makeInput());

    expect(third.metadata.version.toString()).toBe('2.0.1');
  });

  it('初回保存では bump 指定は無視され 1.0.0', async () => {
    const { usecase } = makeSut();

    const tool = await usecase.execute(makeInput({ bump: 'major' }));

    expect(tool.metadata.version.toString()).toBe('1.0.0');
  });

  it('グラフエラー（存在しない列の select）→ ToolValidationError、repo に保存されない', async () => {
    const { usecase, repo } = makeSut();

    await expect(usecase.execute(makeInput({ graph: invalidGraph }))).rejects.toThrow(
      ToolValidationError,
    );
    expect(repo.size).toBe(0);
    await expect(repo.listVersions(scopeA, 'tool-1')).resolves.toEqual([]);
  });

  it('GraphError（未知ノード type 等）はそのまま伝播する', async () => {
    const { usecase, repo } = makeSut();
    const badGraph: ToolGraph = {
      nodes: [{ id: 'src', type: 'no-such-type', config: {} }],
      edges: [],
    };

    await expect(usecase.execute(makeInput({ graph: badGraph }))).rejects.toThrow(GraphError);
    expect(repo.size).toBe(0);
  });

  it('テナント/ワークスペース別で独立採番される', async () => {
    const { usecase } = makeSut();
    const scopeB: TenantScope = { tenantId: 'tenant-b', workspaceId: 'ws-1' };
    const scopeAWs2: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-2' };

    await usecase.execute(makeInput());
    const secondInA = await usecase.execute(makeInput());
    const firstInB = await usecase.execute(makeInput({ scope: scopeB }));
    const firstInAWs2 = await usecase.execute(makeInput({ scope: scopeAWs2 }));

    expect(secondInA.metadata.version.toString()).toBe('1.0.1');
    expect(firstInB.metadata.version.toString()).toBe('1.0.0');
    expect(firstInAWs2.metadata.version.toString()).toBe('1.0.0');
  });

  it('internalId 別でも独立採番される', async () => {
    const { usecase } = makeSut();

    await usecase.execute(makeInput());
    const other = await usecase.execute(makeInput({ internalId: 'tool-2' }));

    expect(other.metadata.version.toString()).toBe('1.0.0');
  });

  it('state 既定は draft、指定時はその値が反映される', async () => {
    const { usecase } = makeSut();

    const draft = await usecase.execute(makeInput());
    expect(draft.metadata.state).toBe('draft');

    const published = await usecase.execute(makeInput({ state: 'published' }));
    expect(published.metadata.state).toBe('published');
  });

  it('inputSchema/outputSchema・sideEffect・メタが Tool に反映される', async () => {
    const { usecase } = makeSut();
    const inputSchema = { columns: [{ name: 'a', type: 'number' as const, nullable: false }] };
    const outputSchema = { columns: [{ name: 'b', type: 'string' as const, nullable: true }] };

    const tool = await usecase.execute(
      makeInput({ sideEffect: 'write', inputSchema, outputSchema }),
    );

    expect(tool.sideEffect).toBe('write');
    expect(tool.inputSchema).toEqual(inputSchema);
    expect(tool.outputSchema).toEqual(outputSchema);
    expect(tool.metadata.internalId).toBe('tool-1');
    expect(tool.metadata.workingName).toBe('working');
    expect(tool.metadata.displayName).toBe('Display');
    expect(tool.metadata.owner).toBe('owner@example.com');
    expect(tool.metadata.tenant).toEqual(scopeA);
    expect(tool.graph).toEqual(validGraph);
  });

  it('workspace-output / graph-output / chart-output はいずれもsideEffect read-onlyでの保存を拒否する（G21）', async () => {
    const { usecase, repo } = makeSut();
    const source = { id: 'src', type: 'json-source' as const, config: { rows: [{ a: 1, b: 2 }] } };

    const workspaceGraph: ToolGraph = {
      nodes: [source, { id: 'sink', type: 'workspace-output', config: { name: 'ws', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 } }],
      edges: [{ from: 'src', to: 'sink' }],
    };
    const graphOutputGraph: ToolGraph = {
      nodes: [source, { id: 'sink', type: 'graph-output', config: { name: 'graph', writeMode: 'create', onConflict: 'new-revision', previewRows: 1, graph: { sourceColumn: 'a', targetColumn: 'b' } } }],
      edges: [{ from: 'src', to: 'sink' }],
    };
    const chartGraph: ToolGraph = {
      nodes: [source, { id: 'sink', type: 'chart-output', config: { configVersion: 1, name: 'chart', chartType: 'scatter', mapping: { xColumn: 'a', yColumn: 'b' }, maxPoints: 100, downsample: 'none', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 } }],
      edges: [{ from: 'src', to: 'sink' }],
    };

    await expect(usecase.execute(makeInput({ internalId: 'ws-tool', graph: workspaceGraph, sideEffect: 'read-only' }))).rejects.toThrow(ToolValidationError);
    await expect(usecase.execute(makeInput({ internalId: 'graph-tool', graph: graphOutputGraph, sideEffect: 'read-only' }))).rejects.toThrow(ToolValidationError);
    // G21: chart-output はこの3条件のうち唯一漏れていたsink種別。read-only保存を拒否できることを確認する。
    await expect(usecase.execute(makeInput({ internalId: 'chart-tool', graph: chartGraph, sideEffect: 'read-only' }))).rejects.toThrow(ToolValidationError);
    expect(repo.size).toBe(0);

    const saved = await usecase.execute(makeInput({ internalId: 'chart-tool-ok', graph: chartGraph, sideEffect: 'session-write' }));
    expect(saved.sideEffect).toBe('session-write');
  });
});
