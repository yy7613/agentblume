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

describe('HarnessBuilder', () => {
  it('patternを切り替えるとslot名・badge・inspectorが変わる', async () => {
    const client = stubClient();
    const { container } = render(<HarnessBuilder client={client} />);

    // Sequential preset (既定) は author/reviewer/publisher を表示する。
    expect(await screen.findByLabelText('Assign agent to Author')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Reviewer')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Publisher')).toBeTruthy();
    expect(container.querySelector('.harness-role-badge')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /^Magentic/ }));

    // Magenticへ切り替えるとslotがManager/Researcher/Coderへ入れ替わる。
    expect(await screen.findByLabelText('Assign agent to Manager')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Researcher')).toBeTruthy();
    expect(screen.getByLabelText('Assign agent to Coder')).toBeTruthy();
    expect(screen.queryByLabelText('Assign agent to Author')).toBeNull();

    const badge = container.querySelector('.harness-role-badge');
    expect(badge?.textContent).toBe('Manager');

    expect(screen.getByText('Max rounds: 6')).toBeTruthy();
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
});
