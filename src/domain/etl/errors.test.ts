import { describe, expect, it } from 'vitest';
import { ConfigError, EtlError, GraphError, SchemaError } from './errors';

describe('EtlError', () => {
  it('stores code and message', () => {
    const e = new EtlError('X', 'boom');
    expect(e.code).toBe('X');
    expect(e.message).toBe('boom');
  });

  it('is an Error and has name "EtlError"', () => {
    const e = new EtlError('X', 'boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('EtlError');
  });
});

describe('ConfigError', () => {
  const e = new ConfigError('bad config');
  it('is instanceof EtlError and Error', () => {
    expect(e).toBeInstanceOf(EtlError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ConfigError);
  });
  it('has code ETL_CONFIG and name ConfigError', () => {
    expect(e.code).toBe('ETL_CONFIG');
    expect(e.name).toBe('ConfigError');
    expect(e.message).toBe('bad config');
  });
});

describe('SchemaError', () => {
  const e = new SchemaError('bad schema');
  it('is instanceof EtlError', () => {
    expect(e).toBeInstanceOf(EtlError);
    expect(e).toBeInstanceOf(SchemaError);
  });
  it('has code ETL_SCHEMA and name SchemaError', () => {
    expect(e.code).toBe('ETL_SCHEMA');
    expect(e.name).toBe('SchemaError');
  });
});

describe('GraphError', () => {
  const e = new GraphError('bad graph');
  it('is instanceof EtlError', () => {
    expect(e).toBeInstanceOf(EtlError);
    expect(e).toBeInstanceOf(GraphError);
  });
  it('has code ETL_GRAPH and name GraphError', () => {
    expect(e.code).toBe('ETL_GRAPH');
    expect(e.name).toBe('GraphError');
  });

  it('subclasses are distinguishable from each other', () => {
    expect(new ConfigError('a')).not.toBeInstanceOf(GraphError);
    expect(new GraphError('a')).not.toBeInstanceOf(SchemaError);
  });
});
