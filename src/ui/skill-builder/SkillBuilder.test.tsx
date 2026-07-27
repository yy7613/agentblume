// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { SerializedSkillDto, SkillSummaryDto } from '../api/types';
import { draftKey, readDraft, writeDraft } from '../hooks/useDraftPersistence';
import { SkillBuilder } from './SkillBuilder';

afterEach(cleanup);
// 下書きは localStorage に残るため、テスト間で持ち越さない。
beforeEach(() => { localStorage.clear(); });

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

// saveSkillのサーバー必須項目をすべて埋める（保存ボタンの活性条件と同じ集合）。
async function fillRequiredFields(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Skill internal ID'), 'data-analysis');
  await userEvent.type(screen.getByLabelText('Skill working name'), 'Data analysis draft');
  await userEvent.type(screen.getByLabelText('Skill display name'), 'Data analysis');
  await userEvent.type(screen.getByLabelText('Skill publish name'), 'data_analysis');
  await userEvent.type(screen.getByLabelText('Skill owner'), 'local-user');
  await userEvent.type(screen.getByLabelText('Skill description'), 'Analyze supplied data.');
  await userEvent.type(screen.getByLabelText('Skill content'), 'Use the supplied data and explain the result.');
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
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveSkill).toHaveBeenCalledWith(expect.objectContaining({
      internalId: 'data-analysis', responsibility: 'Analyze supplied data.', activationCondition: 'Analyze supplied data.', instructions: 'Use the supplied data and explain the result.', tools: [],
    })));
    expect(await screen.findByText('saved 1.0.0')).toBeTruthy();
    // 保存成功は右上のピルだけでなく、保存ボタン近傍にも明示する。
    expect(await screen.findByText('Saved · version 1.0.0')).toBeTruthy();
  });

  it('スキル名だけ空でも保存できず、未入力の項目名を理由として表示する', async () => {
    const client = stubClient();
    const { container } = await openNewSkillEditor(client);
    const save = screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.querySelectorAll('.required-mark').length).toBeGreaterThanOrEqual(7);
    expect(screen.getByText(/Required fields are empty: Internal ID, Working name, Skill name, Publish name, Owner, Skill description, Skill content/)).toBeTruthy();

    await fillRequiredFields();
    expect(save.disabled).toBe(false);

    // スキル名（displayName）だけ空にすると、以前は押せてサーバー400になっていた。
    await userEvent.clear(screen.getByLabelText('Skill display name'));
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Required fields are empty: Skill name.')).toBeTruthy();
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

    it('Deleteは確認ダイアログの承諾後にdeleteSkillを呼び、一覧を再取得する', async () => {
      const client = stubClient();
      (client.listSkills as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([existingSkillSummary])
        .mockResolvedValueOnce([]);
      render(<SkillBuilder client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('Existing Skill');
      expect(client.deleteSkill).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(client.deleteSkill).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

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

  describe('下書きの自動保存と復元', () => {
    const newSkillKey = draftKey('skill-builder', { tenantId: 'local', workspaceId: 'default' });

    it('長文の内容を退避し、画面を離れても失わない', async () => {
      const client = stubClient();
      const { unmount } = await openNewSkillEditor(client);
      await userEvent.type(screen.getByRole('textbox', { name: 'Skill content' }), 'Long skill body.');
      unmount();
      expect(readDraft<{ instructions: string }>(newSkillKey)?.value.instructions).toBe('Long skill body.');
    });

    it('復元バナーから内容を戻せる', async () => {
      writeDraft(newSkillKey, { internalId: 'i', workingName: 'w', displayName: 'Restored Skill', publishName: 'p', owner: 'o', description: 'Restored description.', instructions: 'Restored content.' }, '2026-07-27T09:30:00.000Z');
      const client = stubClient();
      await openNewSkillEditor(client);
      await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
      expect((screen.getByRole('textbox', { name: 'Skill content' }) as HTMLTextAreaElement).value).toBe('Restored content.');
      expect((screen.getByRole('textbox', { name: 'Skill description' }) as HTMLTextAreaElement).value).toBe('Restored description.');
    });

    it('保存に成功すると下書きを消す', async () => {
      const client = stubClient();
      (client.saveSkill as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { version: '1.0.0' } });
      await openNewSkillEditor(client);
      await userEvent.type(screen.getByLabelText('Skill internal ID'), 'saved-skill');
      await userEvent.type(screen.getByLabelText('Skill working name'), 'draft');
      await userEvent.type(screen.getByLabelText('Skill display name'), 'Saved Skill');
      await userEvent.type(screen.getByLabelText('Skill publish name'), 'saved_skill');
      await userEvent.type(screen.getByLabelText('Skill owner'), 'owner');
      await userEvent.type(screen.getByRole('textbox', { name: 'Skill description' }), 'desc');
      await userEvent.type(screen.getByRole('textbox', { name: 'Skill content' }), 'body');

      await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await screen.findByText('Saved · version 1.0.0');
      await waitFor(() => expect(localStorage.getItem(newSkillKey)).toBeNull());
    });
  });
});
