/**
 * 手動確認用の最小データセット（起動経路 `AGENTCONTEXT_SAMPLE_DATA=true` 用の薄いラッパー）。
 *
 * 実体は application 層の `SeedSampleDataUseCase`。UIの「サンプルを読み込む」ボタン（`POST /sample-data`）と
 * この起動経路は同じユースケースを共有するので、投入される内容は必ず一致する。
 */
import type { App } from './composition/root';
import { SAMPLE_AGENT_ID, SAMPLE_DATA_SOURCE_NAMES, SAMPLE_SKILL_ID, SAMPLE_TOOL_ID, SAMPLE_WIKI_ID } from './application/onboarding/seed-sample-data';

export const SAMPLE_SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;

export interface SampleDataResult {
  readonly dataSourceNames: readonly string[];
  readonly toolId: string;
  readonly skillId: string;
  readonly agentId: string;
  readonly wikiId: string;
}

export async function seedSampleData(app: App): Promise<SampleDataResult> {
  await app.seedSampleData.execute(SAMPLE_SCOPE);
  return {
    dataSourceNames: [...SAMPLE_DATA_SOURCE_NAMES],
    toolId: SAMPLE_TOOL_ID,
    skillId: SAMPLE_SKILL_ID,
    agentId: SAMPLE_AGENT_ID,
    wikiId: SAMPLE_WIKI_ID,
  };
}
