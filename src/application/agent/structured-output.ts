import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import { structuredOutputToJsonSchema } from '../../domain/agent/structured-output';
import type { JsonObject, ModelCompletionRequest } from '../model/model-provider';
import { AgentRunError } from './errors';

export function toModelResponseFormat(output: StructuredOutputDefinition): NonNullable<ModelCompletionRequest['responseFormat']> {
  return { name: output.name, strict: true, schema: structuredOutputToJsonSchema(output) };
}

export function validateStructuredResponse(output: StructuredOutputDefinition, content: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) { throw new AgentRunError('structured response is not valid JSON', error); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentRunError('structured response must be a JSON object');
  }
  const value = parsed as Record<string, unknown>;
  const fields = new Map(output.fields.map((field) => [field.name, field]));
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new AgentRunError(`structured response contains unknown field '${key}'`);
  }
  for (const field of output.fields) {
    const item = value[field.name];
    if (item === undefined) {
      if (field.required) throw new AgentRunError(`structured response is missing required field '${field.name}'`);
      continue;
    }
    const valid = field.type === 'integer'
      ? typeof item === 'number' && Number.isInteger(item)
      : typeof item === field.type;
    if (!valid) throw new AgentRunError(`structured response field '${field.name}' must be ${field.type}`);
  }
  return structuredClone(value) as JsonObject;
}
