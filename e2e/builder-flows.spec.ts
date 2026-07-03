import { expect, test } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };

test('Tool Builderでpreviewを確認してversion保存できる', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Tool Builder', { exact: true })).toBeVisible();
  const preview = page.locator('section[aria-label="Preview"]');
  await expect(preview.getByText('Alice')).toBeVisible();
  await expect(preview.getByText('Bob')).toHaveCount(0);

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByLabel('Version history')).toHaveValue('1.0.0');

  const response = await page.request.get('/tools/customer-filter', { params: { ...scope, version: '1.0.0' } });
  expect(response.status()).toBe(200);
  expect((await response.json()).tool.metadata.publishName).toBe('adult_customers');
});

test('Agent BuilderでTool選択からprompt生成・編集・保存まで完了する', async ({ page }) => {
  const toolResponse = await page.request.post('/tools', { data: {
    scope,
    internalId: 'e2e-score-tool',
    workingName: 'E2E score tool',
    displayName: 'E2E Score Tool',
    publishName: 'e2e_score_tool',
    owner: 'e2e@example.com',
    sideEffect: 'read-only',
    graph: {
      nodes: [{
        id: 'input',
        type: 'agent-input',
        config: {
          schema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
          sample: { score: 42 },
        },
      }],
      edges: [],
    },
    inputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
    outputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
  } });
  expect(toolResponse.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByText('Agent Builder', { exact: true })).toBeVisible();
  await page.getByLabel('Agent internal ID').fill('e2e-agent');
  await page.getByRole('checkbox', { name: /E2E Score Tool/ }).check();
  await page.getByRole('checkbox', { name: 'Enable structured output' }).check();

  await page.getByRole('button', { name: 'Generate draft' }).click();
  const prompt = page.getByLabel('System prompt');
  await expect(prompt).toHaveValue(/e2e_score_tool@1\.0\.0/);
  await prompt.fill('Reviewed E2E system prompt.');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('saved 1.0.0')).toBeVisible();

  const agentResponse = await page.request.get('/agents/e2e-agent', { params: scope });
  expect(agentResponse.status()).toBe(200);
  const agent = (await agentResponse.json()).agent;
  expect(agent.systemPrompt).toBe('Reviewed E2E system prompt.');
  expect(agent.tools).toEqual([{ internalId: 'e2e-score-tool', version: '1.0.0' }]);
  expect(agent.output).toEqual({ name: 'assistant_agent_response', fields: [{ name: 'answer', type: 'string', required: true }] });

  await page.route('**/runs', async (route) => {
    const request = route.request();
    expect(request.postDataJSON()).toMatchObject({ agent: { internalId: 'e2e-agent', version: '1.0.0' }, mode: 'preview' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: {
      runId: 'e2e-run', mode: 'preview', agent: { internalId: 'e2e-agent', version: '1.0.0' }, response: '{"answer":"E2E agent response"}', structuredResponse: { answer: 'E2E agent response' }, usage: {},
      trace: [{ sequence: 1, kind: 'model-response', content: '{"answer":"E2E agent response"}' }],
    } }) });
  });
  await page.getByRole('button', { name: 'Run saved agent' }).click();
  await expect(page.getByText('E2E agent response')).toBeVisible();
});
