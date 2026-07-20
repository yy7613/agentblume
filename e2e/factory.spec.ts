import { expect, test } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };

// e2eサーバーはAGENTCONTEXT_PROFILE=testで起動し、ScriptedModelProviderのqueueは空のため、
// 実際にFactory実行を起票するとplanningで必ず失敗する。よってこのsmokeはUIのレンダリングのみを検証し、
// モデル出力に依存する実行フローは対象外とする（実装契約 v33-agent-factory.md §8 E2E方針: 画面遷移smoke）。
test('Factory画面: 入力フォーム・データソース選択・詳細オプションが表示される（smoke）', async ({ page }) => {
  const uploaded = await page.request.post('/data-sources/files', {
    data: { scope, name: 'e2e-factory-sales.csv', format: 'csv', content: 'id,amount\n1,100\n2,200' },
  });
  expect(uploaded.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: 'Factory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent Factory' })).toBeVisible();

  // 入力フォーム: goal必須・Startボタンは無効。
  await expect(page.getByLabel('Factory goal')).toBeVisible();
  const startButton = page.getByRole('button', { name: 'Start factory run' });
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeDisabled();

  // データソース複数選択（チェックボックス一覧）。
  const sourceCheckbox = page.getByRole('checkbox', { name: /e2e-factory-sales.csv/ });
  await expect(sourceCheckbox).toBeVisible();

  // 詳細オプション（折り畳み）。
  await expect(page.getByText('Advanced options')).toBeVisible();

  // 実行履歴は空。
  await expect(page.getByText('No factory runs yet.')).toBeVisible();

  // goal + データソースを入力するとStartが有効になることだけを確認する（実行はしない）。
  await page.getByLabel('Factory goal').fill('Answer sales questions.');
  await sourceCheckbox.check();
  await expect(startButton).toBeEnabled();
});
