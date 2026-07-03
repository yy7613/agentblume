import { describe, expect, it } from 'vitest';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import { AgentRunError } from './errors';
import { toModelResponseFormat, validateStructuredResponse } from './structured-output';

const output: StructuredOutputDefinition = { name: 'answer', fields: [
  { name: 'text', type: 'string', required: true },
  { name: 'score', type: 'number', required: true },
  { name: 'rank', type: 'integer', required: true },
  { name: 'ok', type: 'boolean', required: false },
] };

describe('structured output runtime', () => {
  it('response formatを生成しJSON応答を検証する', () => {
    expect(toModelResponseFormat(output)).toMatchObject({ name: 'answer', strict: true, schema: { type: 'object', required: ['text', 'score', 'rank'], additionalProperties: false } });
    expect(validateStructuredResponse(output, '{"text":"done","score":1.5,"rank":2,"ok":true}')).toEqual({ text: 'done', score: 1.5, rank: 2, ok: true });
  });

  it.each([
    ['not-json', /valid JSON/],
    ['[]', /JSON object/],
    ['{"text":"x","score":1,"rank":2,"extra":true}', /unknown field/],
    ['{"score":1,"rank":2}', /missing required/],
    ['{"text":"x","score":"1","rank":2}', /score.*number/],
    ['{"text":"x","score":1,"rank":2.5}', /rank.*integer/],
  ])('不正応答 %s を拒否する', (content, message) => {
    expect(() => validateStructuredResponse(output, content)).toThrow(AgentRunError);
    expect(() => validateStructuredResponse(output, content)).toThrow(message);
  });
});
