// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, SerializedAgentDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { AgentBuilder } from './AgentBuilder';

afterEach(cleanup);

// 一覧からOpenした時に返す保存済みAgent。
const existingAgentSummary: AgentSummaryDto = { internalId: 'existing-agent', displayName: 'Existing Agent', publishName: 'existing_agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' };
const existingAgentDto: SerializedAgentDto = {
  metadata: { internalId: 'existing-agent', workingName: 'Existing Agent draft', displayName: 'Existing Agent', publishName: 'existing_agent', version: '2.0.0', owner: 'owner@example.com', state: 'draft', tenant: { tenantId: 'local', workspaceId: 'default' } },
  kind: 'normal',
  systemPrompt: 'You are existing.',
  skills: [],
  tools: [{ internalId: 'scores', version: '2.0.0' }],
  agents: [],
};

function stubClient(): ToolApiClient {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    listWikis: vi.fn().mockResolvedValue([]),
    listMcpServers: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn(),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    generateAgentPrompt: vi.fn(),
    saveAgent: vi.fn(),
    runSavedAgent: vi.fn(),
  } as unknown as ToolApiClient;
}

// Layer 1（一覧）が既定viewのため、editorの挙動を検証するテストはNew agentボタン経由で遷移してから始める。
async function openNewAgentEditor(client: ToolApiClient, language: 'en' | 'ja' = 'en') {
  const label = language === 'ja' ? '新規作成' : 'New agent';
  const rendered = language === 'ja'
    ? render(<I18nProvider initialLanguage="ja"><AgentBuilder client={client} /></I18nProvider>)
    : render(<AgentBuilder client={client} />);
  await userEvent.click(await screen.findByRole('button', { name: label }));
  return rendered;
}

describe('AgentBuilder', () => {
  it('日本語設定では空の初期フォームに日本語プレースホルダーを表示する', async () => {
    const client = stubClient();
    await openNewAgentEditor(client, 'ja');
    expect((screen.getByLabelText('エージェント表示名') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('エージェント表示名') as HTMLInputElement).placeholder).toBe('例: サポートエージェント');
    expect((screen.getByLabelText('システムプロンプト') as HTMLTextAreaElement).placeholder).toBe('エージェントの役割、制約、応答スタイルを記述します。');
    // 空状態メッセージ・未入力理由も日本語で出す（ベタ書き英語/日本語を残さない）。
    expect(await screen.findByText('保存済みスキルがありません。')).toBeTruthy();
    expect(screen.getByText('保存済みツールがありません。')).toBeTruthy();
    expect(screen.getByText(/内部ID、作業名、表示名、公開名、所有者、システムプロンプトが未入力です。/)).toBeTruthy();
  });

  it('サーバー必須項目が未入力なら保存できず、未入力の項目名を理由として表示する', async () => {
    const client = stubClient();
    const { container } = await openNewAgentEditor(client);
    const save = screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.querySelectorAll('.required-mark').length).toBeGreaterThanOrEqual(6);
    expect(screen.getByText(/Required fields are empty: Internal ID, Working name, Display name, Publish name, Owner, System prompt/)).toBeTruthy();

    // systemPromptだけ埋めても内部ID等が残るためdisabledのまま（以前はここで押せてサーバー400になっていた）。
    await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'You are helpful.');
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/Required fields are empty: Internal ID, Working name, Display name, Publish name, Owner/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Agent internal ID'), 'support-agent');
    await userEvent.type(screen.getByLabelText('Working name'), 'Support draft');
    await userEvent.type(screen.getByLabelText('Agent display name'), 'Support Agent');
    await userEvent.type(screen.getByLabelText('Publish name'), 'support_agent');
    await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
    expect(save.disabled).toBe(false);
    expect(screen.queryByText(/Required fields are empty/)).toBeNull();
  });

  it('Tool未選択でも保存はブロックせず、データに答えられない旨の警告を表示する', async () => {
    const client = stubClient();
    (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft', sideEffect: 'read-only' }]);
    await openNewAgentEditor(client);
    const warning = 'No Tool is selected. This Agent cannot answer questions that need data.';
    expect(await screen.findByText(warning)).toBeTruthy();

    await userEvent.click(await screen.findByRole('checkbox', { name: /Score filter/ }));
    expect(screen.queryByText(warning)).toBeNull();
  });

  it('Skill・Tool・サブエージェント・Wikiの選択行に種別バッジを付ける', async () => {
    const client = stubClient();
    (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft', sideEffect: 'read-only' }]);
    (client.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue([{ internalId: 'analysis', displayName: 'Analysis skill', publishName: 'analysis', latestVersion: '1.1.0', state: 'draft' }]);
    (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
    (client.listWikis as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'customer-a', name: 'Customer A', description: 'A knowledge', updatedAt: 'now' }]);
    await openNewAgentEditor(client);

    const badgeOf = (checkboxName: RegExp) => screen.getByRole('checkbox', { name: checkboxName }).closest('label')?.querySelector('.validation-status')?.textContent;
    expect(badgeOf(/Analysis skill/)).toBe('Skill');
    expect(badgeOf(/Score filter/)).toBe('Tool');
    expect(badgeOf(/Existing Agent/)).toBe('Sub-agent');
    expect(badgeOf(/Use wiki Customer A/)).toBe('Wiki');
  });

  it('保存成功をボタン近傍に表示し、traceのerrorは種別と実メッセージを表示する', async () => {
    const client = stubClient();
    (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.2.0' } });
    (client.runSavedAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      runId: 'run-err', mode: 'preview', response: 'failed', usage: {}, agent: { internalId: 'support-agent', version: '1.2.0' },
      trace: [{ sequence: 1, kind: 'error', code: 'tool-failed', message: 'scores tool timed out' }],
    });
    await openNewAgentEditor(client);
    await userEvent.type(screen.getByLabelText('Agent internal ID'), 'support-agent');
    await userEvent.type(screen.getByLabelText('Working name'), 'Support draft');
    await userEvent.type(screen.getByLabelText('Agent display name'), 'Support Agent');
    await userEvent.type(screen.getByLabelText('Publish name'), 'support_agent');
    await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
    await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'You are helpful.');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText('Saved · version 1.2.0')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Agent chat message'), 'Run it');
    await userEvent.click(screen.getByRole('button', { name: 'Run saved agent' }));
    expect(await screen.findByText('tool-failed: scores tool timed out')).toBeTruthy();
  });

  it('Tool選択から草案生成・編集・version保存まで行う', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft', sideEffect: 'read-only' }]),
      listSkills: vi.fn().mockResolvedValue([{ internalId: 'analysis', displayName: 'Analysis skill', publishName: 'analysis', latestVersion: '1.1.0', state: 'draft' }]),
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'scorer-agent', displayName: 'Scorer Agent', publishName: 'scorer_agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }]),
      listWikis: vi.fn().mockResolvedValue([{ id: 'customer-a', name: 'Customer A', description: 'A knowledge', updatedAt: 'now' }]),
      listMcpServers: vi.fn().mockResolvedValue([]),
      getAgent: vi.fn().mockResolvedValue({ metadata: { internalId: 'scorer-agent', version: '1.0.0' }, kind: 'normal', systemPrompt: 'x', skills: [], tools: [{ internalId: 'scores', version: '2.0.0' }], agents: [] }),
      generateAgentPrompt: vi.fn().mockResolvedValue({ systemPromptDraft: '# Generated', sections: {}, editable: true, sources: [] }),
      saveAgent: vi.fn().mockResolvedValue({ metadata: { version: '1.0.0' } }),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-1', mode: 'preview', response: '{"answer":"done"}', structuredResponse: { answer: 'done' }, trace: [{ sequence: 1, kind: 'model-response', content: '{"answer":"done"}' }], usage: {}, agent: { internalId: 'assistant-agent', version: '1.0.0' } }),
    } as unknown as ToolApiClient;
    await openNewAgentEditor(client);
    await userEvent.type(screen.getByLabelText('Agent internal ID'), 'assistant-agent');
    await userEvent.type(screen.getByLabelText('Working name'), 'Assistant Agent');
    await userEvent.type(screen.getByLabelText('Agent display name'), 'Assistant Agent');
    await userEvent.type(screen.getByLabelText('Publish name'), 'assistant_agent');
    await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Analysis skill/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Score filter/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Use wiki Customer A/ }));
    // サブエージェント委譲を選択し usage を入力する。
    await userEvent.click(await screen.findByRole('checkbox', { name: /Scorer Agent/ }));
    await userEvent.type(screen.getByLabelText(/Delegation usage for Scorer Agent/), 'delegate scoring');
    // 実効副作用バッジがサブ定義から近似計算される（scorerはread-only Toolのみ）。
    expect(await screen.findByText('read-only')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Enable structured output' }));
    await userEvent.type(screen.getByLabelText('Output field 1 name'), 'answer');
    await userEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await waitFor(() => expect(client.generateAgentPrompt).toHaveBeenCalledWith(expect.objectContaining({ skills: [{ internalId: 'analysis', version: '1.1.0' }], tools: [{ internalId: 'scores', version: '2.0.0' }] })));
    expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('# Generated');
    await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), '\nReviewed');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ skills: [{ internalId: 'analysis', version: '1.1.0' }], systemPrompt: '# Generated\nReviewed', agents: [{ internalId: 'scorer-agent', version: '1.0.0', usage: 'delegate scoring' }], wikis: [{ wikiId: 'customer-a' }], output: { name: 'assistant_agent_response', fields: [{ name: 'answer', type: 'string', required: true }] } })));
    expect(await screen.findByText('saved 1.0.0')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Agent chat message'), 'Run the saved Agent');
    await userEvent.click(screen.getByRole('button', { name: 'Run saved agent' }));
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: { internalId: 'assistant-agent', version: '1.0.0' } })));
    expect(await screen.findByText(/done/)).toBeTruthy();
  });

  describe('MCPサーバー選択', () => {
    const mcpServers = [
      { scope: { tenantId: 'local', workspaceId: 'default' }, name: 'filesystem', transport: { kind: 'stdio', command: 'npx', args: [], env: {} }, disabled: false, updatedAt: 'now' },
      { scope: { tenantId: 'local', workspaceId: 'default' }, name: 'remote', transport: { kind: 'http', url: 'https://example.com/mcp', headers: {} }, disabled: true, updatedAt: 'now' },
    ];

    async function fillRequired(): Promise<void> {
      await userEvent.type(screen.getByLabelText('Agent internal ID'), 'support-agent');
      await userEvent.type(screen.getByLabelText('Working name'), 'Support draft');
      await userEvent.type(screen.getByLabelText('Agent display name'), 'Support Agent');
      await userEvent.type(screen.getByLabelText('Publish name'), 'support_agent');
      await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
      await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'You are helpful.');
    }

    it('保存済みMCPサーバーをtransport種別つきで一覧し、disabledは実行時スキップと注記する', async () => {
      const client = stubClient();
      (client.listMcpServers as ReturnType<typeof vi.fn>).mockResolvedValue(mcpServers);
      await openNewAgentEditor(client);

      const row = (await screen.findByRole('checkbox', { name: 'Use MCP server filesystem' })).closest('label');
      expect(row?.textContent).toContain('stdio');
      expect(row?.querySelector('.validation-status')?.textContent).toBe('MCP');
      expect(screen.getByRole('checkbox', { name: 'Use MCP server remote' }).closest('label')?.textContent).toContain('skipped at run time');
    });

    it('MCPサーバーが1件も無ければMCP画面へ誘導するempty stateを出す', async () => {
      const client = stubClient();
      await openNewAgentEditor(client);
      expect(await screen.findByText('No MCP servers configured. Add them on the MCP page.')).toBeTruthy();
    });

    it('選択したサーバー名をsaveAgentペイロードへ載せ、未選択ならキーごと省略する', async () => {
      const client = stubClient();
      (client.listMcpServers as ReturnType<typeof vi.fn>).mockResolvedValue(mcpServers);
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewAgentEditor(client);
      await fillRequired();

      // 未選択のまま保存すると mcpServers キーは出ない（従来動作）。
      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalled());
      expect(client.saveAgent).toHaveBeenCalledWith(expect.not.objectContaining({ mcpServers: expect.anything() }));

      await userEvent.click(await screen.findByRole('checkbox', { name: 'Use MCP server filesystem' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: ['filesystem'] })));
    });

    it('保存済みAgentを開くとmcpServersの選択を復元し、再保存でも落とさない', async () => {
      const client = stubClient();
      (client.listMcpServers as ReturnType<typeof vi.fn>).mockResolvedValue(mcpServers);
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ ...existingAgentDto, mcpServers: ['remote'] });
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '2.1.0' } });
      render(<AgentBuilder client={client} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Open' }));

      expect((await screen.findByRole('checkbox', { name: 'Use MCP server remote' }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('checkbox', { name: 'Use MCP server filesystem' }) as HTMLInputElement).checked).toBe(false);

      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: ['remote'] })));
    });

    it('8件を超える選択はチェックできず上限を表示する', async () => {
      const client = stubClient();
      const many = Array.from({ length: 9 }, (_, index) => ({ ...mcpServers[0], name: `server-${index}`, disabled: false }));
      (client.listMcpServers as ReturnType<typeof vi.fn>).mockResolvedValue(many);
      await openNewAgentEditor(client);

      await screen.findByRole('checkbox', { name: 'Use MCP server server-0' });
      for (let index = 0; index < 8; index += 1) await userEvent.click(screen.getByRole('checkbox', { name: `Use MCP server server-${index}` }));

      expect(screen.getByText('At most 8 MCP servers can be selected.')).toBeTruthy();
      expect((screen.getByRole('checkbox', { name: 'Use MCP server server-8' }) as HTMLInputElement).disabled).toBe(true);
      // 選択済みは解除できる（上限に達しても操作不能にはしない）。
      await userEvent.click(screen.getByRole('checkbox', { name: 'Use MCP server server-0' }));
      expect((screen.getByRole('checkbox', { name: 'Use MCP server server-8' }) as HTMLInputElement).disabled).toBe(false);
    });
  });

  describe('ハーネス設定', () => {
    // saveAgentの必須項目を埋めて保存ボタンを押せる状態にする。
    async function fillRequired(): Promise<void> {
      await userEvent.type(screen.getByLabelText('Agent internal ID'), 'support-agent');
      await userEvent.type(screen.getByLabelText('Working name'), 'Support draft');
      await userEvent.type(screen.getByLabelText('Agent display name'), 'Support Agent');
      await userEvent.type(screen.getByLabelText('Publish name'), 'support_agent');
      await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
      await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'You are helpful.');
    }

    it('ハーネスボタンでダイアログを開き、6つの機能トグルを表示する', async () => {
      const client = stubClient();
      await openNewAgentEditor(client);
      await userEvent.click(screen.getByRole('button', { name: /^Harness/ }));

      const dialog = screen.getByRole('dialog', { name: 'Runtime harness' });
      expect(within(dialog).getAllByRole('checkbox')).toHaveLength(6);
      for (const name of ['File memory', 'Todo provider', 'Compaction', 'Web search', 'Tool approval', 'Function invocation']) {
        expect(within(dialog).getByRole('checkbox', { name })).toBeTruthy();
      }
      // 既定値: ツール自動実行だけ有効。
      expect((within(dialog).getByRole('checkbox', { name: 'Function invocation' }) as HTMLInputElement).checked).toBe(true);
      expect((within(dialog).getByRole('checkbox', { name: 'Tool approval' }) as HTMLInputElement).checked).toBe(false);
    });

    it('2つ有効にしてApplyすると6キーすべてを含むharnessを保存ペイロードへ載せる', async () => {
      const client = stubClient();
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewAgentEditor(client);
      await userEvent.click(screen.getByRole('button', { name: /^Harness/ }));
      const dialog = screen.getByRole('dialog', { name: 'Runtime harness' });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'File memory' }));
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Todo provider' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));

      // Applyでダイアログは閉じ、ボタンには有効な機能数が出る（fileMemory + todoProvider + functionInvocation）。
      expect(screen.queryByRole('dialog', { name: 'Runtime harness' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Harness (3)' })).toBeTruthy();

      await fillRequired();
      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
        harness: { fileMemory: true, todoProvider: true, compaction: false, webSearch: false, toolApproval: false, functionInvocation: true },
      })));
    });

    it('Cancelでは編集を破棄し、未設定のままなら保存ペイロードにharnessキーを含めない', async () => {
      const client = stubClient();
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewAgentEditor(client);
      await userEvent.click(screen.getByRole('button', { name: /^Harness/ }));
      const dialog = screen.getByRole('dialog', { name: 'Runtime harness' });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Compaction' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'Harness' })).toBeTruthy();

      await fillRequired();
      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalled());
      expect(client.saveAgent).toHaveBeenCalledWith(expect.not.objectContaining({ harness: expect.anything() }));
    });

    it('harness付きの保存済みAgentを開くとダイアログへ復元する', async () => {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...existingAgentDto,
        harness: { fileMemory: true, todoProvider: false, compaction: true, webSearch: false, toolApproval: true, functionInvocation: false },
      });
      render(<AgentBuilder client={client} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Open' }));

      // ボタンには有効な3機能が出る。
      expect(await screen.findByRole('button', { name: 'Harness (3)' })).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Harness (3)' }));
      const dialog = screen.getByRole('dialog', { name: 'Runtime harness' });
      const checked = (name: string) => (within(dialog).getByRole('checkbox', { name }) as HTMLInputElement).checked;
      expect(checked('File memory')).toBe(true);
      expect(checked('Compaction')).toBe(true);
      expect(checked('Tool approval')).toBe(true);
      expect(checked('Todo provider')).toBe(false);
      expect(checked('Web search')).toBe(false);
      expect(checked('Function invocation')).toBe(false);
    });

    it('Clearで未設定へ戻すと保存ペイロードからharnessが消える', async () => {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...existingAgentDto,
        harness: { fileMemory: true, todoProvider: false, compaction: false, webSearch: false, toolApproval: false, functionInvocation: true },
      });
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '2.1.0' } });
      render(<AgentBuilder client={client} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Open' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Harness (2)' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Runtime harness' })).getByRole('button', { name: 'Clear' }));
      expect(screen.queryByRole('dialog', { name: 'Runtime harness' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Harness' })).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalled());
      expect(client.saveAgent).toHaveBeenCalledWith(expect.not.objectContaining({ harness: expect.anything() }));
    });
  });

  describe('一覧（Layer 1）', () => {
    it('listAgentsの内容を一覧表示する', async () => {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      render(<AgentBuilder client={client} />);

      expect(await screen.findByText('Existing Agent')).toBeTruthy();
      expect(screen.getByText('existing_agent@2.0.0')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    });

    it('Agentが無い場合はempty stateを表示する', async () => {
      const client = stubClient();
      render(<AgentBuilder client={client} />);
      expect(await screen.findByText('No agents yet.')).toBeTruthy();
    });

    it('OpenでgetAgentの内容をeditorへ復元し、Internal IDを読み取り専用にする', async () => {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(existingAgentDto);
      render(<AgentBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
      expect(client.getAgent).toHaveBeenCalledWith('existing-agent', expect.any(Object));

      expect((await screen.findByLabelText('Agent display name') as HTMLInputElement).value).toBe('Existing Agent');
      expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('You are existing.');

      const internalIdInput = screen.getByLabelText('Agent internal ID') as HTMLInputElement;
      expect(internalIdInput.value).toBe('existing-agent');
      expect(internalIdInput.readOnly).toBe(true);
    });

    it('Deleteは確認ダイアログの承諾後にdeleteAgentを呼び、一覧を再取得する', async () => {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([existingAgentSummary])
        .mockResolvedValueOnce([]);
      render(<AgentBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      // 確認前は削除しない。文言には対象のAgent名が入る。
      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('Existing Agent');
      expect(client.deleteAgent).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(client.deleteAgent).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

      expect(client.deleteAgent).toHaveBeenCalledWith('existing-agent', expect.any(Object));
      expect(client.listAgents).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('No agents yet.')).toBeTruthy();
    });

    it('Back to listでeditorから一覧へ戻り、一覧を再取得する', async () => {
      const client = stubClient();
      await openNewAgentEditor(client);
      expect(client.listAgents).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole('button', { name: 'Back to list' }));

      expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'New agent' })).toBeTruthy();
      expect(client.listAgents).toHaveBeenCalledTimes(2);
    });
  });
});
