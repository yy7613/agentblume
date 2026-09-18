// @vitest-environment jsdom
/**
 * AI判定ノード（ai-judge）の設定UI。
 *
 * サイドバーは要約と「設定を開く」だけ（ADR-0028）で、実編集はダイアログ側という分担と、
 * 判定モード（はい/いいえ ⇄ 分類）の切替が matchValues・出力列の表示をどう変えるかを固定する。
 * ダイアログの開閉・Cancel破棄そのものは structured-dialogs.test.tsx が担う。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { PropagationResultDto } from '../api/types';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const upstream = {
  columns: [
    { name: 'subject', type: 'string' as const, nullable: false },
    { name: 'body', type: 'string' as const, nullable: true },
  ],
};
afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

/** 上流ノード（スキーマ確定済み）+ AI判定ノードを置き、AI判定を選択した状態にする。 */
function addAiJudge(): string {
  useToolBuilderStore.getState().addNode('json-source');
  const sourceId = useToolBuilderStore.getState().selectedNodeId!;
  const propagation: PropagationResultDto = {
    order: [sourceId], terminalId: sourceId, hasErrors: false,
    nodes: { [sourceId]: { nodeId: sourceId, state: 'inferred', issues: [], schema: upstream } },
  };
  useToolBuilderStore.getState().setPropagation(propagation);
  useToolBuilderStore.getState().addNode('ai-judge');
  return useToolBuilderStore.getState().selectedNodeId!;
}

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

function patchConfig(nodeId: string, patch: Readonly<Record<string, unknown>>): void {
  useToolBuilderStore.getState().updateNodeConfig(nodeId, { ...configOf(nodeId), ...patch });
}

/** NodeInspector が起動時に叩く4本を満たす最小のクライアント。 */
function fakeClient(aiJudgeEnabled: boolean): ToolApiClient {
  return {
    listDataSources: vi.fn().mockResolvedValue([]),
    listSearchProviders: vi.fn().mockResolvedValue([]),
    analysisAssistantCapability: vi.fn().mockResolvedValue(false),
    aiJudgeCapability: vi.fn().mockResolvedValue(aiJudgeEnabled),
  } as unknown as ToolApiClient;
}

async function openDialog(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  return screen.getByRole('dialog', { name: 'Node configuration' });
}

describe('NodeInspector: AI判定のサイドバー要約', () => {
  it('モード・操作の要約を出し、判定基準が空なら設定を開くよう促す', async () => {
    addAiJudge();
    render(<NodeInspector />);

    expect(screen.getByText('yes / no · flag every row')).toBeTruthy();
    expect(screen.getByText(/No judgment question yet/)).toBeTruthy();
    // 実編集はダイアログ側（サイドバーには質問の入力欄を置かない）。
    expect(screen.queryByLabelText('Judgment question')).toBeNull();
    expect(await openDialog()).toBeTruthy();
  });

  it('設定済みなら分類の件数・操作と判定基準の抜粋を出す', () => {
    const id = addAiJudge();
    patchConfig(id, { question: 'この問い合わせはクレームですか？', categories: [{ name: 'complaint' }, { name: 'question' }], action: 'exclude', matchValues: ['complaint'] });
    render(<NodeInspector />);

    expect(screen.getByText('classify · 2 categories · exclude matching rows')).toBeTruthy();
    expect(screen.getByText('Question: この問い合わせはクレームですか？')).toBeTruthy();
    expect(screen.queryByText(/No judgment question yet/)).toBeNull();
  });
});

describe('NodeInspector: AI判定の設定ダイアログ', () => {
  it('分類へ切り替えるとカテゴリ行が1つ増え、判定値でなくなった matchValues は落ちる', async () => {
    const id = addAiJudge();
    patchConfig(id, { action: 'keep', matchValues: ['yes'] });
    render(<NodeInspector />);
    const dialog = await openDialog();

    const verdicts = () => within(dialog).getByLabelText('Match verdicts') as HTMLSelectElement;
    const options = () => Array.from(verdicts().querySelectorAll('option')).map((option) => option.textContent);
    const selected = () => Array.from(verdicts().selectedOptions).map((option) => option.value);

    // はい/いいえ の間は yes が選べる。
    expect(options()).toEqual(['yes', 'no', 'unclear']);
    expect(selected()).toEqual(['yes']);

    await userEvent.selectOptions(within(dialog).getByLabelText('Judgment mode'), 'classify');
    expect(within(dialog).getAllByLabelText('Category name')).toHaveLength(1);
    // yes は分類モードの判定値ではないので、選択は残さない（保存時に弾かれる設定を作らせない）。
    expect(selected()).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText('Category name'), { target: { value: 'complaint' } });
    expect(options()).toEqual(['complaint', 'unclear']);
    await userEvent.selectOptions(verdicts(), 'complaint');
    expect(selected()).toEqual(['complaint']);

    // はい/いいえ へ戻すとカテゴリは消え、カテゴリ名の matchValues も落ちる。
    await userEvent.selectOptions(within(dialog).getByLabelText('Judgment mode'), 'yes-no');
    expect(within(dialog).queryByLabelText('Category name')).toBeNull();
    expect(selected()).toEqual([]);
  });

  it('flag では判定列・理由列を出し、チェックを外すと理由列は null になる', async () => {
    const id = addAiJudge();
    render(<NodeInspector />);
    const dialog = await openDialog();

    expect((within(dialog).getByLabelText('Verdict column') as HTMLInputElement).value).toBe('aiVerdict');
    expect((within(dialog).getByLabelText('Reason column') as HTMLInputElement).value).toBe('aiReason');
    // flag は全行を通すので一致判定（matchValues）は要らない。
    expect(within(dialog).queryByLabelText('Match verdicts')).toBeNull();

    await userEvent.click(within(dialog).getByLabelText('Output a reason column'));
    expect(within(dialog).queryByLabelText('Reason column')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)['reasonColumn']).toBeNull();

    // 付け直すと既定の列名へ戻る。
    const reopened = await openDialog();
    await userEvent.click(within(reopened).getByLabelText('Output a reason column'));
    expect((within(reopened).getByLabelText('Reason column') as HTMLInputElement).value).toBe('aiReason');
  });

  it('keep / exclude では判定列の入力を隠し、現在のモードの判定値だけを候補にする', async () => {
    const id = addAiJudge();
    patchConfig(id, { categories: [{ name: 'complaint' }, { name: 'praise' }], matchValues: [] });
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Action'), 'keep');
    expect(within(dialog).queryByLabelText('Verdict column')).toBeNull();
    expect(within(dialog).queryByLabelText('Output a reason column')).toBeNull();
    expect(Array.from(within(dialog).getByLabelText('Match verdicts').querySelectorAll('option')).map((option) => option.textContent)).toEqual(['complaint', 'praise', 'unclear']);
  });

  it('ローカルLLMが未設定なら警告を出し、設定済みなら出さない', async () => {
    addAiJudge();
    const disabled = fakeClient(false);
    const { unmount } = render(<NodeInspector client={disabled} />);
    const dialog = await openDialog();
    await waitFor(() => expect(disabled.aiJudgeCapability).toHaveBeenCalled());
    expect(await within(dialog).findByText('The local LLM is not configured. Set the main model slot in Settings > Models to run this judgment.')).toBeTruthy();
    // 判定がいつ走るかは常に添える。
    expect(within(dialog).getByText(/The judgment runs when the graph is previewed or executed/)).toBeTruthy();
    unmount();

    const enabled = fakeClient(true);
    render(<NodeInspector client={enabled} />);
    const ready = await openDialog();
    await waitFor(() => expect(enabled.aiJudgeCapability).toHaveBeenCalled());
    await waitFor(() => expect(within(ready).queryByText(/The local LLM is not configured/)).toBeNull());
  });

  it('Applyで判定基準・見せる列・上限をノードconfigへ書き戻す', async () => {
    const id = addAiJudge();
    const before = configOf(id);
    render(<NodeInspector />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByLabelText('Judgment question'), { target: { value: 'Is this a complaint?' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Columns shown to the model'), 'subject');
    fireEvent.change(within(dialog).getByLabelText('Rows judged per run'), { target: { value: '120' } });
    // ダイアログはローカル草案なので、Applyまでグラフは変わらない。
    expect(configOf(id)).toEqual(before);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toEqual({
      configVersion: 1, question: 'Is this a complaint?', categories: [], columns: ['subject'],
      outputColumn: 'aiVerdict', reasonColumn: 'aiReason', action: 'flag', matchValues: ['yes'], maxItems: 120,
    });
  });

  it('境界: カテゴリは20件まで。19件では追加でき、20件に達すると「カテゴリを追加」が無効になる', async () => {
    const id = addAiJudge();
    patchConfig(id, { categories: Array.from({ length: 19 }, (_, index) => ({ name: `c${index}` })) });
    render(<NodeInspector />);
    const dialog = await openDialog();

    const addButton = () => within(dialog).getByRole('button', { name: 'Add category' }) as HTMLButtonElement;
    expect(within(dialog).getAllByLabelText('Category name')).toHaveLength(19);
    expect(addButton().disabled).toBe(false);

    await userEvent.click(addButton());

    // 上限に達したら押せなくする（保存時に弾かれる21件目をダイアログで作らせない）。
    expect(within(dialog).getAllByLabelText('Category name')).toHaveLength(20);
    expect(addButton().disabled).toBe(true);
  });

  // ダイアログ側では予約語も空の質問も止めない（issue はスキーマ伝播＝サーバーが返す）。
  // 利用者が気づけるように、質問の未入力だけはサイドバーの要約が常に促す。
  it('異常: 予約語 unclear のカテゴリ名と空の判定基準も適用でき、サイドバーの未入力案内で気づかせる', async () => {
    const id = addAiJudge();
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Judgment mode'), 'classify');
    fireEvent.change(within(dialog).getByLabelText('Category name'), { target: { value: 'unclear' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({ categories: [{ name: 'unclear' }], question: '' });
    expect(screen.getByText('classify · 1 categories · flag every row')).toBeTruthy();
    expect(screen.getByText(/No judgment question yet/)).toBeTruthy();
  });

  it('異常: keep で一致判定を1つも選ばずに適用すると matchValues は空のまま書き戻る（不備はサーバーが指摘する）', async () => {
    const id = addAiJudge();
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Action'), 'keep');
    const verdicts = within(dialog).getByLabelText('Match verdicts') as HTMLSelectElement;
    // 既定の matchValues（['yes']）が選択済みの状態から、全部外す。
    expect(Array.from(verdicts.selectedOptions).map((option) => option.value)).toEqual(['yes']);

    await userEvent.deselectOptions(verdicts, 'yes');
    expect(Array.from(verdicts.selectedOptions)).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toMatchObject({ action: 'keep', matchValues: [] });
  });
});
