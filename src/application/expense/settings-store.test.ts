/**
 * ワークスペースに 1 つの設定（`ExpenseSettingsStore` / `organizationReader`）のテスト。
 *
 * 規程と同じく「未保存なら既定値を返すが保存しない」（参照が書き込みを起こさない）ことを守る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureOrganization, otherWorkspace, scope } from '../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpenseSettingsRepository } from '../../adapters/storage/in-memory-expense-settings-repository';
import { ExpenseDomainError } from '../../domain/expense/errors';
import { defaultExpenseSettings } from '../../domain/expense/settings';
import { ExpenseSettingsStore, organizationReader } from './settings-store';

let repository: InMemoryExpenseSettingsRepository;
let store: ExpenseSettingsStore;

beforeEach(() => {
  repository = new InMemoryExpenseSettingsRepository();
  store = new ExpenseSettingsStore(repository);
});

describe('ExpenseSettingsStore.load', () => {
  it.each(['organization', 'payout', 'cards', 'fares'] as const)('境界: 未保存の %s は既定値を saved=false で返し、書き込まない', async (kind) => {
    const save = vi.spyOn(repository, 'save');
    const result = await store.load(scope, kind);
    expect(result).toEqual({ value: defaultExpenseSettings(kind), saved: false });
    expect(save).not.toHaveBeenCalled();
    expect(await repository.get(scope, kind)).toBeNull();
  });

  it('正常: 保存済みなら saved=true で保存した値を返す。別のワークスペースは未保存のまま', async () => {
    await store.save(scope, 'organization', fixtureOrganization());
    expect(await store.load(scope, 'organization')).toEqual({ value: fixtureOrganization(), saved: true });
    expect((await store.load(otherWorkspace, 'organization')).saved).toBe(false);
  });
});

describe('ExpenseSettingsStore.save', () => {
  it('正常: 検証した値を保存して返す（検証で正規化された値が保存される）', async () => {
    const raw = { departments: [{ id: 'dept-a', name: '  総務部  ', enabled: true }], updatedAt: '2026-09-15T00:00:00.000Z' };
    const saved = await store.save(scope, 'organization', raw);
    expect(saved.departments[0]).toEqual({ id: 'dept-a', name: '総務部', enabled: true });
    expect(await repository.get(scope, 'organization')).toEqual(saved);
  });

  it('異常: 検証に通らない値は ExpenseDomainError で、何も保存しない', async () => {
    const invalid = { departments: [{ id: 'dept-a', name: '総務部', enabled: true, parentId: 'missing' }], updatedAt: '2026-09-15T00:00:00.000Z' };
    await expect(store.save(scope, 'organization', invalid)).rejects.toThrow(ExpenseDomainError);
    expect(await repository.get(scope, 'organization')).toBeNull();
  });

  it('例外: 保存先の失敗はそのまま伝える', async () => {
    vi.spyOn(repository, 'save').mockRejectedValue(new Error('disk full'));
    await expect(store.save(scope, 'organization', fixtureOrganization())).rejects.toThrow('disk full');
  });
});

describe('organizationReader', () => {
  it('正常: 未保存なら空の組織、保存後は保存した組織を返す', async () => {
    const reader = organizationReader(store);
    expect(await reader.get(scope)).toEqual(defaultExpenseSettings('organization'));
    await store.save(scope, 'organization', fixtureOrganization());
    expect((await reader.get(scope)).departments.map((department) => department.id)).toEqual(['dept-admin', 'dept-sales', 'dept-accounting']);
  });
});
