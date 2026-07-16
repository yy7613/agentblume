import { expect, test } from '@playwright/test';

const scope = { tenantId: 'local', workspaceId: 'default' };

async function fillToolMetadata(page: import('@playwright/test').Page, values: { readonly internalId: string; readonly displayName: string; readonly publishName: string }) {
  await page.getByLabel('Display name').fill(values.displayName);
  await page.getByText('Metadata', { exact: true }).click();
  await page.getByLabel('Internal ID').fill(values.internalId);
  await page.getByLabel('Working name').fill(`${values.displayName} draft`);
  await page.getByLabel('Publish name').fill(values.publishName);
  await page.getByLabel('Owner').fill('e2e@example.com');
}

async function fillAgentDefinition(page: import('@playwright/test').Page, internalId: string, displayName: string, publishName: string) {
  await page.getByLabel('Agent internal ID').fill(internalId);
  await page.getByLabel('Working name').fill(`${displayName} draft`);
  await page.getByLabel('Agent display name').fill(displayName);
  await page.getByLabel('Publish name').fill(publishName);
  await page.getByLabel('Owner').fill('e2e@example.com');
}

async function fillSkillDefinition(page: import('@playwright/test').Page, internalId: string, displayName: string, publishName: string) {
  await page.getByLabel('Skill internal ID').fill(internalId);
  await page.getByLabel('Working name').fill(`${displayName} draft`);
  await page.getByLabel('Skill display name').fill(displayName);
  await page.getByLabel('Publish name').fill(publishName);
  await page.getByLabel('Owner').fill('e2e@example.com');
}

test('Tool Builderでpreviewを確認してversion保存できる', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Tool Builder', { exact: true })).toBeVisible();
  const preview = page.locator('section[aria-label="Preview"]');
  await expect(preview.getByText('Alice')).toBeVisible();
  await expect(preview.getByText('Bob')).toHaveCount(0);
  await fillToolMetadata(page, { internalId: 'customer-filter', displayName: 'Customer filter', publishName: 'adult_customers' });

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
  await fillAgentDefinition(page, 'e2e-agent', 'E2E Agent', 'e2e_agent');
  await page.getByRole('checkbox', { name: /E2E Score Tool/ }).check();
  await page.getByRole('checkbox', { name: 'Enable structured output' }).check();
  await page.getByLabel('Output field 1 name').fill('answer');

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
  expect(agent.output).toEqual({ name: 'e2e_agent_response', fields: [{ name: 'answer', type: 'string', required: true }] });

  await page.route('**/runs', async (route) => {
    const request = route.request();
    expect(request.postDataJSON()).toMatchObject({ agent: { internalId: 'e2e-agent', version: '1.0.0' }, mode: 'preview' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: {
      runId: 'e2e-run', mode: 'preview', agent: { internalId: 'e2e-agent', version: '1.0.0' }, response: '{"answer":"E2E agent response"}', structuredResponse: { answer: 'E2E agent response' }, usage: {},
      trace: [{ sequence: 1, kind: 'model-response', content: '{"answer":"E2E agent response"}' }],
    } }) });
  });
  await page.getByLabel('Agent chat message').fill('Run the saved agent.');
  await page.getByRole('button', { name: 'Run saved agent' }).click();
  await expect(page.getByText('E2E agent response')).toBeVisible();
});

test('Harness BuilderでAgent割当・検証・保存・Sequential previewまで完了する', async ({ page }) => {
  for (const agent of [
    { internalId: 'harness-author', displayName: 'Harness Author' },
    { internalId: 'harness-reviewer', displayName: 'Harness Reviewer' },
    { internalId: 'harness-publisher', displayName: 'Harness Publisher' },
  ]) {
    const response = await page.request.post('/agents', { data: {
      scope, ...agent, workingName: `${agent.displayName} draft`, publishName: agent.internalId.replace(/-/g, '_'), owner: 'e2e@example.com', kind: 'normal', systemPrompt: `You are the ${agent.displayName}.`, tools: [],
    } });
    expect(response.status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Harness', exact: true }).click();
  await expect(page.getByText('Agent Harness Builder', { exact: true })).toBeVisible();
  await page.getByLabel('Internal ID').fill('e2e-content-review');
  await page.getByLabel('Display name').fill('E2E Content Review');
  await page.getByLabel('Owner').fill('e2e@example.com');
  await page.getByLabel('Assign agent to Author').selectOption('harness-author');
  await page.getByLabel('Assign agent to Reviewer').selectOption('harness-reviewer');
  await page.getByLabel('Assign agent to Publisher').selectOption('harness-publisher');
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.getByText('Definition is valid', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'e2e-content-review@1.0.0' })).toBeVisible();

  const harnessResponse = await page.request.get('/harnesses/e2e-content-review', { params: scope });
  expect(harnessResponse.status()).toBe(200);
  expect((await harnessResponse.json()).harness).toMatchObject({ pattern: 'sequential', topology: { orderedSlotIds: ['author', 'reviewer', 'publisher'] } });

  await page.route('**/harness-runs', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      harness: { internalId: 'e2e-content-review', version: '1.0.0' }, message: 'Review this product announcement.', mode: 'preview',
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: {
      runId: 'e2e-harness-run', scope, harness: { internalId: 'e2e-content-review', version: '1.0.0', displayName: 'E2E Content Review' }, mode: 'preview', status: 'succeeded', message: 'Review this product announcement.', startedAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T00:00:01.000Z', response: 'Reviewed and ready to publish.', events: [{ sequence: 1, kind: 'participant_completed', at: '2026-07-16T00:00:01.000Z', slotId: 'publisher', childRunId: 'child-3' }],
    } }) });
  });
  await page.getByLabel('Harness chat message').fill('Review this product announcement.');
  await page.getByRole('button', { name: 'Run preview', exact: true }).click();
  await expect(page.getByText('Reviewed and ready to publish.')).toBeVisible();
});

test('Skill Builderで名前・説明・内容を保存できる', async ({ page }) => {
  const toolResponse = await page.request.post('/tools', { data: {
    scope, internalId: 'e2e-skill-tool', workingName: 'E2E skill tool', displayName: 'E2E Skill Tool',
    publishName: 'e2e_skill_tool', owner: 'e2e@example.com', sideEffect: 'read-only',
    graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema: { columns: [{ name: 'value', type: 'number', nullable: false }] }, sample: { value: 42 } } }], edges: [] },
    inputSchema: { columns: [{ name: 'value', type: 'number', nullable: false }] },
    outputSchema: { columns: [{ name: 'value', type: 'number', nullable: false }] },
  } });
  expect(toolResponse.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: 'Skill', exact: true }).click();
  await expect(page.getByText('Skill Builder', { exact: true })).toBeVisible();
  await fillSkillDefinition(page, 'e2e-analysis-skill', 'E2E Analysis Skill', 'e2e_analysis_skill');
  await page.getByLabel('Skill description').fill('Analyze data and explain the result.');
  await page.getByRole('textbox', { name: 'Skill content' }).fill('Reviewed E2E skill instructions.');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('saved 1.0.0')).toBeVisible();

  const response = await page.request.get('/skills/e2e-analysis-skill', { params: scope });
  expect(response.status()).toBe(200);
  const skill = (await response.json()).skill;
  expect(skill.instructions).toBe('Reviewed E2E skill instructions.');
  expect(skill.responsibility).toBe('Analyze data and explain the result.');
  expect(skill.tools).toEqual([]);
});

test('Chat・MCP・Validation・Memory・Settingsの全ナビが実操作できる', async ({ page }) => {
  const tool = await page.request.post('/tools', { data: {
    scope, internalId: 'screen-tool', workingName: 'Screen tool', displayName: 'Screen Tool', publishName: 'screen_tool', owner: 'e2e', sideEffect: 'read-only',
    graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema: { columns: [] }, sample: {} } }], edges: [] }, inputSchema: { columns: [] }, outputSchema: { columns: [] },
  } });
  expect(tool.status()).toBe(201);
  const agent = await page.request.post('/agents', { data: {
    scope, internalId: 'screen-agent', workingName: 'Screen agent', displayName: 'Screen Agent', publishName: 'screen_agent', owner: 'e2e', kind: 'normal', systemPrompt: 'Use the screen tool.', skills: [], tools: [{ internalId: 'screen-tool', version: '1.0.0' }],
  } });
  expect(agent.status()).toBe(201);
  await page.route('**/agent-sessions', async (route) => {
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ session: { id: 'screen-session', scope, rootAgent: { internalId: 'screen-agent', version: '1.0.0' }, status: 'active', createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z', quota: { maxBytes: 1, maxArtifactBytes: 1, maxArtifacts: 1 } } }) });
  });
  await page.route('**/agent-sessions/**/artifacts**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ artifacts: [] }) });
  });
  await page.route('**/runs', async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: { runId: `screen-${body.mode}`, mode: body.mode, agent: body.agent, response: 'screen response', tools: [{ internalId: 'screen-tool', publishName: 'screen_tool', version: '1.0.0' }], trace: [], usage: {} } }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Chat agent').selectOption('screen-agent');
  await page.getByLabel('Chat message').fill('Screen test message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('screen response')).toBeVisible();

  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('checkbox', { name: /Screen Tool/ }).check();
  await expect(page.locator('.manifest-preview')).toContainText('screen-tool@1.0.0');
  await expect(page.getByRole('button', { name: 'Publish MCP server' })).toBeDisabled();

  await page.getByRole('button', { name: 'Validation', exact: true }).click();
  await page.getByRole('tab', { name: 'Personas' }).click();
  await page.getByRole('button', { name: 'New persona' }).click();
  await page.getByLabel('Persona internal ID').fill('screen-persona');
  await page.getByLabel('Persona working name').fill('Screen persona');
  await page.getByLabel('Persona display name').fill('Screen Persona');
  await page.getByLabel('Persona publish name').fill('screen_persona');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByRole('button', { name: /Screen Persona/ })).toContainText('1.0.0');
  await page.getByRole('tab', { name: 'Scenarios' }).click();
  await expect(page.getByRole('tab', { name: 'Scenarios' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Datasets' }).click();
  await expect(page.getByRole('tab', { name: 'Datasets' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Experiments' }).click();
  await expect(page.getByRole('tab', { name: 'Experiments' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Long-term memory' })).toBeVisible();
  await page.getByLabel('Wiki ID').fill('screen-wiki');
  await page.getByLabel('Wiki name').fill('Screen Wiki');
  await page.getByRole('button', { name: 'Save wiki' }).click();
  await expect(page.getByLabel('Active wiki')).toHaveValue('screen-wiki');
  await page.getByLabel('Title').fill('E2E note');
  await page.getByLabel('Body').fill('E2E memory body.');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('button', { name: /E2E note/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Proposals' }).click();
  await page.getByRole('button', { name: 'Approved' }).click();
  await expect(page.getByRole('button', { name: 'Approved' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible();
  await expect(page.getByText('ok', { exact: true })).toBeVisible();
  await page.getByLabel('Language').selectOption('ja');
  await expect(page.getByRole('heading', { name: '実行環境設定' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ツール', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('ツールビルダー', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('agentcontext.language'))).toBe('ja');
});
