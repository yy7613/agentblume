// @vitest-environment jsdom
/**
 * 「テンプレートから作成」ダイアログ（v43 / ADR-0049）。
 *
 * 見るのは「人が選べるか」と「選んだ根拠が見えるか」:
 * 一覧と絞り込み・読めなかったテンプレートの表示・スロット種別ごとの入力欄・
 * 依存するスロットを変えたときの候補の取り直し・422 のスロット指摘・
 * 作成でストアへ展開されること（メタデータと通知つき）・キーボード操作。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type {
  DataSourceDto,
  InstantiatedTemplateDto,
  TemplateSlotCandidatesResultDto,
  ToolTemplateCatalogDto,
  ToolTemplateDto,
} from '../api/types';
import { I18nProvider } from '../i18n';
import { TemplateDialog } from './TemplateDialog';
import { useToolBuilderStore } from './store';

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

const SERIES: ToolTemplateDto = {
  id: 'period-series', version: '1.0.0',
  title: { ja: '時系列の取り出し', en: 'Time series lookup' },
  summary: { ja: '期間で絞って推移を返す。', en: 'Returns a series filtered by period.' },
  whenToUse: { ja: ['推移を答えたい'], en: ['Answer a trend'] },
  tags: ['time-series'],
  sources: { min: 1, max: 1 },
  slots: [
    { name: 'source', kind: 'dataSource', label: { ja: 'データソース', en: 'Data source' }, optional: false },
    { name: 'periodColumn', kind: 'column', source: 'source', role: 'period', label: { ja: '期間の列', en: 'Period column' }, optional: false },
    { name: 'valueColumns', kind: 'column', source: 'source', role: 'value', multiple: { min: 1, max: 5 }, label: { ja: '値の列', en: 'Value columns' }, optional: false },
    { name: 'categoryColumn', kind: 'column', source: 'source', role: 'category', label: { ja: 'カテゴリの列', en: 'Category column' }, optional: true },
    { name: 'defaultGranularity', kind: 'choice', optionsFrom: 'granularities:periodColumn', label: { ja: '既定の粒度', en: 'Default granularity' }, optional: false },
    { name: 'limit', kind: 'number', min: 1, max: 100, integer: true, default: 36, label: { ja: '返す最大行数', en: 'Maximum rows' }, optional: false },
  ],
};

const RATIO: ToolTemplateDto = {
  id: 'ratio-of-two-sources', version: '1.1.0',
  title: { ja: '2 つのデータの比', en: 'Ratio of two sources' },
  summary: { ja: '分子 ÷ 分母 を返す。', en: 'Returns numerator / denominator.' },
  whenToUse: { ja: ['一人当たりが要る'], en: ['Per-capita values'] },
  tags: ['join'],
  sources: { min: 2, max: 2 },
  slots: [
    { name: 'numeratorSource', kind: 'dataSource', label: { ja: '分子のデータソース', en: 'Numerator source' }, optional: false },
    { name: 'denominatorSource', kind: 'dataSource', label: { ja: '分母のデータソース', en: 'Denominator source' }, optional: false },
    { name: 'joinKeys', kind: 'joinKeys', left: 'numeratorSource', right: 'denominatorSource', multiple: { min: 1, max: 3 }, label: { ja: '結合キー', en: 'Join keys' }, optional: false },
    { name: 'ratioColumn', kind: 'text', maxLength: 40, default: '比率', label: { ja: '計算結果の列名', en: 'Computed column name' }, optional: false },
    { name: 'scale', kind: 'choice', default: '1', label: { ja: '倍率', en: 'Scale' }, optional: false, options: [
      { value: '1', label: { ja: 'そのまま', en: 'As is' } },
      { value: '100', label: { ja: '百分率（×100）', en: 'Percent (×100)' } },
    ] },
  ],
};

const CUSTOM: ToolTemplateDto = {
  id: 'custom-computation', version: '1.0.0',
  title: { ja: '計算列を足す', en: 'Add a computed column' },
  summary: { ja: '意図文から式を書く。', en: 'Writes the formula from an instruction.' },
  whenToUse: { ja: ['自由な計算'], en: ['A free computation'] },
  tags: ['calculation'],
  sources: { min: 1, max: 1 },
  slots: [
    { name: 'source', kind: 'dataSource', label: { ja: 'データソース', en: 'Data source' }, optional: false },
    { name: 'computationIntent', kind: 'intent', maxLength: 200, label: { ja: '何を計算するか', en: 'What to compute' }, optional: false, help: { ja: '式ではなく意図を書く', en: 'Describe the intent' } },
  ],
};

const CATALOG: ToolTemplateCatalogDto = {
  templates: [SERIES, RATIO, CUSTOM],
  invalid: [{ file: 'broken.json', problems: ["id 'Broken!' does not match the shape; rename it to lowercase letters"] }],
};

const DATA_SOURCES: readonly DataSourceDto[] = [
  { id: 'ds-population', tenant: { tenantId: 'local', workspaceId: 'default' }, name: '人口', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 10, createdAt: '', updatedAt: '' },
  { id: 'ds-workers', tenant: { tenantId: 'local', workspaceId: 'default' }, name: '就業者数', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 10, createdAt: '', updatedAt: '' },
];

const SERIES_CANDIDATES: TemplateSlotCandidatesResultDto = {
  templateId: 'period-series', version: '1.0.0',
  candidates: [
    { slot: 'source', kind: 'dataSource', options: [{ value: 'ds-population', name: '人口' }] },
    { slot: 'periodColumn', kind: 'column', options: [{ value: '時点', type: 'string', granularities: { year: 4, month: 1 }, minStart: '2022-01-01', maxStart: '2023-05-01' }] },
    { slot: 'valueColumns', kind: 'column', options: [{ value: '人口', type: 'number' }] },
    { slot: 'categoryColumn', kind: 'column', options: [{ value: '地域', type: 'string', examples: ['北海道', '東京都'], distinctCount: 2 }] },
    { slot: 'defaultGranularity', kind: 'choice', options: [{ value: 'year' }, { value: 'month' }] },
    { slot: 'limit', kind: 'number', range: { min: 1, max: 100 } },
  ],
};

const RATIO_CANDIDATES: TemplateSlotCandidatesResultDto = {
  templateId: 'ratio-of-two-sources', version: '1.1.0',
  candidates: [
    { slot: 'numeratorSource', kind: 'dataSource', options: [{ value: 'ds-population', name: '人口' }, { value: 'ds-workers', name: '就業者数' }] },
    { slot: 'denominatorSource', kind: 'dataSource', options: [{ value: 'ds-population', name: '人口' }, { value: 'ds-workers', name: '就業者数' }] },
    { slot: 'joinKeys', kind: 'joinKeys', options: [
      { value: '時点', overlap: 1, uniqueLeft: false, uniqueRight: false },
      { value: '地域コード', overlap: 1, uniqueLeft: false, uniqueRight: false },
    ] },
    { slot: 'ratioColumn', kind: 'text', freeText: true },
    { slot: 'scale', kind: 'choice', options: [{ value: '1', label: { ja: 'そのまま', en: 'As is' } }, { value: '100', label: { ja: '百分率（×100）', en: 'Percent (×100)' } }] },
  ],
};

function instantiated(overrides: Partial<InstantiatedTemplateDto> = {}): InstantiatedTemplateDto {
  return {
    template: { id: 'period-series', version: '1.0.0' },
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-population' } },
        { id: 'period', type: 'parse-period', config: { column: '時点' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 36, maxBytes: 65536, overflow: 'error' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns: [{ name: 'granularity', type: 'string', nullable: false }] }, sample: { granularity: 'year' } } },
      ],
      edges: [{ from: 'src', to: 'period' }, { from: 'period', to: 'out' }],
    },
    agentTool: { name: 'period-series', description: '人口の推移を返します。' },
    pendingExpressions: [],
    ...overrides,
  };
}

function fakeClient(overrides: Readonly<Record<string, unknown>> = {}): ToolApiClient {
  return {
    listToolTemplates: vi.fn().mockResolvedValue(CATALOG),
    listDataSources: vi.fn().mockResolvedValue(DATA_SOURCES),
    toolTemplateSlotCandidates: vi.fn().mockResolvedValue(SERIES_CANDIDATES),
    instantiateToolTemplate: vi.fn().mockResolvedValue(instantiated()),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderDialog(client: ToolApiClient, language: 'en' | 'ja' = 'en', onClose = vi.fn()) {
  render(<I18nProvider initialLanguage={language}><TemplateDialog client={client} open onClose={onClose} /></I18nProvider>);
  return onClose;
}

/** 一覧からテンプレートを選び、スロットの入力欄が出るまで待つ。 */
async function choose(title: string): Promise<HTMLElement> {
  const card = (await screen.findByText(title)).closest('article') as HTMLElement;
  await userEvent.click(within(card).getByRole('button', { name: /Use this template|このテンプレートを使う/ }));
  return screen.getByRole('dialog');
}

describe('TemplateDialog: テンプレート一覧', () => {
  it('正常: タイトル・要約・使いどころ・タグ・要るデータソース数を出す', async () => {
    renderDialog(fakeClient());
    const card = (await screen.findByText('Time series lookup')).closest('article') as HTMLElement;
    expect(within(card).getByText('Returns a series filtered by period.')).toBeTruthy();
    expect(within(card).getByText('Answer a trend')).toBeTruthy();
    expect(within(card).getByText('time-series')).toBeTruthy();
    expect(within(card).getByText('Data sources: 1')).toBeTruthy();
    expect(within(card).getByText('period-series@1.0.0')).toBeTruthy();
  });

  it('正常: 絞り込みはタイトル・要約・タグ・id のどれかに当たったものだけ残す', async () => {
    renderDialog(fakeClient());
    await screen.findByText('Time series lookup');
    fireEvent.change(screen.getByLabelText('Filter templates'), { target: { value: 'join' } });
    expect(screen.queryByText('Time series lookup')).toBeNull();
    expect(screen.getByText('Ratio of two sources')).toBeTruthy();
  });

  it('境界: 一致が無ければ「一致するテンプレートがありません」を出す', async () => {
    renderDialog(fakeClient());
    await screen.findByText('Time series lookup');
    fireEvent.change(screen.getByLabelText('Filter templates'), { target: { value: 'zzz' } });
    expect(screen.getByText('No template matches.')).toBeTruthy();
  });

  it('異常: 読めなかったテンプレートはファイル名と直し方つきで、既定は畳んで出す', async () => {
    renderDialog(fakeClient());
    const summary = await screen.findByText('Templates that could not be read (1)');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('broken.json')).toBeTruthy();
    expect(within(details).getByText(/rename it to lowercase letters/)).toBeTruthy();
  });

  it('異常: 一覧を取れなければ理由を出す（ダイアログは開いたまま）', async () => {
    renderDialog(fakeClient({ listToolTemplates: vi.fn().mockRejectedValue(new Error('offline')) }));
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
  });

  it('正常: 日本語では見出しとボタンが日本語になる', async () => {
    renderDialog(fakeClient(), 'ja');
    expect(await screen.findByText('時系列の取り出し')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'このテンプレートを使う' }).length).toBeGreaterThan(0);
  });
});

describe('TemplateDialog: スロットの入力欄', () => {
  it('正常: データソースは登録済みのファイルから選ぶ（スロットのラベルで）', async () => {
    renderDialog(fakeClient());
    await choose('Time series lookup');
    const select = screen.getByLabelText('Data source') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Select a data source', '人口 (csv)', '就業者数 (csv)']);
  });

  it('正常: 列の候補は「名前 (型)」で、カテゴリ列には実在値の例、期間列には粒度と範囲が付く', async () => {
    renderDialog(fakeClient());
    await choose('Time series lookup');
    await userEvent.selectOptions(screen.getByLabelText('Data source'), 'ds-population');
    await screen.findByRole('option', { name: /時点/ });
    expect(screen.getByRole('option', { name: /時点 — string · year×4 month×1 2022-01-01〜2023-05-01/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /地域 — string · e\.g\. 北海道, 東京都/ })).toBeTruthy();
  });

  it('正常: 複数選ぶ列はチェックボックスで、何個選べるかを添える', async () => {
    renderDialog(fakeClient());
    await choose('Time series lookup');
    await userEvent.selectOptions(screen.getByLabelText('Data source'), 'ds-population');
    const group = (await screen.findByText('Value columns')).closest('fieldset') as HTMLElement;
    expect(within(group).getByText('Choose 1–5')).toBeTruthy();
    expect(within(group).getByRole('checkbox', { name: /人口 — number/ })).toBeTruthy();
  });

  it('正常: 任意スロットは「(optional)」と「指定しない」を持つ', async () => {
    renderDialog(fakeClient());
    await choose('Time series lookup');
    const select = screen.getByLabelText('Category column (optional)') as HTMLSelectElement;
    expect(select.options[0]?.textContent).toBe('(none)');
  });

  it('正常: 数値は min/max つきの数値入力、既定値が入っている', async () => {
    renderDialog(fakeClient());
    await choose('Time series lookup');
    const input = screen.getByLabelText('Maximum rows') as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.min).toBe('1');
    expect(input.max).toBe('100');
    expect(input.value).toBe('36');
  });

  it('正常: choice はローカライズしたラベルの選択肢、text は入力欄', async () => {
    renderDialog(fakeClient({ toolTemplateSlotCandidates: vi.fn().mockResolvedValue(RATIO_CANDIDATES) }), 'ja');
    await choose('2 つのデータの比');
    await userEvent.selectOptions(screen.getByLabelText('分子のデータソース'), 'ds-workers');
    await userEvent.selectOptions(screen.getByLabelText('分母のデータソース'), 'ds-population');
    await screen.findByRole('option', { name: '百分率（×100） (100)' });
    expect((screen.getByLabelText('計算結果の列名') as HTMLInputElement).value).toBe('比率');
  });

  it('正常: intent は説明つきのテキストエリア', async () => {
    renderDialog(fakeClient());
    await choose('Add a computed column');
    const textarea = screen.getByLabelText('What to compute') as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.maxLength).toBe(200);
    expect(screen.getByText('Describe the intent')).toBeTruthy();
  });

  it('異常: 結合キーを選び残すと「行が増える」警告を出す', async () => {
    renderDialog(fakeClient({ toolTemplateSlotCandidates: vi.fn().mockResolvedValue(RATIO_CANDIDATES) }));
    await choose('Ratio of two sources');
    await userEvent.selectOptions(screen.getByLabelText('Numerator source'), 'ds-workers');
    await userEvent.selectOptions(screen.getByLabelText('Denominator source'), 'ds-population');
    const keys = (await screen.findByText('Join keys')).closest('fieldset') as HTMLElement;
    await userEvent.click(within(keys).getByRole('checkbox', { name: /時点/ }));
    expect(within(keys).getByText(/the join can multiply rows/)).toBeTruthy();
  });

  it('異常: キーを全部選んでも一意にならなければ、その旨を警告する', async () => {
    renderDialog(fakeClient({ toolTemplateSlotCandidates: vi.fn().mockResolvedValue(RATIO_CANDIDATES) }));
    await choose('Ratio of two sources');
    await userEvent.selectOptions(screen.getByLabelText('Numerator source'), 'ds-workers');
    await userEvent.selectOptions(screen.getByLabelText('Denominator source'), 'ds-population');
    const keys = (await screen.findByText('Join keys')).closest('fieldset') as HTMLElement;
    await userEvent.click(within(keys).getByRole('checkbox', { name: /時点/ }));
    await userEvent.click(within(keys).getByRole('checkbox', { name: /地域コード/ }));
    expect(within(keys).getByText(/do not identify a single row/)).toBeTruthy();
  });

  it('正常: 依存するスロット（データソース）を変えると、候補を部分的な値つきで取り直す', async () => {
    const toolTemplateSlotCandidates = vi.fn().mockResolvedValue(RATIO_CANDIDATES);
    renderDialog(fakeClient({ toolTemplateSlotCandidates }));
    await choose('Ratio of two sources');
    await userEvent.selectOptions(screen.getByLabelText('Numerator source'), 'ds-workers');
    // 1 つだけではソース数が足りないので、まだ取りに行かない。
    expect(toolTemplateSlotCandidates).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Denominator source'), 'ds-population');
    await waitFor(() => expect(toolTemplateSlotCandidates).toHaveBeenCalledTimes(1));
    expect(toolTemplateSlotCandidates.mock.calls[0]?.[0]).toMatchObject({
      templateId: 'ratio-of-two-sources',
      dataSourceIds: ['ds-workers', 'ds-population'],
      values: { numeratorSource: 'ds-workers', denominatorSource: 'ds-population' },
    });

    // 文字入力では取り直さない（候補は列とデータソースにしか依存しない）。
    await userEvent.type(screen.getByLabelText('Computed column name'), 'x');
    expect(toolTemplateSlotCandidates).toHaveBeenCalledTimes(1);

    // データソースを入れ替えたら取り直す。
    await userEvent.selectOptions(screen.getByLabelText('Numerator source'), 'ds-population');
    await waitFor(() => expect(toolTemplateSlotCandidates).toHaveBeenCalledTimes(2));
  });
});

describe('TemplateDialog: 作成', () => {
  async function fillSeries(): Promise<void> {
    await choose('Time series lookup');
    await userEvent.selectOptions(screen.getByLabelText('Data source'), 'ds-population');
    await screen.findByRole('option', { name: /時点/ });
    await userEvent.selectOptions(screen.getByLabelText('Period column'), '時点');
    const values = (screen.getByText('Value columns')).closest('fieldset') as HTMLElement;
    await userEvent.click(within(values).getByRole('checkbox', { name: /人口/ }));
    await userEvent.selectOptions(screen.getByLabelText('Default granularity'), 'year');
  }

  it('正常: 実体化した結果をストアへ展開し、メタデータと Agent Tool 契約を埋めて閉じる', async () => {
    const instantiateToolTemplate = vi.fn().mockResolvedValue(instantiated());
    const onClose = vi.fn();
    renderDialog(fakeClient({ instantiateToolTemplate }), 'en', onClose);
    await fillSeries();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(instantiateToolTemplate.mock.calls[0]?.[0]).toMatchObject({
      templateId: 'period-series', dataSourceIds: ['ds-population'], language: 'en',
      values: { periodColumn: '時点', valueColumns: ['人口'], defaultGranularity: 'year', limit: 36 },
    });
    const state = useToolBuilderStore.getState();
    expect(state.nodes.map((node) => node.id)).toEqual(['src', 'period', 'out', 'args']);
    expect(state.edges).toHaveLength(2);
    expect(state.metadata).toMatchObject({
      displayName: 'Time series lookup', publishName: 'period-series', internalId: 'period-series',
      agentName: 'period-series', agentDescription: '人口の推移を返します。',
    });
    expect(state.createdFromTemplate).toBe('period-series@1.0.0');
    expect(state.currentVersion).toBeUndefined();
  });

  it('正常: 位置の無いノードは左→右（トポロジカルな深さ）へ並ぶ', async () => {
    renderDialog(fakeClient());
    await fillSeries();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(useToolBuilderStore.getState().nodes.length).toBe(4));
    const position = (id: string) => useToolBuilderStore.getState().nodes.find((node) => node.id === id)!.position;
    expect(position('period').x).toBeGreaterThan(position('src').x);
    expect(position('out').x).toBeGreaterThan(position('period').x);
    // 繋がっていない agent-input は先頭列に置かれ、src と重ならない。
    expect(position('args').y).not.toBe(position('src').y);
  });

  it('正常: 式が空の calculate があれば、そのノードを選び、意図文を電卓へ預ける', async () => {
    const withPending = instantiated({
      template: { id: 'custom-computation', version: '1.0.0' },
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-population' } },
          { id: 'calc', type: 'calculate', config: { outputColumn: '千人', expression: '' } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 10, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'calc' }, { from: 'calc', to: 'out' }],
      },
      agentTool: { name: 'custom-computation', description: '計算列を返します。' },
      pendingExpressions: [{ nodeId: 'calc', intent: '人口を千で割る' }],
    });
    renderDialog(fakeClient({ instantiateToolTemplate: vi.fn().mockResolvedValue(withPending) }));
    await choose('Add a computed column');
    await userEvent.selectOptions(screen.getByLabelText('Data source'), 'ds-population');
    await userEvent.type(screen.getByLabelText('What to compute'), '人口を千で割る');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(useToolBuilderStore.getState().selectedNodeId).toBe('calc'));
    expect(useToolBuilderStore.getState().pendingCalculateIntent).toEqual({ nodeId: 'calc', intent: '人口を千で割る' });
  });

  it('異常: 422 のスロット指摘は、その欄の真下に出る（ダイアログは閉じない）', async () => {
    const failure = new ApiError(422, 'TOOL_TEMPLATE_SLOTS', 'slots need a different value', undefined, {
      details: { slots: [{ slot: 'valueColumns', message: "slot 'valueColumns' is set to '世帯数', which is not a value column of that data source; choose one of 人口" }] },
    });
    const onClose = vi.fn();
    renderDialog(fakeClient({ instantiateToolTemplate: vi.fn().mockRejectedValue(failure) }), 'en', onClose);
    await fillSeries();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const group = await screen.findByText('Value columns');
    const fieldset = group.closest('fieldset') as HTMLElement;
    expect(within(fieldset).getByRole('alert').textContent).toContain('世帯数');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('異常: 欄に紐づかない失敗は作成ボタンの近くへ出す', async () => {
    const onClose = vi.fn();
    renderDialog(fakeClient({ instantiateToolTemplate: vi.fn().mockRejectedValue(new Error('server is down')) }), 'en', onClose);
    await fillSeries();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toContain('server is down');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('正常: 指摘のあった欄を触ると、その欄の指摘は消える', async () => {
    const failure = new ApiError(422, 'TOOL_TEMPLATE_SLOTS', 'slots need a different value', undefined, {
      details: { slots: [{ slot: 'periodColumn', message: "slot 'periodColumn' is set to 'x', which is not a period column of that data source; choose one of 時点" }] },
    });
    renderDialog(fakeClient({ instantiateToolTemplate: vi.fn().mockRejectedValue(failure) }));
    await fillSeries();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('alert');
    await userEvent.selectOptions(screen.getByLabelText('Period column'), '時点');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('TemplateDialog: 操作', () => {
  it('正常: role="dialog" を持ち、Escape で閉じる', async () => {
    const onClose = vi.fn();
    renderDialog(fakeClient(), 'en', onClose);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('正常: 「一覧へ戻る」でテンプレートを選び直せる', async () => {
    renderDialog(fakeClient());
    await choose('Time series lookup');
    expect(screen.getByLabelText('Data source')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(await screen.findByText('Ratio of two sources')).toBeTruthy();
  });

  it('境界: open=false では何も描画しない', () => {
    render(<I18nProvider initialLanguage="en"><TemplateDialog client={fakeClient()} open={false} onClose={vi.fn()} /></I18nProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
