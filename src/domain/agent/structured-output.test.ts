import { describe, expect, it } from 'vitest';
import { AgentValidationError } from './errors';
import { createStructuredOutput, structuredOutputToJsonSchema } from './structured-output';

describe('StructuredOutputDefinition', () => {
  it('field定義を複製してJSON Schemaへ変換する', () => {
    const fields = [
      { name: 'answer', type: 'string' as const, required: true, description: 'Final answer' },
      { name: 'score', type: 'integer' as const, required: false },
    ];
    const output = createStructuredOutput({ name: 'agent_response', fields });
    fields[0]!.name = 'changed';
    expect(output.fields[0]?.name).toBe('answer');
    expect(structuredOutputToJsonSchema(output)).toEqual({
      type: 'object',
      properties: { answer: { type: 'string', description: 'Final answer' }, score: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    });
  });

  it('不正name、空field、重複field、不正typeを拒否する', () => {
    expect(() => createStructuredOutput({ name: 'bad name', fields: [{ name: 'x', type: 'string', required: true }] })).toThrow(AgentValidationError);
    expect(() => createStructuredOutput({ name: 'valid', fields: [] })).toThrow(/at least one/);
    expect(() => createStructuredOutput({ name: 'valid', fields: [{ name: 'x', type: 'string', required: true }, { name: 'x', type: 'number', required: false }] })).toThrow(/duplicate/);
    expect(() => createStructuredOutput({ name: 'valid', fields: [{ name: 'x', type: 'array' as 'string', required: true }] })).toThrow(/invalid/);
  });
});
