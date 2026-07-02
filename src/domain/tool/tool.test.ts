import { describe, expect, it } from 'vitest';
import type { ToolGraph } from '../etl/graph';
import { ToolValidationError } from './errors';
import type { ToolMetadata } from './metadata';
import { SemVer } from './semver';
import { createTool } from './tool';
import type { CreateToolProps } from './tool';

function baseMetadata(): ToolMetadata {
  return {
    internalId: 'tool-1',
    workingName: 'wname',
    displayName: 'Display Name',
    publishName: 'publish.name',
    version: SemVer.of(1, 0, 0),
    owner: 'alice',
    state: 'draft',
    tenant: { tenantId: 't1', workspaceId: 'w1' },
  };
}

function baseGraph(): ToolGraph {
  return {
    nodes: [{ id: 'n1', type: 'json-source', config: { rows: [{ a: 1 }] } }],
    edges: [],
  };
}

function baseProps(): CreateToolProps {
  return { metadata: baseMetadata(), sideEffect: 'read-only', graph: baseGraph() };
}

describe('createTool (happy path)', () => {
  it('creates a Tool with the given metadata/graph', () => {
    const tool = createTool(baseProps());
    expect(tool.metadata.internalId).toBe('tool-1');
    expect(tool.sideEffect).toBe('read-only');
    expect(tool.graph.nodes).toHaveLength(1);
    expect(tool.metadata.version.toString()).toBe('1.0.0');
  });

  it('supports optional input/output schemas', () => {
    const tool = createTool({
      ...baseProps(),
      inputSchema: { columns: [{ name: 'a', type: 'number', nullable: false }] },
      outputSchema: { columns: [{ name: 'b', type: 'string', nullable: true }] },
    });
    expect(tool.inputSchema?.columns[0]?.name).toBe('a');
    expect(tool.outputSchema?.columns[0]?.name).toBe('b');
  });

  it('omits schemas when not provided', () => {
    const tool = createTool(baseProps());
    expect(tool.inputSchema).toBeUndefined();
    expect(tool.outputSchema).toBeUndefined();
  });
});

describe('createTool (immutability / no mutation of input)', () => {
  it('clones the graph so external mutation does not affect the Tool', () => {
    const graph = baseGraph();
    const tool = createTool({ ...baseProps(), graph });
    // 入力を後から破壊的変更してもツールには波及しない。
    (graph.nodes as { id: string; type: string; config: unknown }[]).push({
      id: 'n2',
      type: 'select',
      config: {},
    });
    expect(tool.graph.nodes).toHaveLength(1);
  });

  it('deep-clones node config', () => {
    const config: { rows: { a: number }[] } = { rows: [{ a: 1 }] };
    const graph: ToolGraph = { nodes: [{ id: 'n1', type: 'x', config }], edges: [] };
    const tool = createTool({ ...baseProps(), graph });
    config.rows[0]!.a = 999;
    const toolConfig = tool.graph.nodes[0]!.config as { rows: { a: number }[] };
    expect(toolConfig.rows[0]!.a).toBe(1);
  });

  it('clones schema arrays', () => {
    const inputSchema = { columns: [{ name: 'a', type: 'number' as const, nullable: false }] };
    const tool = createTool({ ...baseProps(), inputSchema });
    (inputSchema.columns as unknown[]).push({ name: 'z', type: 'string', nullable: true });
    expect(tool.inputSchema?.columns).toHaveLength(1);
  });
});

describe('createTool (invariant violations → ToolValidationError)', () => {
  it.each([
    ['internalId', { internalId: '' }],
    ['workingName', { workingName: '' }],
    ['displayName', { displayName: '' }],
    ['publishName', { publishName: '' }],
    ['owner', { owner: '' }],
  ])('rejects empty %s', (_field, patch) => {
    const props = baseProps();
    expect(() =>
      createTool({ ...props, metadata: { ...props.metadata, ...patch } }),
    ).toThrow(ToolValidationError);
  });

  it('rejects empty tenant ids', () => {
    const props = baseProps();
    expect(() =>
      createTool({
        ...props,
        metadata: { ...props.metadata, tenant: { tenantId: '', workspaceId: 'w1' } },
      }),
    ).toThrow(ToolValidationError);
    expect(() =>
      createTool({
        ...props,
        metadata: { ...props.metadata, tenant: { tenantId: 't1', workspaceId: '' } },
      }),
    ).toThrow(ToolValidationError);
  });

  it('rejects non-SemVer version', () => {
    const props = baseProps();
    expect(() =>
      createTool({
        ...props,
        metadata: { ...props.metadata, version: '1.0.0' as unknown as SemVer },
      }),
    ).toThrow(ToolValidationError);
  });

  it('rejects invalid state', () => {
    const props = baseProps();
    expect(() =>
      createTool({
        ...props,
        metadata: { ...props.metadata, state: 'live' as never },
      }),
    ).toThrow(ToolValidationError);
  });

  it('rejects invalid sideEffect', () => {
    expect(() =>
      createTool({ ...baseProps(), sideEffect: 'nuke' as never }),
    ).toThrow(ToolValidationError);
  });

  it('rejects graph without a nodes array', () => {
    expect(() =>
      createTool({ ...baseProps(), graph: {} as unknown as ToolGraph }),
    ).toThrow(ToolValidationError);
  });
});
