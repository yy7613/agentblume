import { AgentValidationError } from './errors';

export const STRUCTURED_OUTPUT_TYPES = ['string', 'number', 'integer', 'boolean'] as const;
export type StructuredOutputType = (typeof STRUCTURED_OUTPUT_TYPES)[number];

export interface StructuredOutputField {
  readonly name: string;
  readonly type: StructuredOutputType;
  readonly required: boolean;
  readonly description?: string;
}

export interface StructuredOutputDefinition {
  readonly name: string;
  readonly fields: readonly StructuredOutputField[];
}

export interface PrimitiveJsonSchema {
  readonly type: StructuredOutputType;
  readonly description?: string;
}

export interface StructuredOutputJsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, PrimitiveJsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export function createStructuredOutput(value: StructuredOutputDefinition): StructuredOutputDefinition {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.name)) {
    throw new AgentValidationError('structured output name must be 1-64 letters, digits, underscores, or hyphens');
  }
  if (value.fields.length === 0) throw new AgentValidationError('structured output requires at least one field');
  const names = new Set<string>();
  const fields = value.fields.map((field, index) => {
    if (field.name.trim().length === 0) throw new AgentValidationError(`structured output field ${index} requires a name`);
    if (names.has(field.name)) throw new AgentValidationError(`duplicate structured output field: ${field.name}`);
    if (!(STRUCTURED_OUTPUT_TYPES as readonly unknown[]).includes(field.type)) {
      throw new AgentValidationError(`invalid structured output type: ${String(field.type)}`);
    }
    names.add(field.name);
    return {
      name: field.name,
      type: field.type,
      required: field.required,
      ...(field.description !== undefined && field.description.trim().length > 0 ? { description: field.description } : {}),
    };
  });
  return { name: value.name, fields };
}

export function structuredOutputToJsonSchema(output: StructuredOutputDefinition): StructuredOutputJsonSchema {
  const validated = createStructuredOutput(output);
  return {
    type: 'object',
    properties: Object.fromEntries(validated.fields.map((field) => [field.name, {
      type: field.type,
      ...(field.description !== undefined ? { description: field.description } : {}),
    }])),
    required: validated.fields.filter((field) => field.required).map((field) => field.name),
    additionalProperties: false,
  };
}
