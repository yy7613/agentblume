// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { SerializedToolDto, ToolCheckCaseDto, ToolCheckRunResultDto, ToolCheckSuggestionDto, ToolCheckSuggestionsDto, ToolSummaryDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider } from '../navigation';
import { UnsavedChangesProvider } from '../unsaved-changes';
import { ToolCheckPage } from './ToolCheckPage';

/**
 * 「LLMでケースを提案」の画面テスト。SuggestionPanel は ToolCheckPage の中でだけ使うので、
 * 能力の判定・ボタンの有効無効・エディタへの読み込み（未保存化）まで含めて画面ごと描いて確かめる。
 */

afterEach(() => { cleanup(); });

const scope = { tenantId: 'local', workspaceId: 'default' };
const tools: readonly ToolSummaryDto[] = [
  { internalId: 'sales', publishName: 'sales_summary', displayName: 'Sales summary', latestVersion: '1.2.0', state: 'published', sideEffect: 'read-only' },
];
const salesTool = {
  metadata: { internalId: 'sales', workingName: 'w', displayName: 'Sales summary', publishName: 'sales_summary', version: '1.2.0', owner: 'o', state: 'published', tenant: scope },
  sideEffect: 'read-only', graph: { nodes: [], edges: [] },
  inputSchema: { columns: [{ name: 'limit', type: 'number', nullable: false }, { name: 'active', type: 'boolean', nullable: false }, { name: 'region', type: 'string', nullable: true }] },
  outputSchema: { columns: [{ name: 'total', type: 'number', nullable: false }, { name: 'region', type: 'string', nullable: false }] },
  agentTool: { name: 'sales_summary', description: 'Summarize sales by region' },
} as SerializedToolDto;

function makeResult(overrides: Partial<ToolCheckRunResultDto> = {}): ToolCheckRunResultDto {
  return {
    tool: { internalId: 'sales', version: '1.2.0', publishName: 'sales_summary' },
    status: 'passed',
    assertions: [{ kind: 'rowCount', passed: true, expected: 'row count >= 1', actual: 'row count 3' }],
    output: { schema: { columns: [{ name: 'total', type: 'number', nullable: false }] }, rows: [{ total: 1 }, { total: 2 }, { total: 3 }] },
    rowCount: 3, nodes: [], durationMs: 42, checkedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

const normalCase: ToolCheckSuggestionDto = { category: 'normal', name: 'Typical region', rationale: 'Most calls pass a region and a small limit.', arguments: { limit: 5, active: true, region: 'east' }, expectations: { rowCount: { op: 'gte', value: 1 }, columns: ['total'] }, warnings: [] };
const boundaryCase: ToolCheckSuggestionDto = { category: 'boundary', name: 'Zero limit', rationale: 'limit at its lower bound.', arguments: { limit: 0, active: false }, expectations: { rowCount: { op: 'eq', value: 0 } }, warnings: ['dropped undeclared argument "sort"'] };
const abnormalCase: ToolCheckSuggestionDto = { category: 'abnormal', name: 'Missing limit', rationale: 'The required argument is absent.', arguments: { active: true }, expectations: { outcome: 'error' }, warnings: [] };

function makeSuggestions(overrides: Partial<ToolCheckSuggestionsDto> = {}): ToolCheckSuggestionsDto {
  return { tool: { internalId: 'sales', version: '1.2.0', publishName: 'sales_summary' }, suggestions: [normalCase, boundaryCase, abnormalCase], model: { provider: 'openai', model: 'gpt-x' }, warnings: [], ...overrides };
}

function makeCase(overrides: Partial<ToolCheckCaseDto> = {}): ToolCheckCaseDto {
  return { id: 'c1', toolId: 'sales', name: 'Typical region', arguments: {}, expectations: {}, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides };
}

type ClientMethod = 'listTools' | 'getTool' | 'listVersions' | 'runToolCheck' | 'listToolCheckCases' | 'saveToolCheckCase' | 'deleteToolCheckCase' | 'runToolCheckCase' | 'runAllToolCheckCases' | 'toolCheckSuggestionCapability' | 'suggestToolCheckCases';
function makeClient(overrides: Partial<Record<ClientMethod, unknown>> = {}) {
  return {
    listTools: vi.fn().mockResolvedValue(tools),
    getTool: vi.fn().mockResolvedValue(salesTool),
    listVersions: vi.fn().mockResolvedValue(['1.2.0', '1.1.0']),
    runToolCheck: vi.fn().mockResolvedValue(makeResult()),
    listToolCheckCases: vi.fn().mockResolvedValue([]),
    saveToolCheckCase: vi.fn((input: { name: string }) => Promise.resolve(makeCase({ id: `saved-${input.name}`, name: input.name }))),
    deleteToolCheckCase: vi.fn().mockResolvedValue(undefined),
    runToolCheckCase: vi.fn(),
    runAllToolCheckCases: vi.fn().mockResolvedValue([]),
    toolCheckSuggestionCapability: vi.fn().mockResolvedValue(true),
    suggestToolCheckCases: vi.fn().mockResolvedValue(makeSuggestions()),
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

const suggestButton = () => screen.getByRole('button', { name: 'LLMでケースを提案' }) as HTMLButtonElement;

/** 能力ありでパネルを開き、「提案を作成」まで進めて結果を待つ。 */
async function openAndSuggest(client: ToolApiClient): Promise<HTMLElement> {
  renderPage(client);
  await screen.findByLabelText(/^limit/);
  await waitFor(() => expect(suggestButton().disabled).toBe(false));
  await userEvent.click(suggestButton());
  const panel = screen.getByRole('region', { name: 'LLM によるケース提案' });
  await userEvent.click(within(panel).getByRole('button', { name: '提案を作成' }));
  await waitFor(() => expect(client.suggestToolCheckCases).toHaveBeenCalledTimes(1));
  await within(panel).findByText('提案 3 件');
  return panel;
}

function cardOf(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

describe('LLM 提案: 能力の判定とボタン', () => {
  it('正常: 能力があればボタンは有効で、押すとインラインのパネルが開く', async () => {
    const client = makeClient();
    renderPage(client);
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    expect(client.toolCheckSuggestionCapability).toHaveBeenCalledTimes(1);
    expect(suggestButton().title).toBe('');
    await userEvent.click(suggestButton());
    const panel = screen.getByRole('region', { name: 'LLM によるケース提案' });
    expect(within(panel).getByRole('button', { name: '提案を作成' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // もう一度押すと閉じる（トグル）。
    await userEvent.click(suggestButton());
    expect(screen.queryByRole('region', { name: 'LLM によるケース提案' })).toBeNull();
  });

  it('異常: 能力が無ければボタンは無効で、理由と設定画面への導線を出す', async () => {
    const navigate = vi.fn();
    renderPage(makeClient({ toolCheckSuggestionCapability: vi.fn().mockResolvedValue(false) }), { navigate });
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(true));
    expect(suggestButton().title).toBe('設定中のモデルが構造化出力に対応していないため使えません。設定画面で対応モデルを選んでください');
    expect(screen.getByText(/構造化出力に対応していないため使えません/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '設定画面を開く' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
  });

  it('例外: 能力の問い合わせが失敗しても画面は壊れず、使えないものとして扱う', async () => {
    renderPage(makeClient({ toolCheckSuggestionCapability: vi.fn().mockRejectedValue(new Error('offline')) }));
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().title).toContain('構造化出力に対応していない'));
    expect(suggestButton().disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LLM 提案: リクエストと読み込み', () => {
  it('正常: 件数と重点（trim）を載せ、最新版なら version を省いた DTO で提案を求める', async () => {
    const client = makeClient();
    renderPage(client);
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    const count = screen.getByLabelText('カテゴリごとの件数') as HTMLInputElement;
    expect(count.value).toBe('2');
    await userEvent.clear(count);
    await userEvent.type(count, '3');
    await userEvent.type(screen.getByLabelText('重点（任意）'), '  価格の境界  ');
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    await waitFor(() => expect(client.suggestToolCheckCases).toHaveBeenCalledTimes(1));
    const [dto, signal] = vi.mocked(client.suggestToolCheckCases).mock.calls[0] ?? [];
    expect(dto).toStrictEqual({ scope, toolId: 'sales', perCategory: 3, focus: '価格の境界' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('正常: 版を選んでいれば version を付け、重点が空なら focus を省く', async () => {
    const client = makeClient();
    renderPage(client);
    await screen.findByLabelText(/^limit/);
    await userEvent.selectOptions(screen.getByLabelText('ツールのバージョン'), '1.1.0');
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    await waitFor(() => expect(client.suggestToolCheckCases).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.suggestToolCheckCases).mock.calls[0]?.[0]).toStrictEqual({ scope, toolId: 'sales', version: '1.1.0', perCategory: 2 });
  });

  it('境界: 件数は 1 と 5 をそのまま送り、0 と 6 は 1〜5 に丸めて送る', async () => {
    const client = makeClient();
    renderPage(client);
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    const count = screen.getByLabelText('カテゴリごとの件数') as HTMLInputElement;
    expect(count.min).toBe('1');
    expect(count.max).toBe('5');
    const sendWith = async (value: string) => {
      await userEvent.clear(count);
      await userEvent.type(count, value);
      await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    };
    await sendWith('1');
    await sendWith('5');
    await sendWith('0');
    await sendWith('6');
    await waitFor(() => expect(client.suggestToolCheckCases).toHaveBeenCalledTimes(4));
    expect(vi.mocked(client.suggestToolCheckCases).mock.calls.map((call) => call[0]?.perCategory)).toEqual([1, 5, 1, 5]);
    // 欄を離れると表示も丸める。
    await userEvent.clear(count);
    await userEvent.type(count, '9');
    await userEvent.tab();
    expect(count.value).toBe('5');
  });

  it('正常: 実行中は role=status の進捗と「中断」を出し、中断してもエラーにしない', async () => {
    const suggestToolCheckCases = vi.fn((_: unknown, signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    renderPage(makeClient({ suggestToolCheckCases }));
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    const panel = screen.getByRole('region', { name: 'LLM によるケース提案' });
    expect((await within(panel).findByRole('status')).textContent).toContain('モデルにケース案を問い合わせています');
    expect(within(panel).getByRole('button', { name: /提案を作成中… \d+秒/ })).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: '中断' }));
    expect(await within(panel).findByText('中断しました。提案は作られていません。')).toBeTruthy();
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect((within(panel).getByRole('button', { name: '提案を作成' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('異常: 502 MODEL_PROVIDER は次の一手つきの文言と設定画面への導線を出す', async () => {
    const navigate = vi.fn();
    renderPage(makeClient({ suggestToolCheckCases: vi.fn().mockRejectedValue(new ApiError(502, 'MODEL_PROVIDER', 'tool check suggestions are not configured')) }), { navigate });
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    const panel = screen.getByRole('region', { name: 'LLM によるケース提案' });
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('ケース提案に使うモデルが設定されていません。設定画面で構造化出力（JSON スキーマ）に対応したモデルを選んでから、もう一度提案してください。');
    await userEvent.click(within(alert).getByRole('button', { name: '設定画面を開く' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
  });

  it('境界: 提案が 0 件なら空状態の文言を出し、まとめ操作は出さない', async () => {
    const client = makeClient({ suggestToolCheckCases: vi.fn().mockResolvedValue(makeSuggestions({ suggestions: [], model: undefined })) });
    renderPage(client);
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    expect(await screen.findByText(/モデルはケースを返しませんでした/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'すべて保存' })).toBeNull();
    expect(screen.getByText('提案 0 件')).toBeTruthy();
  });
});

describe('LLM 提案: 結果の表示', () => {
  it('正常: カテゴリごとに件数付きでまとめ、カードに名前・理由・引数・期待・モデル名を出す', async () => {
    const panel = await openAndSuggest(makeClient());
    const headings = within(panel).getAllByRole('heading', { level: 4 });
    expect(headings.map((heading) => heading.textContent)).toEqual(['正常 1', '境界 1', '異常 1']);
    expect(within(panel).getByText(/openai \/ gpt-x/)).toBeTruthy();
    const card = cardOf('Typical region');
    expect(within(card).getByText('Most calls pass a region and a small limit.')).toBeTruthy();
    const args = within(card).getByLabelText('引数');
    expect(args.textContent).toContain('limit');
    expect(args.textContent).toContain('5');
    expect(args.textContent).toContain('"east"');
    const expectations = within(card).getByRole('list', { name: '期待' });
    expect(within(expectations).getByText('行数 >= 1')).toBeTruthy();
    expect(within(expectations).getByText('列「total」がある')).toBeTruthy();
    // 保存前は保存済みチップが無い。
    expect(within(card).queryByText('保存済み')).toBeNull();
  });

  it('正常: 提案ごとの警告は ⚠ で、提案全体の警告は 1 回だけ出す', async () => {
    const panel = await openAndSuggest(makeClient({ suggestToolCheckCases: vi.fn().mockResolvedValue(makeSuggestions({ warnings: ['sample run failed; expectations are estimated'] })) }));
    expect(within(cardOf('Zero limit')).getByText(/⚠ dropped undeclared argument "sort"/)).toBeTruthy();
    expect(within(panel).getAllByText(/sample run failed; expectations are estimated/)).toHaveLength(1);
    expect(within(cardOf('Typical region')).queryByText(/⚠/)).toBeNull();
  });

  it('正常: 異常系で失敗が期待値の提案は「失敗が期待値」チップと「実行が失敗すること」を出す', async () => {
    await openAndSuggest(makeClient());
    const card = cardOf('Missing limit');
    expect(within(card).getByText('失敗が期待値')).toBeTruthy();
    expect(within(card).getByText('実行が失敗すること')).toBeTruthy();
    expect(within(cardOf('Typical region')).queryByText('失敗が期待値')).toBeNull();
  });

  it('境界: 期待が空の提案は「期待なし」と出す', async () => {
    await openAndSuggest(makeClient({ suggestToolCheckCases: vi.fn().mockResolvedValue(makeSuggestions({ suggestions: [{ ...normalCase, expectations: {}, arguments: {} }, boundaryCase, abnormalCase] })) }));
    const card = cardOf('Typical region');
    expect(within(card).getByText(/期待なし/)).toBeTruthy();
    expect(within(card).getByText('（引数なし）')).toBeTruthy();
  });
});

describe('LLM 提案: 実行して確認', () => {
  it('正常: 提案の引数と期待で runToolCheck を呼び、カードに合否チップを出す', async () => {
    const client = makeClient();
    await openAndSuggest(client);
    const card = cardOf('Typical region');
    await userEvent.click(within(card).getByRole('button', { name: '実行して確認' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]).toStrictEqual({ scope, toolId: 'sales', arguments: { limit: 5, active: true, region: 'east' }, expectations: { rowCount: { op: 'gte', value: 1 }, columns: ['total'] }, rowLimit: 100 });
    expect(await within(card).findByText('合格')).toBeTruthy();
    expect(within(card).getByText('3 行 · 42 ms')).toBeTruthy();
  });

  it('正常: 不合格は落ちた期待だけを「期待 → 実測」で出す', async () => {
    const client = makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({ status: 'failed', assertions: [{ kind: 'rowCount', passed: false, expected: 'row count == 0', actual: 'row count 3' }, { kind: 'column', passed: true, expected: "column 'total' exists", actual: 'columns: total' }] })) });
    await openAndSuggest(client);
    const card = cardOf('Zero limit');
    await userEvent.click(within(card).getByRole('button', { name: '実行して確認' }));
    expect(await within(card).findByText('不合格')).toBeTruthy();
    const failed = within(card).getByRole('list', { name: '不合格の期待' });
    expect(failed.textContent).toContain('行数 == 0 → 行数 3');
    expect(failed.textContent).not.toContain('total');
  });

  it('正常: 失敗が期待値の提案が失敗して合格したら、期待どおりであることを情報として出す（直すボタンは無い）', async () => {
    const client = makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({
      status: 'passed', assertions: [{ kind: 'outcome', passed: true, expected: 'outcome error', actual: 'outcome error (TOOL_ARGUMENTS)' }],
      output: { schema: { columns: [] }, rows: [] }, rowCount: 0, error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: limit' },
    })) });
    await openAndSuggest(client);
    const card = cardOf('Missing limit');
    await userEvent.click(within(card).getByRole('button', { name: '実行して確認' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.runToolCheck).mock.calls[0]?.[0]?.expectations).toStrictEqual({ outcome: 'error' });
    expect(await within(card).findByText('合格')).toBeTruthy();
    const note = within(card).getByRole('note');
    expect(note.textContent).toContain('期待どおり実行が失敗しました');
    expect(note.textContent).toContain('TOOL_ARGUMENTS');
    expect(within(card).queryByRole('button', { name: /直す/ })).toBeNull();
  });

  it('異常: 実行がエラーなら原因とエディタへの導線を出す', async () => {
    const client = makeClient({ runToolCheck: vi.fn().mockResolvedValue(makeResult({ status: 'error', assertions: [], output: { schema: { columns: [] }, rows: [] }, rowCount: 0, error: { code: 'ETL_CONFIG', message: "filter node 'n2' references unknown column 'amount'", nodeId: 'n2' } })) });
    await openAndSuggest(client);
    const card = cardOf('Typical region');
    await userEvent.click(within(card).getByRole('button', { name: '実行して確認' }));
    expect(await within(card).findByText('エラー')).toBeTruthy();
    expect(within(card).getByText(/エディタに読み込むと、直す場所へのボタンが出ます/)).toBeTruthy();
  });

  it('例外: 実行要求そのものが失敗したらカードに alert を出し、他のカードは操作できる', async () => {
    const client = makeClient({ runToolCheck: vi.fn().mockRejectedValue(new Error('offline')) });
    await openAndSuggest(client);
    const card = cardOf('Typical region');
    await userEvent.click(within(card).getByRole('button', { name: '実行して確認' }));
    expect((await within(card).findByRole('alert')).textContent).toBe('offline');
    expect((within(cardOf('Zero limit')).getByRole('button', { name: '実行して確認' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('正常: 「すべて実行」は提案を順に実行し、各カードにチップを出す', async () => {
    const client = makeClient();
    const panel = await openAndSuggest(client);
    await userEvent.click(within(panel).getByRole('button', { name: 'すべて実行' }));
    await waitFor(() => expect(client.runToolCheck).toHaveBeenCalledTimes(3));
    expect(vi.mocked(client.runToolCheck).mock.calls.map((call) => call[0]?.arguments)).toEqual([normalCase.arguments, boundaryCase.arguments, abnormalCase.arguments]);
    await waitFor(() => expect(within(panel).getAllByText('合格')).toHaveLength(3));
  });
});

describe('LLM 提案: 保存とエディタへの読み込み', () => {
  it('正常: 「保存」は提案名のまま saveToolCheckCase を呼び、保存済みチップを付けて一覧を更新する', async () => {
    const listToolCheckCases = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([makeCase({ id: 'saved-Typical region' })]);
    const client = makeClient({ listToolCheckCases });
    await openAndSuggest(client);
    const card = cardOf('Typical region');
    await userEvent.click(within(card).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(client.saveToolCheckCase).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.saveToolCheckCase).mock.calls[0]?.[0]).toStrictEqual({ scope, toolId: 'sales', name: 'Typical region', arguments: normalCase.arguments, expectations: normalCase.expectations });
    expect(await within(card).findByText('保存済み')).toBeTruthy();
    expect((within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('ケース「Typical region」を保存しました')).toBeTruthy();
    await waitFor(() => expect(listToolCheckCases).toHaveBeenCalledTimes(2));
    expect(within(await screen.findByRole('list', { name: '保存済みケース' })).getByText('Typical region')).toBeTruthy();
  });

  it('正常: 版を選んでいれば toolVersion を付けて保存する', async () => {
    const client = makeClient();
    renderPage(client);
    await screen.findByLabelText(/^limit/);
    await userEvent.selectOptions(screen.getByLabelText('ツールのバージョン'), '1.1.0');
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    await screen.findByText('提案 3 件');
    await userEvent.click(within(cardOf('Zero limit')).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(client.saveToolCheckCase).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.saveToolCheckCase).mock.calls[0]?.[0]?.toolVersion).toBe('1.1.0');
  });

  it('異常: 保存に失敗したら理由を出し、保存済みにはしない', async () => {
    const client = makeClient({ saveToolCheckCase: vi.fn().mockRejectedValue(new Error('disk full')) });
    const panel = await openAndSuggest(client);
    await userEvent.click(within(cardOf('Typical region')).getByRole('button', { name: '保存' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain('「Typical region」を保存できませんでした: disk full');
    expect(within(cardOf('Typical region')).queryByText('保存済み')).toBeNull();
  });

  it('正常: 「すべて保存」は未保存の提案を順に保存し、保存済みは飛ばす', async () => {
    const client = makeClient();
    const panel = await openAndSuggest(client);
    await userEvent.click(within(cardOf('Zero limit')).getByRole('button', { name: '保存' }));
    await within(cardOf('Zero limit')).findByText('保存済み');
    await userEvent.click(within(panel).getByRole('button', { name: 'すべて保存' }));
    await waitFor(() => expect(client.saveToolCheckCase).toHaveBeenCalledTimes(3));
    expect(vi.mocked(client.saveToolCheckCase).mock.calls.map((call) => call[0]?.name)).toEqual(['Zero limit', 'Typical region', 'Missing limit']);
    await waitFor(() => expect(within(panel).getAllByText('保存済み')).toHaveLength(3));
    expect((within(panel).getByRole('button', { name: 'すべて保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('正常: 「エディタに読み込む」は引数・期待・名前をエディタへ入れ、未保存として報告する', async () => {
    const report = vi.fn();
    const client = makeClient();
    renderPage(client, { report });
    await screen.findByLabelText(/^limit/);
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('tool-check', false));
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    await screen.findByText('提案 3 件');
    await userEvent.click(within(cardOf('Missing limit')).getByRole('button', { name: 'エディタに読み込む' }));
    expect((screen.getByLabelText(/^limit/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^active/) as HTMLSelectElement).value).toBe('true');
    expect((screen.getByLabelText('実行の結末') as HTMLSelectElement).value).toBe('error');
    expect((screen.getByLabelText('ケース名') as HTMLInputElement).value).toBe('Missing limit');
    expect(screen.getByRole('heading', { name: '新しい検証' })).toBeTruthy();
    expect(screen.getByText(/提案「Missing limit」をエディタに読み込みました/)).toBeTruthy();
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('tool-check', true));
    // そのまま保存すると提案の内容で新規ケースになる。
    await userEvent.click(screen.getByRole('button', { name: 'ケースとして保存' }));
    await waitFor(() => expect(client.saveToolCheckCase).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.saveToolCheckCase).mock.calls[0]?.[0]).toStrictEqual({ scope, toolId: 'sales', name: 'Missing limit', arguments: { active: true }, expectations: { outcome: 'error' } });
  });

  it('正常: 実行済みの提案を読み込むと、その結果もエディタの結果欄に出る', async () => {
    const client = makeClient();
    await openAndSuggest(client);
    const card = cardOf('Typical region');
    await userEvent.click(within(card).getByRole('button', { name: '実行して確認' }));
    await within(card).findByText('合格');
    await userEvent.click(within(card).getByRole('button', { name: 'エディタに読み込む' }));
    const result = await screen.findByRole('region', { name: '結果' });
    expect(result.textContent).toContain('合格 1 / 不合格 0');
  });

  it('正常: エディタに未保存の編集があれば読み込みの前に確認を挟む', async () => {
    const client = makeClient();
    renderPage(client);
    const limit = await screen.findByLabelText(/^limit/);
    await userEvent.type(limit, '9');
    await waitFor(() => expect(suggestButton().disabled).toBe(false));
    await userEvent.click(suggestButton());
    await userEvent.click(screen.getByRole('button', { name: '提案を作成' }));
    await screen.findByText('提案 3 件');
    await userEvent.click(within(cardOf('Typical region')).getByRole('button', { name: 'エディタに読み込む' }));
    expect(screen.getByRole('alertdialog', { name: '編集中の内容を破棄しますか' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect((screen.getByLabelText(/^limit/) as HTMLInputElement).value).toBe('9');
    await userEvent.click(within(cardOf('Typical region')).getByRole('button', { name: 'エディタに読み込む' }));
    await userEvent.click(screen.getByRole('button', { name: '破棄する' }));
    await waitFor(() => expect((screen.getByLabelText(/^limit/) as HTMLInputElement).value).toBe('5'));
  });
});
