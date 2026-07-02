import { describe, expect, it } from 'vitest';
import {
  ToolError,
  ToolNotFoundError,
  ToolValidationError,
  VersionConflictError,
} from './errors';

describe('ToolError', () => {
  it('stores code and message', () => {
    const e = new ToolError('X', 'boom');
    expect(e.code).toBe('X');
    expect(e.message).toBe('boom');
  });

  it('is an Error and has name "ToolError"', () => {
    const e = new ToolError('X', 'boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ToolError');
  });
});

describe('ToolValidationError', () => {
  const e = new ToolValidationError('bad meta');
  it('is instanceof ToolError and Error', () => {
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ToolError);
    expect(e).toBeInstanceOf(ToolValidationError);
  });
  it('has code TOOL_VALIDATION and name ToolValidationError', () => {
    expect(e.code).toBe('TOOL_VALIDATION');
    expect(e.name).toBe('ToolValidationError');
    expect(e.message).toBe('bad meta');
  });
});

describe('ToolNotFoundError', () => {
  const e = new ToolNotFoundError('missing');
  it('is instanceof ToolError', () => {
    expect(e).toBeInstanceOf(ToolError);
    expect(e).toBeInstanceOf(ToolNotFoundError);
  });
  it('has code TOOL_NOT_FOUND and name ToolNotFoundError', () => {
    expect(e.code).toBe('TOOL_NOT_FOUND');
    expect(e.name).toBe('ToolNotFoundError');
  });
});

describe('VersionConflictError', () => {
  const e = new VersionConflictError('dup');
  it('is instanceof ToolError', () => {
    expect(e).toBeInstanceOf(ToolError);
    expect(e).toBeInstanceOf(VersionConflictError);
  });
  it('has code TOOL_VERSION_CONFLICT and name VersionConflictError', () => {
    expect(e.code).toBe('TOOL_VERSION_CONFLICT');
    expect(e.name).toBe('VersionConflictError');
  });
});

describe('subclasses are distinguishable', () => {
  it('do not cross-match', () => {
    expect(new ToolValidationError('a')).not.toBeInstanceOf(ToolNotFoundError);
    expect(new ToolNotFoundError('a')).not.toBeInstanceOf(VersionConflictError);
    expect(new VersionConflictError('a')).not.toBeInstanceOf(ToolValidationError);
  });
});
