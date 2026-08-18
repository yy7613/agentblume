import { expect, test, type Locator, type Page } from '@playwright/test';

const screenshotDir = 'docs/assets/demo-manual';
const liveModel = process.env['AGENTCONTEXT_MANUAL_LIVE'] === 'true';

async function capture(page: Page, fileName: string): Promise<void> {
  await page.screenshot({ path: `${screenshotDir}/${fileName}`, fullPage: false, animations: 'disabled' });
}

async function captureElement(locator: Locator, fileName: string): Promise<void> {
  await locator.screenshot({ path: `${screenshotDir}/${fileName}`, animations: 'disabled' });
}

async function navigate(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  const leave = page.getByRole('button', { name: '移動する', exact: true });
  if (await leave.isVisible().catch(() => false)) await leave.click();
}

test('デモデータの実画面を操作してマニュアル画像を生成する', async ({ page }) => {
  test.setTimeout(liveModel ? 180_000 : 90_000);
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => localStorage.setItem('agentcontext.language', 'ja'));
  await page.goto('/');
  await navigate(page, 'ツール');
  await expect(page.getByText('ツールビルダー', { exact: true })).toBeVisible();

  await navigate(page, 'データソース');
  await expect(page.getByRole('heading', { name: 'ツールで扱うデータ' })).toBeVisible();
  await expect(page.getByText('sample-products.csv', { exact: true })).toBeVisible();
  await expect(page.getByText('sample-customers.json', { exact: true })).toBeVisible();
  await capture(page, '01-data-sources.png');

  await navigate(page, 'ツール');
  await page.locator('article.agent-list-row').filter({ hasText: 'Sample Product Catalog' })
    .getByRole('button', { name: '開く' }).click();
  await page.getByText('メタデータ', { exact: true }).click();
  await page.getByRole('button', { name: 'バージョン', exact: true }).click();
  await expect(page.getByLabel('バージョン履歴').locator('option[value="1.0.0"]')).toHaveCount(1);
  await page.getByLabel('バージョン履歴').selectOption('1.0.0');
  await expect(page.getByLabel('表示名')).toHaveValue('Sample Product Catalog');
  const preview = page.locator('section[aria-label="プレビュー"]');
  await expect(preview.getByText('Wireless Headphones', { exact: true })).toBeVisible();
  await expect(preview.getByText('Mechanical Keyboard', { exact: true })).toBeVisible();
  await expect(preview.getByText('Desk Lamp', { exact: true })).toBeVisible();
  await page.getByText('メタデータ', { exact: true }).click();
  await capture(page, '02-tool-preview.png');

  await navigate(page, 'エージェント');
  await page.locator('article.agent-list-row').filter({ hasText: 'Sample Product Assistant' })
    .getByRole('button', { name: '開く' }).click();
  const skillAssignment = page.locator('label.agent-tool-option').filter({ hasText: 'Sample Product Analysis' }).getByRole('checkbox');
  const toolAssignment = page.locator('label.agent-tool-option').filter({ hasText: 'Sample Product Catalog' }).getByRole('checkbox');
  const wikiAssignment = page.getByLabel('Wikiを使用 Sample Product Operations');
  await expect(skillAssignment).toBeChecked();
  await expect(toolAssignment).toBeChecked();
  await expect(wikiAssignment).toBeChecked();
  await captureElement(page.locator('section.agent-definition-card'), '03-agent-context.png');

  await navigate(page, '記憶');
  await expect(page.getByRole('heading', { name: '長期記憶' })).toBeVisible();
  await expect(page.getByLabel('選択中のWiki')).toHaveValue('sample-product-ops');
  await page.getByRole('button', { name: /Product catalog response guide/ }).click();
  await expect(page.getByLabel('本文')).toHaveValue(/Recommend only in-stock products/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, '04-wiki-memory.png');

  await navigate(page, 'チャット');
  await expect(page.getByRole('heading', { name: 'エージェント実行' })).toBeVisible();
  await expect(page.getByLabel('チャット対象エージェント')).toHaveValue('sample-product-assistant');
  await page.getByLabel('チャットメッセージ').fill('在庫のあるelectronics商品を価格付きで比較して。');
  await capture(page, '05-chat-ready.png');
  if (liveModel) {
    await page.getByRole('button', { name: '送信' }).click();
    await expect(page.locator('.cc-msg.assistant .cc-meta').filter({ hasText: /^run / }))
      .toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await capture(page, '07-chat-result.png');
  }

  await navigate(page, 'マルチエージェント');
  await page.getByRole('button', { name: '新規作成', exact: true }).click();
  await page.getByRole('button', { name: /^Concurrent/ }).click();
  await page.getByLabel('Agentを割り当て 調査').selectOption('sample-product-assistant');
  await expect(page.getByText('集約: collect', { exact: true }).first()).toBeVisible();
  await capture(page, '08-harness-builder.png');

  await navigate(page, '自動生成 (Factory)');
  await expect(page.getByRole('heading', { name: '新規Factory実行' })).toBeVisible();
  await page.getByLabel('Factoryのやりたいこと').fill('月次の売上データについて質問に答え、傾向を要約できるアシスタントが欲しい');
  await page.getByLabel('Factory想定利用者').fill('経理担当者。SQLは書けない');
  await capture(page, '09-factory.png');

  await navigate(page, 'ツール');
  await expect(page.getByText('ツールビルダー', { exact: true })).toBeVisible();
  await page.locator('article.agent-list-row').filter({ hasText: 'Sample Product Catalog' })
    .getByRole('button', { name: '開く' }).click();
  await expect(page.getByText('有効な草案', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^グラフ出力 / }).click();
  await page.getByRole('button', { name: '設定を開く' }).click();
  const dialog = page.getByRole('dialog', { name: 'ノード設定' });
  await expect(dialog.getByLabel('始点列')).toHaveValue('id');
  await expect(dialog.getByLabel('終点列')).toHaveValue('name');
  await expect(dialog.getByText('プロパティグラフ対応')).toBeVisible();
  await capture(page, '06-graph-output.png');
});
