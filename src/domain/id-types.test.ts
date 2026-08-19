/**
 * 型レベルテスト: ID 型(Flavor)の取り違え検出(ADR-0034)
 *
 * Flavor は素の string からの代入を許し(既存コード無修正)、異種 ID 間の代入のみを
 * コンパイルエラーにする。@ts-expect-error は typecheck ゲートで検証される
 * (誤りなら Unused directive で失格するため、拒否自体がテストになる)。
 */
import { describe, expect, it } from 'vitest';
import type { AgentId } from './agent/ids';
import type { SlotId } from './harness/ids';
import type { RunId } from './run/ids';
import type { TenantId, WorkspaceId } from './shared/tenant-scope';
import type { ToolId } from './tool/ids';

describe('ID types (flavored)', () => {
  it('accepts plain strings and rejects cross-ID assignment (type-level)', () => {
    const agentId: AgentId = 'agent-1';
    // @ts-expect-error AgentId → ToolId の代入は拒否される(取り違え検出)
    const toolId: ToolId = agentId;
    const runId: RunId = 'run-1';
    // @ts-expect-error RunId → SlotId の代入は拒否される
    const slotId: SlotId = runId;
    const tenantId: TenantId = 't1';
    // @ts-expect-error TenantId → WorkspaceId の代入は拒否される
    const workspaceId: WorkspaceId = tenantId;
    // 実行時表現は素の string のまま(ブランドはコンパイル後に消える)。
    expect([toolId, slotId, workspaceId]).toEqual(['agent-1', 'run-1', 't1']);
  });

  it('flows into string-typed sinks without conversion', () => {
    const join = (...parts: readonly string[]): string => parts.join('/');
    const toolId: ToolId = 'tool-1';
    const slotId: SlotId = 'slot-1';
    expect(join(toolId, slotId)).toBe('tool-1/slot-1');
  });
});
