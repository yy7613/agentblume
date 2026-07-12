import { expect, test } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };

test('Tool BuilderでWorkspace graph outputを構造化Dialogから設定して保存できる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Workspace output/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace output' })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Node configuration' });
  await dialog.getByLabel('Artifact name').fill('sales-result');
  await dialog.getByLabel('Artifact type').selectOption('graph');
  await dialog.getByLabel('Source column').selectOption('id');
  await dialog.getByLabel('Target column').selectOption('name');
  await dialog.getByRole('button', { name: 'Apply settings' }).click();
  await page.getByLabel('Display name').fill('Customer filter');
  await page.getByText('Metadata', { exact: true }).click();
  await page.getByLabel('Internal ID').fill('customer-filter');
  await page.getByLabel('Working name').fill('Customer filter draft');
  await page.getByLabel('Publish name').fill('adult_customers');
  await page.getByLabel('Owner').fill('e2e@example.com');
  await page.getByRole('button', { name: 'Save version' }).click();
  const response = await page.request.get('/tools/customer-filter', { params: scope });
  expect(response.status()).toBe(200);
  const tool = (await response.json()).tool;
  expect(tool.sideEffect).toBe('session-write');
  expect(tool.graph.nodes).toContainEqual(expect.objectContaining({ type: 'workspace-output', config: expect.objectContaining({ name: 'sales-result', artifactKind: 'graph', graph: { sourceColumn: 'id', targetColumn: 'name' } }) }));
});
