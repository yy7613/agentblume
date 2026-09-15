// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/tool-api';
import { formatYen, isApiErrorCode, isIsoDateText, readFileBytes, rowOf } from './input-shared';

describe('input-shared', () => {
  it('正常: arrayBuffer が無い環境では FileReader で読む', async () => {
    const file = new File(['中野'], 'a.csv');
    Object.defineProperty(file, 'arrayBuffer', { value: undefined });
    expect(new TextDecoder().decode(await readFileBytes(file))).toBe('中野');
  });

  it('例外: FileReader が失敗したら拒否する', async () => {
    const original = globalThis.FileReader;
    class FailingReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      readAsArrayBuffer() { queueMicrotask(() => this.onerror?.()); }
    }
    globalThis.FileReader = FailingReader as unknown as typeof FileReader;
    try {
      const file = new File(['x'], 'a.csv');
      Object.defineProperty(file, 'arrayBuffer', { value: undefined });
      await expect(readFileBytes(file)).rejects.toThrow('The file could not be read.');
    } finally {
      globalThis.FileReader = original;
    }
  });

  it('境界: 行番号・code の判定、金額と日付の書式', () => {
    expect(rowOf(new Error('x'))).toBeUndefined();
    expect(rowOf(new ApiError(400, 'EXPENSE_CSV_IMPORT', 'x', undefined, { details: { row: 'two' } }))).toBeUndefined();
    expect(isApiErrorCode(new Error('x'), 'EXPENSE_DOMAIN')).toBe(false);
    expect(isApiErrorCode(new ApiError(400, 'EXPENSE_DOMAIN', 'x'), 'EXPENSE_DOMAIN')).toBe(true);
    expect(formatYen(undefined)).toBe('—');
    expect(formatYen(Number.NaN)).toBe('—');
    expect(formatYen(12345)).toBe('¥12,345');
    expect(isIsoDateText('2026-09-15')).toBe(true);
    expect(isIsoDateText('2026/09/15')).toBe(false);
  });
});
