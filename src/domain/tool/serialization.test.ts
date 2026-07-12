import { describe, expect, it } from 'vitest';
import type { ToolGraph } from '../etl/graph';
import { ToolValidationError } from './errors';
import type { ToolMetadata } from './metadata';
import { SemVer } from './semver';
import { deserializeTool, serializeTool } from './serialization';
import { createTool } from './tool';
import type { Tool } from './tool';

function metadata(): ToolMetadata {
  return {
    internalId: 'tool-1',
    workingName: 'wname',
    displayName: 'Display',
    publishName: 'publish.name',
    version: SemVer.of(2, 3, 4),
    owner: 'alice',
    state: 'published',
    tenant: { tenantId: 't1', workspaceId: 'w1' },
  };
}

function sampleTool(): Tool {
  const graph: ToolGraph = {
    nodes: [
      { id: 'n1', type: 'json-source', config: { rows: [{ a: 1, b: 'x' }] } },
      { id: 'n2', type: 'select', config: { columns: ['a'] } },
    ],
    edges: [{ from: 'n1', to: 'n2', toInput: 0 }],
  };
  return createTool({
    metadata: metadata(),
    sideEffect: 'write',
    graph,
    inputSchema: { columns: [{ name: 'a', type: 'number', nullable: false }] },
    outputSchema: { columns: [{ name: 'a', type: 'number', nullable: false }] },
  });
}

describe('serializeTool', () => {
  it('converts version to string and produces JSON-serializable data', () => {
    const data = serializeTool(sampleTool());
    expect(data.metadata.version).toBe('2.3.4');
    expect(() => JSON.stringify(data)).not.toThrow();
  });

  it('keeps the optional Agent-facing Tool contract', () => {
    const original = createTool({
      ...sampleTool(),
      agentTool: { name: 'search_records', description: 'Search matching records.' },
    });
    expect(deserializeTool(JSON.parse(JSON.stringify(serializeTool(original)))).agentTool).toEqual({ name: 'search_records', description: 'Search matching records.' });
  });
});

describe('round-trip (serialize → JSON → parse → deserialize)', () => {
  it('yields an equivalent Tool', () => {
    const original = sampleTool();
    const json = JSON.stringify(serializeTool(original));
    const restored = deserializeTool(JSON.parse(json));

    expect(restored.metadata.internalId).toBe(original.metadata.internalId);
    expect(restored.metadata.version.equals(original.metadata.version)).toBe(true);
    expect(restored.metadata.state).toBe(original.metadata.state);
    expect(restored.metadata.tenant).toEqual(original.metadata.tenant);
    expect(restored.sideEffect).toBe(original.sideEffect);
    expect(restored.graph).toEqual(original.graph);
    expect(restored.inputSchema).toEqual(original.inputSchema);
    expect(restored.outputSchema).toEqual(original.outputSchema);
  });

  it('round-trips a tool without optional schemas', () => {
    const tool = createTool({
      metadata: metadata(),
      sideEffect: 'read-only',
      graph: { nodes: [{ id: 'n1', type: 'json-source', config: {} }], edges: [] },
    });
    const restored = deserializeTool(JSON.parse(JSON.stringify(serializeTool(tool))));
    expect(restored.inputSchema).toBeUndefined();
    expect(restored.outputSchema).toBeUndefined();
  });
});

describe('deserializeTool validation', () => {
  it('throws ToolValidationError for missing required field', () => {
    const data = serializeTool(sampleTool()) as unknown as Record<string, unknown>;
    const broken = { ...data, metadata: { ...(data.metadata as object) } } as Record<string, unknown>;
    delete (broken.metadata as Record<string, unknown>).owner;
    expect(() => deserializeTool(broken)).toThrow(ToolValidationError);
  });

  it('throws ToolValidationError for invalid version string', () => {
    const data = serializeTool(sampleTool());
    const broken = { ...data, metadata: { ...data.metadata, version: 'not-a-version' } };
    expect(() => deserializeTool(broken)).toThrow(ToolValidationError);
  });

  it('throws ToolValidationError for invalid state enum', () => {
    const data = serializeTool(sampleTool());
    const broken = { ...data, metadata: { ...data.metadata, state: 'live' } };
    expect(() => deserializeTool(broken)).toThrow(ToolValidationError);
  });

  it('throws ToolValidationError for invalid sideEffect enum', () => {
    const data = serializeTool(sampleTool());
    const broken = { ...data, sideEffect: 'nuke' };
    expect(() => deserializeTool(broken)).toThrow(ToolValidationError);
  });

  it('throws ToolValidationError for non-object input', () => {
    expect(() => deserializeTool(null)).toThrow(ToolValidationError);
    expect(() => deserializeTool('nope')).toThrow(ToolValidationError);
  });
});
