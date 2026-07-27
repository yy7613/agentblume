// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_KEY_PREFIX, draftKey, readDraft, removeDraft, useDraftPersistence, writeDraft } from './useDraftPersistence';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

interface Form { readonly name: string; readonly body?: string }

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('draftKey', () => {
  it('画面・scope・編集対象でキーを分ける', () => {
    expect(draftKey('agent-builder', scope, 'sales')).toBe(`${DRAFT_KEY_PREFIX}.agent-builder.local.default.sales`);
    expect(draftKey('agent-builder', { tenantId: 'acme', workspaceId: 'ws' }, 'sales'))
      .not.toBe(draftKey('agent-builder', scope, 'sales'));
    expect(draftKey('agent-builder', scope, 'a')).not.toBe(draftKey('agent-builder', scope, 'b'));
    expect(draftKey('skill-builder', scope, 'a')).not.toBe(draftKey('agent-builder', scope, 'a'));
  });

  it('編集対象が未指定・空白なら新規用のキーになる', () => {
    expect(draftKey('agent-builder', scope)).toBe(`${DRAFT_KEY_PREFIX}.agent-builder.local.default.__new__`);
    expect(draftKey('agent-builder', scope, '   ')).toBe(draftKey('agent-builder', scope));
    expect(draftKey('agent-builder', scope, ' sales ')).toBe(draftKey('agent-builder', scope, 'sales'));
  });
});

describe('readDraft / writeDraft / removeDraft', () => {
  it('書いた下書きを読み戻せる', () => {
    expect(writeDraft('k', { name: 'a' }, '2026-07-27T00:00:00.000Z')).toBe(true);
    expect(readDraft<Form>('k')).toEqual({ savedAt: '2026-07-27T00:00:00.000Z', value: { name: 'a' } });
  });

  it('未保存・壊れたJSON・想定外の形は「無い」として扱う', () => {
    expect(readDraft('missing')).toBeUndefined();
    localStorage.setItem('broken', '{not json');
    expect(readDraft('broken')).toBeUndefined();
    localStorage.setItem('array', '[1,2]');
    expect(readDraft('array')).toBeUndefined();
    localStorage.setItem('null', 'null');
    expect(readDraft('null')).toBeUndefined();
    localStorage.setItem('no-value', '{"savedAt":"t"}');
    expect(readDraft('no-value')).toBeUndefined();
    localStorage.setItem('no-time', '{"value":{}}');
    expect(readDraft('no-time')).toBeUndefined();
  });

  it('容量超過（QuotaExceededError）でも例外を投げずfalseを返す', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect(writeDraft('k', { name: 'a' }, 't')).toBe(false);
  });

  it('storageが使えない環境でも読み書き・削除で落ちない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('disabled'); });
    expect(readDraft('k')).toBeUndefined();
    expect(() => removeDraft('k')).not.toThrow();
  });
});

describe('useDraftPersistence', () => {
  function setup(initial: Form, key = 'draft-key', enabled = true) {
    return renderHook(({ value, enabled: on, key: k }) => useDraftPersistence<Form>({ key: k, value, enabled: on, debounceMs: 500 }),
      { initialProps: { value: initial, enabled, key } });
  }

  it('初期表示では未変更（dirty=false）で、下書きも書かない', () => {
    vi.useFakeTimers();
    const { result } = setup({ name: '' });
    expect(result.current.dirty).toBe(false);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(localStorage.getItem('draft-key')).toBeNull();
  });

  it('編集するとdirtyになり、デバウンス後にlocalStorageへ保存する', () => {
    vi.useFakeTimers();
    const { result, rerender } = setup({ name: '' });
    rerender({ value: { name: 'Sales' }, enabled: true, key: 'draft-key' });
    expect(result.current.dirty).toBe(true);
    act(() => { vi.advanceTimersByTime(499); });
    expect(localStorage.getItem('draft-key')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(readDraft<Form>('draft-key')?.value).toEqual({ name: 'Sales' });
  });

  it('連続入力ではデバウンスされ、最後の内容だけを保存する', () => {
    vi.useFakeTimers();
    const { rerender } = setup({ name: '' });
    for (const name of ['S', 'Sa', 'Sal']) {
      rerender({ value: { name }, enabled: true, key: 'draft-key' });
      act(() => { vi.advanceTimersByTime(200); });
    }
    expect(localStorage.getItem('draft-key')).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(readDraft<Form>('draft-key')?.value).toEqual({ name: 'Sal' });
  });

  it('デバウンス待ちのままアンマウントしても取りこぼさない（画面切替）', () => {
    vi.useFakeTimers();
    const { rerender, unmount } = setup({ name: '' });
    rerender({ value: { name: 'Sales' }, enabled: true, key: 'draft-key' });
    act(() => { vi.advanceTimersByTime(100); });
    unmount();
    expect(readDraft<Form>('draft-key')?.value).toEqual({ name: 'Sales' });
  });

  it('編集画面を閉じた（enabled=false）ときも保留分を書き出し、以後は保存しない', () => {
    vi.useFakeTimers();
    const { result, rerender } = setup({ name: '' });
    rerender({ value: { name: 'Sales' }, enabled: true, key: 'draft-key' });
    act(() => { rerender({ value: { name: 'Sales' }, enabled: false, key: 'draft-key' }); });
    expect(readDraft<Form>('draft-key')?.value).toEqual({ name: 'Sales' });
    expect(result.current.dirty).toBe(false);
  });

  it('入力を元に戻して離脱したときは、消した内容を書き戻さない', () => {
    vi.useFakeTimers();
    const { rerender, unmount } = setup({ name: '' });
    rerender({ value: { name: 'typo' }, enabled: true, key: 'draft-key' });
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ value: { name: '' }, enabled: true, key: 'draft-key' });
    unmount();
    expect(localStorage.getItem('draft-key')).toBeNull();
  });

  it('beforeunloadでも保留分を書き出す', () => {
    vi.useFakeTimers();
    const { rerender } = setup({ name: '' });
    rerender({ value: { name: 'Sales' }, enabled: true, key: 'draft-key' });
    act(() => { window.dispatchEvent(new Event('beforeunload')); });
    expect(readDraft<Form>('draft-key')?.value).toEqual({ name: 'Sales' });
  });

  it('保存済みの下書きは自動適用せず、復元候補（pending）として返す', () => {
    writeDraft('draft-key', { name: 'From draft' }, '2026-07-27T01:02:00.000Z');
    const { result } = setup({ name: '' });
    expect(result.current.pending).toEqual({ savedAt: '2026-07-27T01:02:00.000Z', value: { name: 'From draft' } });
    expect(result.current.dirty).toBe(false);
  });

  it('restoreは下書きの値を返してバナーを閉じる', () => {
    writeDraft('draft-key', { name: 'From draft' }, 't');
    const { result } = setup({ name: '' });
    let restored: Form | undefined;
    act(() => { restored = result.current.restore(); });
    expect(restored).toEqual({ name: 'From draft' });
    expect(result.current.pending).toBeUndefined();
    // 破棄はしていないので、localStorage には残ったまま（復元内容は再保存される）。
    expect(readDraft('draft-key')).toBeTruthy();
  });

  it('復元候補が無いときのrestoreはundefinedを返す', () => {
    const { result } = setup({ name: '' });
    let restored: Form | undefined = { name: 'x' };
    act(() => { restored = result.current.restore(); });
    expect(restored).toBeUndefined();
  });

  it('discardは下書きを削除してバナーを閉じる（編集中の内容は触らない）', () => {
    writeDraft('draft-key', { name: 'From draft' }, 't');
    const { result } = setup({ name: '' });
    expect(result.current.pending).toBeTruthy();
    act(() => { result.current.discard(); });
    expect(result.current.pending).toBeUndefined();
    expect(localStorage.getItem('draft-key')).toBeNull();
  });

  it('現在の内容と同じ下書きでは復元バナーを出さない', () => {
    writeDraft('draft-key', { name: 'Same' }, 't');
    const { result } = setup({ name: 'Same' });
    expect(result.current.pending).toBeUndefined();
  });

  it('clearで下書きを消し、現在値を新しい基準にする（サーバー保存成功）', () => {
    vi.useFakeTimers();
    const { result, rerender } = setup({ name: '' });
    rerender({ value: { name: 'Sales' }, enabled: true, key: 'draft-key' });
    act(() => { vi.advanceTimersByTime(500); });
    expect(localStorage.getItem('draft-key')).not.toBeNull();

    act(() => { result.current.clear(); });
    expect(localStorage.getItem('draft-key')).toBeNull();
    expect(result.current.dirty).toBe(false);

    // clear後は保留分の再書き込みも起きない。
    act(() => { vi.advanceTimersByTime(2000); });
    expect(localStorage.getItem('draft-key')).toBeNull();
  });

  it('キーが変わると基準を取り直し、別キーの下書きを読み直す', () => {
    writeDraft('other-key', { name: 'Other draft' }, 't');
    const { result, rerender } = setup({ name: 'A' });
    expect(result.current.pending).toBeUndefined();
    act(() => { rerender({ value: { name: 'B' }, enabled: true, key: 'other-key' }); });
    expect(result.current.dirty).toBe(false);
    expect(result.current.pending?.value).toEqual({ name: 'Other draft' });
  });

  it('enabled=falseの間はdirtyにならず、復元候補も出さない（一覧表示中）', () => {
    writeDraft('draft-key', { name: 'From draft' }, 't');
    const { result, rerender } = setup({ name: '' }, 'draft-key', false);
    expect(result.current.pending).toBeUndefined();
    rerender({ value: { name: 'typed' }, enabled: false, key: 'draft-key' });
    expect(result.current.dirty).toBe(false);
  });

  it('容量超過でも編集は続行できる（保存失敗を握りつぶす）', () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    const { result, rerender } = setup({ name: '' });
    rerender({ value: { name: 'Sales' }, enabled: true, key: 'draft-key' });
    expect(() => act(() => { vi.advanceTimersByTime(600); })).not.toThrow();
    expect(result.current.dirty).toBe(true);
  });
});
