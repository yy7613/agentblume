import { describe, expect, it } from 'vitest';
import type { ToolSummary } from '../../domain/tool/metadata';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { createAgent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import { AgentValidationError } from '../../domain/agent/errors';
import { GenerateAgentPromptUseCase } from './generate-agent-prompt';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const tool = createTool({
  metadata: { internalId: 'scores', workingName: 'scores', displayName: 'Score filter', publishName: 'filter_scores', version: SemVer.of(2, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
  sideEffect: 'read-only', graph: { nodes: [], edges: [] },
  inputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
  outputSchema: { columns: [{ name: 'passed', type: 'boolean', nullable: false }] },
});
/** nullable（省略可能）なTool引数を持つTool。 */
const optionalArgumentTool = createTool({
  metadata: { internalId: 'regions', workingName: 'regions', displayName: 'Region search', publishName: 'search_regions', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
  sideEffect: 'read-only', graph: { nodes: [], edges: [] },
  inputSchema: { columns: [{ name: 'month', type: 'string', nullable: false }, { name: 'region', type: 'string', nullable: true }] },
});
const catalog: Readonly<Record<string, Tool>> = { scores: tool, regions: optionalArgumentTool };
class FakeTools implements ToolRepository {
  async findVersion(target: TenantScope, id: string, version: SemVer): Promise<Tool | null> {
    const found = catalog[id];
    return target.tenantId === 'tenant' && found !== undefined && found.metadata.version.toString() === version.toString() ? found : null;
  }
  async findLatest(): Promise<Tool | null> { return null; }
  async save(): Promise<void> {}
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ToolSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

describe('GenerateAgentPromptUseCase', () => {
  it('Tool公開名・固定version・schema・side effectを編集可能な草案へ含める', async () => {
    const result = await new GenerateAgentPromptUseCase(new FakeTools()).execute({ scope, displayName: 'Judge', kind: 'evaluator', tools: [{ internalId: 'scores', version: SemVer.of(2, 0, 0) }], output: { name: 'judge_response', fields: [{ name: 'verdict', type: 'boolean', required: true }] } });
    expect(result.editable).toBe(true);
    expect(result.systemPromptDraft).toContain('filter_scores@2.0.0');
    expect(result.systemPromptDraft).toContain('score:number');
    expect(result.systemPromptDraft).toContain('side-effect read-only');
    expect(result.systemPromptDraft).toContain('verdict:boolean');
    expect(result.sources).toEqual(['tool:filter_scores@2.0.0 の入出力・副作用']);
  });

  it('nullable引数は`?`付きで示し、省略時に絞り込みを行わないことを補足する', async () => {
    const result = await new GenerateAgentPromptUseCase(new FakeTools()).execute({ scope, displayName: 'Searcher', kind: 'normal', tools: [{ internalId: 'regions', version: SemVer.of(1, 0, 0) }] });
    expect(result.sections.toolUsageGuide).toContain('input [month:string, region?:string]');
    expect(result.sections.toolUsageGuide).toContain('`?` 付きの引数は省略可能');
    expect(result.sections.toolUsageGuide).toContain('絞り込みを行わない');
  });

  it('nullable引数を持つToolが無ければ省略可能引数の補足は出さない', async () => {
    const result = await new GenerateAgentPromptUseCase(new FakeTools()).execute({ scope, displayName: 'Judge', kind: 'normal', tools: [{ internalId: 'scores', version: SemVer.of(2, 0, 0) }] });
    expect(result.sections.toolUsageGuide).not.toContain('省略可能');
  });

  it('空displayNameと未存在Toolを拒否する', async () => {
    const usecase = new GenerateAgentPromptUseCase(new FakeTools());
    await expect(usecase.execute({ scope, displayName: ' ', kind: 'normal', tools: [] })).rejects.toBeInstanceOf(AgentValidationError);
    await expect(usecase.execute({ scope, displayName: 'Agent', kind: 'normal', tools: [{ internalId: 'missing', version: SemVer.of(1, 0, 0) }] })).rejects.toThrow(/not found/);
  });

  it('サブエージェントの委譲基準を協働者ガイドとsourcesへ含める', async () => {
    const sub = createAgent({ metadata: { internalId: 'scorer', workingName: 'scorer', displayName: 'Scorer', publishName: 'scorer', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope }, kind: 'normal', systemPrompt: 'Score.', tools: [] });
    const agents = { findVersion: async (_s: TenantScope, id: string) => id === 'scorer' ? sub : null, findLatest: async () => null, save: async () => {}, listVersions: async () => [], list: async (): Promise<AgentSummary[]> => [] } as unknown as AgentRepository;
    const result = await new GenerateAgentPromptUseCase(new FakeTools(), undefined, agents).execute({
      scope, displayName: 'Coordinator', kind: 'normal', tools: [], agents: [{ internalId: 'scorer', version: SemVer.of(1, 0, 0), usage: 'delegate numeric scoring' }],
    });
    expect(result.sections.collaboratorGuide).toContain('ask_scorer');
    expect(result.systemPromptDraft).toContain('協働者ガイド');
    expect(result.systemPromptDraft).toContain('delegate numeric scoring');
    expect(result.sources).toContain('agent:scorer@1.0.0 の委譲基準');
  });

  it('サブエージェント未指定なら協働者ガイドはなしと明記しsourcesを増やさない', async () => {
    const result = await new GenerateAgentPromptUseCase(new FakeTools()).execute({ scope, displayName: 'Solo', kind: 'normal', tools: [{ internalId: 'scores', version: SemVer.of(2, 0, 0) }] });
    expect(result.sections.collaboratorGuide).toContain('ありません');
    expect(result.sources).toEqual(['tool:filter_scores@2.0.0 の入出力・副作用']);
  });
});
