// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { SkillBuilder } from './SkillBuilder';

afterEach(cleanup);

describe('SkillBuilder', () => {
  it('Tool選択から草案生成・編集・version保存まで行う', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ internalId: 'scores', displayName: 'Score filter', publishName: 'filter_scores', latestVersion: '2.0.0', state: 'draft' }]),
      generateSkillPrompt: vi.fn().mockResolvedValue({ promptDraft: '# Generated', sections: {}, editable: true, sources: [] }),
      saveSkill: vi.fn().mockResolvedValue({ metadata: { version: '1.0.0' } }),
    } as unknown as ToolApiClient;
    render(<SkillBuilder client={client} />);
    await userEvent.type(screen.getByLabelText('Skill internal ID'), 'data-analysis');
    await userEvent.type(screen.getByLabelText('Working name'), 'Data analysis draft');
    await userEvent.type(screen.getByLabelText('Skill display name'), 'Data analysis');
    await userEvent.type(screen.getByLabelText('Publish name'), 'data_analysis');
    await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
    await userEvent.type(screen.getByLabelText('Skill responsibility'), 'Analyze supplied data.');
    await userEvent.type(screen.getByLabelText('Skill activation condition'), 'Use for analysis.');

    await userEvent.click(await screen.findByRole('checkbox', { name: /Score filter/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await waitFor(() => expect(client.generateSkillPrompt).toHaveBeenCalledWith(expect.objectContaining({
      responsibility: expect.any(String), tools: [{ internalId: 'scores', version: '2.0.0' }],
    })));
    const instructions = screen.getByRole('textbox', { name: 'Skill instructions' });
    expect((instructions as HTMLTextAreaElement).value).toBe('# Generated');
    await userEvent.type(instructions, '\nReviewed');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveSkill).toHaveBeenCalledWith(expect.objectContaining({
      internalId: 'data-analysis', instructions: '# Generated\nReviewed', tools: [{ internalId: 'scores', version: '2.0.0' }],
    })));
    expect(await screen.findByText('saved 1.0.0')).toBeTruthy();
  });

  it('Tool一覧取得エラーを表示する', async () => {
    const client = { listTools: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ToolApiClient;
    render(<SkillBuilder client={client} />);
    expect(await screen.findByText('offline')).toBeTruthy();
  });
});
