import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import { createPersona } from './persona';
import { createScenario } from './scenario';
import { createScenarioRun } from './scenario-run';
import {
  deserializePersona, deserializeScenario, deserializeScenarioRun,
  serializePersona, serializeScenario, serializeScenarioRun,
} from './serialization';
import { DEFAULT_SURVEY } from './survey';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const metadata = { internalId: 'id-1', workingName: 'w', displayName: 'D', publishName: 'p_name', version: SemVer.of(1, 2, 3), owner: 'owner', state: 'draft' as const, tenant: scope };

describe('Persona serialization', () => {
  it('JSON往復で等価（任意項目あり/なし）', () => {
    const full = createPersona({
      metadata, archetype: 'busy', knowledgeLevel: 'high', patience: 'low', tone: '事務的', verbosity: 'terse', language: 'en',
      extraInstructions: '営業部。', promptOverride: 'カスタム。',
    });
    const roundTripped = deserializePersona(JSON.parse(JSON.stringify(serializePersona(full))));
    expect(roundTripped).toEqual(full);
    expect(roundTripped.metadata.version.toString()).toBe('1.2.3');

    const minimal = createPersona({ metadata, archetype: 'custom', knowledgeLevel: 'mid', patience: 'mid', tone: 'casual', verbosity: 'chatty', language: 'ja' });
    const minimalRound = deserializePersona(JSON.parse(JSON.stringify(serializePersona(minimal))));
    expect(minimalRound).toEqual(minimal);
    expect('promptOverride' in minimalRound).toBe(false);
  });

  it('形の壊れた入力・不変条件違反を拒否する', () => {
    expect(() => deserializePersona({ archetype: 'novice' })).toThrow(ValidationDomainError);
    expect(() => deserializePersona(null)).toThrow(ValidationDomainError);
    const serialized = serializePersona(createPersona({ metadata, archetype: 'novice', knowledgeLevel: 'low', patience: 'low', tone: 't', verbosity: 'normal', language: 'ja' }));
    expect(() => deserializePersona({ ...serialized, tone: '' })).toThrow(ValidationDomainError);
    expect(() => deserializePersona({ ...serialized, metadata: { ...serialized.metadata, version: 'x' } })).toThrow(/invalid version/);
  });
});

describe('Scenario serialization', () => {
  const scenario = createScenario({
    metadata,
    target: { agentId: 'agent-1', version: SemVer.of(2, 0, 0) },
    persona: { personaId: 'persona-1', version: SemVer.of(1, 0, 0) },
    goal: '売上を知る', context: '急ぎ', maxUserTurns: 4, expectedTools: ['sales_summary'], survey: DEFAULT_SURVEY,
  });

  it('JSON往復で等価（SemVerは文字列化される）', () => {
    const serialized = serializeScenario(scenario);
    expect(serialized.target.version).toBe('2.0.0');
    expect(serialized.persona.version).toBe('1.0.0');
    const roundTripped = deserializeScenario(JSON.parse(JSON.stringify(serialized)));
    expect(roundTripped).toEqual(scenario);
  });

  it('形の壊れた入力・不変条件違反を拒否する', () => {
    expect(() => deserializeScenario({})).toThrow(ValidationDomainError);
    const serialized = serializeScenario(scenario);
    expect(() => deserializeScenario({ ...serialized, maxUserTurns: 0 })).toThrow(ValidationDomainError);
    expect(() => deserializeScenario({ ...serialized, survey: [] })).toThrow(ValidationDomainError);
  });
});

describe('ScenarioRun serialization', () => {
  const run = createScenarioRun({
    id: 'run-1', scope,
    scenario: { id: 'scenario-1', version: SemVer.of(1, 0, 0) },
    status: 'max-turns', goalAchieved: false,
    transcript: [
      { speaker: 'user', message: '質問' },
      { speaker: 'agent', message: '回答', runId: 'agent-run-1' },
    ],
    survey: [{ questionId: 'q1', value: false }, { questionId: 'q2', value: 3 }, { questionId: 'impressions', value: 'まあまあ' }],
    impressions: 'まあまあ',
    metrics: {
      userTurns: 1, agentRuns: 1, totalToolCalls: 1,
      expectedToolHit: { expected: ['a', 'b'], called: ['a'], hitRate: 0.5 },
      durationMs: 900, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
    startedAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:00:00.900Z',
  });

  it('JSON往復で等価', () => {
    const serialized = serializeScenarioRun(run);
    expect(serialized.scenario.version).toBe('1.0.0');
    const roundTripped = deserializeScenarioRun(JSON.parse(JSON.stringify(serialized)));
    expect(roundTripped).toEqual(run);
  });

  it('形の壊れた入力・不変条件違反を拒否する', () => {
    expect(() => deserializeScenarioRun({ id: 'x' })).toThrow(ValidationDomainError);
    const serialized = serializeScenarioRun(run);
    expect(() => deserializeScenarioRun({ ...serialized, status: 'running' })).toThrow(ValidationDomainError);
    expect(() => deserializeScenarioRun({ ...serialized, metrics: { ...serialized.metrics, userTurns: -1 } })).toThrow(ValidationDomainError);
  });
});
