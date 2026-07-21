// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { I18nProvider } from '../i18n';
import { HarnessBuilder } from './HarnessBuilder';

afterEach(cleanup);

function stubClient(): ToolApiClient {
  return {
    listAgents: vi.fn().mockResolvedValue([
      { internalId: 'agent-a', displayName: 'Agent A', publishName: 'agent_a', latestVersion: '1.0.0', kind: 'normal', state: 'draft' },
      { internalId: 'agent-b', displayName: 'Agent B', publishName: 'agent_b', latestVersion: '2.0.0', kind: 'normal', state: 'draft' },
    ]),
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

describe('HarnessBuilder', () => {
  it('patternを切り替えるとslot名・badge・inspector・canvas構造が変わる', async () => {
    const client = stubClient();
    const { container } = render(<HarnessBuilder client={client} />);

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
    const { container } = render(<HarnessBuilder client={client} />);
    await screen.findByLabelText('Assign agent to Author');

    // Concurrent: branchが縦に積まれ、slotではないaggregation nodeが現れる。
    // (canvasへscopeする: inspectorのtopology summaryも同じ正規化文字列"Aggregation: collect"を含むため)
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));
    const concurrentCanvas = await screen.findByLabelText('Harness canvas');
    expect(within(concurrentCanvas).getByText('Aggregation: collect')).toBeTruthy();
    expect(container.querySelectorAll('.harness-canvas--concurrent .harness-branch')).toHaveLength(3);

    // Agent as tools: coordinatorがhub、2人のparticipantへdashedのask連携が伸びる。
    await userEvent.click(screen.getByRole('button', { name: /^Agent as tools/ }));
    const agentAsToolsCanvas = await screen.findByLabelText('Harness canvas');
    expect(within(agentAsToolsCanvas).getAllByText('ask')).toHaveLength(2);
    expect(container.querySelector('.harness-canvas--agent-as-tools .harness-hub-layout')).toBeTruthy();

    // Handoff: start slotから2本のhandoff routeが伸びる。
    await userEvent.click(screen.getByRole('button', { name: /^Handoff/ }));
    const handoffCanvas = await screen.findByLabelText('Harness canvas');
    expect(within(handoffCanvas).getAllByText('handoff')).toHaveLength(2);
    expect(container.querySelectorAll('.harness-canvas--handoff .harness-handoff-route')).toHaveLength(2);

    // Group Chat: slotではないround-robin hubが現れる。
    await userEvent.click(screen.getByRole('button', { name: /^Group Chat/ }));
    const groupChatCanvas = await screen.findByLabelText('Harness canvas');
    expect(within(groupChatCanvas).getByText('Round-robin · max 3 rounds')).toBeTruthy();
    expect(container.querySelector('.harness-canvas--group-chat .harness-hub-layout')).toBeTruthy();
  });

  it('pattern切り替え後もindex位置のAgent割り当てを保持する', async () => {
    const client = stubClient();
    render(<HarnessBuilder client={client} />);

    const authorSelect = await screen.findByLabelText('Assign agent to Author') as HTMLSelectElement;
    await userEvent.selectOptions(authorSelect, 'agent-a');
    expect(authorSelect.value).toBe('agent-a');

    await userEvent.click(screen.getByRole('button', { name: /^Magentic/ }));

    const managerSelect = await screen.findByLabelText('Assign agent to Manager') as HTMLSelectElement;
    expect(managerSelect.value).toBe('agent-a');
  });

  it('日本語設定ではslot名・pattern note・入力出力nodeを日本語で表示する', async () => {
    const client = stubClient();
    render(<I18nProvider initialLanguage="ja"><HarnessBuilder client={client} /></I18nProvider>);

    expect(await screen.findByLabelText('Agentを割り当て 作成者')).toBeTruthy();
    expect(screen.getByLabelText('Agentを割り当て レビュアー')).toBeTruthy();
    expect(screen.getByLabelText('Agentを割り当て 公開担当')).toBeTruthy();

    const canvas = screen.getByLabelText('Harnessキャンバス');
    expect(within(canvas).getByText('入力')).toBeTruthy();
    expect(within(canvas).getByText('出力')).toBeTruthy();

    // note文言は presets 一覧と inspector の両方に表示されるため getAllByText で確認する。
    expect(screen.getAllByText('順番に受け渡して仕上げる').length).toBeGreaterThanOrEqual(1);
  });

  it('concurrentのaggregationをmechanical(collect/vote)とAI(agent)で切り替えられる', async () => {
    const client = stubClientWithSave();
    render(<HarnessBuilder client={client} />);
    await screen.findByLabelText('Assign agent to Author');
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));

    const aggregationSelect = await screen.findByLabelText('Aggregation') as HTMLSelectElement;
    expect(aggregationSelect.value).toBe('collect');

    // vote: hub chipの表示とtopologyのaggregation値が切り替わる（aggregatorSlotIdは付与しない）。
    await userEvent.selectOptions(aggregationSelect, 'vote');
    const canvas = screen.getByLabelText('Harness canvas');
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
    render(<HarnessBuilder client={client} />);
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
  });

  it('participant slotを追加・削除でき、最小件数では削除controlが消える', async () => {
    const client = stubClient();
    render(<HarnessBuilder client={client} />);
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
    render(<HarnessBuilder client={client} />);
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
    render(<HarnessBuilder client={client} />);
    await screen.findByLabelText('Assign agent to Author');
    await userEvent.click(screen.getByRole('button', { name: /^Concurrent/ }));
    await fillMetadata('ready-check', 'Ready Check');
    await userEvent.selectOptions(await screen.findByLabelText('Assign agent to Research'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Legal'), 'agent-a');
    await userEvent.selectOptions(screen.getByLabelText('Assign agent to Marketing'), 'agent-a');
    await userEvent.selectOptions(await screen.findByLabelText('Aggregation'), 'agent');

    const saveButton = screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    await userEvent.selectOptions(await screen.findByLabelText('Assign agent to Aggregator'), 'agent-b');
    expect(saveButton.disabled).toBe(false);
  });
});
