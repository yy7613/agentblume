// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { HarnessPoliciesDto, HarnessSummaryDto, SerializedAgentHarnessDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { HarnessBuilder } from './HarnessBuilder';

afterEach(cleanup);

const testPolicies: HarnessPoliciesDto = {
  budget: { maxDurationMs: 120000, maxParticipantRuns: 20, maxModelRounds: 40, maxToolCalls: 100, maxParallelism: 4 },
  context: 'task-only',
  planning: { enabled: false, requireApproval: false },
  memory: { wikiIds: [], sessionWorkspace: true },
  approvals: { mode: 'inherit-agent' },
  failure: { mode: 'fail-fast' },
};

// 一覧からOpenした時に返す保存済みHarness。handoffのnon-preset id/labelを使い、populateEditorFromHarnessが
// presetに頼らずsaved label/purpose/assignmentをそのまま復元することを検証する。
const existingHarnessSummary: HarnessSummaryDto = { internalId: 'existing-harness', displayName: 'Existing Harness', publishName: 'existing_harness', latestVersion: '2.0.0', pattern: 'handoff', state: 'draft' };
const existingHarnessDto: SerializedAgentHarnessDto = {
  metadata: { internalId: 'existing-harness', workingName: 'Existing Harness draft', displayName: 'Existing Harness', publishName: 'existing_harness', version: '2.0.0', owner: 'owner@example.com', state: 'draft', tenant: { tenantId: 'local', workspaceId: 'default' } },
  pattern: 'handoff',
  slots: [
    { id: 'intake', label: 'Intake', purpose: 'Understand the request.', assignment: { internalId: 'agent-a', version: '1.0.0' } },
    { id: 'fulfillment', label: 'Fulfillment', purpose: 'Handle the request.', assignment: { internalId: 'agent-b', version: '2.0.0' } },
  ],
  topology: { pattern: 'handoff', startSlotId: 'intake', transitions: [{ fromSlotId: 'intake', toSlotId: 'fulfillment', condition: 'needs fulfillment' }], autonomous: false },
  policies: testPolicies,
  output: { format: 'text' },
};

function stubClient(): ToolApiClient {
  return {
    listAgents: vi.fn().mockResolvedValue([
      { internalId: 'agent-a', displayName: 'Agent A', publishName: 'agent_a', latestVersion: '1.0.0', kind: 'normal', state: 'draft' },
      { internalId: 'agent-b', displayName: 'Agent B', publishName: 'agent_b', latestVersion: '2.0.0', kind: 'normal', state: 'draft' },
    ]),
    listHarnesses: vi.fn().mockResolvedValue([]),
    getHarness: vi.fn(),
    deleteHarness: vi.fn().mockResolvedValue(undefined),
    validateHarness: vi.fn(),
    saveHarness: vi.fn(),
    runHarness: vi.fn(),
  } as unknown as ToolApiClient;
}

// saveHarnessの呼び出し引数を検証するテスト用: metadata.versionを返すresolveされたPromiseにしておく。
function stubClientWithSave(): ToolApiClient {
  const client = stubClient();
  (client.saveHarness as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
  return client;
}

async function fillMetadata(internalId: string, displayName: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Internal ID'), internalId);
  await userEvent.type(screen.getByLabelText('Display name'), displayName);
  await userEvent.type(screen.getByLabelText('Owner'), 'owner@example.com');
}

// Layer 1（一覧）が既定viewのため、editorの挙動を検証するテストはNew harnessボタン経由で遷移してから始める。
async function openNewHarnessEditor(client: ToolApiClient, language: 'en' | 'ja' = 'en') {
  const label = language === 'ja' ? '新規作成' : 'New multi-agent';
  const rendered = language === 'ja'
    ? render(<I18nProvider initialLanguage="ja"><HarnessBuilder client={client} /></I18nProvider>)
    : render(<HarnessBuilder client={client} />);
  await userEvent.click(await screen.findByRole('button', { name: label }));
  return rendered;
}

describe('HarnessBuilder', () => {
  it('patternを切り替えるとslot名・badge・inspector・canvas構造が変わる', async () => {
    const client = stubClient();
    const { container } = await openNewHarnessEditor(client);

    // Sequential preset (既定) は author/reviewer/publisher を横一列chainで表示する。
    expect(await screen.findByLabelText('Assign agent to Author')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Reviewer')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Publisher')).toBeTruthy();
    expect(container.querySelector('.harness-role-badge')).toBeNull();
    expect(container.querySelector('.harness-canvas--sequential .harness-chain')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /^Magentic/ }));

    // Magenticへ切り替えるとslotがManager/Researcher/Coderへ入れ替わり、hub&spoke構造＋ledger chipが現れる。
    expect(await screen.findByLabelText('Assign agent to Manager')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Researcher')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Coder')).toBeTruthy();
    expect(screen.queryByLabelText('Assign agent to Author')).toBeNull();

    const badge = container.querySelector('.harness-role-badge');
    expect(badge?.textContent).toBe('Manager');

    expect(screen.getByText('Max rounds: 6')).toBeTruthy();
    expect(container.querySelector('.harness-canvas--magentic .harness-hub-layout')).toBeTruthy();
    expect(screen.getByText('Plan / Progress ledger · max 6 rounds')).toBeTruthy();
    expect(screen.getAllByText('delegate')).toHaveLength(2);
  });

  it('patternごとにcanvasの構造（分岐・hub&spoke・handoff route）が異なる', async () => {
    const client = stubClient();
    const { container } = await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');

    // Concurrent: branchが縦に積まれ、slotではないaggregation nodeが現れる。
    // (canvasへscopeする: inspectorのtopology summaryも同じ正規化文字列"Aggregation: collect"を含むため)
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));
    const concurrentCanvas = await screen.findByLabelText('Multi-agent canvas');
    expect(within(concurrentCanvas).getByText('Aggregation: collect')).toBeTruthy();
    expect(container.querySelectorAll('.harness-canvas--concurrent .harness-branch')).toHaveLength(3);

    // Agent as tools: coordinatorがhub、2人のparticipantへdashedのask連携が伸びる。
    await userEvent.click(screen.getByRole('button', { name: /^Agent as tools/ }));
    const agentAsToolsCanvas = await screen.findByLabelText('Multi-agent canvas');
    expect(within(agentAsToolsCanvas).getAllByText('ask')).toHaveLength(2);
    expect(container.querySelector('.harness-canvas--agent-as-tools .harness-hub-layout')).toBeTruthy();

    // Handoff: start slotから2本のhandoff routeが伸びる。
    await userEvent.click(screen.getByRole('button', { name: /^Handoff/ }));
    const handoffCanvas = await screen.findByLabelText('Multi-agent canvas');
    expect(within(handoffCanvas).getAllByText('handoff')).toHaveLength(2);
    expect(container.querySelectorAll('.harness-canvas--handoff .harness-handoff-route')).toHaveLength(2);

    // Group Chat: slotではないround-robin hubが現れる。
    await userEvent.click(screen.getByRole('button', { name: /^Group Chat/ }));
    const groupChatCanvas = await screen.findByLabelText('Multi-agent canvas');
    expect(within(groupChatCanvas).getByText('Round-robin · max 3 rounds')).toBeTruthy();
    expect(container.querySelector('.harness-canvas--group-chat .harness-hub-layout')).toBeTruthy();
  });

  it('pattern切り替え後もindex位置のAgent割り当てを保持する', async () => {
    const client = stubClient();
    await openNewHarnessEditor(client);

    const authorSelect = await screen.findByLabelText('Assign agent to Author') as HTMLSelectElement;
    await userEvent.selectOptions(authorSelect, 'agent-a');
    expect(authorSelect.value).toBe('agent-a');

    await userEvent.click(screen.getByRole('button', { name: /^Magentic/ }));

    const managerSelect = await screen.findByLabelText('Assign agent to Manager') as HTMLSelectElement;
    expect(managerSelect.value).toBe('agent-a');
  });

  it('日本語設定ではslot名・pattern note・入力出力nodeを日本語で表示する', async () => {
    const client = stubClient();
    await openNewHarnessEditor(client, 'ja');

    // 見出しの英語素通し（'Multi-Agent Builder'）を残さない。
    expect(screen.getByText('マルチエージェントビルダー')).toBeTruthy();
    expect(screen.queryByText('Multi-Agent Builder')).toBeNull();
    expect(await screen.findByLabelText('Agentを割り当て 作成者')).toBeTruthy();
    expect(screen.getByLabelText('Agentを割り当て レビュアー')).toBeTruthy();
    expect(screen.getByLabelText('Agentを割り当て 公開担当')).toBeTruthy();

    const canvas = screen.getByLabelText('マルチエージェントキャンバス');
    expect(within(canvas).getByText('入力')).toBeTruthy();
    expect(within(canvas).getByText('出力')).toBeTruthy();

    // note文言は presets 一覧と inspector の両方に表示されるため getAllByText で確認する。
    expect(screen.getAllByText('順番に受け渡して仕上げる').length).toBeGreaterThanOrEqual(1);
  });

  it('concurrentのaggregationをmechanical(collect/vote)とAI(agent)で切り替えられる', async () => {
    const client = stubClientWithSave();
    await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));

    const aggregationSelect = await screen.findByLabelText('Aggregation') as HTMLSelectElement;
    expect(aggregationSelect.value).toBe('collect');

    // vote: hub chipの表示とtopologyのaggregation値が切り替わる（aggregatorSlotIdは付与しない）。
    await userEvent.selectOptions(aggregationSelect, 'vote');
    const canvas = screen.getByLabelText('Multi-agent canvas');
    expect(within(canvas).getByText('Aggregation: vote')).toBeTruthy();

    // agent: fan-in位置にaggregator専用cardが現れ、参加者columnには含まれない。
    await userEvent.selectOptions(aggregationSelect, 'agent');
    const aggregatorSelect = await screen.findByLabelText('Assign agent to Aggregator') as HTMLSelectElement;
    await userEvent.selectOptions(aggregatorSelect, 'agent-b');

    await fillMetadata('concurrent-agg', 'Concurrent Agg');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Research'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Legal'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Marketing'), 'agent-a');

    const saveButton = screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    await userEvent.click(saveButton);

    expect(client.saveHarness).toHaveBeenCalledWith(expect.objectContaining({
      topology: expect.objectContaining({ pattern: 'concurrent', aggregation: 'agent', aggregatorSlotId: 'aggregator', participantSlotIds: ['research', 'legal', 'marketing'] }),
      slots: expect.arrayContaining([expect.objectContaining({ id: 'aggregator', assignment: { internalId: 'agent-b', version: '2.0.0' } })]),
    }));
  });

  it('vote集約はaggregatorSlotIdを付けずに保存できる', async () => {
    const client = stubClientWithSave();
    await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));
    await userEvent.selectOptions(await screen.findByLabelText('Aggregation'), 'vote');

    await fillMetadata('concurrent-vote', 'Concurrent Vote');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Research'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Legal'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Marketing'), 'agent-a');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));

    expect(client.saveHarness).toHaveBeenCalledWith(expect.objectContaining({
      topology: { pattern: 'concurrent', participantSlotIds: ['research', 'legal', 'marketing'], aggregation: 'vote' },
    }));
    // 保存成功は保存ボタン近傍にも明示する。
    expect(await screen.findByText('Saved · version 1.0.0')).toBeTruthy();
  });

  it('participant slotを追加・削除でき、最小件数では削除controlが消える', async () => {
    const client = stubClient();
    await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');

    // sequential既定は3 slot。追加すると4番目のparticipantが現れる。
    await userEvent.click(screen.getByRole('button', { name: '+ Add participant' }));
    expect(await screen.findByLabelText('Assign agent to Participant 4')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Remove slot Participant 4' }));
    expect(screen.queryByLabelText('Assign agent to Participant 4')).toBeNull();

    // sequentialの最小件数(2)まで減らすと、残りのslotから削除controlが消える。
    await userEvent.click(screen.getByRole('button', { name: 'Remove slot Author' }));
    expect(screen.queryByLabelText('Assign agent to Author')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove slot/ })).toBeNull();

    // agent-as-tools / magentic: 固定先頭slot（coordinator/manager）には削除controlが出ない。
    await userEvent.click(screen.getByRole('button', { name: /^Agent as tools/ }));
    await screen.findByLabelText('Assign agent to Coordinator');
    expect(screen.queryByRole('button', { name: 'Remove slot Coordinator' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /^Magentic/ }));
    await screen.findByLabelText('Assign agent to Manager');
    expect(screen.queryByRole('button', { name: 'Remove slot Manager' })).toBeNull();
  });

  it('slot labelを編集すると割り当てselectのaria-labelと保存内容へ反映される', async () => {
    const client = stubClientWithSave();
    await openNewHarnessEditor(client);
    const labelInput = await screen.findByLabelText('Slot label author') as HTMLInputElement;
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Lead Writer');

    expect(await screen.findByLabelText('Assign agent to Lead Writer')).toBeTruthy();
    expect(screen.queryByLabelText('Assign agent to Author')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Lead Writer'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Reviewer'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Publisher'), 'agent-b');
    await fillMetadata('label-edit', 'Label Edit');

    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));

    expect(client.saveHarness).toHaveBeenCalledWith(expect.objectContaining({
      slots: expect.arrayContaining([expect.objectContaining({ id: 'author', label: 'Lead Writer' })]),
    }));
  });

  it('concurrent+agent集約はaggregator割り当てが済むまでSaveを無効化する', async () => {
    const client = stubClient();
    await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));
    await fillMetadata('ready-check', 'Ready Check');
    await userEvent.selectOptions(await screen.findByLabelText('Assign agent to Research'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Legal'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Marketing'), 'agent-a');
    await userEvent.selectOptions(await screen.findByLabelText('Aggregation'), 'agent');

    const saveButton = screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText('Assign a saved Agent version to the Aggregator slot.')).toBeTruthy();

    await userEvent.selectOptions(await screen.findByLabelText('Assign agent to Aggregator'), 'agent-b');
    expect(saveButton.disabled).toBe(false);
  });

  it('保存できない理由を、検証ボタンを押さなくてもボタン近傍へ表示する', async () => {
    const client = stubClient();
    await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');

    expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Required fields are empty: Internal ID, Display name, Owner.')).toBeTruthy();
    expect(screen.getByText('Assign a saved Agent version to every slot: Author, Reviewer, Publisher.')).toBeTruthy();

    await fillMetadata('reason-check', 'Reason Check');
    expect(screen.queryByText(/Required fields are empty/)).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Author'), 'agent-a');
    expect(screen.getByText('Assign a saved Agent version to every slot: Reviewer, Publisher.')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Reviewer'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Publisher'), 'agent-b');
    expect(screen.queryByText(/Assign a saved Agent version to every slot/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('「previewで実行可能」は検証・保存が通るまで緑表示にしない', async () => {
    const client = stubClientWithSave();
    (client.validateHarness as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true, issues: [] });
    const { container } = await openNewHarnessEditor(client);
    await screen.findByLabelText('Assign agent to Author');

    // 全slot未割当では緑バッジを出さない（以前は条件式なしのハードコードで常に緑だった）。
    expect(screen.queryByText('Executable in preview')).toBeNull();
    expect(screen.getByText('Definition incomplete')).toBeTruthy();
    expect(container.querySelector('.harness-inspector .validation-status.good')).toBeNull();

    await fillMetadata('status-check', 'Status Check');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Author'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Reviewer'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Publisher'), 'agent-b');
    expect(screen.getByText('Not validated yet')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Executable in preview')).toBeTruthy();
    expect(container.querySelector('.harness-inspector .validation-status.good')).toBeTruthy();

    (client.validateHarness as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false, issues: [{ path: 'topology', message: 'needs two slots' }] });
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation failed')).toBeTruthy();
    expect(screen.queryByText('Executable in preview')).toBeNull();
  });

  it('slot目的文は全文をtitleで読めるようにし、はみ出しは省略記号で示す', async () => {
    const client = stubClient();
    await openNewHarnessEditor(client, 'ja');
    const purpose = await screen.findByLabelText('Slotの目的 author') as HTMLInputElement;
    expect(purpose.title).toBe('最初の成果物を作成する。');
    expect(purpose.style.textOverflow).toBe('ellipsis');
  });

  describe('一覧（Layer 1）', () => {
    it('listHarnessesの内容を一覧表示する', async () => {
      const client = stubClient();
      (client.listHarnesses as ReturnType<typeof vi.fn>).mockResolvedValue([existingHarnessSummary]);
      render(<HarnessBuilder client={client} />);

      expect(await screen.findByText('Existing Harness')).toBeTruthy();
      expect(screen.getByText('existing_harness@2.0.0')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    });

    it('Harnessが無い場合はempty stateを表示する', async () => {
      const client = stubClient();
      render(<HarnessBuilder client={client} />);
      expect(await screen.findByText('No multi-agents yet.')).toBeTruthy();
    });

    it('OpenでgetHarnessの内容をeditorへ復元し、Internal IDを読み取り専用にする', async () => {
      const client = stubClient();
      (client.listHarnesses as ReturnType<typeof vi.fn>).mockResolvedValue([existingHarnessSummary]);
      (client.getHarness as ReturnType<typeof vi.fn>).mockResolvedValue(existingHarnessDto);
      const { container } = render(<HarnessBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
      expect(client.getHarness).toHaveBeenCalledWith('existing-harness', expect.any(Object));

      // handoffのnon-preset slot（intake/fulfillment）がlabel・assignmentとも保存値のまま復元される。
      const intakeSelect = await screen.findByLabelText('Assign agent to Intake') as HTMLSelectElement;
      expect(intakeSelect.value).toBe('agent-a');
      const fulfillmentSelect = screen.getByLabelText('Assign agent to Fulfillment') as HTMLSelectElement;
      expect(fulfillmentSelect.value).toBe('agent-b');
      expect(container.querySelector('.harness-canvas--handoff .harness-handoff-row')).toBeTruthy();

      const internalIdInput = screen.getByLabelText('Internal ID') as HTMLInputElement;
      expect(internalIdInput.value).toBe('existing-harness');
      expect(internalIdInput.readOnly).toBe(true);
    });

    it('Deleteは確認ダイアログの承諾後にdeleteHarnessを呼び、一覧を再取得する', async () => {
      const client = stubClient();
      (client.listHarnesses as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([existingHarnessSummary])
        .mockResolvedValueOnce([]);
      render(<HarnessBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('Existing Harness');
      expect(client.deleteHarness).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(client.deleteHarness).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

      expect(client.deleteHarness).toHaveBeenCalledWith('existing-harness', expect.any(Object));
      expect(client.listHarnesses).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('No multi-agents yet.')).toBeTruthy();
    });

    it('Back to listでeditorから一覧へ戻り、一覧を再取得する', async () => {
      const client = stubClient();
      await openNewHarnessEditor(client);
      expect(client.listHarnesses).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole('button', { name: 'Back to list' }));

      expect(await screen.findByRole('heading', { name: 'Multi-Agents' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'New multi-agent' })).toBeTruthy();
      expect(client.listHarnesses).toHaveBeenCalledTimes(2);
    });
  });
});
