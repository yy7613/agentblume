// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { AgentBuilder } from './AgentBuilder';

afterEach(cleanup);

describe('AgentBuilder', () => {
  it('Tool選択から草案生成・編集・version保存まで行う', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft', sideEffect: 'read-only' }]),
      listSkills: vi.fn().mockResolvedValue([{ internalId: 'analysis', displayName: 'Analysis skill', publishName: 'analysis', latestVersion: '1.1.0', state: 'draft' }]),
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'scorer-agent', displayName: 'Scorer Agent', publishName: 'scorer_agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }]),
      getAgent: vi.fn().mockResolvedValue({ metadata: { internalId: 'scorer-agent', version: '1.0.0' }, kind: 'normal', systemPrompt: 'x', skills: [], tools: [{ internalId: 'scores', version: '2.0.0' }], agents: [] }),
      generateAgentPrompt: vi.fn().mockResolvedValue({ systemPromptDraft: '# Generated', sections: {}, editable: true, sources: [] }),
      saveAgent: vi.fn().mockResolvedValue({ metadata: { version: '1.0.0' } }),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-1', mode: 'preview', response: '{"answer":"done"}', structuredResponse: { answer: 'done' }, trace: [{ sequence: 1, kind: 'model-response', content: '{"answer":"done"}' }], usage: {}, agent: { internalId: 'assistant-agent', version: '1.0.0' } }),
    } as unknown as ToolApiClient;
    render(<AgentBuilder client={client} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Analysis skill/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Score filter/ }));
    // サブエージェント委譲を選択し usage を入力する。
    await userEvent.click(await screen.findByRole('checkbox', { name: /Scorer Agent/ }));
    await userEvent.type(screen.getByLabelText(/Delegation usage for Scorer Agent/), 'delegate scoring');
    // 実効副作用バッジがサブ定義から近似計算される（scorerはread-only Toolのみ）。
    expect(await screen.findByText('read-only')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Enable structured output' }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await waitFor(() => expect(client.generateAgentPrompt).toHaveBeenCalledWith(expect.objectContaining({ skills: [{ internalId: 'analysis', version: '1.1.0' }], tools: [{ internalId: 'scores', version: '2.0.0' }] })));
    expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('# Generated');
    await userEvent.type(screen.getByRole('textbox', { name: 'System prompt' }), '\nReviewed');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ skills: [{ internalId: 'analysis', version: '1.1.0' }], systemPrompt: '# Generated\nReviewed', agents: [{ internalId: 'scorer-agent', version: '1.0.0', usage: 'delegate scoring' }], output: { name: 'assistant_agent_response', fields: [{ name: 'answer', type: 'string', required: true }] } })));
    expect(await screen.findByText('saved 1.0.0')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Run saved agent' }));
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: { internalId: 'assistant-agent', version: '1.0.0' } })));
    expect(await screen.findByText(/done/)).toBeTruthy();
  });
});
