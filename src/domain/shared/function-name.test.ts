import { describe, expect, it } from 'vitest';
import { assertFunctionName, FUNCTION_NAME_PATTERN, isFunctionName } from './function-name';
import { SharedValidationError } from './errors';

describe('isFunctionName', () => {
  it('正常: 英数字・アンダースコア・ハイフンを受け付ける', () => {
    expect(isFunctionName('score_lookup')).toBe(true);
    expect(isFunctionName('a-B9')).toBe(true);
    expect(isFunctionName('population_top')).toBe(true);
  });

  it('正常: 64文字ちょうどを受け付ける', () => {
    expect(isFunctionName('x'.repeat(64))).toBe(true);
  });

  it('異常: 日本語を含む名前は拒否する', () => {
    expect(isFunctionName('スコア検索')).toBe(false);
    expect(isFunctionName('score検索')).toBe(false);
  });

  it('異常: 空白を含む・空白のみの名前は拒否する', () => {
    expect(isFunctionName('score lookup')).toBe(false);
    expect(isFunctionName(' ')).toBe(false);
    expect(isFunctionName('score\n')).toBe(false);
  });

  it('異常: 空文字は拒否する', () => {
    expect(isFunctionName('')).toBe(false);
  });

  it('異常: ピリオド・スラッシュなどの区切り記号は拒否する', () => {
    expect(isFunctionName('score.lookup')).toBe(false);
    expect(isFunctionName('score/lookup')).toBe(false);
  });

  it('境界: 64文字は受け付け、65文字は拒否する', () => {
    expect(isFunctionName('x'.repeat(64))).toBe(true);
    expect(isFunctionName('x'.repeat(65))).toBe(false);
  });

  it('境界: 1文字(記号のみ)は受け付ける', () => {
    expect(isFunctionName('-')).toBe(true);
    expect(isFunctionName('_')).toBe(true);
  });

  it('FUNCTION_NAME_PATTERN はソース文字列として ^[A-Za-z0-9_-]{1,64}$ を保つ', () => {
    expect(FUNCTION_NAME_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,64}$');
  });
});

describe('assertFunctionName', () => {
  it('正常: 妥当な名前では例外を投げない', () => {
    expect(() => assertFunctionName('population_top', 'label')).not.toThrow();
  });

  it('例外: 不正な名前は既定で SharedValidationError を投げる', () => {
    expect(() => assertFunctionName('bad name', 'label')).toThrow(SharedValidationError);
  });

  it('例外: メッセージは `${label} must be a valid function name` と一致する', () => {
    expect(() => assertFunctionName('bad name', 'label')).toThrow(/^label must be a valid function name$/);
  });

  it('例外: 文字列以外の値も拒否する', () => {
    expect(() => assertFunctionName(undefined, 'label')).toThrow(SharedValidationError);
    expect(() => assertFunctionName(123, 'label')).toThrow(SharedValidationError);
  });

  it('例外: 65文字は境界超過として拒否する', () => {
    expect(() => assertFunctionName('x'.repeat(65), 'label')).toThrow(SharedValidationError);
  });

  it('fail を注入すると BC 固有のエラー型を投げる', () => {
    class InjectedError extends Error {}
    expect(() => assertFunctionName('bad name', 'label', (m) => new InjectedError(m))).toThrow(InjectedError);
    expect(() => assertFunctionName('bad name', 'label', (m) => new InjectedError(m))).not.toThrow(SharedValidationError);
  });
});
