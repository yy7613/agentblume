import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from './composition/root';
import { SAMPLE_SCOPE, seedSampleData } from './sample-data';

describe('seedSampleData', () => {
  const apps: App[] = [];
  afterEach(() => { for (const app of apps.splice(0)) app.close(); });

  it('creates a linked manual-test dataset once and keeps it idempotent', async () => {
    const app = createApp({ profile: 'test' });
    apps.push(app);

    const first = await seedSampleData(app);
    const second = await seedSampleData(app);

    expect(second).toEqual(first);
    expect((await app.queryDataSources.list(SAMPLE_SCOPE)).map((source) => source.name)).toEqual(expect.arrayContaining([...first.dataSourceNames]));
    expect((await app.listTools.execute(SAMPLE_SCOPE)).filter((tool) => tool.internalId === first.toolId)).toHaveLength(1);
    expect((await app.querySkills.list(SAMPLE_SCOPE)).filter((skill) => skill.internalId === first.skillId)).toHaveLength(1);
    const agent = await app.queryAgents.get(SAMPLE_SCOPE, first.agentId);
    expect(agent.tools).toEqual([{ internalId: first.toolId, version: agent.tools[0]?.version }]);
    expect(agent.skills).toEqual([{ internalId: first.skillId, version: agent.skills[0]?.version }]);
    expect(agent.wikis).toEqual([{ wikiId: first.wikiId }]);
    expect((await app.queryWiki.search(SAMPLE_SCOPE, 'catalog', 10, [first.wikiId])).map((page) => page.title)).toContain('Product catalog response guide');
  });
});
