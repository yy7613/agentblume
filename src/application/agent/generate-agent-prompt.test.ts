import { describe, expect, it } from 'vitest';
import type { ToolSummary } from '../../domain/tool/metadata';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { AgentValidationError } from '../../domain/agent/errors';
import { GenerateAgentPromptUseCase } from './generate-agent-prompt';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const tool = createTool({
  metadata: { internalId: 'scores', workingName: 'scores', displayName: 'Score filter', publishName: 'filter_scores', version: SemVer.of(2, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
  sideEffect: 'read-only', graph: { nodes: [], edges: [] },
  inputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
  outputSchema: { columns: [{ name: 'passed', type: 'boolean', nullable: false }] },
});
class FakeTools implements ToolRepository {
  async findVersion(target: TenantScope, id: string, version: SemVer): Promise<Tool | null> { return target.tenantId === 'tenant' && id === 'scores' && version.toString() === '2.0.0' ? tool : null; }
  async findLatest(): Promise<Tool | null> { return null; }
  async save(): Promise<void> {}
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ToolSummary[]> { return []; }
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

  it('空displayNameと未存在Toolを拒否する', async () => {
    const usecase = new GenerateAgentPromptUseCase(new FakeTools());
    await expect(usecase.execute({ scope, displayName: ' ', kind: 'normal', tools: [] })).rejects.toBeInstanceOf(AgentValidationError);
    await expect(usecase.execute({ scope, displayName: 'Agent', kind: 'normal', tools: [{ internalId: 'missing', version: SemVer.of(1, 0, 0) }] })).rejects.toThrow(/not found/);
  });
});
