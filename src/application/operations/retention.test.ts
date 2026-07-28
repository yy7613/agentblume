/**
 * 保持期限（retention）に監査ログが合流していることのテスト。
 *
 * 監査ログは trace（既定14日）よりずっと長く残す（既定365日）。同じ「保持期限を適用」の
 * 1操作で両方が掃除されること、監査の台帳を渡していない配線でも従来どおり動くことを見る。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryAuditLogRepository } from '../../adapters/storage/in-memory-audit-log-repository';
import { InMemoryOperationsRepository } from '../../adapters/storage/in-memory-operations-repository';
import { InMemoryRunRepository } from '../../adapters/storage/in-memory-run-repository';
import { DEFAULT_RETENTION_DAYS } from '../../domain/operations/operations';
import { createAuditEntry } from '../../domain/security/audit';
import { RetentionUseCase } from './retention';

const scope = { tenantId: 'acme', workspaceId: 'ops' };
const NOW = new Date('2026-07-28T00:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function setup(withAudit = true) {
  const runs = new InMemoryRunRepository();
  const operations = new InMemoryOperationsRepository();
  const audit = new InMemoryAuditLogRepository();
  const retention = new RetentionUseCase(runs, operations, () => NOW, undefined, withAudit ? audit : undefined);
  return { audit, operations, retention };
}

describe('RetentionUseCase と監査ログ', () => {
  it('既定ポリシーは監査を365日残す（traceよりずっと長い）', async () => {
    const { retention } = setup();
    const policy = await retention.get(scope);
    expect(policy).toMatchObject({ auditDays: DEFAULT_RETENTION_DAYS.audit, traceDays: DEFAULT_RETENTION_DAYS.trace });
    expect(policy.auditDays).toBeGreaterThan(policy.traceDays);
  });

  it('保持期限を過ぎた監査エントリだけを消す', async () => {
    const { audit, retention } = setup();
    for (const days of [400, 366, 300, 1]) {
      await audit.record(createAuditEntry({ at: daysAgo(days), subject: 'alice', scope, action: 'delete', resource: { kind: 'tool' }, outcome: 'succeeded' }));
    }
    const result = await retention.apply(scope);
    expect(result.auditDeleted).toBe(2);
    expect((await audit.list(scope)).map((entry) => entry.at)).toEqual([daysAgo(1), daysAgo(300)]);
  });

  it('保持期間を保存すれば監査にも効く', async () => {
    const { audit, retention } = setup();
    await audit.record(createAuditEntry({ at: daysAgo(10), subject: 'alice', scope, action: 'operate', resource: { kind: 'workspace' }, outcome: 'succeeded' }));
    await retention.save({ scope, payloadDays: 30, traceDays: 14, aggregateDays: 365, auditDays: 5 });
    expect((await retention.apply(scope)).auditDeleted).toBe(1);
    expect(await audit.list(scope)).toEqual([]);
  });

  it('監査の台帳を渡していない配線でも保持期限は動く（0件として報告する）', async () => {
    const { retention } = setup(false);
    await expect(retention.apply(scope)).resolves.toMatchObject({ auditDeleted: 0 });
  });

  it('全スコープ一括でも監査の削除件数を合算する', async () => {
    const { audit, retention } = setup();
    await audit.record(createAuditEntry({ at: daysAgo(400), subject: 'alice', scope, action: 'delete', resource: { kind: 'tool' }, outcome: 'succeeded' }));
    const swept = await retention.applyAll([scope]);
    expect(swept).toMatchObject({ scopes: 1, failures: 0, auditDeleted: 1 });
  });
});
