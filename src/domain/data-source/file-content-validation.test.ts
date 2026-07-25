import { describe, expect, it } from 'vitest';
import { InvalidFileContentError } from './errors';
import { validateFileContent } from './file-content-validation';

describe('validateFileContent: csv', () => {
  it('accepts a well-formed csv with a header row', () => {
    expect(() => validateFileContent('csv', 'id,name\n1,Alice\n2,Bob')).not.toThrow();
  });

  it('accepts a header-only csv (no data rows)', () => {
    expect(() => validateFileContent('csv', 'id,name')).not.toThrow();
  });

  it('accepts CRLF line endings and tab delimiters (not treated as control characters)', () => {
    expect(() => validateFileContent('csv', 'id\tname\r\n1\tAlice')).not.toThrow();
  });

  it('rejects content containing a null character (binary contamination)', () => {
    try {
      validateFileContent('csv', 'id,name\n1,A\u0000lice');
      throw new Error('expected validateFileContent to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidFileContentError);
      expect((error as InstanceType<typeof InvalidFileContentError>).code).toBe('INVALID_FILE_CONTENT');
      expect((error as Error).message).toMatch(/^csv content could not be parsed:/);
      expect((error as Error).message).toContain('U+0000');
    }
  });

  it('rejects content containing other binary/control characters', () => {
    expect(() => validateFileContent('csv', 'id,name\n1,A\u0001B')).toThrow(/control character/);
  });

  it('rejects content whose header row is missing (blank first line)', () => {
    expect(() => validateFileContent('csv', '\n1,Alice\n2,Bob')).toThrow(/header row is missing/);
  });

  it('rejects content that is only whitespace on the first line', () => {
    expect(() => validateFileContent('csv', '   \n1,Alice')).toThrow(/header row is missing/);
  });
});

describe('validateFileContent: json', () => {
  it('accepts well-formed JSON', () => {
    expect(() => validateFileContent('json', '[{"id":1}]')).not.toThrow();
  });

  it('rejects malformed JSON', () => {
    try {
      validateFileContent('json', '{');
      throw new Error('expected validateFileContent to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidFileContentError);
      expect((error as InstanceType<typeof InvalidFileContentError>).code).toBe('INVALID_FILE_CONTENT');
      expect((error as Error).message).toMatch(/^json content could not be parsed:/);
    }
  });

  it('rejects binary garbage that is not valid JSON', () => {
    expect(() => validateFileContent('json', '\u0000\u0001PK\u0003\u0004binarydata')).toThrow(InvalidFileContentError);
  });
});
