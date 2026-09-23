import { describe, expect, it } from 'vitest';
import { CODE_LIKE_COLUMN } from './column-roles';

describe('CODE_LIKE_COLUMN', () => {
  it('正常: 日本語の「コード」「番号」を含む列名にマッチする', () => {
    expect(CODE_LIKE_COLUMN.test('地域コード')).toBe(true);
    expect(CODE_LIKE_COLUMN.test('電話番号')).toBe(true);
  });

  it('正常: 英語の code / id 系の列名にマッチする（大文字小文字を問わない）', () => {
    expect(CODE_LIKE_COLUMN.test('AreaCode')).toBe(true);
    expect(CODE_LIKE_COLUMN.test('user_id')).toBe(true);
    expect(CODE_LIKE_COLUMN.test('employeeId')).toBe(true);
  });

  it('異常: コードらしさの無い列名にはマッチしない', () => {
    expect(CODE_LIKE_COLUMN.test('賃金')).toBe(false);
    expect(CODE_LIKE_COLUMN.test('amount')).toBe(false);
  });

  it('境界: "id" は語末のときだけマッチする（語中は対象外）', () => {
    expect(CODE_LIKE_COLUMN.test('id')).toBe(true);
    expect(CODE_LIKE_COLUMN.test('idea')).toBe(false);
  });
});
