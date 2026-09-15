/** 既存の申請の申請者 → 従業員の紐付け候補（docs/21 §20.1.1）。名前だけで自動では結ばない（候補を示すだけ）。 */
import { describe, expect, it } from 'vitest';
import { employeeLinkSuggestion, sameNameEmployees, type LinkableEmployee } from './employee-links';

const employees: readonly LinkableEmployee[] = [
  { id: 'emp-taro', name: 'テスト 太郎', code: 'E001', departmentId: 'sales', enabled: true },
  { id: 'emp-hanako-2', name: 'テスト花子', code: 'E102', enabled: true },
  { id: 'emp-hanako-1', name: 'テスト花子', enabled: true },
  { id: 'emp-shiro', name: 'テスト四郎', code: 'E005', enabled: false },
  { id: 'emp-saburo', name: 'テスト三郎', enabled: true },
];

describe('employeeLinkSuggestion', () => {
  it('正常: 社員番号（NFKC・空白・大文字小文字を無視）が有効な従業員 1 人と一致すれば exact-code', () => {
    expect(employeeLinkSuggestion({ name: '別の表記', employeeCode: ' ｅ００１ ' }, employees)).toEqual({ match: 'exact-code', candidates: [{ id: 'emp-taro', name: 'テスト 太郎', code: 'E001', departmentId: 'sales' }] });
  });

  it('正常: 社員番号が無い・一致しないなら氏名キーで探し、1 人なら unique-name', () => {
    expect(employeeLinkSuggestion({ name: 'テスト太郎' }, employees)).toMatchObject({ match: 'unique-name', candidates: [{ id: 'emp-taro' }] });
    expect(employeeLinkSuggestion({ name: 'テスト太郎', employeeCode: 'E999' }, employees).match).toBe('unique-name');
    expect(employeeLinkSuggestion({ name: 'テスト太郎', employeeCode: '  ' }, employees).match).toBe('unique-name');
  });

  it('異常: 同姓同名は ambiguous で全員（id 昇順）を候補にし、誰とも一致しなければ none', () => {
    expect(employeeLinkSuggestion({ name: 'テスト花子' }, employees)).toEqual({ match: 'ambiguous', candidates: [{ id: 'emp-hanako-1', name: 'テスト花子' }, { id: 'emp-hanako-2', name: 'テスト花子', code: 'E102' }] });
    expect(employeeLinkSuggestion({ name: '山田 一郎' }, employees)).toEqual({ match: 'none', candidates: [] });
  });

  it('境界: 無効な従業員は社員番号が一致しても候補にしない（確定で選べないため）', () => {
    expect(employeeLinkSuggestion({ name: 'テスト四郎', employeeCode: 'E005' }, employees)).toEqual({ match: 'none', candidates: [] });
    expect(sameNameEmployees('テスト四郎', employees)).toEqual([]);
    expect(sameNameEmployees('テスト　三郎', employees).map((employee) => employee.id)).toEqual(['emp-saburo']);
  });
});
