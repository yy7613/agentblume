import { describe, expect, it } from 'vitest';
import type { SchemaState } from '../data/types';
import { combineStates, stateRank } from './state';

describe('stateRank', () => {
  it('orders confirmed < inferred < partial < unknown < mismatch', () => {
    expect(stateRank('confirmed')).toBe(0);
    expect(stateRank('inferred')).toBe(1);
    expect(stateRank('partial')).toBe(2);
    expect(stateRank('unknown')).toBe(3);
    expect(stateRank('mismatch')).toBe(4);
  });

  it('is strictly increasing along the defined order', () => {
    const order: SchemaState[] = ['confirmed', 'inferred', 'partial', 'unknown', 'mismatch'];
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1] as SchemaState;
      const cur = order[i] as SchemaState;
      expect(stateRank(cur)).toBeGreaterThan(stateRank(prev));
    }
  });
});

describe('combineStates', () => {
  it('empty -> confirmed', () => {
    expect(combineStates([])).toBe('confirmed');
  });

  it('single element -> itself', () => {
    expect(combineStates(['inferred'])).toBe('inferred');
    expect(combineStates(['mismatch'])).toBe('mismatch');
  });

  it('returns the worst (max rank) element', () => {
    expect(combineStates(['confirmed', 'inferred'])).toBe('inferred');
    expect(combineStates(['inferred', 'confirmed'])).toBe('inferred');
    expect(combineStates(['confirmed', 'partial', 'inferred'])).toBe('partial');
    expect(combineStates(['inferred', 'unknown', 'mismatch'])).toBe('mismatch');
  });

  it('all confirmed -> confirmed', () => {
    expect(combineStates(['confirmed', 'confirmed'])).toBe('confirmed');
  });

  it('does not mutate the input array', () => {
    const states: SchemaState[] = ['inferred', 'confirmed'];
    const snapshot = [...states];
    combineStates(states);
    expect(states).toEqual(snapshot);
  });
});
