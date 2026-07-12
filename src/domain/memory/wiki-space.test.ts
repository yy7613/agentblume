import { describe, expect, it } from 'vitest';
import { createWikiSpace, reviseWikiSpace } from './wiki-space';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('WikiSpace', () => {
  it('名前付きWikiを作成・改訂しIDと作成時刻を固定する', () => {
    const created = createWikiSpace({ id: ' customer-a ', tenant: scope, name: ' Customer A ', description: ' knowledge ', createdAt: '2026-07-11T00:00:00.000Z' });
    expect(created).toEqual({ id: 'customer-a', tenant: scope, name: 'Customer A', description: 'knowledge', createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z' });
    expect(reviseWikiSpace(created, { name: 'Customer A v2', updatedAt: '2026-07-12T00:00:00.000Z' })).toMatchObject({ id: 'customer-a', name: 'Customer A v2', description: '', createdAt: created.createdAt, updatedAt: '2026-07-12T00:00:00.000Z' });
  });
  it('空ID・名前を拒否する', () => {
    expect(() => createWikiSpace({ id: '', tenant: scope, name: 'x', createdAt: 'now' })).toThrow(/id/);
    expect(() => createWikiSpace({ id: 'x', tenant: scope, name: ' ', createdAt: 'now' })).toThrow(/name/);
  });
});
