import { describe, expect, it } from 'vitest';
import { SchemaError } from '../errors';
import { agentInputNode } from './agent-input';

const config = {
  schema: {
    columns: [
      { name: 'month', type: 'string' as const, nullable: false },
      { name: 'limit', type: 'number' as const, nullable: true },
    ],
  },
  sample: { month: '2026-07', limit: 10 },
};

describe('agent-input', () => {
  it('declared schema and one sample rowを返す', () => {
    const validated = agentInputNode.validateConfig(config);
    expect(agentInputNode.inferSchema([], validated)).toMatchObject({ state: 'confirmed', issues: [] });
    expect(agentInputNode.execute([], validated)).toEqual({ schema: config.schema, rows: [config.sample] });
  });

  it('required欠損と型不一致をmismatchにする', () => {
    const validated = agentInputNode.validateConfig({ ...config, sample: { limit: 'ten' } });
    const inference = agentInputNode.inferSchema([], validated);
    expect(inference.state).toBe('mismatch');
    expect(inference.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', column: 'month' }),
      expect.objectContaining({ severity: 'error', column: 'limit' }),
    ]));
    expect(() => agentInputNode.execute([], validated)).toThrow(SchemaError);
  });

  it('undeclared sample fieldはwarningで出力から除く', () => {
    const validated = agentInputNode.validateConfig({ ...config, sample: { ...config.sample, extra: true } });
    expect(agentInputNode.inferSchema([], validated).issues).toEqual([
      expect.objectContaining({ severity: 'warning', column: 'extra' }),
    ]);
    expect(agentInputNode.execute([], validated).rows[0]).toEqual(config.sample);
  });

  it('dateはvalid Dateだけを受け入れる', () => {
    const dateConfig = agentInputNode.validateConfig({
      schema: { columns: [{ name: 'at', type: 'date', nullable: false }] },
      sample: { at: new Date('2026-07-03T00:00:00Z') },
    });
    expect(agentInputNode.inferSchema([], dateConfig).state).toBe('confirmed');
    const wireConfig = agentInputNode.validateConfig({
      schema: { columns: [{ name: 'at', type: 'date', nullable: false }] },
      sample: { at: '2026-07-03T00:00:00Z' },
    });
    expect(agentInputNode.execute([], wireConfig).rows[0]?.['at']).toBeInstanceOf(Date);
  });

  it('duplicate columnをerrorにする', () => {
    const duplicate = agentInputNode.validateConfig({
      schema: { columns: [{ name: 'x', type: 'null', nullable: false }, { name: 'x', type: 'unknown', nullable: true }] },
      sample: { x: null },
    });
    expect(agentInputNode.inferSchema([], duplicate)).toMatchObject({ state: 'mismatch', issues: [expect.objectContaining({ message: expect.stringContaining('duplicate') })] });
  });
});
