import { expect, test } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };

test('Statusで運用時系列とRun観測を確認してfeedbackを保存できる', async ({ page }) => {
  const summary = { runId: 'run-observed', status: 'succeeded', mode: 'preview', purpose: 'interactive', agent: { internalId: 'observed-agent', version: '1.0.0', publishName: 'observed_agent' }, startedAt: '2026-07-10T00:00:00.000Z', response: 'answer', usage: { totalTokens: 150 }, latency: { totalMs: 20, modelMs: 18, toolMs: 0 }, estimatedCost: { kind: 'estimated', amount: 0.0002, currency: 'USD', price: { currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '2026-07-01T00:00:00.000Z' } }, traceEventCount: 1 };
  const record = { ...summary, scope, model: { provider: 'scripted', model: 'scripted', modelConfigHash: 'hash' }, trace: [{ sequence: 1, kind: 'model-response', content: 'answer' }] };
  const status = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z', summary: { runCount: 1, failureRate: 0, p50LatencyMs: 20, p95LatencyMs: 20, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 0 }, points: [{ bucketStart: '2026-07-10T00:00:00.000Z', runCount: 1, failureRate: 0, p50LatencyMs: 20, p95LatencyMs: 20, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 0 }] };
  let submitted: unknown;
  await page.route('**/runs?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [summary] }) }));
  await page.route('**/operations/status?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status }) }));
  await page.route('**/runs/run-observed/trace?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: record }) }));
  await page.route('**/runs/run-observed/feedback*', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feedback: null }) });
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feedback: { id: 'feedback', scope, runId: 'run-observed', agent: { internalId: 'observed-agent', version: '1.0.0' }, ...(submitted as object), createdAt: 'now', updatedAt: 'now' } }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Operations metrics' })).toContainText('$0.000200');
  await page.getByRole('button', { name: /observed_agent/ }).click();
  await expect(page.getByText('scripted / scripted')).toBeVisible();
  await page.getByRole('button', { name: /Needs work/ }).click();
  await page.getByLabel('Rating').selectOption('2');
  await page.getByLabel(/Issue tags/).fill('incorrect');
  await page.getByLabel('Comment').fill('wrong answer');
  await page.getByRole('button', { name: 'Save feedback' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  expect(submitted).toEqual({ scope, thumb: 'down', rating: 2, comment: 'wrong answer', issueTags: ['incorrect'] });
});
