import type { AgentHarness } from '../../domain/harness/agent-harness';
import type { SideEffect } from '../../domain/tool/metadata';

export interface ExecutableHarnessNode { readonly id: string; readonly kind: 'input' | 'participant' | 'output'; readonly slotId?: string; }
export interface ExecutableHarnessEdge { readonly from: string; readonly to: string; readonly label?: string; }
export interface ExecutableHarness {
  readonly harnessRef: { readonly internalId: string; readonly version: string };
  readonly pattern: AgentHarness['pattern'];
  readonly nodes: readonly ExecutableHarnessNode[];
  readonly edges: readonly ExecutableHarnessEdge[];
  readonly entryNodeId: string;
  readonly outputNodeId: string;
  /** M1は保存済みAgentの存在を保証する。実効副作用はRuntimeでAgent実行前に再検証する。 */
  readonly effectiveSideEffect: SideEffect;
}

export class CompileHarnessUseCase {
  execute(harness: AgentHarness): ExecutableHarness {
    const nodes: ExecutableHarnessNode[] = [{ id: 'input', kind: 'input' }, ...harness.slots.map((slot) => ({ id: `slot:${slot.id}`, kind: 'participant' as const, slotId: slot.id })), { id: 'output', kind: 'output' }];
    const edges = this.edges(harness);
    return { harnessRef: { internalId: harness.metadata.internalId, version: harness.metadata.version.toString() }, pattern: harness.pattern, nodes, edges, entryNodeId: 'input', outputNodeId: 'output', effectiveSideEffect: 'read-only' };
  }
  private edges(harness: AgentHarness): ExecutableHarnessEdge[] {
    const slot = (id: string) => `slot:${id}`;
    const topology = harness.topology;
    switch (topology.pattern) {
      case 'sequential': return [{ from: 'input', to: slot(topology.orderedSlotIds[0]!) }, ...topology.orderedSlotIds.slice(1).map((id, index) => ({ from: slot(topology.orderedSlotIds[index]!), to: slot(id) })), { from: slot(topology.orderedSlotIds.at(-1)!), to: 'output' }];
      case 'concurrent': {
        const branches = topology.participantSlotIds.map((id) => ({ from: 'input', to: slot(id) }));
        if (topology.aggregation !== 'agent') return [...branches, ...topology.participantSlotIds.map((id) => ({ from: slot(id), to: 'output' }))];
        const aggregator = slot(topology.aggregatorSlotId!);
        return [...branches, ...topology.participantSlotIds.map((id) => ({ from: slot(id), to: aggregator })), { from: aggregator, to: 'output' }];
      }
      case 'agent-as-tools': return [{ from: 'input', to: slot(topology.coordinatorSlotId) }, ...topology.participantSlotIds.flatMap((id) => [{ from: slot(topology.coordinatorSlotId), to: slot(id) }, { from: slot(id), to: slot(topology.coordinatorSlotId) }]), { from: slot(topology.coordinatorSlotId), to: 'output' }];
      case 'handoff': return [{ from: 'input', to: slot(topology.startSlotId) }, ...topology.transitions.map((transition) => ({ from: slot(transition.fromSlotId), to: slot(transition.toSlotId), label: transition.condition })), ...harness.slots.map((item) => ({ from: slot(item.id), to: 'output' }))];
      case 'group-chat': {
        // 進行役未指定(round-robin/fixed-order)は先頭参加者を図上のhubとして扱う。hub自身への自己辺は張らない
        // (明示managerはドメイン検証で参加者と排他。暗黙hubの場合も自己ループは実行トポロジとして無意味)。
        const hub = topology.managerSlotId ?? topology.participantSlotIds[0]!;
        return [
          { from: 'input', to: slot(hub) },
          ...topology.participantSlotIds.filter((id) => id !== hub).map((id) => ({ from: slot(hub), to: slot(id) })),
          ...topology.participantSlotIds.map((id) => ({ from: slot(id), to: 'output' })),
        ];
      }
      case 'magentic': return [{ from: 'input', to: slot(topology.managerSlotId) }, ...topology.participantSlotIds.flatMap((id) => [{ from: slot(topology.managerSlotId), to: slot(id) }, { from: slot(id), to: slot(topology.managerSlotId) }]), { from: slot(topology.managerSlotId), to: 'output' }];
    }
  }
}
