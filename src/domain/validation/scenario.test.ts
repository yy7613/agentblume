import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import { createScenario, type CreateScenarioProps } from './scenario';
import { DEFAULT_SURVEY } from './survey';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function props(overrides: Partial<CreateScenarioProps> = {}): CreateScenarioProps {
  return {
    metadata: { internalId: 'scenario-1', workingName: 's', displayName: 'Scenario', publishName: 'scenario_one', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    target: { agentId: 'agent-1', version: SemVer.of(1, 2, 0) },
    persona: { personaId: 'persona-1', version: SemVer.of(2, 0, 0) },
    goal: '先月の売上サマリを得る',
    maxUserTurns: 4,
    survey: DEFAULT_SURVEY,
    ...overrides,
  };
}

describe('createScenario', () => {
  it('SemVer固定参照・正規化済みsurvey・任意項目の保持で生成する', () => {
    const scenario = createScenario(props({ context: '締め前', expectedTools: ['sales_summary'] }));
    expect(scenario.target.version.toString()).toBe('1.2.0');
    expect(scenario.persona?.version.toString()).toBe('2.0.0');
    expect(scenario.context).toBe('締め前');
    expect(scenario.expectedTools).toEqual(['sales_summary']);
    expect(scenario.survey).toHaveLength(8);
    expect(scenario.survey[1]).toMatchObject({ min: 1, max: 5 });

    const minimal = createScenario(props());
    expect('context' in minimal).toBe(false);
    expect('expectedTools' in minimal).toBe(false);
  });

  it('persona と pseudoUser は排他かつどちらか必須（v18）', () => {
    const pseudoUser = { agentId: 'pseudo-agent', version: SemVer.of(1, 0, 0) };
    const withAgent = createScenario(props({ persona: undefined, pseudoUser }));
    expect(withAgent.pseudoUser).toEqual(pseudoUser);
    expect(withAgent.persona).toBeUndefined();
    // 両方指定・どちらも無しは拒否。
    expect(() => createScenario(props({ pseudoUser }))).toThrow(/exactly one/);
    expect(() => createScenario(props({ persona: undefined }))).toThrow(/exactly one/);
    // pseudoUser.version は SemVer 必須。
    expect(() => createScenario(props({ persona: undefined, pseudoUser: { agentId: 'a', version: '1.0.0' as unknown as SemVer } }))).toThrow(ValidationDomainError);
  });

  it('maxUserTurns は整数1..8のみ', () => {
    expect(createScenario(props({ maxUserTurns: 1 })).maxUserTurns).toBe(1);
    expect(createScenario(props({ maxUserTurns: 8 })).maxUserTurns).toBe(8);
    for (const invalid of [0, 9, 2.5, Number.NaN]) {
      expect(() => createScenario(props({ maxUserTurns: invalid }))).toThrow(ValidationDomainError);
    }
  });

  it('参照・goal・expectedTools・survey の不変条件違反は ValidationDomainError', () => {
    expect(() => createScenario(props({ goal: ' ' }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ context: 1 as unknown as string }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ target: { agentId: '', version: SemVer.of(1, 0, 0) } }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ target: { agentId: 'a', version: '1.0.0' as unknown as SemVer } }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ persona: { personaId: 'p', version: '1.0.0' as unknown as SemVer } }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ expectedTools: [] }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ expectedTools: ['a', 'a'] }))).toThrow(/duplicate/);
    expect(() => createScenario(props({ expectedTools: ['a', ''] }))).toThrow(ValidationDomainError);
    expect(() => createScenario(props({ survey: [] }))).toThrow(ValidationDomainError);
  });
});
