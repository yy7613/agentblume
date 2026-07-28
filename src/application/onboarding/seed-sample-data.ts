/**
 * application層: オンボーディング用サンプルデータの投入（UIの「サンプルを読み込む」／CLIの `dev:sample` 共通の実体）
 *
 * 空のスタジオでは何から触ればよいか分からないため、データソース → ツール → スキル → Wiki → エージェント
 * まで**繋がった1セット**を1操作で用意する。
 *
 * **冪等性**: 同じ内部IDの資産が既にあれば作り直さない（再投入で新versionを増やさない）。
 * 何度呼んでも一覧の内容は同じで、`created` だけが「今回新しく作った件数」として変わる。
 * 利用者が編集したサンプルを上書きしないための選択でもある。
 */
import type { TenantScope } from '../../domain/tool/ids';
import type { QueryDataSourcesUseCase, SaveFileDataSourceUseCase } from '../data-source/manage-data-sources';
import type { GetToolUseCase, ListToolsUseCase } from '../tool/query-tool';
import type { SaveToolUseCase } from '../tool/save-tool';
import type { QuerySkillsUseCase } from '../skill/query-skills';
import type { SaveSkillUseCase } from '../skill/save-skill';
import type { QueryWikiSpacesUseCase, SaveWikiSpaceUseCase } from '../memory/wiki-spaces';
import type { QueryWikiUseCase } from '../memory/query-wiki';
import type { SaveWikiPageUseCase } from '../memory/save-wiki-page';
import type { QueryAgentsUseCase } from '../agent/query-agents';
import type { SaveAgentUseCase } from '../agent/save-agent';

/** サンプル資産の固定ID。冪等判定のキーでもあるので変更しないこと。 */
export const SAMPLE_TOOL_ID = 'sample-product-catalog';
export const SAMPLE_SKILL_ID = 'sample-product-analysis';
export const SAMPLE_AGENT_ID = 'sample-product-assistant';
export const SAMPLE_WIKI_ID = 'sample-product-ops';
export const SAMPLE_WIKI_PAGE_ID = 'sample-product-guide';
export const SAMPLE_DATA_SOURCE_NAMES = ['sample-products.csv', 'sample-customers.json', 'sample-monthly-sales.csv'] as const;

/** 投入結果。UIが「何が入ったか」を一覧表示するためのサマリ。 */
export interface SampleDataSummary {
  readonly dataSources: readonly string[];
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly wikis: readonly string[];
  /** 今回新しく作成した資産の数。0 なら既に投入済み（何も変更していない）。 */
  readonly created: number;
}

/** 必要な操作だけを受け取る（App全体を渡さないので、テストでは最小のfakeで組める）。 */
export interface SeedSampleDataDeps {
  readonly queryDataSources: Pick<QueryDataSourcesUseCase, 'list'>;
  readonly saveFileDataSource: Pick<SaveFileDataSourceUseCase, 'execute'>;
  readonly listTools: Pick<ListToolsUseCase, 'execute'>;
  readonly getTool: Pick<GetToolUseCase, 'latest'>;
  readonly saveTool: Pick<SaveToolUseCase, 'execute'>;
  readonly querySkills: Pick<QuerySkillsUseCase, 'list' | 'get'>;
  readonly saveSkill: Pick<SaveSkillUseCase, 'execute'>;
  readonly queryWikiSpaces: Pick<QueryWikiSpacesUseCase, 'list'>;
  readonly saveWikiSpace: Pick<SaveWikiSpaceUseCase, 'execute'>;
  readonly queryWiki: Pick<QueryWikiUseCase, 'get'>;
  readonly saveWikiPage: Pick<SaveWikiPageUseCase, 'execute'>;
  readonly queryAgents: Pick<QueryAgentsUseCase, 'list'>;
  readonly saveAgent: Pick<SaveAgentUseCase, 'execute'>;
}

const PRODUCTS_CSV = [
  'id,name,category,price,in_stock',
  'p-100,Wireless Headphones,electronics,12900,true',
  'p-200,Mechanical Keyboard,electronics,15800,true',
  'p-300,Desk Lamp,home,4200,false',
].join('\n');

const CUSTOMERS_JSON = JSON.stringify([
  { id: 'c-100', name: 'Aki Sato', plan: 'pro', active: true },
  { id: 'c-200', name: 'Ren Ito', plan: 'starter', active: true },
], null, 2);

// Agent Factory（v33）を試す用: 集計・傾向要約しやすい月次売上CSV（2リージョン × 3ヶ月）。
const MONTHLY_SALES_CSV = [
  'month,region,revenue,units',
  '2026-05,East,120000,400',
  '2026-05,West,98000,350',
  '2026-06,East,135000,420',
  '2026-06,West,101000,360',
  '2026-07,East,140000,430',
  '2026-07,West,110000,370',
].join('\n');

export class SeedSampleDataUseCase {
  constructor(private readonly deps: SeedSampleDataDeps) {}

  async execute(scope: TenantScope): Promise<SampleDataSummary> {
    let created = 0;
    const existingSources = await this.deps.queryDataSources.list(scope);
    const saveFile = async (name: string, format: 'csv' | 'json', content: string): Promise<void> => {
      if (existingSources.some((source) => source.name === name)) return;
      await this.deps.saveFileDataSource.execute({ scope, name, format, content });
      created += 1;
    };
    await saveFile('sample-products.csv', 'csv', PRODUCTS_CSV);
    await saveFile('sample-customers.json', 'json', CUSTOMERS_JSON);
    await saveFile('sample-monthly-sales.csv', 'csv', MONTHLY_SALES_CSV);

    const toolExists = (await this.deps.listTools.execute(scope)).some((item) => item.internalId === SAMPLE_TOOL_ID);
    const tool = toolExists
      ? await this.deps.getTool.latest(scope, SAMPLE_TOOL_ID)
      : await this.deps.saveTool.execute({
          scope,
          internalId: SAMPLE_TOOL_ID,
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
    if (!toolExists) created += 1;

    const skillExists = (await this.deps.querySkills.list(scope)).some((item) => item.internalId === SAMPLE_SKILL_ID);
    const skill = skillExists
      ? await this.deps.querySkills.get(scope, SAMPLE_SKILL_ID)
      : await this.deps.saveSkill.execute({
          scope,
          internalId: SAMPLE_SKILL_ID,
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
    if (!skillExists) created += 1;

    const spaces = await this.deps.queryWikiSpaces.list(scope);
    if (!spaces.some((space) => space.id === SAMPLE_WIKI_ID)) {
      await this.deps.saveWikiSpace.execute({ scope, id: SAMPLE_WIKI_ID, name: 'Sample Product Operations', description: 'Operational notes used by the sample agent.' });
      created += 1;
    }
    try {
      await this.deps.queryWiki.get(scope, SAMPLE_WIKI_PAGE_ID);
    } catch {
      await this.deps.saveWikiPage.execute({
        scope,
        id: SAMPLE_WIKI_PAGE_ID,
        wikiId: SAMPLE_WIKI_ID,
        title: 'Product catalog response guide',
        tags: ['sample', 'products'],
        body: 'Recommend only in-stock products. Compare price and category before suggesting an alternative.',
      });
      created += 1;
    }

    if (!(await this.deps.queryAgents.list(scope)).some((item) => item.internalId === SAMPLE_AGENT_ID)) {
      await this.deps.saveAgent.execute({
        scope,
        internalId: SAMPLE_AGENT_ID,
        workingName: 'Sample product assistant draft',
        displayName: 'Sample Product Assistant',
        publishName: 'sample_product_assistant',
        owner: 'sample-data',
        kind: 'normal',
        systemPrompt: 'Help users choose products using the assigned catalog tool, skill, and wiki. Do not invent catalog entries.',
        skills: [{ internalId: skill.metadata.internalId, version: skill.metadata.version }],
        tools: [{ internalId: tool.metadata.internalId, version: tool.metadata.version }],
        wikis: [{ wikiId: SAMPLE_WIKI_ID }],
      });
      created += 1;
    }

    return {
      dataSources: [...SAMPLE_DATA_SOURCE_NAMES],
      tools: [SAMPLE_TOOL_ID],
      skills: [SAMPLE_SKILL_ID],
      agents: [SAMPLE_AGENT_ID],
      wikis: [SAMPLE_WIKI_ID],
      created,
    };
  }
}
