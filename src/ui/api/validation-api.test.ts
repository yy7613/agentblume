import { describe, expect, it, vi } from 'vitest';
import { ToolApiClient } from './tool-api';
import type { SavePersonaDto, SaveScenarioDto } from './types';

const scope = { tenantId: 'tenant a', workspaceId: 'workspace/1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ToolApiClient scenario validation contract', () => {
  it('Persona save・一覧・version固定取得のwire contractを扱う', async () => {
    const persona = { metadata: { internalId: 'novice-user', version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ persona }, 201))
      .mockResolvedValueOnce(jsonResponse({ personas: [{ internalId: 'novice-user', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ persona }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const input: SavePersonaDto = {
      scope, internalId: 'novice/user', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o',
      archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja', bump: 'minor',
    };
    await client.savePersona(input);
    await expect(client.listPersonas(scope)).resolves.toHaveLength(1);
    await client.getPersona('novice/user', scope, '1.0.0');
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/personas', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/personas?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/personas/novice%2Fuser?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('version=1.0.0');
  });

  it('Scenario save・一覧・取得とAgent version列挙のwire contractを扱う', async () => {
    const scenario = { metadata: { internalId: 'sc', version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ scenario }, 201))
      .mockResolvedValueOnce(jsonResponse({ scenarios: [{ internalId: 'sc', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ scenario }))
      .mockResolvedValueOnce(jsonResponse({ versions: ['1.0.0', '1.1.0'] }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const input: SaveScenarioDto = {
      scope, internalId: 'sc', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o',
      target: { agentId: 'agent', version: '1.0.0' }, persona: { personaId: 'novice-user', version: '1.0.0' },
      goal: 'Get the monthly summary', maxUserTurns: 4, expectedTools: ['summary_tool'],
      survey: [{ id: 'q1', textJa: '達成?', textEn: 'Achieved?', kind: 'boolean' }],
    };
    await client.saveScenario(input);
    await expect(client.listScenarios(scope)).resolves.toHaveLength(1);
    await client.getScenario('sc', scope);
    await expect(client.listAgentVersions('agent/1', scope)).resolves.toEqual(['1.0.0', '1.1.0']);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/scenarios', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(fetcher.mock.calls[2]?.[0]).toContain('/scenarios/sc?');
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('version=');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/agents/agent%2F1/versions?');
  });

  it('Scenario実行とScenarioRun一覧・詳細のwire contractを扱う', async () => {
    const run = { id: 'srun-1', status: 'completed' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ runs: [run] }))
      .mockResolvedValueOnce(jsonResponse({ run }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const body = { scope, version: '1.0.0', mode: 'test' as const };
    await expect(client.runScenario('sc/1', body, controller.signal)).resolves.toMatchObject(run);
    await expect(client.listScenarioRuns(scope, 'sc/1')).resolves.toHaveLength(1);
    await client.getScenarioRun('srun/1', scope);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/scenarios/sc%2F1/run', expect.objectContaining({
      method: 'POST', body: JSON.stringify(body), signal: controller.signal,
    }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/scenario-runs?');
    expect(fetcher.mock.calls[1]?.[0]).toContain('scenarioId=sc%2F1');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/scenario-runs/srun%2F1?');
  });
});
