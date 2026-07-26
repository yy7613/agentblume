import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAgentHarnessRepository } from '../../adapters/storage/in-memory-harness-repository';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { createAgent } from '../../domain/agent/agent';
import { createAgentHarness, type AgentSlot, type HarnessPattern, type HarnessTopology } from '../../domain/harness/agent-harness';
import { SemVer } from '../../domain/tool/semver';
import { CompileHarnessUseCase } from './compile-harness';
import { DeleteHarnessUseCase } from './delete-harness';
import { QueryHarnessesUseCase } from './query-harnesses';
import { SaveHarnessUseCase, type SaveHarnessInput } from './save-harness';
import { ValidateHarnessUseCase } from './validate-harness';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const version = SemVer.of(1, 0, 0);
const SLOT_IDS = ['writer', 'reviewer', 'publisher'] as const;

function slots(ids: readonly string[] = SLOT_IDS): AgentSlot[] {
  return ids.map((id) => ({ id, label: id, purpose: `${id} work`, assignment: { internalId: id, version } }));
}

function harnessOf(pattern: HarnessPattern, topology: HarnessTopology, ids: readonly string[] = SLOT_IDS) {
  return createAgentHarness({
    metadata: { internalId: 'content-review', workingName: 'w', displayName: 'Content review', publishName: 'content_review', version, owner: 'owner', state: 'draft', tenant: scope },
    pattern, slots: slots(ids), topology,
  });
}

function saveInput(overrides: Partial<SaveHarnessInput> = {}): SaveHarnessInput {
  return {
    scope, internalId: 'content-review', workingName: 'w', displayName: 'Content review', publishName: 'content_review', owner: 'owner',
    pattern: 'sequential', slots: slots(),
    topology: { pattern: 'sequential', orderedSlotIds: [...SLOT_IDS], contextMode: 'full-conversation' },
    ...overrides,
  };
}

async function agentRepoWithAll(ids: readonly string[] = SLOT_IDS): Promise<InMemoryAgentRepository> {
  const repo = new InMemoryAgentRepository();
  for (const id of ids) {
    await repo.save(createAgent({
      metadata: { internalId: id, workingName: id, displayName: id, publishName: id, version, owner: 'owner', state: 'draft', tenant: scope },
      kind: 'normal', systemPrompt: `You are ${id}.`, tools: [],
    }));
  }
  return repo;
}

describe('CompileHarnessUseCase', () => {
  const usecase = new CompileHarnessUseCase();

  it('入力・スロット・出力ノードとversion付きの参照を持つ実行形へ変換する', () => {
    const executable = usecase.execute(harnessOf('sequential', { pattern: 'sequential', orderedSlotIds: [...SLOT_IDS], contextMode: 'previous-response' }));
    expect(executable.harnessRef).toEqual({ internalId: 'content-review', version: '1.0.0' });
    expect(executable.entryNodeId).toBe('input');
    expect(executable.outputNodeId).toBe('output');
    // M1は保存済みAgentの存在だけを保証し、実効副作用はRuntimeで再検証する。
    expect(executable.effectiveSideEffect).toBe('read-only');
    expect(executable.nodes).toEqual([
      { id: 'input', kind: 'input' },
      { id: 'slot:writer', kind: 'participant', slotId: 'writer' },
      { id: 'slot:reviewer', kind: 'participant', slotId: 'reviewer' },
      { id: 'slot:publisher', kind: 'participant', slotId: 'publisher' },
      { id: 'output', kind: 'output' },
    ]);
  });

  it('sequentialは入力→各スロット→出力を1本の鎖に並べる', () => {
    const executable = usecase.execute(harnessOf('sequential', { pattern: 'sequential', orderedSlotIds: [...SLOT_IDS], contextMode: 'full-conversation' }));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:reviewer' },
      { from: 'slot:reviewer', to: 'slot:publisher' },
      { from: 'slot:publisher', to: 'output' },
    ]);
  });

  it('concurrentは集約方法がagentでなければ各分岐を直接出力へつなぐ', () => {
    const executable = usecase.execute(harnessOf('concurrent', { pattern: 'concurrent', participantSlotIds: ['writer', 'reviewer'], aggregation: 'collect' }));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'input', to: 'slot:reviewer' },
      { from: 'slot:writer', to: 'output' },
      { from: 'slot:reviewer', to: 'output' },
    ]);
  });

  it('concurrentの集約agentは全分岐を集めてから出力へつなぐ', () => {
    const executable = usecase.execute(harnessOf('concurrent', { pattern: 'concurrent', participantSlotIds: ['writer', 'reviewer'], aggregation: 'agent', aggregatorSlotId: 'publisher' }));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'input', to: 'slot:reviewer' },
      { from: 'slot:writer', to: 'slot:publisher' },
      { from: 'slot:reviewer', to: 'slot:publisher' },
      { from: 'slot:publisher', to: 'output' },
    ]);
  });

  it('agent-as-toolsは調整役と各参加者を往復する辺を張る', () => {
    const executable = usecase.execute(harnessOf('agent-as-tools', { pattern: 'agent-as-tools', coordinatorSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'] }));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:reviewer' },
      { from: 'slot:reviewer', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:publisher' },
      { from: 'slot:publisher', to: 'slot:writer' },
      { from: 'slot:writer', to: 'output' },
    ]);
  });

  it('handoffは遷移条件をラベルにし、どのスロットからも出力へ抜けられる', () => {
    const executable = usecase.execute(harnessOf('handoff', {
      pattern: 'handoff', startSlotId: 'writer', autonomous: true,
      transitions: [{ fromSlotId: 'writer', toSlotId: 'reviewer', condition: 'needs review' }],
    }, ['writer', 'reviewer']));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:reviewer', label: 'needs review' },
      { from: 'slot:writer', to: 'output' },
      { from: 'slot:reviewer', to: 'output' },
    ]);
  });

  it('group-chatはmanager未指定なら先頭参加者を進行役として扱う', () => {
    const executable = usecase.execute(harnessOf('group-chat', { pattern: 'group-chat', participantSlotIds: ['writer', 'reviewer'], selector: 'round-robin', maxRounds: 3 }));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:reviewer' },
      { from: 'slot:writer', to: 'output' },
      { from: 'slot:reviewer', to: 'output' },
    ]);
  });

  it('group-chatはmanager指定時にその進行役を起点にする', () => {
    const executable = usecase.execute(harnessOf('group-chat', { pattern: 'group-chat', participantSlotIds: ['writer', 'reviewer'], selector: 'agent', managerSlotId: 'publisher', maxRounds: 3 }));
    expect(executable.edges[0]).toEqual({ from: 'input', to: 'slot:publisher' });
    expect(executable.edges).toContainEqual({ from: 'slot:publisher', to: 'slot:reviewer' });
  });

  it('magenticはmanagerと各参加者を往復し、managerから出力へ抜ける', () => {
    const executable = usecase.execute(harnessOf('magentic', {
      pattern: 'magentic', managerSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'],
      maxRounds: 5, maxStalls: 1, maxResets: 1, requirePlanSignoff: false,
    }));
    expect(executable.edges).toEqual([
      { from: 'input', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:reviewer' },
      { from: 'slot:reviewer', to: 'slot:writer' },
      { from: 'slot:writer', to: 'slot:publisher' },
      { from: 'slot:publisher', to: 'slot:writer' },
      { from: 'slot:writer', to: 'output' },
    ]);
  });
});

describe('SaveHarnessUseCase', () => {
  let harnesses: InMemoryAgentHarnessRepository;
  let agents: InMemoryAgentRepository;
  let usecase: SaveHarnessUseCase;

  beforeEach(async () => {
    harnesses = new InMemoryAgentHarnessRepository();
    agents = await agentRepoWithAll();
    usecase = new SaveHarnessUseCase(harnesses, agents);
  });

  it('初回保存は1.0.0で、以降は既存の最新versionからbumpする', async () => {
    const first = await usecase.execute(saveInput());
    expect(first.metadata.version.toString()).toBe('1.0.0');

    const second = await usecase.execute(saveInput());
    expect(second.metadata.version.toString()).toBe('1.0.1');

    const third = await usecase.execute(saveInput({ bump: 'minor' }));
    expect(third.metadata.version.toString()).toBe('1.1.0');

    const major = await usecase.execute(saveInput({ bump: 'major' }));
    expect(major.metadata.version.toString()).toBe('2.0.0');
    expect((await harnesses.listVersions(scope, 'content-review')).map((item) => item.toString())).toEqual(['1.0.0', '1.0.1', '1.1.0', '2.0.0']);
  });

  it('最大versionから採番する（保存順が昇順でなくても）', async () => {
    await harnesses.save(createAgentHarness({
      metadata: { internalId: 'content-review', workingName: 'w', displayName: 'd', publishName: 'p', version: SemVer.of(2, 5, 0), owner: 'owner', state: 'draft', tenant: scope },
      pattern: 'sequential', slots: slots(), topology: { pattern: 'sequential', orderedSlotIds: [...SLOT_IDS], contextMode: 'full-conversation' },
    }));
    await harnesses.save(createAgentHarness({
      metadata: { internalId: 'content-review', workingName: 'w', displayName: 'd', publishName: 'p', version: SemVer.of(1, 9, 0), owner: 'owner', state: 'draft', tenant: scope },
      pattern: 'sequential', slots: slots(), topology: { pattern: 'sequential', orderedSlotIds: [...SLOT_IDS], contextMode: 'full-conversation' },
    }));

    const saved = await usecase.execute(saveInput({ bump: 'minor' }));
    expect(saved.metadata.version.toString()).toBe('2.6.0');
  });

  it('policies・output・stateの指定を保存内容へ引き継ぐ', async () => {
    const saved = await usecase.execute(saveInput({
      state: 'published', output: { format: 'text' },
      policies: {
        budget: { maxDurationMs: 60_000, maxParticipantRuns: 5, maxModelRounds: 10, maxToolCalls: 20, maxParallelism: 2 },
        context: 'full-conversation', planning: { enabled: true, requireApproval: true },
        memory: { wikiIds: ['ops'], sessionWorkspace: false },
        approvals: { mode: 'always' }, failure: { mode: 'collect' },
      },
    }));
    expect(saved.metadata.state).toBe('published');
    expect(saved.policies).toMatchObject({ context: 'full-conversation', approvals: { mode: 'always' }, failure: { mode: 'collect' } });
    expect(saved.policies.memory.wikiIds).toEqual(['ops']);
  });

  it('割り当てAgentが存在しなければ保存しない', async () => {
    await expect(usecase.execute(saveInput({
      slots: [...slots(['writer']), { id: 'ghost', label: 'ghost', purpose: 'p', assignment: { internalId: 'ghost', version } }],
      topology: { pattern: 'sequential', orderedSlotIds: ['writer', 'ghost'], contextMode: 'full-conversation' },
    }))).rejects.toThrow('SaveHarness: assigned agent not found: ghost@1.0.0');
    expect(await harnesses.listVersions(scope, 'content-review')).toEqual([]);
  });
});

describe('ValidateHarnessUseCase', () => {
  it('保存と同じ不変条件を副作用なしで適用する', async () => {
    const usecase = new ValidateHarnessUseCase(await agentRepoWithAll());
    await expect(usecase.execute(saveInput())).resolves.toEqual({ valid: true, issues: [] });
  });

  it('定義そのものが不正なら以降のAgent照合をせず1件だけ報告する', async () => {
    const usecase = new ValidateHarnessUseCase(new InMemoryAgentRepository());
    const result = await usecase.execute(saveInput({
      topology: { pattern: 'sequential', orderedSlotIds: ['writer', 'ghost'], contextMode: 'full-conversation' },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ path: '(definition)', message: expect.stringContaining('references unknown slot: ghost') }]);
  });

  it('未登録Agentの割り当てをslot位置つきで列挙する', async () => {
    const usecase = new ValidateHarnessUseCase(await agentRepoWithAll(['writer']));
    const result = await usecase.execute(saveInput());
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      { path: 'slots.1.assignment', message: 'Assigned agent not found: reviewer@1.0.0' },
      { path: 'slots.2.assignment', message: 'Assigned agent not found: publisher@1.0.0' },
    ]);
  });
});

describe('DeleteHarnessUseCase / QueryHarnessesUseCase', () => {
  let harnesses: InMemoryAgentHarnessRepository;

  beforeEach(async () => {
    harnesses = new InMemoryAgentHarnessRepository();
    const usecase = new SaveHarnessUseCase(harnesses, await agentRepoWithAll());
    await usecase.execute(saveInput());
    await usecase.execute(saveInput({ bump: 'minor' }));
  });

  it('最新版・version固定の取得と一覧を扱う', async () => {
    const query = new QueryHarnessesUseCase(harnesses);
    expect((await query.get(scope, 'content-review')).metadata.version.toString()).toBe('1.1.0');
    expect((await query.get(scope, 'content-review', SemVer.of(1, 0, 0))).metadata.version.toString()).toBe('1.0.0');
    expect((await query.versions(scope, 'content-review')).map((item) => item.toString())).toEqual(['1.0.0', '1.1.0']);
    expect(await query.list(scope)).toEqual([expect.objectContaining({ internalId: 'content-review', pattern: 'sequential' })]);
  });

  it('未存在・未存在versionはHarnessNotFoundErrorにする', async () => {
    const query = new QueryHarnessesUseCase(harnesses);
    await expect(query.get(scope, 'missing')).rejects.toThrow('Harness not found: missing');
    await expect(query.get(scope, 'content-review', SemVer.of(9, 9, 9))).rejects.toThrow('Harness not found: content-review@9.9.9');
  });

  it('論理削除は一覧と最新取得から外すが、version固定の参照は残す', async () => {
    const remove = new DeleteHarnessUseCase(harnesses);
    const query = new QueryHarnessesUseCase(harnesses);

    await expect(remove.execute(scope, 'content-review')).resolves.toBeUndefined();
    expect(await query.list(scope)).toEqual([]);
    await expect(query.get(scope, 'content-review')).rejects.toThrow('Harness not found: content-review');
    expect((await query.get(scope, 'content-review', SemVer.of(1, 0, 0))).metadata.displayName).toBe('Content review');
  });

  it('未存在・削除済みの削除はHarnessNotFoundErrorにする', async () => {
    const remove = new DeleteHarnessUseCase(harnesses);
    await expect(remove.execute(scope, 'missing')).rejects.toThrow('Harness not found: missing');
    await remove.execute(scope, 'content-review');
    await expect(remove.execute(scope, 'content-review')).rejects.toThrow('Harness not found: content-review');
  });
});
