// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { SerializedToolDto, ToolCheckCaseDto, ToolCheckRunResultDto, ToolSummaryDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { UnsavedChangesProvider } from '../unsaved-changes';
import { ToolCheckPage } from './ToolCheckPage';

afterEach(() => { cleanup(); consumePendingOpen('Tool'); });

const scope = { tenantId: 'local', workspaceId: 'default' };
const tools: readonly ToolSummaryDto[] = [
  { internalId: 'sales', publishName: 'sales_summary', displayName: 'Sales summary', latestVersion: '1.2.0', state: 'published', sideEffect: 'read-only' },
  { internalId: 'noargs', publishName: 'no_args_tool', displayName: 'No args', latestVersion: '1.0.0', state: 'draft', sideEffect: 'read-only' },
];
const salesTool = {
  metadata: { internalId: 'sales', workingName: 'w', displayName: 'Sales summary', publishName: 'sales_summary', version: '1.2.0', owner: 'o', state: 'published', tenant: scope },
  sideEffect: 'read-only', graph: { nodes: [], edges: [] },
  inputSchema: { columns: [{ name: 'limit', type: 'number', nullable: false }, { name: 'active', type: 'boolean', nullable: false }, { name: 'region', type: 'string', nullable: true }] },
  outputSchema: { columns: [{ name: 'total', type: 'number', nullable: false }, { name: 'region', type: 'string', nullable: false }] },
  agentTool: { name: 'sales_summary', description: 'Summarize sales by region' },
} as SerializedToolDto;
const noArgsTool = {
  metadata: { ...salesTool.metadata, internalId: 'noargs', publishName: 'no_args_tool', version: '1.0.0' },
  sideEffect: 'read-only', graph: { nodes: [], edges: [] },
} as SerializedToolDto;

function makeResult(overrides: Partial<ToolCheckRunResultDto> = {}): ToolCheckRunResultDto {
  return {
    tool: { internalId: 'sales', version: '1.2.0', publishName: 'sales_summary' },
    status: 'passed',
    assertions: [{ kind: 'rowCount', passed: true, expected: 'row count == 3', actual: 'row count 3' }],
    output: { schema: { columns: [{ name: 'total', type: 'number', nullable: false }] }, rows: [{ total: 1 }, { total: 2 }, { total: 3 }] },
    rowCount: 3,
    nodes: [{ nodeId: 'n1', rowCount: 3 }],
    durationMs: 42,
    checkedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeCase(overrides: Partial<ToolCheckCaseDto> = {}): ToolCheckCaseDto {
  return { id: 'c1', toolId: 'sales', name: 'Three rows', arguments: { limit: 7, active: true, region: null }, expectations: { rowCount: { op: 'eq', value: 3 } }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides };
}

type ClientMethod = 'listTools' | 'getTool' | 'listVersions' | 'runToolCheck' | 'listToolCheckCases' | 'saveToolCheckCase' | 'deleteToolCheckCase' | 'runToolCheckCase' | 'runAllToolCheckCases' | 'toolCheckSuggestionCapability' | 'suggestToolCheckCases';
function makeClient(overrides: Partial<Record<ClientMethod, unknown>> = {}) {
  return {
    listTools: vi.fn().mockResolvedValue(tools),
    getTool: vi.fn((internalId: string) => Promise.resolve(internalId === 'noargs' ? noArgsTool : salesTool)),
    listVersions: vi.fn().mockResolvedValue(['1.2.0', '1.1.0']),
    runToolCheck: vi.fn().mockResolvedValue(makeResult()),
    listToolCheckCases: vi.fn().mockResolvedValue([]),
    saveToolCheckCase: vi.fn(),
    deleteToolCheckCase: vi.fn().mockResolvedValue(undefined),
    runToolCheckCase: vi.fn(),
    runAllToolCheckCases: vi.fn().mockResolvedValue([]),
    toolCheckSuggestionCapability: vi.fn().mockResolvedValue(false),
    suggestToolCheckCases: vi.fn(),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderPage(client: ToolApiClient, { navigate = vi.fn(), report = vi.fn() }: { navigate?: (screen: string) => void; report?: (id: string, unsaved: boolean) => void } = {}) {
  return render(
    <I18nProvider initialLanguage="ja">
      <UnsavedChangesProvider value={{ report }}>
        <NavigationProvider navigate={navigate as never}>
          <ToolCheckPage client={client} />
        </NavigationProvider>
      </UnsavedChangesProvider>
    </I18nProvider>,
  );
}

/** ツール定義が読み込まれ、引数欄が出るまで待つ。 */
async function waitForArguments(): Promise<HTMLInputElement> {
  return await screen.findByLabelText(/^limit/) as HTMLInputElement;
}

describe('ToolCheckPage: ツール選択と引数フォーム', () => {
  it('正常: ツール一覧を select に出し、列の型ごとに引数欄を生成する', async () => {
    renderPage(makeClient());
    expect(await screen.findByRole('option', { name: 'Sales summary (sales_summary)' })).toBeTruthy();
    const limit = await waitForArguments();
    expect(limit.type).toBe('number');
    // boolean は true/false の select、nullable な string は「未指定(null)」トグルを持つ。
    expect((screen.getByLabelText(/^active/) as HTMLSelectElement).tagName).toBe('SELECT');
    expect((screen.getByLabelText(/^region/) as HTMLInputElement).type).toBe('text');
    expect(screen.getByLabelText('未指定(null)')).toBeTruthy();
    expect(screen.getByText(/Summarize sales by region/)).toBeTruthy();
    // 版の select は最新 + 保存済みの版。
    expect(screen.getByRole('option', { name: '最新 (1.2.0)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '1.1.0' })).toBeTruthy();
  });

  it('正常: 引数なしのツールは「引数なし」を出し、{} で実行する', async () => {
    const client = makeClient();
    renderPage(client);
    await waitForArguments();
    await userEvent.selectOptions(screen.getByLabelText('ツール'), 'noargs');
    expect(await screen.findByText(/引数なし/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]).toStrictEqual({ scope, toolId: 'noargs', arguments: {}, rowLimit: 100 });
  });

  it('異常: ツール一覧の取得に失敗したらエラーを出す', async () => {
    renderPage(makeClient({ listTools: vi.fn().mockRejectedValue(new Error('offline')) }));
    expect((await screen.findByRole('alert'))?.textContent).toContain('ツール一覧を読み込めませんでした: offline');
  });

  it('境界: ツールが 0 件なら、ツール画面への導線を出す', async () => {
    const navigate = vi.fn();
    renderPage(makeClient({ listTools: vi.fn().mockResolvedValue([]) }), { navigate });
    await userEvent.click(await screen.findByRole('button', { name: 'ツール画面で作る' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
  });

  it('異常: ツール定義の取得に失敗したら理由を出し、実行ボタンを無効にする', async () => {
    renderPage(makeClient({ getTool: vi.fn().mockRejectedValue(new Error('not found')) }));
    expect((await screen.findByRole('alert'))?.textContent).toContain('ツール定義を読み込めませんでした: not found');
    expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ToolCheckPage: 実行', () => {
  it('正常: number は数値・boolean は真偽値・null トグルは null で、rowLimit 100 の DTO を送る', async () => {
    const client = makeClient();
    renderPage(client);
    const limit = await waitForArguments();
    await userEvent.type(limit, '5');
    await userEvent.selectOptions(screen.getByLabelText(/^active/), 'true');
    await userEvent.click(screen.getByLabelText('未指定(null)'));
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    const [dto, signal] = vi.mocked(client.runToolCheck).mock.calls[0] ?? [];
    expect(dto).toStrictEqual({ scope, toolId: 'sales', arguments: { limit: 5, active: true, region: null }, rowLimit: 100 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('正常: 埋めた期待だけを expectations に含め、版を選べば version を付ける', async () => {
    const client = makeClient();
    renderPage(client);
    await waitForArguments();
    await userEvent.selectOptions(screen.getByLabelText('ツールのバージョン'), '1.1.0');
    await waitFor(() => expect(client.getTool).toHaveBeenCalledWith('sales', scope, '1.1.0'));
    await userEvent.selectOptions(screen.getByLabelText('行数'), 'gte');
    await userEvent.type(screen.getByLabelText('期待する行数'), '3');
    await userEvent.selectOptions(screen.getByLabelText('存在すべき列'), 'total');
    await userEvent.click(screen.getByRole('button', { name: '列を追加' }));
    await userEvent.click(screen.getByRole('button', { name: '条件を追加' }));
    await userEvent.selectOptions(screen.getByLabelText('条件 1 の列'), 'total');
    await userEvent.selectOptions(screen.getByLabelText('条件 1 の演算子'), 'gte');
    await userEvent.type(screen.getByLabelText('条件 1 の値'), '100');
    await userEvent.type(screen.getByLabelText('所要時間上限 (ms)'), '500');
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]).toStrictEqual({
      scope, toolId: 'sales', version: '1.1.0', arguments: { active: false },
      expectations: { rowCount: { op: 'gte', value: 3 }, columns: ['total'], cells: [{ column: 'total', op: 'gte', value: 100, mode: 'any' }], maxDurationMs: 500 },
      rowLimit: 100,
    });
  });

  it('境界: 行数 0 の期待は空欄と区別して送る', async () => {
    const client = makeClient();
    renderPage(client);
    await waitForArguments();
    await userEvent.type(screen.getByLabelText('期待する行数'), '0');
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]?.expectations).toStrictEqual({ rowCount: { op: 'eq', value: 0 } });
  });

  // 50 行分のフォーム操作は jsdom では重く、全スイート並列実行時に既定タイムアウトを超えることがある。
  it('境界: セル条件 50 件を送れる', { timeout: 120_000 }, async () => {
    const client = makeClient();
    renderPage(client);
    await waitForArguments();
    // 150 回の操作になるので、userEvent（1操作ごとにイベント列を再現）ではなく fireEvent で直接変更する。
    for (let index = 0; index < 50; index += 1) fireEvent.click(screen.getByRole('button', { name: '条件を追加' }));
    for (let index = 0; index < 50; index += 1) {
      fireEvent.change(screen.getByLabelText(`条件 ${index + 1} の列`), { target: { value: 'total' } });
      fireEvent.change(screen.getByLabelText(`条件 ${index + 1} の値`), { target: { value: String(index) } });
    }
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]?.expectations?.cells).toHaveLength(50);
  });

  it('正常: 合格を role=status のバナーと日本語化した期待の表で出す', async () => {
    renderPage(makeClient());
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    const banner = await screen.findByRole('status');
    expect((banner)?.textContent).toContain('合格');
    expect((banner)?.textContent).toContain('合格 1 / 不合格 0');
    expect(screen.getByText('行数 == 3')).toBeTruthy();
    expect(screen.getByText('行数 3')).toBeTruthy();
    expect(screen.getByText('3 行')).toBeTruthy();
    expect(screen.getByText('n1')).toBeTruthy();
  });

  it('正常: 不合格は期待ごとの ✕ と実測を出す', async () => {
    renderPage(makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({
      status: 'failed',
      assertions: [{ kind: 'column', passed: false, expected: "column 'total' exists", actual: 'columns: a, b, c' }, { kind: 'cell', passed: false, expected: 'some row has total >= 100', actual: '2 of 5 rows match' }],
    })) }));
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect((await screen.findByRole('status'))?.textContent).toContain('不合格');
    expect(screen.getByText('列「total」がある')).toBeTruthy();
    expect(screen.getByText('列: a, b, c')).toBeTruthy();
    expect(screen.getByText('いずれかの行で total >= 100')).toBeTruthy();
    expect(screen.getByText('5 行中 2 行が該当')).toBeTruthy();
    expect(screen.getAllByLabelText('不合格')).toHaveLength(2);
  });

  it('正常: ノードが分かるエラーは「次の一手 → 原因 → 直すボタン」で出し、ボタンでツール画面のノードを開く', async () => {
    const navigate = vi.fn();
    renderPage(makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({
      status: 'error', assertions: [], output: { schema: { columns: [] }, rows: [] }, rowCount: 0, nodes: [],
      error: { code: 'ETL_CONFIG', message: "filter node 'n2' references unknown column 'amount'", nodeId: 'n2' },
    })) }), { navigate });
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect((await screen.findByRole('status'))?.textContent).toContain('エラー');
    const fix = screen.getByRole('button', { name: 'ツール「sales_summary」のノード「n2」を開いて直す' });
    // 失敗箇所（ノード）が本文に出る。
    expect(screen.getByText('n2', { selector: 'code' })).toBeTruthy();
    await userEvent.click(fix);
    expect(navigate).toHaveBeenCalledWith('Tool');
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'sales', version: '1.2.0', nodeId: 'n2' });
  });

  it('正常: TOOL_ARGUMENTS は該当の引数欄を強調し、「欄へ」ボタンでフォーカスを移す', async () => {
    renderPage(makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({
      status: 'error', assertions: [], output: { schema: { columns: [] }, rows: [] }, rowCount: 0, nodes: [],
      error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: limit' },
    })) }));
    const limit = await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await screen.findByRole('status');
    expect(limit.closest('.tool-check-arg')?.classList.contains('highlighted')).toBe(true);
    expect(limit.getAttribute('aria-invalid')).toBe('true');
    // 引数の欄へ戻る導線と、ツール定義を直す導線の両方がある。
    await userEvent.click(screen.getByRole('button', { name: '引数「limit」の欄へ' }));
    expect(document.activeElement).toBe(limit);
    expect(screen.getByRole('button', { name: 'ツール「sales_summary」を開いて直す' })).toBeTruthy();
  });

  it('異常: 数値欄に数値でない値（型が変わったツールの保存済みケース）があれば送らず、理由を出して欄へフォーカスする', async () => {
    // 入力欄（type=number）からは文字が入らないので、ツールの列型が string → number に変わった後の保存済みケースで再現する。
    const client = makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([makeCase({ arguments: { limit: 'abc' } })]) });
    renderPage(client);
    const limit = await waitForArguments();
    await userEvent.click(await screen.findByRole('button', { name: '開く' }));
    expect(await screen.findByText('数値を入力してください')).toBeTruthy();
    // 一覧の行にも「実行」があるので、エディタ側のボタンに絞る。
    await userEvent.click(within(document.querySelector('.tool-check-editor') as HTMLElement).getByRole('button', { name: '実行' }));
    expect(screen.getByText('赤く示した引数を直してから実行してください')).toBeTruthy();
    expect(client.runToolCheck).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(limit);
  });

  it('異常: サーバーエラー（500）はローカライズ済みの文言を role=alert で出す', async () => {
    renderPage(makeClient({ runToolCheck: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom')) }));
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(new ApiError(500, 'INTERNAL', 'boom').message);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('正常: 実行中は経過表示と「中断」を出し、中断すると結果を出さずに知らせる', async () => {
    const runToolCheck = vi.fn((_: unknown, signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    renderPage(makeClient({ runToolCheck }));
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect((await screen.findByRole('button', { name: /実行中… \d+秒/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '中断' }));
    expect(await screen.findByText('中断しました。検証は行われていません。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '中断' })).toBeNull();
    expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ToolCheckPage: 実行の結末（outcome）', () => {
  it('正常: 「失敗すること」を選ぶと expectations.outcome = error を送り、「指定なし」に戻せば省く', async () => {
    const client = makeClient();
    renderPage(client);
    await waitForArguments();
    await userEvent.selectOptions(screen.getByLabelText('実行の結末'), 'error');
    expect(screen.getByText(/実行が失敗（引数不正・ノードエラー）したら合格です/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]?.expectations).toStrictEqual({ outcome: 'error' });

    await userEvent.selectOptions(screen.getByLabelText('実行の結末'), '');
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.runToolCheck).mock.calls[1]?.[0]?.expectations).toBeUndefined();
  });

  it('正常: 期待どおり失敗して合格したときは合格バナーと失敗の内容を情報として出し、直すボタンは出さない', async () => {
    renderPage(makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({
      status: 'passed',
      assertions: [{ kind: 'outcome', passed: true, expected: 'outcome error', actual: 'outcome error (TOOL_ARGUMENTS)' }],
      output: { schema: { columns: [] }, rows: [] }, rowCount: 0, nodes: [],
      error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: limit' },
    })) }));
    const limit = await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect((await screen.findByRole('status'))?.textContent).toContain('合格');
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('期待どおり実行が失敗しました');
    expect(note.textContent).toContain('TOOL_ARGUMENTS');
    // 期待の表は outcome の項目名と「〜すること / 〜した」で出る。
    expect(screen.getByText('実行の結末', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText('実行が失敗すること')).toBeTruthy();
    expect(screen.getByText('失敗した（TOOL_ARGUMENTS）')).toBeTruthy();
    // 直す導線（引数欄の強調・ツールを開くボタン）は出ない。
    expect(screen.queryByRole('button', { name: /を開いて直す/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /の欄へ/ })).toBeNull();
    expect(limit.closest('.tool-check-arg')?.classList.contains('highlighted')).toBe(false);
  });

  it('異常: 「成功すること」を期待して失敗したらエラーとして直す導線を出す', async () => {
    renderPage(makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({
      status: 'error',
      assertions: [{ kind: 'outcome', passed: false, expected: 'outcome success', actual: 'outcome error (TOOL_ARGUMENTS)' }],
      output: { schema: { columns: [] }, rows: [] }, rowCount: 0, nodes: [],
      error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: limit' },
    })) }));
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect((await screen.findByRole('status'))?.textContent).toContain('エラー');
    expect(screen.getByText('実行が成功すること')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: '引数「limit」の欄へ' })).toBeTruthy();
  });

  it('正常: 保存済みケースの outcome を開くと select に戻る', async () => {
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([makeCase({ expectations: { outcome: 'error' } })]) }));
    await waitForArguments();
    await userEvent.click(await screen.findByRole('button', { name: '開く' }));
    await waitFor(() => expect((screen.getByLabelText('実行の結末') as HTMLSelectElement).value).toBe('error'));
  });
});

describe('ToolCheckPage: 結果表示の境界', () => {
  it('境界: 出力 0 行は空状態の文言を出す', async () => {
    renderPage(makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({ output: { schema: { columns: [{ name: 'total', type: 'number', nullable: false }] }, rows: [] }, rowCount: 0 })) }));
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect(await screen.findByText('出力は 0 行でした')).toBeTruthy();
  });

  it('境界: 全 101 行のうち 100 行だけ届いたときは切り詰めを明示し、100 行ちょうどなら明示しない', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ total: index }));
    const runToolCheck = vi.fn()
      .mockResolvedValueOnce(makeResult({ output: { schema: { columns: [{ name: 'total', type: 'number', nullable: false }] }, rows }, rowCount: 101 }))
      .mockResolvedValueOnce(makeResult({ output: { schema: { columns: [{ name: 'total', type: 'number', nullable: false }] }, rows }, rowCount: 100 }));
    renderPage(makeClient({ runToolCheck }));
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect(await screen.findByText('全 101 行のうち 100 行を表示')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect(await screen.findByText('100 行')).toBeTruthy();
  });
});

describe('ToolCheckPage: ケースの保存・一覧・削除', () => {
  it('正常: 名前を付けて保存すると id 無しで送り、一覧を更新し、以降は上書き保存になる', async () => {
    const saveToolCheckCase = vi.fn().mockResolvedValue(makeCase({ id: 'new-1', name: 'My case' }));
    const listToolCheckCases = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([makeCase({ id: 'new-1', name: 'My case' })]);
    const client = makeClient({ saveToolCheckCase, listToolCheckCases });
    renderPage(client);
    const limit = await waitForArguments();
    await userEvent.type(limit, '7');
    await userEvent.type(screen.getByLabelText('ケース名'), 'My case');
    await userEvent.click(screen.getByRole('button', { name: 'ケースとして保存' }));
    await waitFor(() => expect(saveToolCheckCase).toHaveBeenCalledTimes(1));
    expect(saveToolCheckCase.mock.calls[0]?.[0]).toStrictEqual({ scope, toolId: 'sales', name: 'My case', arguments: { limit: 7, active: false }, expectations: {} });
    expect(await screen.findByText('ケース「My case」を保存しました')).toBeTruthy();
    await waitFor(() => expect(listToolCheckCases).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { name: 'ケース: My case' })).toBeTruthy();
    // 2回目は上書き保存（id 付き）。
    await userEvent.click(screen.getByRole('button', { name: '上書き保存' }));
    await waitFor(() => expect(saveToolCheckCase).toHaveBeenCalledTimes(2));
    expect(saveToolCheckCase.mock.calls[1]?.[0]?.id).toBe('new-1');
    expect(await screen.findByText('ケース「My case」を上書き保存しました')).toBeTruthy();
  });

  it('異常: ケース名が空なら保存せず理由を出す', async () => {
    const client = makeClient();
    renderPage(client);
    await waitForArguments();
    await userEvent.click(screen.getByRole('button', { name: 'ケースとして保存' }));
    expect((screen.getByRole('alert'))?.textContent).toContain('ケース名を入力してから保存してください');
    expect(client.saveToolCheckCase).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText('ケース名'));
  });

  it('異常: 保存に失敗したらエラーを出す', async () => {
    renderPage(makeClient({ saveToolCheckCase: vi.fn().mockRejectedValue(new Error('disk full')) }));
    await waitForArguments();
    await userEvent.type(screen.getByLabelText('ケース名'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'ケースとして保存' }));
    expect((await screen.findByRole('alert'))?.textContent).toContain('ケースを保存できませんでした: disk full');
  });

  it('正常: 一覧は名前・ツール@版・直近の結果チップを出し、「開く」で引数と期待を復元する', async () => {
    const cases = [
      makeCase(),
      makeCase({ id: 'c2', name: 'Pinned', toolVersion: '1.1.0', lastResult: { status: 'failed', checkedAt: '2026-09-10T00:00:00.000Z', toolVersion: '1.1.0', summary: '1 failed' } }),
    ];
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue(cases) }));
    const list = await screen.findByRole('list', { name: '保存済みケース' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect((rows[0])?.textContent).toContain('Three rows');
    expect((rows[0])?.textContent).toContain('sales_summary@latest');
    expect((rows[0])?.textContent).toContain('未実行');
    expect((rows[1])?.textContent).toContain('sales_summary@1.1.0');
    expect((rows[1])?.textContent).toContain('不合格');
    expect((rows[1])?.textContent).toContain('2026-09-10T00:00:00.000Z');
    // 長い名前が行を壊さないよう折り返しクラスを持つ。
    expect(rows[0]?.querySelector('.tool-check-name')).toBeTruthy();

    await userEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: '開く' }));
    await waitFor(() => expect((screen.getByLabelText(/^limit/) as HTMLInputElement).value).toBe('7'));
    expect((screen.getByLabelText(/^active/) as HTMLSelectElement).value).toBe('true');
    expect((screen.getByLabelText('未指定(null)') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('期待する行数') as HTMLInputElement).value).toBe('3');
    expect(screen.getByRole('heading', { name: 'ケース: Three rows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '上書き保存' })).toBeTruthy();
  });

  it('境界: ケースが 0 件なら、ケースとは何かを説明する', async () => {
    renderPage(makeClient());
    expect(await screen.findByText(/ケースは「ツール1つに対する引数と期待の組」です/)).toBeTruthy();
  });

  it('異常: 一覧の取得に失敗したらエラーを出す', async () => {
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockRejectedValue(new Error('db locked')) }));
    expect(await screen.findByText(/ケース一覧を読み込めませんでした: db locked/)).toBeTruthy();
  });

  it('正常: 削除は確認ダイアログを挟み、キャンセルなら削除しない・確定なら削除して一覧を更新する', async () => {
    const listToolCheckCases = vi.fn().mockResolvedValueOnce([makeCase()]).mockResolvedValue([]);
    const client = makeClient({ listToolCheckCases });
    renderPage(client);
    await screen.findByText('Three rows');
    await userEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(screen.getByRole('alertdialog', { name: 'このケースを削除しますか' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(client.deleteToolCheckCase).not.toHaveBeenCalled();
    expect(screen.getByText('Three rows')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(client.deleteToolCheckCase).toHaveBeenCalledWith('c1', scope));
    expect(await screen.findByText('ケース「Three rows」を削除しました')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Three rows')).toBeNull());
  });

  it('異常: 削除に失敗したらエラーを出す', async () => {
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([makeCase()]), deleteToolCheckCase: vi.fn().mockRejectedValue(new Error('forbidden')) }));
    await screen.findByText('Three rows');
    await userEvent.click(screen.getByRole('button', { name: '削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    expect((await screen.findByRole('alert'))?.textContent).toContain('ケースを削除できませんでした: forbidden');
  });
});

describe('ToolCheckPage: ケースの実行', () => {
  it('正常: 1件実行でそのケースのチップが更新される', async () => {
    const item = makeCase();
    const runToolCheckCase = vi.fn().mockResolvedValue({ case: { ...item, lastResult: { status: 'passed', checkedAt: '2026-09-12T01:00:00.000Z', toolVersion: '1.2.0', summary: 'ok' } }, result: makeResult({ checkedAt: '2026-09-12T01:00:00.000Z' }) });
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([item]), runToolCheckCase }));
    const list = await screen.findByRole('list', { name: '保存済みケース' });
    expect((list)?.textContent).toContain('未実行');
    await userEvent.click(within(list).getByRole('button', { name: '実行' }));
    await waitFor(() => expect(runToolCheckCase).toHaveBeenCalledWith('c1', scope));
    await waitFor(() => expect((list)?.textContent).toContain('合格'));
    expect((list)?.textContent).toContain('2026-09-12T01:00:00.000Z');
  });

  it('異常: 1件実行の失敗はケース名付きのエラーにする', async () => {
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([makeCase()]), runToolCheckCase: vi.fn().mockRejectedValue(new Error('timeout')) }));
    const list = await screen.findByRole('list', { name: '保存済みケース' });
    await userEvent.click(within(list).getByRole('button', { name: '実行' }));
    expect((await screen.findByRole('alert'))?.textContent).toContain('ケース「Three rows」を実行できませんでした: timeout');
  });

  it('正常: すべて実行は集計と各ケースの結果を出し、1件がエラーでも他の結果を表示する', async () => {
    const items = [makeCase(), makeCase({ id: 'c2', name: 'Broken' })];
    const runAllToolCheckCases = vi.fn().mockResolvedValue([
      { case: items[0], result: makeResult() },
      { case: items[1], result: makeResult({ status: 'error', assertions: [], error: { code: 'TOOL_NOT_FOUND', message: 'tool not found' } }) },
    ]);
    const client = makeClient({ listToolCheckCases: vi.fn().mockResolvedValue(items), runAllToolCheckCases });
    renderPage(client);
    await screen.findByText('Broken');
    await userEvent.click(screen.getByRole('button', { name: 'すべて実行' }));
    await waitFor(() => expect(runAllToolCheckCases).toHaveBeenCalledWith(scope, undefined));
    const summary = await screen.findByText('すべて実行: 合格 1 / 不合格 0 / エラー 1');
    const panel = summary.closest('.tool-check-run-all') as HTMLElement;
    expect(within(panel).getByText('Three rows')).toBeTruthy();
    expect(within(panel).getByText('Broken')).toBeTruthy();
    expect(within(panel).getByText('エラー')).toBeTruthy();
  });

  it('正常: 「選択中のツールのみ」を付けると toolId で絞って実行し、一覧も絞る', async () => {
    const items = [makeCase(), makeCase({ id: 'c2', name: 'Other tool', toolId: 'noargs' })];
    const client = makeClient({ listToolCheckCases: vi.fn().mockResolvedValue(items) });
    renderPage(client);
    await screen.findByText('Other tool');
    await userEvent.click(screen.getByLabelText('選択中のツールのみ'));
    expect(screen.queryByText('Other tool')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'すべて実行' }));
    await waitFor(() => expect(client.runAllToolCheckCases).toHaveBeenCalledWith(scope, 'sales'));
  });

  it('異常: すべて実行が丸ごと失敗したらエラーを出す', async () => {
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([makeCase()]), runAllToolCheckCases: vi.fn().mockRejectedValue(new Error('offline')) }));
    await screen.findByText('Three rows');
    await userEvent.click(screen.getByRole('button', { name: 'すべて実行' }));
    expect(await screen.findByText(/すべて実行に失敗しました: offline/)).toBeTruthy();
  });

  it('境界: ケースが 0 件なら「すべて実行」は無効', async () => {
    renderPage(makeClient());
    await waitForArguments();
    expect((screen.getByRole('button', { name: 'すべて実行' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ToolCheckPage: 未保存の扱い', () => {
  it('正常: 編集すると未保存を App へ報告し、ツールを切り替えるときは確認を挟む（キャンセルで値を保つ）', async () => {
    const report = vi.fn();
    renderPage(makeClient(), { report });
    const limit = await waitForArguments();
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('tool-check', false));
    await userEvent.type(limit, '9');
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('tool-check', true));

    await userEvent.selectOptions(screen.getByLabelText('ツール'), 'noargs');
    expect(screen.getByRole('alertdialog', { name: '編集中の内容を破棄しますか' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect((screen.getByLabelText(/^limit/) as HTMLInputElement).value).toBe('9');
    expect((screen.getByLabelText('ツール') as HTMLSelectElement).value).toBe('sales');

    // 破棄を選ぶと切り替わり、引数欄も新しいツールのものになる。
    await userEvent.selectOptions(screen.getByLabelText('ツール'), 'noargs');
    await userEvent.click(screen.getByRole('button', { name: '破棄する' }));
    expect(await screen.findByText(/引数なし/)).toBeTruthy();
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('tool-check', false));
  });

  it('正常: 「新規」は編集中のケースを離れて空のエディタに戻す', async () => {
    renderPage(makeClient({ listToolCheckCases: vi.fn().mockResolvedValue([makeCase()]) }));
    await waitForArguments();
    await userEvent.click(await screen.findByRole('button', { name: '開く' }));
    await screen.findByRole('heading', { name: 'ケース: Three rows' });
    await userEvent.click(screen.getByRole('button', { name: '新規' }));
    expect(await screen.findByRole('heading', { name: '新しい検証' })).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(/^limit/) as HTMLInputElement).value).toBe(''));
  });
});
