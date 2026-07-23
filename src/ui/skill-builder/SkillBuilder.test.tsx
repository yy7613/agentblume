// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { SerializedSkillDto, SkillSummaryDto } from '../api/types';
import { SkillBuilder } from './SkillBuilder';

afterEach(cleanup);

// 一覧からOpenした時に返す保存済みSkill。
const existingSkillSummary: SkillSummaryDto = { internalId: 'existing-skill', displayName: 'Existing Skill', publishName: 'existing_skill', latestVersion: '2.0.0', state: 'draft' };
const existingSkillDto: SerializedSkillDto = {
  metadata: { internalId: 'existing-skill', workingName: 'Existing Skill draft', displayName: 'Existing Skill', publishName: 'existing_skill', version: '2.0.0', owner: 'owner@example.com', state: 'draft', tenant: { tenantId: 'local', workspaceId: 'default' } },
  responsibility: 'Analyze existing data.',
  activationCondition: 'Analyze existing data.',
  inputDescription: 'See skill content.',
  outputDescription: 'Follow skill content.',
  instructions: 'Use the existing data and explain the result.',
  tools: [],
};

function stubClient(): ToolApiClient {
  return {
    listSkills: vi.fn().mockResolvedValue([]),
    getSkill: vi.fn(),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    saveSkill: vi.fn(),
  } as unknown as ToolApiClient;
}

// Layer 1（一覧）が既定viewのため、editorの挙動を検証するテストはNew skillボタン経由で遷移してから始める。
async function openNewSkillEditor(client: ToolApiClient) {
  const rendered = render(<SkillBuilder client={client} />);
  await userEvent.click(await screen.findByRole('button', { name: 'New skill' }));
  return rendered;
}

describe('SkillBuilder', () => {
  it('保存設定と、名前・説明・内容だけのAgentコンテキストを別の領域に表示する', async () => {
    const client = stubClient();
    await openNewSkillEditor(client);
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
    const client = stubClient();
    (client.saveSkill as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
    await openNewSkillEditor(client);
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

  describe('一覧（Layer 1）', () => {
    it('listSkillsの内容を一覧表示する', async () => {
      const client = stubClient();
      (client.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue([existingSkillSummary]);
      render(<SkillBuilder client={client} />);

      expect(await screen.findByText('Existing Skill')).toBeTruthy();
      expect(screen.getByText('existing_skill@2.0.0')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    });

    it('Skillが無い場合はempty stateを表示する', async () => {
      const client = stubClient();
      render(<SkillBuilder client={client} />);
      expect(await screen.findByText('No skills yet.')).toBeTruthy();
    });

    it('OpenでgetSkillの内容をeditorへ復元し、Internal IDを読み取り専用にする', async () => {
      const client = stubClient();
      (client.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue([existingSkillSummary]);
      (client.getSkill as ReturnType<typeof vi.fn>).mockResolvedValue(existingSkillDto);
      render(<SkillBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
      expect(client.getSkill).toHaveBeenCalledWith('existing-skill', expect.any(Object));

      expect((await screen.findByLabelText('Skill display name') as HTMLInputElement).value).toBe('Existing Skill');
      expect((screen.getByLabelText('Skill description') as HTMLTextAreaElement).value).toBe('Analyze existing data.');
      expect((screen.getByLabelText('Skill content') as HTMLTextAreaElement).value).toBe('Use the existing data and explain the result.');

      const internalIdInput = screen.getByLabelText('Skill internal ID') as HTMLInputElement;
      expect(internalIdInput.value).toBe('existing-skill');
      expect(internalIdInput.readOnly).toBe(true);
    });

    it('Deleteでdeleteskillを呼び、一覧を再取得する', async () => {
      const client = stubClient();
      (client.listSkills as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([existingSkillSummary])
        .mockResolvedValueOnce([]);
      render(<SkillBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      expect(client.deleteSkill).toHaveBeenCalledWith('existing-skill', expect.any(Object));
      expect(client.listSkills).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('No skills yet.')).toBeTruthy();
    });

    it('Back to listでeditorから一覧へ戻り、一覧を再取得する', async () => {
      const client = stubClient();
      await openNewSkillEditor(client);
      expect(client.listSkills).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole('button', { name: 'Back to list' }));

      expect(await screen.findByRole('heading', { name: 'Skills' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'New skill' })).toBeTruthy();
      expect(client.listSkills).toHaveBeenCalledTimes(2);
    });
  });
});
