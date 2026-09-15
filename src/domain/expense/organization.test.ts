import { describe, expect, it } from 'vitest';
import { createExpenseOrganization, departmentHeadOf, emptyExpenseOrganization, findApproverGroup, findDepartment } from './organization';

const AT = '2026-09-15T00:00:00.000Z';
const dept = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `部門 ${id}`, enabled: true, ...extra });

describe('createExpenseOrganization', () => {
  it('正常: 部門の親子・部門長・補助軸の値、承認グループのメンバー（重複は 1 つ）', () => {
    const organization = createExpenseOrganization({
      departments: [dept('hq', { headEmployeeId: 'emp-9', code: 'D1', journalDimensionValueId: 'hq' }), dept('sales', { parentId: 'hq' }), dept('sales-east', { parentId: 'sales', parentless: true })] as never,
      approverGroups: [{ id: 'accounting', name: '経理', memberEmployeeIds: ['emp-3', 'emp-3', ' emp-4 '], enabled: true }],
      updatedAt: AT,
    });
    expect(organization.departments[0]).toEqual({ id: 'hq', code: 'D1', name: '部門 hq', headEmployeeId: 'emp-9', journalDimensionValueId: 'hq', enabled: true });
    expect(organization.approverGroups[0]?.memberEmployeeIds).toEqual(['emp-3', 'emp-4']);
    expect(findDepartment(organization, 'sales')?.parentId).toBe('hq');
    expect(findDepartment(organization, undefined)).toBeUndefined();
    expect(findApproverGroup(organization, 'accounting')?.name).toBe('経理');
    expect(findApproverGroup(organization, undefined)).toBeUndefined();
    // 部門長が空なら親をたどる。
    expect(departmentHeadOf(organization, 'sales-east')).toEqual({ departmentId: 'hq', headEmployeeId: 'emp-9' });
    expect(departmentHeadOf(emptyExpenseOrganization(), 'x')).toBeUndefined();
  });

  it('境界: 名前の一意は有効な部門どうしだけ（無効な部門は同名でよい）', () => {
    expect(() => createExpenseOrganization({ departments: [dept('a', { name: '営業' }), dept('b', { name: ' 営業 ' })] as never, updatedAt: AT })).toThrow(/used by both a and b/u);
    expect(createExpenseOrganization({ departments: [dept('a', { name: '営業' }), dept('b', { name: '営業', enabled: false })] as never, updatedAt: AT }).departments).toHaveLength(2);
  });

  it('異常: 親の循環・存在しない親・id の重複・形', () => {
    expect(() => createExpenseOrganization({ departments: [dept('a', { parentId: 'b' }), dept('b', { parentId: 'a' })] as never, updatedAt: AT })).toThrow(/loops back/u);
    expect(() => createExpenseOrganization({ departments: [dept('a', { parentId: 'x' })] as never, updatedAt: AT })).toThrow(/unknown parent/u);
    expect(() => createExpenseOrganization({ departments: [dept('a'), dept('a')] as never, updatedAt: AT })).toThrow(/duplicate department id/u);
    expect(() => createExpenseOrganization({ departments: [dept('A B')] as never, updatedAt: AT })).toThrow(/id must match/u);
    expect(() => createExpenseOrganization({ departments: [dept('a', { name: '' })] as never, updatedAt: AT })).toThrow(/name must be a non-empty/u);
    expect(() => createExpenseOrganization({ departments: [dept('a', { enabled: 1 })] as never, updatedAt: AT })).toThrow(/enabled must be a boolean/u);
    expect(() => createExpenseOrganization({ departments: [null] as never, updatedAt: AT })).toThrow(/must be an object/u);
    expect(() => createExpenseOrganization({ approverGroups: [{ id: 'g', name: 'g', memberEmployeeIds: [''], enabled: true }], updatedAt: AT })).toThrow(/memberEmployeeIds/u);
    expect(() => createExpenseOrganization({ approverGroups: [{ id: 'g', name: 'g', memberEmployeeIds: [], enabled: true }, { id: 'g', name: 'h', memberEmployeeIds: [], enabled: true }], updatedAt: AT })).toThrow(/must be unique/u);
    expect(() => createExpenseOrganization({ approverGroups: [{ id: 'g', name: '', memberEmployeeIds: [], enabled: true }], updatedAt: AT })).toThrow(/name must be/u);
    expect(() => createExpenseOrganization({ approverGroups: [{ id: 'g', name: 'g', memberEmployeeIds: [], enabled: 'x' }] as never, updatedAt: AT })).toThrow(/enabled/u);
    expect(() => createExpenseOrganization({ updatedAt: 'x' })).toThrow(/updatedAt/u);
    expect(() => createExpenseOrganization(null as never)).toThrow(/props are required/u);
  });

  it('境界: 部門長をたどるのは 10 段まで', () => {
    const departments = Array.from({ length: 13 }, (_, index) => dept(`d${index}`, index === 12 ? { headEmployeeId: 'top' } : { parentId: `d${index + 1}` }));
    const organization = createExpenseOrganization({ departments: departments as never, updatedAt: AT });
    expect(departmentHeadOf(organization, 'd2')).toEqual({ departmentId: 'd12', headEmployeeId: 'top' });
    expect(departmentHeadOf(organization, 'd0')).toBeUndefined();
  });
});
