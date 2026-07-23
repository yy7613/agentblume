import { expect, test } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };

test('複数Wikiを作成しAgentごとに利用Wikiを指定できる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Memory', exact: true }).click();

  await page.getByRole('button', { name: 'New wiki' }).click();
  await page.getByLabel('Wiki ID').fill('customer-a');
  await page.getByLabel('Wiki name').fill('Customer A');
  await page.getByLabel('Description').fill('Customer A knowledge');
  await page.getByRole('button', { name: 'Save wiki' }).click();
  await expect(page.getByLabel('Active wiki')).toHaveValue('customer-a');
  await page.getByLabel('Title').fill('Refund policy');
  await page.getByLabel('Body').fill('Customer A requires a receipt.');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('button', { name: /Refund policy/ })).toBeVisible();

  await page.getByRole('button', { name: 'New wiki' }).click();
  await page.getByLabel('Wiki ID').fill('customer-b');
  await page.getByLabel('Wiki name').fill('Customer B');
  await page.getByLabel('Description').fill('Customer B knowledge');
  await page.getByRole('button', { name: 'Save wiki' }).click();
  await expect(page.getByLabel('Active wiki')).toHaveValue('customer-b');

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.getByLabel('Agent internal ID').fill('customer-a-agent');
  await page.getByLabel('Working name').fill('Customer A agent draft');
  await page.getByLabel('Agent display name').fill('Customer A Agent');
  await page.getByLabel('Publish name').fill('customer_a_agent');
  await page.getByLabel('Owner').fill('e2e@example.com');
  await page.getByLabel('System prompt').fill('Answer from Customer A knowledge only.');
  await page.getByRole('checkbox', { name: 'Use wiki Customer A' }).check();
  await expect(page.getByRole('checkbox', { name: 'Use wiki Customer B' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('saved 1.0.0')).toBeVisible();

  const response = await page.request.get('/agents/customer-a-agent', { params: scope });
  expect(response.status()).toBe(200);
  expect((await response.json()).agent.wikis).toEqual([{ wikiId: 'customer-a' }]);
});
