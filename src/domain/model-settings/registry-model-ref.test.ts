import { describe, expect, it } from 'vitest';
import { formatRegistryModelRef, parseRegistryModelRef, registryProviderOf } from './registry-model-ref';

describe('parseRegistryModelRef', () => {
  it('splits at the first slash', () => {
    expect(parseRegistryModelRef('openai/gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  it('keeps later slashes inside the model part', () => {
    expect(parseRegistryModelRef('fireworks/accounts/fireworks/models/x')).toEqual({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/x',
    });
  });

  it('trims the input before splitting', () => {
    expect(parseRegistryModelRef('  openai/gpt-5  ')).toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  it.each(['no-slash', '/leading', 'trailing/', '/', '', '  '])('returns null for malformed %p', (value) => {
    expect(parseRegistryModelRef(value)).toBeNull();
  });
});

describe('formatRegistryModelRef', () => {
  it('is the inverse of parseRegistryModelRef', () => {
    const ref = parseRegistryModelRef('openai/gpt-5');
    expect(ref).not.toBeNull();
    expect(formatRegistryModelRef(ref as NonNullable<typeof ref>)).toBe('openai/gpt-5');
  });
});

describe('registryProviderOf', () => {
  it.each<[string, string]>([
    ['openai/gpt-5', 'openai'],
    ['OpenAI/GPT-5', 'openai'],
    // 不正形でも投げない緩い抽出(modelDestination の従来挙動の保存)。
    ['trailing/', 'trailing'],
    ['no-slash', 'no-slash'],
    ['/leading', '/leading'],
  ])('extracts %p -> %p', (input, expected) => {
    expect(registryProviderOf(input)).toBe(expected);
  });
});
