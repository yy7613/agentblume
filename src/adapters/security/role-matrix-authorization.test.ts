/**
 * `RoleMatrixAuthorization` は domain の判定表を Port の形へ載せるだけの層。
 * ここで見るのは「表の結果がそのまま出ること」と「同期の判定を Promise で返すこと」。
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../domain/security/principal';
import { RoleMatrixAuthorization } from './role-matrix-authorization';

const principal = (roles: readonly string[]): Principal => ({ subject: 'alice', tenantId: 't', workspaceId: 'w', roles });

describe('RoleMatrixAuthorization', () => {
  const authorization = new RoleMatrixAuthorization();

  it('表どおりに許可する', async () => {
    await expect(authorization.authorize(principal(['editor']), 'create', { kind: 'tool' })).resolves.toEqual({ kind: 'allow' });
    await expect(authorization.authorize(principal(['operator']), 'read', { kind: 'audit-log' })).resolves.toEqual({ kind: 'allow' });
  });

  it('表どおりに拒否し、理由を返す', async () => {
    await expect(authorization.authorize(principal(['editor']), 'operate', { kind: 'workspace' }))
      .resolves.toEqual({ kind: 'deny', reason: "this operation requires the 'workspace:operate' permission" });
  });

  it('リソースを省略しても判定できる', async () => {
    await expect(authorization.authorize(principal(['workspace-admin']), 'manage-access')).resolves.toEqual({ kind: 'allow' });
  });
});
