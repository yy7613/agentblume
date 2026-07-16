import type { AgentRepository } from '../../domain/agent/agent-repository';
import { SemVer } from '../../domain/tool/semver';
import { buildHarness, type SaveHarnessInput } from './save-harness';

export interface HarnessValidationIssue { readonly path: string; readonly message: string; }
export interface HarnessDraftValidation { readonly valid: boolean; readonly issues: readonly HarnessValidationIssue[]; }

/** 保存と同じ不変条件を、副作用なしでDraftへ適用する。 */
export class ValidateHarnessUseCase {
  constructor(private readonly agents: AgentRepository) {}
  async execute(input: SaveHarnessInput): Promise<HarnessDraftValidation> {
    const issues: HarnessValidationIssue[] = [];
    try { buildHarness(input, SemVer.of(0, 0, 0)); }
    catch (error) { issues.push({ path: '(definition)', message: error instanceof Error ? error.message : 'Invalid harness definition' }); return { valid: false, issues }; }
    for (const [index, slot] of input.slots.entries()) {
      const agent = await this.agents.findVersion(input.scope, slot.assignment.internalId, slot.assignment.version);
      if (agent === null) issues.push({ path: `slots.${index}.assignment`, message: `Assigned agent not found: ${slot.assignment.internalId}@${slot.assignment.version.toString()}` });
    }
    return { valid: issues.length === 0, issues };
  }
}
