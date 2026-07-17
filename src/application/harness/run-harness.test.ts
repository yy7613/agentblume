import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAgentHarnessRepository } from '../../adapters/storage/in-memory-harness-repository';
import { InMemoryHarnessRunRepository } from '../../adapters/storage/in-memory-harness-run-repository';
import { createAgentHarness } from '../../domain/harness/agent-harness';
import { SemVer } from '../../domain/tool/semver';
import type { RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import { RunHarnessUseCase } from './run-harness';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const version = SemVer.parse('1.0.0');

describe('RunHarnessUseCase interactive checkpoint guards', () => {
  let nowMs: number;
  let executeSaved: ReturnType<typeof vi.fn>;
  let runs: InMemoryHarnessRunRepository;
  let usecase: RunHarnessUseCase;

  beforeEach(async () => {
    nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    executeSaved = vi.fn().mockResolvedValue({ runId: 'child-1', response: 'Which audience should I address?' });
    const harnesses = new InMemoryAgentHarnessRepository();
    runs = new InMemoryHarnessRunRepository();
    await harnesses.save(createAgentHarness({
      metadata: { internalId: 'interactive-handoff', workingName: 'Interactive handoff', displayName: 'Interactive handoff', publishName: 'interactive_handoff', version, owner: 'owner', state: 'published', tenant: scope },
      pattern: 'handoff',
      slots: [
        { id: 'writer', label: 'Writer', purpose: 'Ask and draft', assignment: { internalId: 'writer', version } },
        { id: 'reviewer', label: 'Reviewer', purpose: 'Review work', assignment: { internalId: 'reviewer', version } },
      ],
      topology: { pattern: 'handoff', startSlotId: 'writer', transitions: [{ fromSlotId: 'writer', toSlotId: 'reviewer', condition: 'review is necessary' }], autonomous: false },
    }));
    usecase = new RunHarnessUseCase(harnesses, runs, { executeSaved } as unknown as RunAgentPreviewUseCase, () => 'harness-run-1', () => new Date(nowMs));
  });

  async function waitingRun() {
    return usecase.execute({ scope, harnessId: 'interactive-handoff', message: 'Prepare the announcement.', mode: 'preview' });
  }

  it('rejects an approval response for a Handoff input checkpoint without changing the checkpoint', async () => {
    const waiting = await waitingRun();

    await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'approval', decision: 'approve' } })).rejects.toThrow('waiting for conversation input');

    const stored = await runs.find(scope, waiting.runId);
    expect(stored).toMatchObject({ status: 'waiting-input', checkpoint: { kind: 'handoff-input', activeSlotId: 'writer' } });
    expect(executeSaved).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired checkpoint before starting another participant run', async () => {
    const waiting = await waitingRun();
    nowMs += 24 * 60 * 60 * 1_000;

    await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'input', message: 'Enterprise administrators.' } })).rejects.toThrow('checkpoint expired');

    const stored = await runs.find(scope, waiting.runId);
    expect(stored).toMatchObject({ status: 'waiting-input', checkpoint: { kind: 'handoff-input' } });
    expect(executeSaved).toHaveBeenCalledTimes(1);
  });
});
