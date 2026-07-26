import { expect } from 'vitest';
import { createModelSettings } from '../../domain/model-settings/model-settings';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import type { TenantScope } from '../../domain/tool/ids';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const otherTenant: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

const sealed = { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: 'ZGF0YQ==', hint: 'cdef' } as const;

/** ModelSettingsRepository 実装が満たすべき共有契約。 */
export async function modelSettingsRepositoryContract(repo: ModelSettingsRepository): Promise<void> {
  // 未保存は null（= env 既定を使う状態）。
  expect(await repo.find(scope)).toBeNull();

  const settings = createModelSettings({
    scope,
    main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b', apiKey: sealed },
    judge: { source: 'registry', model: 'openai/gpt-4o-mini' },
    updatedAt: '2026-07-26T00:00:00.000Z',
  });
  await repo.save(settings);
  expect(await repo.find(scope)).toEqual(settings);

  // save は upsert（版を持たない）。スロットを消した状態も保存できる。
  const revised = createModelSettings({ scope, judge: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T01:00:00.000Z' });
  await repo.save(revised);
  const reloaded = await repo.find(scope);
  expect(reloaded).toEqual(revised);
  expect(reloaded?.main).toBeUndefined();

  // テナント分離: 別テナント・別ワークスペースからは見えない。
  expect(await repo.find(otherTenant)).toBeNull();
  expect(await repo.find(otherWorkspace)).toBeNull();
  const otherSettings = createModelSettings({ scope: otherWorkspace, main: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T02:00:00.000Z' });
  await repo.save(otherSettings);
  expect(await repo.find(otherWorkspace)).toEqual(otherSettings);
  expect(await repo.find(scope)).toEqual(revised);

  // 保存した値は複製され、リポジトリ内部の状態が呼び出し側の参照経由で壊れない。
  const loaded = await repo.find(scope);
  expect(loaded).not.toBe(revised);
}
