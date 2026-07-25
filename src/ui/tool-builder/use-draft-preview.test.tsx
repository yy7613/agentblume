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

  it('API errorをdraftIssueへ保存し、保存失敗メッセージは消さない', async () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    useToolBuilderStore.getState().setSaveError('SaveTool: graph validation failed');
    const client = { inferDraft: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState()).toMatchObject({
      draftIssue: 'offline', previewLoading: false, propagation: undefined, saveError: 'SaveTool: graph validation failed',
    });
  });

  it('abort済みの遅延失敗とError以外のrejectを取り違えない', async () => {
    let rejectStale: (cause: unknown) => void = () => {};
    const client = {
      inferDraft: vi.fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStale = reject; }))
        .mockRejectedValue('offline'),
      previewDraft: vi.fn(),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    // 編集で1件目はabortされる。遅れて届いた失敗は表示しない。
    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gte', value: 21 }));
    await act(async () => { rejectStale(new Error('stale')); await vi.advanceTimersByTimeAsync(0); });
    expect(useToolBuilderStore.getState().draftIssue).toBeUndefined();

    // Error以外のrejectは既定文言へ落とす。
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState()).toMatchObject({ draftIssue: 'Preview failed', previewLoading: false });
  });

  it('自動検証の成功でもsaveErrorを上書きしない', async () => {
    const client = {
      inferDraft: vi.fn().mockResolvedValue(propagation),
      previewDraft: vi.fn().mockResolvedValue(preview),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    act(() => useToolBuilderStore.getState().setSaveError('SaveTool: invalid metadata'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState()).toMatchObject({ draftIssue: undefined, saveError: 'SaveTool: invalid metadata' });
  });

  it('バグ5: hasErrorsになったら直近の成功previewを残さずクリアする', async () => {
    const invalid = { ...propagation, hasErrors: true };
    const client = {
      inferDraft: vi.fn()
        .mockResolvedValueOnce(propagation)
        .mockResolvedValueOnce(invalid),
      previewDraft: vi.fn().mockResolvedValue(preview),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState().preview).toEqual(preview);

    // グラフを壊す（構造エラーを模す）: 2回目のinferDraftはhasErrors:trueを返す。
    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'lt', value: 5 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(client.previewDraft).toHaveBeenCalledOnce(); // 2回目はhasErrorsなのでpreviewDraftは呼ばれない。
    expect(useToolBuilderStore.getState()).toMatchObject({ preview: undefined, propagation: invalid });
  });

  it('バグ5: 構造エラー（inferDraft/previewDraftの失敗）でも直近の成功previewを残さずクリアする', async () => {
    const client = {
      inferDraft: vi.fn()
        .mockResolvedValueOnce(propagation)
        .mockRejectedValueOnce(new Error('graph must have exactly one terminal node, found 2: a, b')),
      previewDraft: vi.fn().mockResolvedValue(preview),
    } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState().preview).toEqual(preview);

    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'lt', value: 5 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useToolBuilderStore.getState()).toMatchObject({
      preview: undefined,
      propagation: undefined,
      draftIssue: 'graph must have exactly one terminal node, found 2: a, b',
    });
  });

  it('必須設定が空のノードは要求せずローカルでdraftIssueを出す', async () => {
    const client = { inferDraft: vi.fn(), previewDraft: vi.fn() } as unknown as ToolApiClient;
    renderHook(() => useDraftPreview(client));
    act(() => useToolBuilderStore.getState().addNode('graph-output'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(client.inferDraft).not.toHaveBeenCalled();
    const added = useToolBuilderStore.getState().nodes.at(-1);
    expect(useToolBuilderStore.getState()).toMatchObject({
      draftIssue: `Configuration is incomplete: ${added?.id ?? ''}`, previewLoading: false,
    });
  });
});
