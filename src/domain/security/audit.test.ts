/**
 * 監査エントリの組み立てと直列化。
 *
 * 一番守りたいのは「**秘密が台帳に残らない**」こと。`detail` は自由なキーを取る器なので、
 * ドメイン側で機械的に落ちることを確かめる（呼び出し側の注意力に依存させない）。
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_DETAIL_MAX_LENGTH,
  UNAUTHENTICATED_SUBJECT,
  createAuditEntry,
  deserializeAuditEntry,
  maskAuditDetail,
  serializeAuditEntry,
} from './audit';

const scope = { tenantId: 'acme', workspaceId: 'ops' };

describe('createAuditEntry', () => {
  it('スコープを平らに展開し、渡された値をそのまま持つ', () => {
    const entry = createAuditEntry({
      at: '2026-07-28T00:00:00.000Z', subject: 'alice', scope,
      action: 'delete', resource: { kind: 'tool', id: 'scores', version: '1.2.0' }, outcome: 'succeeded',
      detail: { method: 'DELETE', route: '/tools/:internalId', status: 204 },
    });
    expect(entry).toEqual({
      at: '2026-07-28T00:00:00.000Z', subject: 'alice', tenantId: 'acme', workspaceId: 'ops',
      action: 'delete', resource: { kind: 'tool', id: 'scores', version: '1.2.0' }, outcome: 'succeeded',
      detail: { method: 'DELETE', route: '/tools/:internalId', status: 204 },
    });
  });

  it('subject が空なら「誰か分からない誰か」を入れる', () => {
    expect(createAuditEntry({ at: 'now', subject: '', scope, action: 'read', resource: { kind: 'workspace' }, outcome: 'denied' }).subject)
      .toBe(UNAUTHENTICATED_SUBJECT);
  });

  it('detail に秘密っぽいキーがあれば捨てる', () => {
    const entry = createAuditEntry({
      at: 'now', subject: 'alice', scope, action: 'operate', resource: { kind: 'model-settings' }, outcome: 'succeeded',
      detail: {
        route: '/model-settings', apiKey: 'sk-live-1234', api_key: 'sk-live-1234', token: 'bearer-abc',
        password: 'hunter2', authorization: 'Bearer abc', cookie: 'session=1', clientSecret: 'shhh', provider: 'openai',
      },
    });
    expect(entry.detail).toEqual({ route: '/model-settings', provider: 'openai' });
    expect(JSON.stringify(entry)).not.toContain('sk-live-1234');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('detail の値はプリミティブだけ・長い文字列は切り詰める', () => {
    const long = 'x'.repeat(AUDIT_DETAIL_MAX_LENGTH + 50);
    const entry = createAuditEntry({
      at: 'now', subject: 'alice', scope, action: 'execute', resource: { kind: 'agent' }, outcome: 'failed',
      detail: { reason: long, nested: { a: 1 }, list: [1, 2], nothing: undefined, nan: Number.NaN, ok: true, count: 3 },
    });
    expect(entry.detail?.['reason']).toBe(`${'x'.repeat(AUDIT_DETAIL_MAX_LENGTH)}…`);
    expect(entry.detail).not.toHaveProperty('nested');
    expect(entry.detail).not.toHaveProperty('list');
    expect(entry.detail).not.toHaveProperty('nothing');
    expect(entry.detail).not.toHaveProperty('nan');
    expect(entry.detail?.['ok']).toBe(true);
    expect(entry.detail?.['count']).toBe(3);
  });

  it('detail が空（全部落ちた）なら detail 自体を持たない', () => {
    const entry = createAuditEntry({ at: 'now', subject: 'a', scope, action: 'read', resource: { kind: 'tool' }, outcome: 'allowed', detail: { token: 'x' } });
    expect(entry).not.toHaveProperty('detail');
    expect(maskAuditDetail(undefined)).toBeUndefined();
  });
});

describe('直列化', () => {
  it('往復しても等しい', () => {
    const entry = createAuditEntry({ at: '2026-07-28T00:00:00.000Z', subject: 'alice', scope, action: 'approve', resource: { kind: 'promotion', id: 'p1' }, outcome: 'succeeded', detail: { decision: 'approved' } });
    expect(deserializeAuditEntry(JSON.parse(JSON.stringify(serializeAuditEntry(entry))))).toEqual(entry);
  });

  it('値域外のアクション・結末は落ちる', () => {
    expect(() => deserializeAuditEntry({ at: 'now', subject: 'a', tenantId: 't', workspaceId: 'w', action: 'nuke', resource: { kind: 'tool' }, outcome: 'succeeded' })).toThrow();
    expect(() => deserializeAuditEntry({ at: 'now', subject: 'a', tenantId: 't', workspaceId: 'w', action: 'read', resource: { kind: 'tool' }, outcome: 'maybe' })).toThrow();
    expect(() => deserializeAuditEntry({ at: 'now', subject: 'a', tenantId: 't', workspaceId: 'w', action: 'read', resource: { kind: 'nope' }, outcome: 'succeeded' })).toThrow();
  });
});
