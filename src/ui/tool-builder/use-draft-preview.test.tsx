// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { PreviewResultDto, PropagationResultDto } from '../api/types';
import { useToolBuilderStore } from './store';
import { useDraftPreview } from './use-draft-preview';

const propagation: PropagationResultDto = {
  order: ['source-1', 'filter-1'], nodes: {}, hasErrors: false,
};
const preview: PreviewResultDto = {
  terminalId: 'filter-1', output: { schema: { columns: [] }, rows: [] }, nodes: {},
};

beforeEach(() => {
  useToolBuilderStore.getState().reset();
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useDraftPreview', () => {
  it('300ms後にinferし、正常ならpreviewしてstateへ反映する', async () => {
    const client = {
      inferDraft: vi.fn().mockResolvedValue(propagation),
      previewDraft: vi.fn().mockResolvedValue(preview),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    expect(client.inferDraft).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(client.inferDraft).toHaveBeenCalledOnce();
    expect(client.previewDraft).toHaveBeenCalledOnce();
    expect(useToolBuilderStore.getState()).toMatchObject({ propagation, preview, previewLoading: false });
  });

  it('schema issueがあればpreviewを呼ばない', async () => {
    const invalid = { ...propagation, hasErrors: true };
    const client = {
      inferDraft: vi.fn().mockResolvedValue(invalid),
      previewDraft: vi.fn(),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(client.previewDraft).not.toHaveBeenCalled();
    expect(useToolBuilderStore.getState().propagation?.hasErrors).toBe(true);
  });

  it('graph変更時に古いrequestをabortする', async () => {
    const signals: AbortSignal[] = [];
    const client = {
      inferDraft: vi.fn((_graph, signal: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve(propagation);
      }),
      previewDraft: vi.fn().mockResolvedValue(preview),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gt', value: 20 }));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(client.inferDraft).toHaveBeenCalledTimes(2);
  });

  it('API errorを表示用stateへ保存する', async () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    const client = { inferDraft: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState()).toMatchObject({ error: 'offline', previewLoading: false, propagation: undefined });
  });
});
