import { expect, test, type Page } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };
const screenshotDir = 'docs/assets/harness-tutorial';

async function capture(page: Page, fileName: string): Promise<void> {
  await page.screenshot({ path: `${screenshotDir}/${fileName}`, fullPage: false, animations: 'disabled' });
}

test('Harness BuilderのAgent割当とチャット対象選択を撮影する', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('agentcontext.language', 'ja'));
  for (const agent of [
    { internalId: 'tutorial-writer', displayName: 'Tutorial Writer' },
    { internalId: 'tutorial-reviewer', displayName: 'Tutorial Reviewer' },
    { internalId: 'tutorial-publisher', displayName: 'Tutorial Publisher' },
  ]) {
    const response = await page.request.post('/agents', { data: {
      scope, ...agent, workingName: `${agent.displayName} draft`, publishName: agent.internalId.replace(/-/g, '_'), owner: 'tutorial@example.com', kind: 'normal', systemPrompt: `You are ${agent.displayName}.`, tools: [],
    } });
    expect(response.status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Harness', exact: true }).click();
  await expect(page.getByText('Agent Harness Builder', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新規作成', exact: true }).click();
  await page.getByLabel('内部ID').fill('tutorial-content-review');
  await page.getByLabel('表示名').fill('商品紹介レビュー');
  await page.getByLabel('所有者').fill('tutorial@example.com');
  await page.getByLabel('Agentを割り当て Author').selectOption('tutorial-writer');
  await page.getByLabel('Agentを割り当て Reviewer').selectOption('tutorial-reviewer');
  await page.getByLabel('Agentを割り当て Publisher').selectOption('tutorial-publisher');
  await capture(page, '01-harness-agent-assignment.png');

  await page.getByRole('main').getByRole('button', { name: '検証', exact: true }).click();
  await expect(page.getByText('定義は有効です', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'バージョンを保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'tutorial-content-review@1.0.0' })).toBeVisible();
  await capture(page, '02-harness-saved.png');

  const saved = await page.request.get('/harnesses/tutorial-content-review', { params: scope });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).harness).toMatchObject({ pattern: 'sequential', topology: { orderedSlotIds: ['author', 'reviewer', 'publisher'] } });

  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  const target = page.getByLabel('チャット対象エージェント');
  await expect(target).toBeEnabled();
  await target.selectOption('harness:tutorial-content-review');
  await expect(target).toHaveValue('harness:tutorial-content-review');
  await capture(page, '03-chat-harness-target.png');
});
