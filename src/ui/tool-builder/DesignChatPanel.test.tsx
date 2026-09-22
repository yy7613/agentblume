// @vitest-environment jsdom
/**
 * 設計アシスタントのパネル（v47 / ADR-0051）。
 *
 * 「指示 → キャンバスが変わる → 1 手で戻せる」が壊れていないことを画面の側から見る。
 * グラフの当て方そのもの（配置・強調の算出）は store.test.ts、強調クラスの付与は
 * FlowCanvas.test.tsx が見るので、ここは会話・入力・取り消しの導線に絞る。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { DesignChatResultDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider } from '../navigation';
import { DESIGN_CHAT_HIGHLIGHT_MS, DESIGN_CHAT_OPEN_KEY, DesignChatPanel } from './DesignChatPanel';
import { ToolBuilder } from './ToolBuilder';
import { currentGraph, useToolBuilderStore } from './store';

vi.mock('./FlowCanvas', () => ({ FlowCanvas: () => <div aria-label="ETL canvas" /> }));
vi.mock('./NodePalette', () => ({ NodePalette: () => <aside aria-label="Node palette" /> }));

/** starter グラフ（source-1 → filter-1）へ sort を 1 つ足した応答。 */
const SORT_RESULT: DesignChatResultDto = {
  message: '並べ替えを足しました。',
  graph: {
    nodes: [
      { id: 'source-1', type: 'json-source', config: { rows: [] }, position: { x: 80, y: 120 } },
      { id: 'filter-1', type: 'filter', config: { column: 'age', op: 'gte', value: 18 }, position: { x: 390, y: 120 } },
      { id: 'sort-1', type: 'sort', config: { by: 'age' } },
    ],
    edges: [{ from: 'source-1', to: 'filter-1' }, { from: 'filter-1', to: 'sort-1' }],
  },
  changes: [{ op: 'add-node', nodeId: 'sort-1', summary: 'sort を追加（age の降順）' }],
  problems: [],
};

function client(overrides: Readonly<Record<string, unknown>> = {}): ToolApiClient {
  return {
    designAssistantCapability: vi.fn().mockResolvedValue(true),
    designChat: vi.fn().mockResolvedValue(SORT_RESULT),
    compactDesignChat: vi.fn().mockResolvedValue({ summary: '- 地域は引数にする' }),
    // 編集画面（NodeInspector / 一覧）が起動時に叩くもの。無いと描画で落ちる。
    listTools: vi.fn().mockResolvedValue([]),
    inferDraft: vi.fn().mockResolvedValue(undefined),
    previewDraft: vi.fn().mockResolvedValue(undefined),
    listDataSources: vi.fn().mockResolvedValue([]),
    listSearchProviders: vi.fn().mockResolvedValue([]),
    analysisAssistantCapability: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as ToolApiClient;
}

/** パネル単体。可否の取得が終わって入力欄が使える状態まで待つ。 */
async function renderPanel(api: ToolApiClient, language: 'en' | 'ja' = 'ja') {
  render(<I18nProvider initialLanguage={language}><DesignChatPanel client={api} /></I18nProvider>);
  await waitFor(() => expect(screen.getByLabelText(language === 'ja' ? '指示' : 'Instruction')).toBeTruthy());
  return screen.getByLabelText(language === 'ja' ? '指示' : 'Instruction') as HTMLTextAreaElement;
}

async function send(input: HTMLTextAreaElement, instruction: string): Promise<void> {
  fireEvent.change(input, { target: { value: instruction } });
  await userEvent.click(screen.getByRole('button', { name: '送信' }));
}

/** 文脈の消費の 1 行（v49）。出ていなければ null。中に直し方の一言が入ることがあるので要素で取る。 */
function meter(): HTMLElement | null {
  return document.querySelector('.design-chat-meter');
}

/**
 * 会話を count 往復ぶん積む（v49 の圧縮・クリアの前提づくり）。
 * 画面から送ると 1 往復ごとにモックを積み替える必要があるので、ストア側から直に積む。
 */
function seedTurns(count: number, options: { readonly offset?: number; readonly usage?: Record<string, number> } = {}): void {
  const offset = options.offset ?? 0;
  useToolBuilderStore.getState().setDesignChatOpen(true);
  for (let index = offset; index < offset + count; index += 1) {
    const id = useToolBuilderStore.getState().startDesignChatTurn(`指示${index}`);
    useToolBuilderStore.getState().completeDesignChatTurn(id, {
      message: `返答${index}`,
      changes: [{ op: 'set-config', nodeId: 'filter-1', summary: `変更${index}` }],
      ...(index === offset + count - 1 && options.usage !== undefined ? { usage: options.usage } : {}),
    });
  }
}

/** 会話を積んだ状態でパネルだけを描く（可否の取得が終わるまで待つ）。 */
async function renderSeeded(api: ToolApiClient, count: number, language: 'en' | 'ja' = 'ja', usage?: Record<string, number>) {
  seedTurns(count, usage === undefined ? {} : { usage });
  return renderPanel(api, language);
}

afterEach(cleanup);
// reset は開閉を引き継ぐ（利用者の設定なので）ため、テスト間では明示的に閉じておく。
beforeEach(() => { localStorage.clear(); useToolBuilderStore.getState().reset(); useToolBuilderStore.getState().setDesignChatOpen(false); });

describe('DesignChatPanel: 指示を送る', () => {
  it('正常: 指示を送ると返答と変更一覧が出て、キャンバスへ即座に適用される', async () => {
    const api = client();
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');

    expect(api.designChat).toHaveBeenCalledWith(expect.objectContaining({
      instruction: '多い順に並べて',
      transcript: [],
      graph: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ id: 'filter-1' })]) }),
    }));
    expect(await screen.findByText('並べ替えを足しました。')).toBeTruthy();
    expect(screen.getByText('sort を追加（age の降順）')).toBeTruthy();
    expect(useToolBuilderStore.getState().nodes.map((node) => node.id)).toEqual(['source-1', 'filter-1', 'sort-1']);
    // 送った指示は入力欄から消える（同じ文をもう一度送らせない）。
    expect(input.value).toBe('');
  });

  it('正常: 2 通目は直前の会話を添えて送る（変更一覧は送らない）', async () => {
    const api = client();
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');
    await send(input, '10 件に絞って');

    const second = (api.designChat as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(second.transcript).toEqual([
      { role: 'user', content: '多い順に並べて' },
      { role: 'assistant', content: '並べ替えを足しました。' },
    ]);
    expect(second.instruction).toBe('10 件に絞って');
  });

  it('正常: 送信中は入力を無効にして「考えています…」を出す', async () => {
    let resolve: (result: DesignChatResultDto) => void = () => {};
    const api = client({ designChat: vi.fn().mockReturnValue(new Promise<DesignChatResultDto>((done) => { resolve = done; })) });
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');

    expect(screen.getByRole('status').textContent).toBe('考えています…');
    expect(input.disabled).toBe(true);
    await act(async () => { resolve(SORT_RESULT); });
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('指示') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('境界: Enter で送信し、Shift+Enter では送らずに改行のままにする', async () => {
    const api = client();
    const input = await renderPanel(api);

    fireEvent.change(input, { target: { value: '年次に絞って' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.designChat).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.designChat).toHaveBeenCalledTimes(1));
    expect((api.designChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].instruction).toBe('年次に絞って');
  });

  it('例外: 日本語入力の変換確定（composing）の Enter では送らない', async () => {
    const api = client();
    const input = await renderPanel(api);
    fireEvent.change(input, { target: { value: '年次' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(api.designChat).not.toHaveBeenCalled();
  });

  it('境界: 空白だけの指示は送らない', async () => {
    const api = client();
    const input = await renderPanel(api);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.designChat).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('異常: 通信に失敗したら理由を出し、キャンバスは変えない', async () => {
    const api = client({ designChat: vi.fn().mockRejectedValue(new Error('モデルへ接続できませんでした')) });
    const before = currentGraph();
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');

    expect((await screen.findByRole('alert')).textContent).toContain('モデルへ接続できませんでした');
    expect(currentGraph()).toEqual(before);
  });
});

describe('DesignChatPanel: 適用結果の扱い', () => {
  it('正常: 取り消すと適用前のキャンバスへ戻り、その返答は「取り消し済み」になる', async () => {
    const before = currentGraph();
    const input = await renderPanel(client());
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');

    await userEvent.click(screen.getByRole('button', { name: 'この変更を取り消す' }));
    expect(currentGraph()).toEqual(before);
    expect(screen.getByText('取り消し済み')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'この変更を取り消す' })).toBeNull();
    // 会話そのものは残す。
    expect(screen.getByText('多い順に並べて')).toBeTruthy();
  });

  it('正常: 後のターンを取り消すと、そのターン以降の返答すべてに「取り消し済み」が付く', async () => {
    const second: DesignChatResultDto = {
      message: '10 件に絞りました。',
      graph: {
        nodes: [...SORT_RESULT.graph!.nodes.map((node) => ({ ...node, position: node.position ?? { x: 610, y: 120 } })), { id: 'limit-1', type: 'limit', config: { count: 10 } }],
        edges: [...SORT_RESULT.graph!.edges, { from: 'sort-1', to: 'limit-1' }],
      },
      changes: [{ op: 'add-node', nodeId: 'limit-1', summary: 'limit を追加' }],
    };
    const api = client({ designChat: vi.fn().mockResolvedValueOnce(SORT_RESULT).mockResolvedValueOnce(second) });
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');
    await send(input, '10 件に絞って');
    await screen.findByText('10 件に絞りました。');

    await userEvent.click(screen.getAllByRole('button', { name: 'この変更を取り消す' })[0] as HTMLElement);
    expect(screen.getAllByText('取り消し済み')).toHaveLength(2);
    expect(useToolBuilderStore.getState().nodes.map((node) => node.id)).toEqual(['source-1', 'filter-1']);
  });

  it('異常: problems は返答の下に赤枠で、日本語化して出す（キャンバスは変えない）', async () => {
    const before = currentGraph();
    const api = client({ designChat: vi.fn().mockResolvedValue({
      message: '指示どおりに直せませんでした。',
      changes: [],
      problems: ['sort: column(s) not found: population'],
    } satisfies DesignChatResultDto) });
    const input = await renderPanel(api);
    await send(input, '人口の多い順に');

    const problems = await screen.findByRole('alert');
    expect(problems.className).toContain('design-chat-problems');
    expect(problems.textContent).toContain('列が見つかりません');
    expect(problems.textContent).not.toContain('column(s) not found');
    expect(currentGraph()).toEqual(before);
    expect(screen.queryByRole('button', { name: 'この変更を取り消す' })).toBeNull();
  });

  it('正常: 変更したノードの強調は数秒で消える', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const input = await renderPanel(client());
      await send(input, '多い順に並べて');
      await screen.findByText('並べ替えを足しました。');
      expect(useToolBuilderStore.getState().designChat.highlight).toEqual(['sort-1']);

      await act(async () => { await vi.advanceTimersByTimeAsync(DESIGN_CHAT_HIGHLIGHT_MS); });
      expect(useToolBuilderStore.getState().designChat.highlight).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DesignChatPanel: モデル未設定', () => {
  it('異常: モデルが未設定なら入力欄を無効にし、関数電卓と同じ直し方を案内する', async () => {
    const api = client({ designAssistantCapability: vi.fn().mockResolvedValue(false) });
    render(<I18nProvider initialLanguage="ja"><DesignChatPanel client={api} /></I18nProvider>);

    expect(await screen.findByText(/ローカルLLMが未設定です。設定 > モデル で main スロットを設定して/)).toBeTruthy();
    const input = screen.getByLabelText('指示') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '年次に絞って' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.designChat).not.toHaveBeenCalled();
  });

  it('異常: 可否を答えられない古いサーバーでも落ちず、使えないものとして案内する', async () => {
    const api = client({ designAssistantCapability: vi.fn().mockRejectedValue(new Error('offline')) });
    render(<I18nProvider initialLanguage="ja"><DesignChatPanel client={api} /></I18nProvider>);
    expect(await screen.findByText(/ローカルLLMが未設定です/)).toBeTruthy();
  });
});

describe('DesignChatPanel: 適用済みの注記（warnings）', () => {
  it('正常: warnings は赤枠ではなく注記として出し、グラフは適用される', async () => {
    useToolBuilderStore.getState().reset();
    useToolBuilderStore.getState().setDesignChatOpen(true);
    const id = useToolBuilderStore.getState().startDesignChatTurn('新しい順にして');
    useToolBuilderStore.getState().completeDesignChatTurn(id, {
      message: '並べ替えました。',
      graph: { nodes: [{ id: 'src', type: 'json-source', config: { rows: [] } }, { id: 'out', type: 'agent-output', config: {} }], edges: [{ from: 'src', to: 'out' }] },
      changes: [], repaired: true, problems: [],
      warnings: ["node 'period': the period column '時点' mixes granularities (monthly, quarterly, yearly and fiscal-year rows share it), but no filter narrows \"periodGranularity\" to one granularity"],
    });
    render(<I18nProvider initialLanguage="ja"><DesignChatPanel client={client()} /></I18nProvider>);
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('mixes granularities');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useToolBuilderStore.getState().nodes.map((node) => node.id)).toEqual(['src', 'out']);
  });
});

describe('DesignChatPanel: 文脈の消費（v49）', () => {
  it('正常: 直前の応答の消費を見出しの下に「文脈 6.8k / 200k（3%）」として出す', async () => {
    const api = client({ designChat: vi.fn().mockResolvedValue({ ...SORT_RESULT, usage: { promptTokens: 6812, completionTokens: 240, contextWindow: 200192 } }) });
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');

    expect(meter()?.textContent).toBe('文脈 6.8k / 200k（3%）');
    expect(meter()?.className).toBe('design-chat-meter');
  });

  it('境界: コンテキスト長が取れないプロバイダでは、比率を出さずトークン数だけを出す', async () => {
    const api = client({ designChat: vi.fn().mockResolvedValue({ ...SORT_RESULT, usage: { promptTokens: 6812 } }) });
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');

    expect(meter()?.textContent).toBe('文脈 約 6.8k トークン');
  });

  it('境界: 70% 以上で黄、90% 以上で赤にし、赤には直し方を添える', async () => {
    const api = client({ designChat: vi.fn()
      .mockResolvedValueOnce({ ...SORT_RESULT, usage: { promptTokens: 140000, contextWindow: 200000 } })
      .mockResolvedValueOnce({ ...SORT_RESULT, message: 'さらに直しました。', usage: { promptTokens: 180000, contextWindow: 200000 } }) });
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');
    expect(meter()?.className).toBe('design-chat-meter warn');
    expect(meter()?.textContent).toBe('文脈 140k / 200k（70%）');

    await send(input, '10 件に絞って');
    await screen.findByText('さらに直しました。');
    expect(meter()?.className).toBe('design-chat-meter danger');
    expect(meter()?.textContent).toContain('履歴を圧縮するか、クリアしてください');
  });

  it('異常: 消費を返さない応答ではメーターを出さない（推定はしない）', async () => {
    const api = client({ designChat: vi.fn()
      .mockResolvedValueOnce({ ...SORT_RESULT, usage: { promptTokens: 6812, contextWindow: 200192 } })
      .mockResolvedValueOnce({ message: '足りています。', changes: [] }) });
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await waitFor(() => expect(meter()).not.toBeNull());

    await send(input, 'この結合のキーは足りている？');
    await screen.findByText('足りています。');
    expect(meter()).toBeNull();
  });

  it('境界: 送信前はメーターを出さず、最初の応答が数えた時点で出す', async () => {
    const api = client({ designChat: vi.fn().mockResolvedValue({ ...SORT_RESULT, usage: { promptTokens: 6812, contextWindow: 200192 } }) });
    const input = await renderPanel(api);
    expect(meter()).toBeNull();

    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');
    expect(meter()?.textContent).toContain('文脈');
  });
});

describe('DesignChatPanel: 履歴の圧縮（v49）', () => {
  it('正常: 圧縮すると古いターンが要約 API へ渡り、直近 4 ターンと覚え書きが残る', async () => {
    const api = client();
    await renderSeeded(api, 6);
    await userEvent.click(screen.getByRole('button', { name: '履歴を圧縮' }));

    const body = (api.compactDesignChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(body.turns).toEqual([
      { user: '指示0', assistant: '返答0', changes: ['変更0'] },
      { user: '指示1', assistant: '返答1', changes: ['変更1'] },
    ]);
    expect(body.language).toBe('ja');
    // 1 回目は取り込む覚え書きがまだ無い。
    expect(body.previousSummary).toBeUndefined();

    expect(await screen.findByText('圧縮済み（2 ターン）')).toBeTruthy();
    expect(screen.getByText('- 地域は引数にする')).toBeTruthy();
    expect(screen.queryByText('指示0')).toBeNull();
    expect(screen.getByText('指示2')).toBeTruthy();
  });

  it('正常: 2 回目の圧縮では前回の覚え書きを材料として渡し、返った覚え書きで置き換える', async () => {
    const api = client({ compactDesignChat: vi.fn()
      .mockResolvedValueOnce({ summary: '1 回目の覚え書き' })
      .mockResolvedValueOnce({ summary: '1 回目と 2 回目をまとめた覚え書き' }) });
    await renderSeeded(api, 10);
    await userEvent.click(screen.getByRole('button', { name: '履歴を圧縮' }));
    await screen.findByText('圧縮済み（6 ターン）');

    act(() => seedTurns(3, { offset: 10 }));
    await userEvent.click(screen.getByRole('button', { name: '履歴を圧縮' }));

    const second = (api.compactDesignChat as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(second.previousSummary).toBe('1 回目の覚え書き');
    expect(second.turns.map((turn: { user: string }) => turn.user)).toEqual(['指示6', '指示7', '指示8']);
    expect(await screen.findByText('圧縮済み（9 ターン）')).toBeTruthy();
    expect(screen.getByText('1 回目と 2 回目をまとめた覚え書き')).toBeTruthy();
    expect(screen.queryByText('1 回目の覚え書き')).toBeNull();
  });

  it('正常: 要約を待つ間は「要約しています…」を出し、入力を止める', async () => {
    let resolve: (result: { summary: string }) => void = () => {};
    const api = client({ compactDesignChat: vi.fn().mockReturnValue(new Promise<{ summary: string }>((done) => { resolve = done; })) });
    const input = await renderSeeded(api, 6);
    await userEvent.click(screen.getByRole('button', { name: '履歴を圧縮' }));

    expect(screen.getByRole('status').textContent).toBe('要約しています…');
    expect(input.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '要約しています…' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { resolve({ summary: '覚え書き' }); });
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('指示') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('異常: 要約に失敗したら会話を畳まず、理由を出す', async () => {
    const api = client({ compactDesignChat: vi.fn().mockRejectedValue(new Error('モデルが設定されていません')) });
    await renderSeeded(api, 6);
    await userEvent.click(screen.getByRole('button', { name: '履歴を圧縮' }));

    expect((await screen.findByRole('alert')).textContent).toContain('モデルが設定されていません');
    expect(screen.getByText('指示0')).toBeTruthy();
    expect(screen.queryByText(/圧縮済み/)).toBeNull();
  });

  it('境界: 4 ターン以下では圧縮できず、押せない理由を title に出す', async () => {
    const api = client();
    await renderSeeded(api, 4);
    const button = screen.getByRole('button', { name: '履歴を圧縮' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('5 ターン以上');

    await userEvent.click(button);
    expect(api.compactDesignChat).not.toHaveBeenCalled();
  });

  it('異常: モデルが未設定なら圧縮も押せない（要約もモデルが書くため）', async () => {
    const api = client({ designAssistantCapability: vi.fn().mockResolvedValue(false) });
    await renderSeeded(api, 6);
    await screen.findByText(/ローカルLLMが未設定です/);
    expect((screen.getByRole('button', { name: '履歴を圧縮' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('正常: 取り消せなくなることを、押す前に補助文で伝える', async () => {
    await renderSeeded(client(), 6);
    expect(screen.getByText('圧縮したターンの変更は取り消せなくなります')).toBeTruthy();
  });
});

describe('DesignChatPanel: 履歴のクリア（v49）', () => {
  it('正常: クリアすると会話が消え、キャンバスはそのまま', async () => {
    const api = client();
    const before = currentGraph();
    await renderSeeded(api, 2);
    await userEvent.click(screen.getByRole('button', { name: '履歴をクリア' }));

    expect(screen.queryByText('指示0')).toBeNull();
    expect(currentGraph()).toEqual(before);
    // 消すものが無くなったので、圧縮・クリアの行ごと消える。
    expect(screen.queryByRole('button', { name: '履歴をクリア' })).toBeNull();
  });
});

describe('DesignChatPanel: Tool Calling 契約の説明（v49）', () => {
  it('正常: 応答の agentTool を反映し、「この変更を取り消す」で元の説明へ戻す', async () => {
    const api = client({ designChat: vi.fn().mockResolvedValue({
      ...SORT_RESULT,
      agentTool: { name: 'population_all', description: '都道府県別の総人口を返す。date は ISO（期間の開始日）。' },
      changes: [{ op: 'set-agent-tool', nodeId: 'agent-tool', summary: 'エージェント向けの説明文を更新' }],
    } satisfies DesignChatResultDto) });
    useToolBuilderStore.getState().setMetadata('agentName', 'population_top');
    useToolBuilderStore.getState().setMetadata('agentDescription', '古い説明');
    const input = await renderPanel(api);
    await send(input, '説明文に日付の渡し方を書いて');
    await screen.findByText('エージェント向けの説明文を更新');

    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'population_all', agentDescription: '都道府県別の総人口を返す。date は ISO（期間の開始日）。' });
    await userEvent.click(screen.getByRole('button', { name: 'この変更を取り消す' }));
    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'population_top', agentDescription: '古い説明' });
  });

  it('正常: 送信本文にいまの agentTool と圧縮済みの覚え書きを載せる', async () => {
    const api = client();
    seedTurns(6);
    useToolBuilderStore.getState().completeDesignChatCompact(2, '- 地域は引数にする');
    useToolBuilderStore.getState().setMetadata('agentName', 'population_top');
    useToolBuilderStore.getState().setMetadata('agentDescription', '都道府県別の総人口を返す');
    const input = await renderPanel(api);
    await send(input, '10 件に絞って');

    expect(api.designChat).toHaveBeenCalledWith(expect.objectContaining({
      agentTool: { name: 'population_top', description: '都道府県別の総人口を返す' },
      transcriptSummary: '- 地域は引数にする',
    }));
  });

  it('境界: 名前か説明のどちらかが入っていれば送り、両方空なら送らない', async () => {
    const api = client();
    useToolBuilderStore.getState().setMetadata('agentName', 'population_top');
    const input = await renderPanel(api);
    await send(input, '多い順に並べて');
    await screen.findByText('並べ替えを足しました。');
    const calls = (api.designChat as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0].agentTool).toEqual({ name: 'population_top', description: '' });

    useToolBuilderStore.getState().setMetadata('agentName', '');
    await send(input, '10 件に絞って');
    expect(calls[1]?.[0].agentTool).toBeUndefined();
    // 圧縮していないので覚え書きも送らない（空文字は作らない）。
    expect(calls[1]?.[0].transcriptSummary).toBeUndefined();
  });
});

describe('DesignChatPanel: 英語UI（v49）', () => {
  it('正常: メーターと履歴の操作は英語で出し、要約も英語で頼む', async () => {
    const api = client();
    await renderSeeded(api, 6, 'en', { promptTokens: 6812, contextWindow: 200192 });

    expect(meter()?.textContent).toBe('Context 6.8k / 200k (3%)');
    expect(screen.getByText('Undo stops working for compacted turns')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear history' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Compact history' }));

    expect((api.compactDesignChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].language).toBe('en');
    expect(await screen.findByText('Compacted (2 turns)')).toBeTruthy();
  });
});

describe('ToolBuilder: 設計アシスタントの開閉', () => {
  async function openEditor(api: ToolApiClient, language: 'en' | 'ja' = 'ja') {
    render(<I18nProvider initialLanguage={language}><NavigationProvider navigate={vi.fn()}><ToolBuilder client={api} /></NavigationProvider></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: language === 'ja' ? '新規作成' : 'New tool' }));
  }

  it('正常: ヘッダのボタンでキャンバスの右に開き、× で閉じる', async () => {
    const api = client();
    await openEditor(api);
    expect(screen.queryByLabelText('設計アシスタント')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '設計アシスタント' }));
    const panel = await screen.findByLabelText('設計アシスタント');
    // インスペクターの隣（builder-workspace の最後の列）に置く。
    expect(panel.parentElement?.className).toContain('builder-workspace');
    expect(panel.parentElement?.lastElementChild).toBe(panel);
    expect(localStorage.getItem(DESIGN_CHAT_OPEN_KEY)).toBe('true');

    await userEvent.click(within(panel).getByRole('button', { name: '設計アシスタントを閉じる' }));
    expect(screen.queryByLabelText('設計アシスタント')).toBeNull();
    expect(localStorage.getItem(DESIGN_CHAT_OPEN_KEY)).toBe('false');
  });

  it('正常: 英語UIでは Design assistant として出る', async () => {
    await openEditor(client(), 'en');
    await userEvent.click(screen.getByRole('button', { name: 'Design assistant' }));
    expect(await screen.findByLabelText('Design assistant')).toBeTruthy();
  });

  it('境界: 前回開いていれば、次に編集画面を開いたときも開いたまま始まる', async () => {
    localStorage.setItem(DESIGN_CHAT_OPEN_KEY, 'true');
    await openEditor(client());
    expect(await screen.findByLabelText('設計アシスタント')).toBeTruthy();
  });

  it('異常: Storage が使えなくても開閉そのものは効く', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      await openEditor(client());
      await userEvent.click(screen.getByRole('button', { name: '設計アシスタント' }));
      expect(await screen.findByLabelText('設計アシスタント')).toBeTruthy();
    } finally {
      setItem.mockRestore();
    }
  });
});
