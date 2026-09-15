import { describe, expect, it } from 'vitest';
import { ContractExtractionSchemaError, ContractExtractionUnavailableError } from './errors';

describe('契約の LLM 機能のエラー', () => {
  it('ContractExtractionUnavailableError: code と name で api が 409 に写せる', () => {
    const error = new ContractExtractionUnavailableError('needs a model');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'CONTRACT_EXTRACTION_UNAVAILABLE', name: 'ContractExtractionUnavailableError', message: 'needs a model' });
  });

  it('ContractExtractionSchemaError: 問題の一覧をメッセージに連結し、配列は複製して持つ', () => {
    const issues = ['束 1: findings が配列ではない', '束 2: 応答が空だった'];
    const error = new ContractExtractionSchemaError('no usable extraction', issues);
    expect(error).toMatchObject({ code: 'CONTRACT_EXTRACTION_SCHEMA', name: 'ContractExtractionSchemaError' });
    expect(error.message).toBe('no usable extraction: 束 1: findings が配列ではない; 束 2: 応答が空だった');
    issues.push('後から足した');
    expect(error.issues).toHaveLength(2);
  });

  it('境界: 問題が無ければメッセージはそのまま、issues は空', () => {
    const error = new ContractExtractionSchemaError('no usable extraction');
    expect(error.message).toBe('no usable extraction');
    expect(error.issues).toEqual([]);
  });
});
