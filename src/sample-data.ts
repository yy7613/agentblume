/**
 * 手動確認用の最小データセット。
 * 起動経路からだけ呼び出し、アプリケーション本体の通常データには介入しない。
 */
import type { App } from './composition/root';

export const SAMPLE_SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;

export interface SampleDataResult {
  readonly dataSourceNames: readonly string[];
  readonly toolId: string;
  readonly skillId: string;
  readonly agentId: string;
  readonly wikiId: string;
}

export async function seedSampleData(app: App): Promise<SampleDataResult> {
  const scope = SAMPLE_SCOPE;
  const dataSources = await app.queryDataSources.list(scope);
  const saveFile = async (name: string, format: 'csv' | 'json', content: string): Promise<void> => {
    if (!dataSources.some((source) => source.name === name)) {
      await app.saveFileDataSource.execute({ scope, name, format, content });
    }
  };

  await saveFile('sample-products.csv', 'csv', [
    'id,name,category,price,in_stock',
    'p-100,Wireless Headphones,electronics,12900,true',
    'p-200,Mechanical Keyboard,electronics,15800,true',
    'p-300,Desk Lamp,home,4200,false',
  ].join('\n'));
  await saveFile('sample-customers.json', 'json', JSON.stringify([
    { id: 'c-100', name: 'Aki Sato', plan: 'pro', active: true },
    { id: 'c-200', name: 'Ren Ito', plan: 'starter', active: true },
  ], null, 2));

  const toolId = 'sample-product-catalog';
  const tool = (await app.listTools.execute(scope)).some((item) => item.internalId === toolId)
    ? await app.getTool.latest(scope, toolId)
    : await app.saveTool.execute({
        scope,
        internalId: toolId,
        workingName: 'Sample product catalog draft',
        displayName: 'Sample Product Catalog',
        publishName: 'sample_product_catalog',
        owner: 'sample-data',
        sideEffect: 'read-only',
        graph: {
          nodes: [
            { id: 'catalog', type: 'json-source', config: { rows: [
              { id: 'p-100', name: 'Wireless Headphones', category: 'electronics', price: 12900, inStock: true },
              { id: 'p-200', name: 'Mechanical Keyboard', category: 'electronics', price: 15800, inStock: true },
              { id: 'p-300', name: 'Desk Lamp', category: 'home', price: 4200, inStock: false },
            ] } },
            { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
          ],
          edges: [{ from: 'catalog', to: 'agent-result' }],
        },
      });

  const skillId = 'sample-product-analysis';
  const skill = (await app.querySkills.list(scope)).some((item) => item.internalId === skillId)
    ? await app.querySkills.get(scope, skillId)
    : await app.saveSkill.execute({
        scope,
        internalId: skillId,
        workingName: 'Sample product analysis draft',
        displayName: 'Sample Product Analysis',
        publishName: 'sample_product_analysis',
        owner: 'sample-data',
        responsibility: 'Analyze product catalog results.',
        activationCondition: 'Use when a product catalog question is received.',
        inputDescription: 'A question and product catalog rows.',
        outputDescription: 'A concise, evidence-based product recommendation.',
        instructions: 'Answer from the available catalog data. State when no matching product is available. Keep product names and prices exact.',
        tools: [],
      });

  const wikiId = 'sample-product-ops';
  const spaces = await app.queryWikiSpaces.list(scope);
  if (!spaces.some((space) => space.id === wikiId)) {
    await app.saveWikiSpace.execute({ scope, id: wikiId, name: 'Sample Product Operations', description: 'Operational notes used by the sample agent.' });
  }
  try {
    await app.queryWiki.get(scope, 'sample-product-guide');
  } catch {
    await app.saveWikiPage.execute({
      scope,
      id: 'sample-product-guide',
      wikiId,
      title: 'Product catalog response guide',
      tags: ['sample', 'products'],
      body: 'Recommend only in-stock products. Compare price and category before suggesting an alternative.',
    });
  }

  const agentId = 'sample-product-assistant';
  if (!(await app.queryAgents.list(scope)).some((item) => item.internalId === agentId)) {
    await app.saveAgent.execute({
      scope,
      internalId: agentId,
      workingName: 'Sample product assistant draft',
      displayName: 'Sample Product Assistant',
      publishName: 'sample_product_assistant',
      owner: 'sample-data',
      kind: 'normal',
      systemPrompt: 'Help users choose products using the assigned catalog tool, skill, and wiki. Do not invent catalog entries.',
      skills: [{ internalId: skill.metadata.internalId, version: skill.metadata.version }],
      tools: [{ internalId: tool.metadata.internalId, version: tool.metadata.version }],
      wikis: [{ wikiId }],
    });
  }

  return { dataSourceNames: ['sample-products.csv', 'sample-customers.json'], toolId, skillId, agentId, wikiId };
}
