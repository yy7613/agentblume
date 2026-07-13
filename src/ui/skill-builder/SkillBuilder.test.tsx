// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { SkillBuilder } from './SkillBuilder';

afterEach(cleanup);

describe('SkillBuilder', () => {
  it('保存設定と、名前・説明・内容だけのAgentコンテキストを別の領域に表示する', () => {
    const client = {} as ToolApiClient;
    render(<SkillBuilder client={client} />);
    const saveSettings = screen.getByLabelText('Save settings');
    const agentContext = screen.getByLabelText('Agent context');
    expect(saveSettings).not.toBe(agentContext);
    expect(saveSettings.contains(screen.getByLabelText('Skill internal ID'))).toBe(true);
    expect(agentContext.contains(screen.getByLabelText('Skill description'))).toBe(true);
    expect(screen.getByLabelText('Skill content')).toBeTruthy();
    expect(screen.queryByText('Available Tools')).toBeNull();
    expect(screen.queryByLabelText('Skill responsibility')).toBeNull();
  });

  it('説明と内容をユーザー記述でversion保存する', async () => {
    const client = {
      saveSkill: vi.fn().mockResolvedValue({ metadata: { version: '1.0.0' } }),
    } as unknown as ToolApiClient;
    render(<SkillBuilder client={client} />);
    await userEvent.type(screen.getByLabelText('Skill internal ID'), 'data-analysis');
    await userEvent.type(screen.getByLabelText('Working name'), 'Data analysis draft');
    await userEvent.type(screen.getByLabelText('Skill display name'), 'Data analysis');
    await userEvent.type(screen.getByLabelText('Publish name'), 'data_analysis');
    await userEvent.type(screen.getByLabelText('Owner'), 'local-user');
    await userEvent.type(screen.getByLabelText('Skill description'), 'Analyze supplied data.');
    await userEvent.type(screen.getByLabelText('Skill content'), 'Use the supplied data and explain the result.');
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveSkill).toHaveBeenCalledWith(expect.objectContaining({
      internalId: 'data-analysis', responsibility: 'Analyze supplied data.', activationCondition: 'Analyze supplied data.', instructions: 'Use the supplied data and explain the result.', tools: [],
    })));
    expect(await screen.findByText('saved 1.0.0')).toBeTruthy();
  });
});
