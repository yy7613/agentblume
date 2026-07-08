import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import { buildPersonaBasePrompt, buildPersonaSystemPrompt, composeScenarioPrompt, createPersona, type CreatePersonaProps, type Persona } from './persona';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function props(overrides: Partial<CreatePersonaProps> = {}): CreatePersonaProps {
  return {
    metadata: { internalId: 'persona-1', workingName: 'p', displayName: 'Novice user', publishName: 'novice_user', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja',
    ...overrides,
  };
}

describe('createPersona', () => {
  it('有効な属性を防御的コピーで受け入れ、任意項目は指定時のみ保持する', () => {
    const persona = createPersona(props());
    expect(persona).toMatchObject({ archetype: 'novice', tone: '丁寧', language: 'ja' });
    expect('extraInstructions' in persona).toBe(false);
    expect('promptOverride' in persona).toBe(false);
    const withExtras = createPersona(props({ extraInstructions: '経理部所属。', promptOverride: '完全カスタム。' }));
    expect(withExtras.extraInstructions).toBe('経理部所属。');
    expect(withExtras.promptOverride).toBe('完全カスタム。');
  });

  it('不変条件違反は ValidationDomainError', () => {
    expect(() => createPersona(props({ archetype: 'weird' as Persona['archetype'] }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ knowledgeLevel: 'huge' as Persona['knowledgeLevel'] }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ patience: '' as Persona['patience'] }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ verbosity: 'loud' as Persona['verbosity'] }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ language: 'fr' as Persona['language'] }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ tone: '  ' }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ promptOverride: '' }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ extraInstructions: 1 as unknown as string }))).toThrow(ValidationDomainError);
    const meta = props().metadata;
    expect(() => createPersona(props({ metadata: { ...meta, internalId: '' } }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ metadata: { ...meta, version: '1.0.0' as unknown as SemVer } }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ metadata: { ...meta, state: 'live' as typeof meta.state } }))).toThrow(ValidationDomainError);
    expect(() => createPersona(props({ metadata: { ...meta, tenant: { tenantId: '', workspaceId: 'w' } } }))).toThrow(ValidationDomainError);
  });
});

describe('buildPersonaSystemPrompt', () => {
  it('決定的: 同一入力は同一出力', () => {
    const persona = createPersona(props({ extraInstructions: '経理部所属。' }));
    const first = buildPersonaSystemPrompt(persona, '売上を知る', '締め前');
    const second = buildPersonaSystemPrompt(persona, '売上を知る', '締め前');
    expect(first).toBe(second);
  });

  it('archetype・属性・goal/context が本文へ反映される（ja）', () => {
    const persona = createPersona(props({ patience: 'low', verbosity: 'terse', extraInstructions: '経理部所属。' }));
    const prompt = buildPersonaSystemPrompt(persona, '売上サマリを得る', '締め前で急いでいる');
    expect(prompt).toContain('初心者');
    expect(prompt).toContain('知識レベル=低い');
    expect(prompt).toContain('口調=丁寧');
    expect(prompt).toContain('簡潔に短く');
    expect(prompt).toContain('約2ターン進展がなければ諦める');
    expect(prompt).toContain('経理部所属。');
    expect(prompt).toContain('あなたはユーザーとして振る舞う');
    expect(prompt).toContain('目標: 売上サマリを得る');
    expect(prompt).toContain('状況: 締め前で急いでいる');
  });

  it('language=en で英語テンプレートへ切り替わり、context 省略時は状況行を含めない', () => {
    const persona = createPersona(props({ language: 'en', archetype: 'skeptical', patience: 'high', tone: 'formal' }));
    const prompt = buildPersonaSystemPrompt(persona, 'Get the sales summary');
    expect(prompt).toContain('skeptical');
    expect(prompt).toContain('persist until the turn limit');
    expect(prompt).toContain('Goal: Get the sales summary');
    expect(prompt).not.toContain('Context:');
    expect(prompt).not.toContain('目標');
  });

  it('promptOverride があればそれを基底にし goal/context のみ合成する（テンプレ非使用）', () => {
    const persona = createPersona(props({ promptOverride: '完全カスタムの人物設定。' }));
    const prompt = buildPersonaSystemPrompt(persona, '売上を知る', '急ぎ');
    expect(prompt).toBe('完全カスタムの人物設定。\n\n目標: 売上を知る\n状況: 急ぎ');
  });

  it('custom archetype は人物設定行を持たず属性のみで構成される', () => {
    const persona = createPersona(props({ archetype: 'custom' }));
    const prompt = buildPersonaSystemPrompt(persona, 'goal');
    expect(prompt).not.toContain('初心者');
    expect(prompt.split('\n').every((line) => line.length > 0)).toBe(true);
  });

  it('base+compose の合成は buildPersonaSystemPrompt と厳密一致する（v18分割の等価性）', () => {
    const cases = [props({ extraInstructions: '経理部所属。' }), props({ language: 'en', archetype: 'skeptical', tone: 'formal' }), props({ promptOverride: 'カスタム人物。' }), props({ archetype: 'custom' })];
    for (const raw of cases) {
      const persona = createPersona(raw);
      expect(composeScenarioPrompt(buildPersonaBasePrompt(persona), 'G', 'C', persona.language)).toBe(buildPersonaSystemPrompt(persona, 'G', 'C'));
      expect(composeScenarioPrompt(buildPersonaBasePrompt(persona), 'G', undefined, persona.language)).toBe(buildPersonaSystemPrompt(persona, 'G'));
    }
  });

  it('buildPersonaBasePrompt は goal/context を含まず人物設定・出力規律のみを持つ', () => {
    const base = buildPersonaBasePrompt(createPersona(props()));
    expect(base).not.toContain('目標:');
    expect(base).not.toContain('状況:');
    expect(base).toContain('あなたはユーザーとして振る舞う');
  });
});
