// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentDiagnosticsDto, AgentSummaryDto, SerializedAgentDto } from '../api/types';
import { draftKey, readDraft, writeDraft } from '../hooks/useDraftPersistence';
import { I18nProvider } from '../i18n';
import { NavigationProvider, consumePendingOpen, useOpenInScreen } from '../navigation';
import { AgentBuilder } from './AgentBuilder';

afterEach(() => { cleanup(); consumePendingOpen('Agent'); });
// 下書きは localStorage に残るため、テスト間で持ち越さない。
beforeEach(() => { localStorage.clear(); });

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

  describe('組み込みチェック（プリフライト診断）', () => {
    async function fillRequired(): Promise<void> {
      await userEvent.type(screen.getByLabelText('Agent internal ID'), 'support-agent');
      await userEvent.type(screen.getByLabelText('Working name'), 'Support draft');
      await userEvent.type(screen.getByLabelText('Agent display name'), 'Support Agent');
      await userEvent.type(screen.getByLabelText('Publish name'), 'support_agent');
      await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
      await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'You are helpful.');
    }
    const blocked: AgentDiagnosticsDto = {
      agent: { internalId: 'support-agent', version: 'draft' }, status: 'error',
      checks: [{ id: 'skills', status: 'ok' }, { id: 'harness', status: 'warning', detail: 'web search enabled without a provider' }],
      tools: [{ internalId: 'scores', version: '2.0.0', source: 'direct', functionName: 'filter_scores', status: 'error', checks: [{ id: 'output-schema', status: 'error', detail: 'declared output schema does not match' }] }],
    };
    const clean: AgentDiagnosticsDto = { agent: { internalId: 'support-agent', version: '1.2.0' }, status: 'ok', checks: [{ id: 'skills', status: 'ok' }], tools: [] };

    it('保存と同じ活性条件で、保存と同じ DTO を diagnoseAgentDraft へ送り、結果をパネルに描く', async () => {
      const client = stubClient();
      const diagnoseAgentDraft = vi.fn().mockResolvedValue(blocked);
      (client as unknown as { diagnoseAgentDraft: unknown }).diagnoseAgentDraft = diagnoseAgentDraft;
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewAgentEditor(client);
      const check = () => screen.getByRole('button', { name: 'Check integration' }) as HTMLButtonElement;
      expect(check().disabled).toBe(true);
      await fillRequired();
      expect(check().disabled).toBe(false);

      await userEvent.click(check());
      expect(await screen.findByText('Blocked')).toBeTruthy();
      expect(screen.getByText(/Integration check found 2 issue\(s\)/)).toBeTruthy();
      expect(screen.getByText('Output schema consistency')).toBeTruthy();
      expect(screen.getByText('filter_scores')).toBeTruthy();
      // 編集中のエージェント自身を別画面で開くボタンは出さないが、ツール（出力設定）と実行オプションへは飛べる。
      expect(screen.queryByRole('button', { name: /^Open agent/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open tool "filter_scores" (output)' })).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Open runtime options (harness)' }));
      expect(screen.getByRole('dialog', { name: 'Runtime options' })).toBeTruthy();
      await userEvent.keyboard('{Escape}');

      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await waitFor(() => expect(client.saveAgent).toHaveBeenCalledOnce());
      expect(diagnoseAgentDraft.mock.calls[0]?.[0]).toEqual((client.saveAgent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(diagnoseAgentDraft).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal));

      await userEvent.click(screen.getByRole('button', { name: 'Close diagnostics' }));
      expect(screen.queryByText('Blocked')).toBeNull();
    });

    it('ツール等の選択が変わると自動で診断し、選択行にバッジと一番目の問題を出す（パネルは勝手に開かない）', async () => {
      const client = stubClient();
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
        { internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft', sideEffect: 'read-only' },
        { internalId: 'clean', displayName: 'Clean tool', publishName: 'clean_tool', latestVersion: '1.0.0', state: 'draft', sideEffect: 'read-only' },
      ]);
      const diagnoseAgentDraft = vi.fn().mockImplementation((dto: { tools: readonly { internalId: string }[] }) => Promise.resolve({
        ...blocked,
        tools: dto.tools.map((ref) => ref.internalId === 'scores'
          ? blocked.tools[0]
          : { internalId: 'clean', version: '1.0.0', source: 'direct', functionName: 'clean_tool', status: 'ok', checks: [{ id: 'function-definition', status: 'ok' }] }),
      }));
      (client as unknown as { diagnoseAgentDraft: unknown }).diagnoseAgentDraft = diagnoseAgentDraft;
      await openNewAgentEditor(client);
      // 必須項目が揃うまでは自動診断しない。
      await screen.findByRole('checkbox', { name: /Score filter/ });
      await fillRequired();
      await waitFor(() => expect(diagnoseAgentDraft).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(screen.queryByText('Blocked')).toBeNull();

      await userEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      await userEvent.click(screen.getByRole('checkbox', { name: /Clean tool/ }));
      // 2回のクリックは1回の要求にまとめる（デバウンス）。
      await waitFor(() => expect(diagnoseAgentDraft).toHaveBeenCalledTimes(2), { timeout: 3000 });
      expect(diagnoseAgentDraft.mock.calls[1]?.[0]).toMatchObject({ tools: [{ internalId: 'scores', version: '2.0.0' }, { internalId: 'clean', version: '1.0.0' }] });

      const broken = await screen.findByRole('img', { name: 'Tool diagnostics: error' });
      expect(broken.textContent).toBe('✕');
      expect(broken.getAttribute('title')).toBe('Output schema consistency: declared output schema does not match');
      expect(broken.closest('label')?.textContent).toContain('Score filter');
      expect(screen.getByRole('img', { name: 'Tool diagnostics: no blockers' }).closest('label')?.textContent).toContain('Clean tool');
      // 要約行から詳細を開ける。
      expect(screen.getByText(/Integration check found 2 issue\(s\)/)).toBeTruthy();
      expect(screen.queryByText('Blocked')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));
      expect(screen.getByText('Blocked')).toBeTruthy();
    });

    it('診断の取得失敗はアラートで示す', async () => {
      const client = stubClient();
      (client as unknown as { diagnoseAgentDraft: unknown }).diagnoseAgentDraft = vi.fn().mockRejectedValue(new Error('server unreachable'));
      await openNewAgentEditor(client);
      await fillRequired();
      await userEvent.click(screen.getByRole('button', { name: 'Check integration' }));
      expect((await screen.findByRole('alert')).textContent).toBe('Diagnostics failed: server unreachable');
    });

    it('保存後に保存版で diagnoseAgent を呼び、問題数の要約と詳細の開閉を出す', async () => {
      const client = stubClient();
      const diagnoseAgent = vi.fn().mockResolvedValue({ ...blocked, agent: { internalId: 'support-agent', version: '1.2.0' } });
      (client as unknown as { diagnoseAgent: unknown }).diagnoseAgent = diagnoseAgent;
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.2.0' } });
      await openNewAgentEditor(client);
      await fillRequired();
      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));

      expect(await screen.findByText('Saved · version 1.2.0')).toBeTruthy();
      await waitFor(() => expect(diagnoseAgent).toHaveBeenCalledWith('support-agent', expect.anything(), '1.2.0', expect.any(AbortSignal)));
      // harness の warning + output-schema の error = 2件。
      expect(await screen.findByText(/Saved\. Tool diagnostics found 2 issue\(s\)/)).toBeTruthy();
      expect(screen.queryByText('Blocked')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));
      expect(screen.getByText('Blocked')).toBeTruthy();
      expect(screen.getByText('Harness features')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));
      expect(screen.queryByText('Blocked')).toBeNull();
    });

    it('問題が無ければ「問題なし」、診断の失敗は保存成功を損なわず「取得できなかった」と出す', async () => {
      const client = stubClient();
      const diagnoseAgent = vi.fn().mockResolvedValueOnce(clean).mockRejectedValueOnce(new Error('offline'));
      (client as unknown as { diagnoseAgent: unknown }).diagnoseAgent = diagnoseAgent;
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.2.0' } });
      await openNewAgentEditor(client);
      await fillRequired();
      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      expect(await screen.findByText(/Saved\. Tool diagnostics: no blockers/)).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      expect(await screen.findByText('Diagnostics unavailable')).toBeTruthy();
      expect(screen.getByText('saved 1.2.0')).toBeTruthy();
    });
  });

  describe('自動診断のデバウンスと中断（fake timers）', () => {
    const tools = [
      { internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft', sideEffect: 'read-only' },
      { internalId: 'clean', displayName: 'Clean tool', publishName: 'clean_tool', latestVersion: '1.0.0', state: 'draft', sideEffect: 'read-only' },
    ];
    const blocked: AgentDiagnosticsDto = {
      agent: { internalId: 'support-agent', version: 'draft' }, status: 'error',
      checks: [{ id: 'skills', status: 'ok' }, { id: 'harness', status: 'warning', detail: 'web search enabled without a provider' }],
      tools: [{ internalId: 'scores', version: '2.0.0', source: 'direct', functionName: 'filter_scores', status: 'error', checks: [{ id: 'output-schema', status: 'error', detail: 'declared output schema does not match' }] }],
    };
    const clean: AgentDiagnosticsDto = { agent: { internalId: 'support-agent', version: 'draft' }, status: 'ok', checks: [{ id: 'skills', status: 'ok' }], tools: [] };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { cleanup(); vi.useRealTimers(); });
    const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const attach = (client: ToolApiClient, extra: Record<string, unknown>) => Object.assign(client as unknown as Record<string, unknown>, extra);

    function fillRequiredSync(): void {
      fireEvent.change(screen.getByLabelText('Agent internal ID'), { target: { value: 'support-agent' } });
      fireEvent.change(screen.getByLabelText('Working name'), { target: { value: 'Support draft' } });
      fireEvent.change(screen.getByLabelText('Agent display name'), { target: { value: 'Support Agent' } });
      fireEvent.change(screen.getByLabelText('Publish name'), { target: { value: 'support_agent' } });
      fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'local-user' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'System prompt' }), { target: { value: 'You are helpful.' } });
    }
    async function openNewEditor(client: ToolApiClient, language: 'en' | 'ja' = 'en'): Promise<void> {
      if (language === 'ja') render(<I18nProvider initialLanguage="ja"><AgentBuilder client={client} /></I18nProvider>);
      else render(<AgentBuilder client={client} />);
      await tick();
      fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '新規作成' : 'New agent' }));
      await tick();
    }

    it('必須項目が揃うまで要求せず、揃ってから600ms後に1回、連続した選択変更も600ms後に1回にまとめる', async () => {
      const client = stubClient();
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue(tools);
      const diagnoseAgentDraft = vi.fn().mockResolvedValue(clean);
      attach(client, { diagnoseAgentDraft });
      await openNewEditor(client);
      await tick(1000);
      expect(diagnoseAgentDraft).not.toHaveBeenCalled();

      fillRequiredSync();
      await tick(599);
      expect(diagnoseAgentDraft).not.toHaveBeenCalled();
      await tick(1);
      expect(diagnoseAgentDraft).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      await tick(300);
      fireEvent.click(screen.getByRole('checkbox', { name: /Clean tool/ }));
      await tick(599);
      expect(diagnoseAgentDraft).toHaveBeenCalledTimes(1);
      await tick(1);
      expect(diagnoseAgentDraft).toHaveBeenCalledTimes(2);
      expect(diagnoseAgentDraft.mock.calls[1]?.[0]).toMatchObject({ tools: [{ internalId: 'scores', version: '2.0.0' }, { internalId: 'clean', version: '1.0.0' }] });

      // 名前やプロンプトの入力（選択の変化ではない）では再実行しない。
      fireEvent.change(screen.getByRole('textbox', { name: 'System prompt' }), { target: { value: 'You are still helpful.' } });
      fireEvent.change(screen.getByLabelText('Agent display name'), { target: { value: 'Renamed' } });
      await tick(1000);
      expect(diagnoseAgentDraft).toHaveBeenCalledTimes(2);
      // 自動実行はパネルを開かない。
      expect(screen.queryByText('No blockers')).toBeNull();
      expect(screen.getByText('Integration check: no blockers')).toBeTruthy();
    });

    it('一覧へ戻ると進行中の要求を中断して結果を捨て、一覧では時間が経っても要求しない', async () => {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(existingAgentDto);
      const pending: { readonly resolve: (value: AgentDiagnosticsDto) => void; readonly signal: AbortSignal }[] = [];
      const diagnoseAgentDraft = vi.fn((_dto: unknown, signal: AbortSignal) => new Promise<AgentDiagnosticsDto>((resolve) => { pending.push({ resolve, signal }); }));
      attach(client, { diagnoseAgentDraft });
      render(<AgentBuilder client={client} />);
      await tick();
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      await tick();
      // 読み込んだエージェントは必須項目が揃っているので、開いた直後に自動診断する。
      await tick(600);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.signal.aborted).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
      await tick();
      expect(pending[0]?.signal.aborted).toBe(true);
      await tick(2000);
      expect(pending).toHaveLength(1);

      // 開き直した直後（次の自動診断が走る前）に前の結果が届いても表示しない。
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      await tick();
      pending[0]?.resolve(blocked);
      await tick();
      expect(screen.queryByText(/Integration check/)).toBeNull();
      expect(document.querySelector('.diag-badge')).toBeNull();
      await tick(600);
      expect(pending).toHaveLength(2);
    });

    it('新しい要求が走ると前の要求を中断し、前の結果が後から届いても無視して新しい結果だけを出す', async () => {
      const client = stubClient();
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue(tools);
      const pending: { readonly resolve: (value: AgentDiagnosticsDto) => void; readonly signal: AbortSignal }[] = [];
      const diagnoseAgentDraft = vi.fn((_dto: unknown, signal: AbortSignal) => new Promise<AgentDiagnosticsDto>((resolve) => { pending.push({ resolve, signal }); }));
      attach(client, { diagnoseAgentDraft });
      await openNewEditor(client);
      fillRequiredSync();
      await tick(600);
      fireEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      await tick(600);
      expect(pending).toHaveLength(2);
      expect(pending[0]?.signal.aborted).toBe(true);
      expect(pending[1]?.signal.aborted).toBe(false);

      pending[0]?.resolve(blocked);
      await tick();
      expect(screen.queryByText(/Integration check/)).toBeNull();
      pending[1]?.resolve({ ...clean, tools: [{ internalId: 'scores', version: '2.0.0', source: 'direct', functionName: 'filter_scores', status: 'ok', checks: [{ id: 'resolved', status: 'ok' }] }] });
      await tick();
      expect(screen.getByText('Integration check: no blockers')).toBeTruthy();
      expect(screen.getByRole('img', { name: 'Tool diagnostics: no blockers' })).toBeTruthy();
      expect(screen.queryByRole('img', { name: 'Tool diagnostics: error' })).toBeNull();
    });

    it('自動診断の失敗は静かな注記に留めて落ちず、その後の手動チェックは動く', async () => {
      const client = stubClient();
      const diagnoseAgentDraft = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(blocked);
      attach(client, { diagnoseAgentDraft });
      await openNewEditor(client);
      fillRequiredSync();
      await tick(600);
      expect(screen.getByText('Integration check unavailable')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect((screen.getByRole('button', { name: 'Check integration' }) as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Check integration' }));
      await tick();
      expect(screen.queryByText('Integration check unavailable')).toBeNull();
      expect(screen.getByText('Blocked')).toBeTruthy();
      expect(screen.getByText(/Integration check found 2 issue\(s\)/)).toBeTruthy();
    });

    it('自動診断が応答を返さない間も手動チェックは押せ、押すと自動側の要求を中断して手動の結果を出す', async () => {
      const client = stubClient();
      const signals: AbortSignal[] = [];
      const diagnoseAgentDraft = vi.fn()
        // 1回目（自動）: 永遠に応答しない（止まったサーバー）。
        .mockImplementationOnce((_input: unknown, signal: AbortSignal) => { signals.push(signal); return new Promise(() => { /* never */ }); })
        .mockImplementationOnce((_input: unknown, signal: AbortSignal) => { signals.push(signal); return Promise.resolve(blocked); });
      attach(client, { diagnoseAgentDraft });
      await openNewEditor(client);
      fillRequiredSync();
      await tick(600);
      expect(diagnoseAgentDraft).toHaveBeenCalledTimes(1);
      const button = screen.getByRole('button', { name: 'Check integration' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);

      fireEvent.click(button);
      await tick();
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(screen.getByText('Blocked')).toBeTruthy();
      expect(screen.getByText(/Integration check found 2 issue\(s\)/)).toBeTruthy();
    });

    it('diagnoseAgentDraft を持たないクライアントでは自動診断を試みず、要約もバッジも出さない', async () => {
      const client = stubClient();
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue(tools);
      await openNewEditor(client);
      fillRequiredSync();
      fireEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      await tick(2000);
      expect(screen.queryByText(/Integration check/)).toBeNull();
      expect(document.querySelector('.diag-badge')).toBeNull();
      expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('バッジは warning も出し、診断結果に無いツールには出さず、選択を外した瞬間に消える', async () => {
      const client = stubClient();
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue(tools);
      const diagnoseAgentDraft = vi.fn().mockResolvedValue({
        ...clean, status: 'warning',
        tools: [{ internalId: 'scores', version: '2.0.0', source: 'direct', functionName: 'filter_scores', status: 'warning', checks: [{ id: 'resolved', status: 'ok' }, { id: 'state', status: 'warning', detail: 'tool is deprecated' }] }],
      });
      attach(client, { diagnoseAgentDraft });
      await openNewEditor(client);
      fillRequiredSync();
      fireEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Clean tool/ }));
      await tick(600);
      const warned = screen.getByRole('img', { name: 'Tool diagnostics: warning' });
      expect(warned.textContent).toBe('!');
      expect(warned.getAttribute('title')).toBe('Tool lifecycle state: tool is deprecated');
      expect(warned.closest('label')?.textContent).toContain('Score filter');
      expect(screen.getByRole('checkbox', { name: /Clean tool/ }).closest('label')?.querySelector('.diag-badge')).toBeNull();
      expect(screen.getByText(/Integration check found 1 issue\(s\)/)).toBeTruthy();

      fireEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      expect(screen.queryByRole('img', { name: /Tool diagnostics/ })).toBeNull();
    });

    it('バッジの title は一番目の問題を日本語化して出す', async () => {
      const client = stubClient();
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue(tools);
      const diagnoseAgentDraft = vi.fn().mockResolvedValue({
        ...blocked,
        tools: [{ internalId: 'scores', version: '2.0.0', source: 'direct', functionName: 'filter_scores', status: 'error', checks: [
          { id: 'state', status: 'warning', detail: 'tool is deprecated' },
          { id: 'graph', status: 'error', nodeId: 'filter-1', detail: "node 'filter-1' (type 'filter') expects 1 input(s) but has in-degree 0" },
        ] }],
      });
      attach(client, { diagnoseAgentDraft });
      await openNewEditor(client, 'ja');
      fireEvent.change(screen.getByLabelText('エージェント内部ID'), { target: { value: 'support-agent' } });
      fireEvent.change(screen.getByLabelText('作業名'), { target: { value: 'Support draft' } });
      fireEvent.change(screen.getByLabelText('エージェント表示名'), { target: { value: 'Support Agent' } });
      fireEvent.change(screen.getByLabelText('公開名'), { target: { value: 'support_agent' } });
      fireEvent.change(screen.getByLabelText('所有者'), { target: { value: 'local-user' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'システムプロンプト' }), { target: { value: 'You are helpful.' } });
      fireEvent.click(screen.getByRole('checkbox', { name: /Score filter/ }));
      await tick(600);
      const badge = screen.getByRole('img', { name: 'ツール診断: エラー' });
      expect(badge.textContent).toBe('✕');
      // warning が先に並んでいても error を一番目の問題にし、detail は「原因 + 次の一手」の日本語にする。
      expect(badge.getAttribute('title')).toMatch(/^グラフ検証: ノード「filter-1」\(filter\)には1本の入力が必要ですが、0本接続されています/);
      expect(badge.getAttribute('title')).not.toContain('in-degree');
    });
  });

  it('function 名として無効な publishName には委譲できない旨を注意し、保存は止めない', async () => {
    const client = stubClient();
    await openNewAgentEditor(client);
    await userEvent.type(screen.getByLabelText('Publish name'), 'support agent');
    expect(screen.getByText('Other agents cannot delegate to this agent: ask_support agent is not a valid function name (use 1–64 ASCII letters, digits, _ or -)')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Publish name'));
    // 未入力は必須項目側で伝えるので、ここでは注意を出さない。
    expect(screen.queryByText(/is not a valid function name/)).toBeNull();
    await userEvent.type(screen.getByLabelText('Publish name'), 'support_agent');
    expect(screen.queryByText(/is not a valid function name/)).toBeNull();
  });

  it('publishName の長さは ask_ を付けた function 名（64文字まで）で判定する: 60文字は可、61文字は注意', async () => {
    const client = stubClient();
    await openNewAgentEditor(client);
    fireEvent.change(screen.getByLabelText('Publish name'), { target: { value: 'a'.repeat(60) } });
    expect(screen.queryByText(/is not a valid function name/)).toBeNull();
    // サーバーの sub-agents 検査は ask_<publishName>（= 65文字）を function 名として弾く。
    fireEvent.change(screen.getByLabelText('Publish name'), { target: { value: 'a'.repeat(61) } });
    expect(screen.getByText(/is not a valid function name/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(true); // 他の必須項目が空なので保存不可（注意のせいではない）。
  });

  it('登録の無いMCPサーバーを参照している場合は未登録として見せ、チェックを外せる', async () => {
    const client = stubClient();
    (client.listMcpServers as ReturnType<typeof vi.fn>).mockResolvedValue([{ scope: { tenantId: 'local', workspaceId: 'default' }, name: 'filesystem', transport: { kind: 'stdio', command: 'npx', args: [], env: {} }, disabled: false, updatedAt: 'now' }]);
    (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
    (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ ...existingAgentDto, mcpServers: ['filesystem', 'ghost'] });
    (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '2.1.0' } });
    render(<AgentBuilder client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));

    const ghost = await screen.findByRole('checkbox', { name: 'Use MCP server ghost' }) as HTMLInputElement;
    expect(ghost.checked).toBe(true);
    const row = ghost.closest('label');
    expect(row?.textContent).toContain('not registered');
    expect(row?.className).toContain('unregistered');
    expect(screen.getByRole('checkbox', { name: 'Use MCP server filesystem' }).closest('label')?.textContent).not.toContain('not registered');

    await userEvent.click(ghost);
    expect(screen.queryByRole('checkbox', { name: 'Use MCP server ghost' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: ['filesystem'] })));
  });

  describe('他画面からの「エージェントを開く」', () => {
    function Opener({ section }: { readonly section?: string }) {
      const open = useOpenInScreen();
      return <button type="button" onClick={() => open('Agent', { internalId: 'existing-agent', version: '2.0.0', ...(section === undefined ? {} : { section }) })}>open existing</button>;
    }
    function openableClient(): ToolApiClient {
      const client = stubClient();
      (client.listAgents as ReturnType<typeof vi.fn>).mockResolvedValue([existingAgentSummary]);
      (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(existingAgentDto);
      return client;
    }

    it('一覧を経ずにそのエージェントを開く', async () => {
      const client = openableClient();
      render(<NavigationProvider navigate={vi.fn()}><Opener /><AgentBuilder client={client} /></NavigationProvider>);
      await screen.findByRole('button', { name: 'Open' });

      await userEvent.click(screen.getByRole('button', { name: 'open existing' }));
      await waitFor(() => expect(client.getAgent).toHaveBeenCalledWith('existing-agent', expect.any(Object)));
      expect((await screen.findByLabelText('Agent display name') as HTMLInputElement).value).toBe('Existing Agent');
    });

    it('section=harness なら開いた直後に実行オプションのダイアログを出す', async () => {
      const client = openableClient();
      render(<NavigationProvider navigate={vi.fn()}><Opener section="harness" /><AgentBuilder client={client} /></NavigationProvider>);
      await screen.findByRole('button', { name: 'Open' });
      await userEvent.click(screen.getByRole('button', { name: 'open existing' }));
      expect(await screen.findByRole('dialog', { name: 'Runtime options' })).toBeTruthy();
    });

    it('section=tools ならツール選択の見出しへフォーカスする', async () => {
      const client = openableClient();
      render(<NavigationProvider navigate={vi.fn()}><Opener section="tools" /><AgentBuilder client={client} /></NavigationProvider>);
      await screen.findByRole('button', { name: 'Open' });
      await userEvent.click(screen.getByRole('button', { name: 'open existing' }));
      await screen.findByLabelText('Agent display name');
      await waitFor(() => expect(document.activeElement?.id).toBe('agent-section-tools'));
    });

    it('未知の section でも落ちずに開き、ダイアログもフォーカス移動も起こさない', async () => {
      const client = openableClient();
      render(<NavigationProvider navigate={vi.fn()}><Opener section="nowhere" /><AgentBuilder client={client} /></NavigationProvider>);
      await screen.findByRole('button', { name: 'Open' });
      await userEvent.click(screen.getByRole('button', { name: 'open existing' }));
      expect((await screen.findByLabelText('Agent display name') as HTMLInputElement).value).toBe('Existing Agent');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement?.id ?? '').not.toMatch(/^agent-section-/);
    });

    it('読み込みに失敗したら一覧にエラーを出し、失敗した依頼の区画指定を次に開いた編集画面へ持ち越さない', async () => {
      const client = openableClient();
      (client.getAgent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('agent gone'));
      render(<NavigationProvider navigate={vi.fn()}><Opener section="tools" /><AgentBuilder client={client} /></NavigationProvider>);
      await screen.findByRole('button', { name: 'Open' });
      await userEvent.click(screen.getByRole('button', { name: 'open existing' }));
      expect(await screen.findByText('agent gone')).toBeTruthy();
      expect(screen.queryByLabelText('Agent display name')).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'New agent' }));
      await screen.findByLabelText('Agent display name');
      expect(document.activeElement?.id).not.toBe('agent-section-tools');
    });
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

    it('実行オプションボタンでダイアログを開き、6つの機能トグルを表示する', async () => {
      const client = stubClient();
      await openNewAgentEditor(client);
      await userEvent.click(screen.getByRole('button', { name: /^Runtime options/ }));

      const dialog = screen.getByRole('dialog', { name: 'Runtime options' });
      expect(within(dialog).getAllByRole('checkbox')).toHaveLength(6);
      for (const name of ['File memory', 'Todo provider', 'Compaction', 'Web search', 'Tool approval', 'Function invocation']) {
        expect(within(dialog).getByRole('checkbox', { name })).toBeTruthy();
      }
      // 既定値: ツール自動実行だけ有効。
      expect((within(dialog).getByRole('checkbox', { name: 'Function invocation' }) as HTMLInputElement).checked).toBe(true);
      expect((within(dialog).getByRole('checkbox', { name: 'Tool approval' }) as HTMLInputElement).checked).toBe(false);
    });

    it('実行オプションダイアログはEscapeで閉じ、フォーカスを開いたボタンへ戻す', async () => {
      const client = stubClient();
      await openNewAgentEditor(client);
      const opener = screen.getByRole('button', { name: /^Runtime options/ });
      await userEvent.click(opener);
      expect(screen.getByRole('dialog', { name: 'Runtime options' })).toBeTruthy();

      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'Runtime options' })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Runtime options/ }));
    });

    it('2つ有効にしてApplyすると6キーすべてを含むharnessを保存ペイロードへ載せる', async () => {
      const client = stubClient();
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewAgentEditor(client);
      await userEvent.click(screen.getByRole('button', { name: /^Runtime options/ }));
      const dialog = screen.getByRole('dialog', { name: 'Runtime options' });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'File memory' }));
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Todo provider' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));

      // Applyでダイアログは閉じ、ボタンには有効な機能数が出る（fileMemory + todoProvider + functionInvocation）。
      expect(screen.queryByRole('dialog', { name: 'Runtime options' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Runtime options (3)' })).toBeTruthy();

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
      await userEvent.click(screen.getByRole('button', { name: /^Runtime options/ }));
      const dialog = screen.getByRole('dialog', { name: 'Runtime options' });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Compaction' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'Runtime options' })).toBeTruthy();

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
      expect(await screen.findByRole('button', { name: 'Runtime options (3)' })).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Runtime options (3)' }));
      const dialog = screen.getByRole('dialog', { name: 'Runtime options' });
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

      await userEvent.click(await screen.findByRole('button', { name: 'Runtime options (2)' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Runtime options' })).getByRole('button', { name: 'Clear' }));
      expect(screen.queryByRole('dialog', { name: 'Runtime options' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Runtime options' })).toBeTruthy();

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

  describe('下書きの自動保存と復元', () => {
    const scope = { tenantId: 'local', workspaceId: 'default' } as const;
    const newAgentKey = draftKey('agent-builder', scope);

    it('編集内容をlocalStorageへ退避し、画面を離れても失わない', async () => {
      const client = stubClient();
      const { unmount } = await openNewAgentEditor(client);
      await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'Draft prompt.');
      // アンマウント（左ナビでの画面切替相当）でデバウンス待ちの内容も書き出す。
      unmount();
      expect(readDraft<{ systemPrompt: string }>(newAgentKey)?.value.systemPrompt).toBe('Draft prompt.');
    });

    it('下書きがあると復元バナーを出し、自動では適用しない', async () => {
      writeDraft(newAgentKey, { internalId: 'restored', workingName: 'w', displayName: 'Restored Agent', publishName: 'p', owner: 'o', kind: 'normal', systemPrompt: 'Restored prompt.', structuredOutput: false, outputFields: [{ name: '', type: 'string', required: true }], tools: [], skills: [], wikis: [], mcpServers: [], subAgents: [] }, '2026-07-27T09:30:00.000Z');
      const client = stubClient();
      await openNewAgentEditor(client);

      expect(await screen.findByText(/Unsaved edits from .* were found/)).toBeTruthy();
      // 自動適用はしない（バナーを出すだけ）。
      expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('');

      await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
      expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('Restored prompt.');
      expect((screen.getByLabelText('Agent display name') as HTMLInputElement).value).toBe('Restored Agent');
      expect(screen.queryByText(/Unsaved edits from/)).toBeNull();
    });

    it('破棄を選ぶと下書きを消し、編集中の内容は触らない', async () => {
      writeDraft(newAgentKey, { internalId: 'x', workingName: 'w', displayName: 'Old', publishName: 'p', owner: 'o', kind: 'normal', systemPrompt: 'Old prompt.', structuredOutput: false, outputFields: [], tools: [], skills: [], wikis: [], mcpServers: [], subAgents: [] }, '2026-07-27T09:30:00.000Z');
      const client = stubClient();
      await openNewAgentEditor(client);

      await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
      expect(screen.queryByText(/Unsaved edits from/)).toBeNull();
      expect(localStorage.getItem(newAgentKey)).toBeNull();
      expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('');
    });

    it('保存に成功すると下書きを消す', async () => {
      const client = stubClient();
      (client.saveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewAgentEditor(client);
      await userEvent.type(screen.getByLabelText('Agent internal ID'), 'saved-agent');
      await userEvent.type(screen.getByLabelText('Working name'), 'draft');
      await userEvent.type(screen.getByLabelText('Agent display name'), 'Saved Agent');
      await userEvent.type(screen.getByLabelText('Publish name'), 'saved_agent');
      await userEvent.type(screen.getByLabelText('Owner'), 'owner');
      await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), 'Prompt.');

      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await screen.findByText('Saved · version 1.0.0');
      await waitFor(() => expect(localStorage.getItem(newAgentKey)).toBeNull());
    });

    it('別Agentの下書きは混ざらない（キーがinternalIdで分かれる）', async () => {
      writeDraft(draftKey('agent-builder', scope, 'other-agent'), { systemPrompt: 'Other draft.' }, '2026-07-27T09:30:00.000Z');
      const client = stubClient();
      await openNewAgentEditor(client);
      expect(screen.queryByText(/Unsaved edits from/)).toBeNull();
    });
  });
});
