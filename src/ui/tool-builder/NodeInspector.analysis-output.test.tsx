// @vitest-environment jsdom
/**
 * 設定ダイアログのうち、分析ノード（AnalysisFields）・チャート出力・Web検索入力・
 * 登録済みデータソース選択・ローカルLLM設定補助の挙動を確認する。
 *
 * 構造化ダイアログの開閉とCancel破棄は structured-dialogs.test.tsx、
 * group-by / limit / filter は NodeInspector.group-limit-filter.test.tsx が担う。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { DataSourceDto, PropagationResultDto, SearchProviderDto } from '../api/types';
import { NodeInspector } from './NodeInspector';
import type { ToolNodeType } from './node-catalog';
import { useToolBuilderStore } from './store';

const scope = { tenantId: 'local', workspaceId: 'default' };
const upstream = {
  columns: [
    { name: 'region', type: 'string' as const, nullable: false },
    { name: 'amount', type: 'number' as const, nullable: true },
    { name: 'observedAt', type: 'date' as const, nullable: false },
  ],
};
const propagation: PropagationResultDto = {
  order: ['source-1', 'filter-1'],
  hasErrors: false,
  nodes: {
    'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: upstream },
    'filter-1': { nodeId: 'filter-1', state: 'inferred', issues: [], schema: upstream },
  },
};

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

function withUpstreamColumns(): void {
  useToolBuilderStore.getState().setPropagation(propagation);
}

function addNode(type: ToolNodeType): string {
  useToolBuilderStore.getState().addNode(type);
  return useToolBuilderStore.getState().selectedNodeId!;
}

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

async function openDialog(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  return screen.getByRole('dialog', { name: 'Node configuration' });
}

/** NodeInspector が起動時に叩く3本を満たす最小のクライアント。 */
function fakeClient(overrides: Readonly<Record<string, unknown>> = {}): ToolApiClient {
  return {
    listDataSources: vi.fn().mockResolvedValue([]),
    listSearchProviders: vi.fn().mockResolvedValue([]),
    analysisAssistantCapability: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('NodeInspector: 分析ノードの設定ダイアログ', () => {
  it('基本統計量は数値列だけを候補にし、グループ列・統計量・分散を適用する', async () => {
    withUpstreamColumns();
    const id = addNode('summary-statistics');
    useToolBuilderStore.getState().updateNodeConfig(id, { ...configOf(id), metrics: [] });
    render(<NodeInspector />);
    const dialog = await openDialog();

    const numeric = within(dialog).getByLabelText('Numeric columns');
    expect(Array.from(numeric.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['amount · number']);

    await userEvent.selectOptions(numeric, 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Group columns'), 'region');
    await userEvent.selectOptions(within(dialog).getByLabelText('Metrics'), 'mean');
    await userEvent.selectOptions(within(dialog).getByLabelText('Standard deviation'), 'population');
    // ダイアログはローカル草案なので、Applyまでグラフは変わらない。
    expect(configOf(id)['columns']).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toMatchObject({ columns: ['amount'], groupBy: ['region'], metrics: ['mean'], variance: 'population' });
  });

  it('相関分析の方法・欠損値・最小ペア数・対角成分を適用する', async () => {
    withUpstreamColumns();
    const id = addNode('correlation-analysis');
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Numeric columns'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Method'), 'spearman');
    await userEvent.selectOptions(within(dialog).getByLabelText('Missing values'), 'listwise');
    fireEvent.change(within(dialog).getByLabelText('Minimum pairs'), { target: { value: '5' } });
    await userEvent.click(within(dialog).getByLabelText('Include diagonal'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({ columns: ['amount'], method: 'spearman', missing: 'listwise', minPairs: 5, includeDiagonal: true });
  });

  it('時系列分析は日時列だけを時間軸候補にし、間隔・集計・タイムゾーンを適用する', async () => {
    withUpstreamColumns();
    const id = addNode('time-series-analysis');
    render(<NodeInspector />);
    const dialog = await openDialog();

    const timeColumn = within(dialog).getByLabelText('Time column');
    expect(Array.from(timeColumn.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Select a date column', 'observedAt']);

    await userEvent.selectOptions(timeColumn, 'observedAt');
    await userEvent.selectOptions(within(dialog).getByLabelText('Value columns'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Group columns'), 'region');
    fireEvent.change(within(dialog).getByLabelText('Timezone'), { target: { value: 'Asia/Tokyo' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Interval'), 'month');
    await userEvent.selectOptions(within(dialog).getByLabelText('Aggregation'), 'sum');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({
      timeColumn: 'observedAt', valueColumns: ['amount'], groupBy: ['region'],
      timezone: 'Asia/Tokyo', interval: 'month', aggregate: 'sum',
    });
  });

  it('外れ値の検出は方法・閾値・操作・null処理を適用する', async () => {
    withUpstreamColumns();
    const id = addNode('outlier-filter');
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Numeric columns'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Group columns'), 'region');
    await userEvent.selectOptions(within(dialog).getByLabelText('Method'), 'z-score');
    fireEvent.change(within(dialog).getByLabelText('Threshold'), { target: { value: '3' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Action'), 'exclude');
    await userEvent.selectOptions(within(dialog).getByLabelText('Null values'), 'exclude');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({
      columns: ['amount'], groupBy: ['region'], method: 'z-score', threshold: 3, action: 'exclude', nulls: 'exclude',
    });
  });
});

describe('NodeInspector: ローカルLLMによる分析設定補助', () => {
  it('提案を取得してダイアログの草案へ適用し、Applyでグラフへ書き戻す', async () => {
    withUpstreamColumns();
    const id = addNode('summary-statistics');
    const suggestAnalysisConfig = vi.fn().mockResolvedValue({
      nodeId: id, nodeType: 'summary-statistics',
      config: { configVersion: 1, columns: ['amount'], groupBy: ['region'], metrics: ['mean'], variance: 'population' },
      rationale: ['amount is the only numeric column'], warnings: ['region has empty values'],
    });
    const client = fakeClient({ analysisAssistantCapability: vi.fn().mockResolvedValue(true), suggestAnalysisConfig });
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    await within(dialog).findByText('Local LLM assistance');
    const suggestButton = within(dialog).getByRole('button', { name: 'Suggest configuration' });
    // 目的が空のうちは提案できない。
    expect((suggestButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Analysis goal'), { target: { value: 'monthly trend by region' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest configuration' }));

    await within(dialog).findByText('• amount is the only numeric column');
    expect(within(dialog).getByText('• region has empty values')).toBeTruthy();
    expect(suggestAnalysisConfig).toHaveBeenCalledWith(expect.objectContaining({ nodeId: id, intent: 'monthly trend by region', scope }));
    // 現在の草案が graph 側のノードconfigへ反映されて送られる。
    const sent = suggestAnalysisConfig.mock.calls[0]![0] as { graph: { nodes: { id: string; config: unknown }[] } };
    expect(sent.graph.nodes.find((node) => node.id === id)?.config).toEqual(configOf(id));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply proposal to this dialog' }));
    expect(within(dialog).queryByText('• amount is the only numeric column')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toEqual({ configVersion: 1, columns: ['amount'], groupBy: ['region'], metrics: ['mean'], variance: 'population' });
  });

  it('提案の失敗はダイアログ内にメッセージとして残し、草案は変えない', async () => {
    withUpstreamColumns();
    const id = addNode('correlation-analysis');
    const before = configOf(id);
    const client = fakeClient({
      analysisAssistantCapability: vi.fn().mockResolvedValue(true),
      suggestAnalysisConfig: vi.fn().mockRejectedValue(new Error('local model is offline')),
    });
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    fireEvent.change(await within(dialog).findByLabelText('Analysis goal'), { target: { value: 'find pairs' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest configuration' }));

    expect(await within(dialog).findByText('local model is offline')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toEqual(before);
  });

  it('設定補助が無効なランタイムでは補助セクションを出さない', async () => {
    withUpstreamColumns();
    addNode('summary-statistics');
    const client = fakeClient();
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();
    await waitFor(() => expect(client.analysisAssistantCapability).toHaveBeenCalled());
    expect(within(dialog).queryByText('Local LLM assistance')).toBeNull();
  });
});

describe('NodeInspector: チャート出力の設定ダイアログ', () => {
  it('チャート種別ごとに必要な列マッピングだけを出す', async () => {
    withUpstreamColumns();
    addNode('chart-output');
    render(<NodeInspector />);
    const dialog = await openDialog();

    const cases: readonly (readonly [string, readonly string[]])[] = [
      ['histogram', ['Value column']],
      ['box-plot', ['Value column', 'Category column']],
      ['scatter', ['X column', 'Y column', 'Series column']],
      ['correlation-heatmap', ['X column', 'Y column', 'Coefficient column']],
      ['outlier-overlay', ['X column', 'Value column', 'Outlier flag column']],
      ['time-series', ['Time column', 'Value column', 'Series column']],
    ];
    for (const [chartType, labels] of cases) {
      await userEvent.selectOptions(within(dialog).getByLabelText('Chart type'), chartType);
      for (const label of labels) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    }
  });

  it('種別を変えるとマッピングを捨て、選び直した列と表示上限を適用する', async () => {
    withUpstreamColumns();
    const id = addNode('chart-output');
    useToolBuilderStore.getState().updateNodeConfig(id, { ...configOf(id), mapping: { timeColumn: 'observedAt', valueColumn: 'amount' } });
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Chart type'), 'histogram');
    await userEvent.selectOptions(within(dialog).getByLabelText('Value column'), 'amount');
    fireEvent.change(within(dialog).getByLabelText('Artifact name'), { target: { value: 'amount-histogram' } });
    fireEvent.change(within(dialog).getByLabelText('Maximum points'), { target: { value: '250' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Downsample'), 'lttb');
    fireEvent.change(within(dialog).getByLabelText('Title (optional)'), { target: { value: 'Amounts' } });
    fireEvent.change(within(dialog).getByLabelText('Preview rows'), { target: { value: '3' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({
      chartType: 'histogram', mapping: { valueColumn: 'amount' },
      name: 'amount-histogram', maxPoints: 250, downsample: 'lttb', title: 'Amounts', previewRows: 3,
    });
  });

  it('タイトルを空にするとキーごと落とす（任意項目のため）', async () => {
    withUpstreamColumns();
    const id = addNode('chart-output');
    render(<NodeInspector />);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Title (optional)'), { target: { value: 'Trend' } });
    fireEvent.change(within(dialog).getByLabelText('Title (optional)'), { target: { value: '' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)['title']).toBeUndefined();
  });
});

describe('NodeInspector: 出力ノードの設定ダイアログ', () => {
  it('エージェント出力の形式・単一値の列・上限・超過時の扱いを適用する', async () => {
    withUpstreamColumns();
    const id = addNode('agent-output');
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Result shape'), 'single-value');
    await userEvent.selectOptions(within(dialog).getByLabelText('Value column'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Output columns'), 'region');
    await userEvent.selectOptions(within(dialog).getByLabelText('Format'), 'markdown-table');
    fireEvent.change(within(dialog).getByLabelText('Maximum bytes'), { target: { value: '2048' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('When too large'), 'store-and-reference');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({
      shape: 'single-value', valueColumn: 'amount', columns: ['region'],
      format: 'markdown-table', maxBytes: 2048, overflow: 'store-and-reference',
    });
  });

  it('rows形式では単一値の列を出さない', async () => {
    withUpstreamColumns();
    addNode('agent-output');
    render(<NodeInspector />);
    const dialog = await openDialog();
    expect(within(dialog).queryByLabelText('Value column')).toBeNull();
  });

  it('ワークスペース出力のArtifact名・種別・書き込み方法・同名時・プレビュー行数を適用する', async () => {
    const id = addNode('workspace-output');
    render(<NodeInspector />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByLabelText('Artifact name'), { target: { value: 'monthly-report' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Artifact type'), 'json');
    await userEvent.selectOptions(within(dialog).getByLabelText('Write mode'), 'replace');
    await userEvent.selectOptions(within(dialog).getByLabelText('Name conflict'), 'fail');
    fireEvent.change(within(dialog).getByLabelText('Preview rows'), { target: { value: '4' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({
      name: 'monthly-report', artifactKind: 'json', writeMode: 'replace', onConflict: 'fail', previewRows: 4,
    });
  });

  it('グラフ出力のedgeラベル列・書き込み方法・同名時・プレビュー行数を適用する', async () => {
    withUpstreamColumns();
    const id = addNode('graph-output');
    render(<NodeInspector />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByLabelText('Artifact name'), { target: { value: 'region-graph' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Edge label column (optional)'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Write mode'), 'replace');
    await userEvent.selectOptions(within(dialog).getByLabelText('Name conflict'), 'fail');
    fireEvent.change(within(dialog).getByLabelText('Preview rows'), { target: { value: '2' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({
      name: 'region-graph', writeMode: 'replace', onConflict: 'fail', previewRows: 2,
      graph: { sourceColumn: 'region', targetColumn: 'amount', edgeLabelColumn: 'amount' },
    });
  });

  it('グラフ出力を相関ネットワークへ切り替えると係数系の対応列に差し替わる', async () => {
    withUpstreamColumns();
    const id = addNode('graph-output');
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.selectOptions(within(dialog).getByLabelText('Mapping mode'), 'correlation-network');
    expect(within(dialog).queryByLabelText('Source column')).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('First variable column'), 'region');
    await userEvent.selectOptions(within(dialog).getByLabelText('Second variable column'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Coefficient column'), 'amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Pair count column'), 'amount');
    fireEvent.change(within(dialog).getByLabelText('Minimum absolute coefficient'), { target: { value: '0.5' } });
    fireEvent.change(within(dialog).getByLabelText('Minimum pair count'), { target: { value: '10' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)['graph']).toEqual({
      mode: 'correlation-network', columnX: 'region', columnY: 'amount', coefficient: 'amount',
      pairCount: 'amount', minimumAbsoluteCoefficient: 0.5, minimumPairCount: 10,
    });
  });
});

describe('NodeInspector: Web検索入力', () => {
  const providers: readonly SearchProviderDto[] = [
    { id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true },
    { id: 'tinyfish', label: 'TinyFish', supportsDomainFilter: false },
  ];

  it('明示取得したキャッシュ結果をconfigへ書き戻す', async () => {
    const fetchWebSearch = vi.fn().mockResolvedValue({
      cacheKey: 'cache-1', provider: 'tavily', query: 'LLMOps', maxResults: 3,
      includeDomains: ['example.com'], rows: [],
      retrievedAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-07-20T00:15:00.000Z',
    });
    const client = fakeClient({ listSearchProviders: vi.fn().mockResolvedValue(providers), fetchWebSearch });
    const id = addNode('web-search-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    await within(dialog).findByRole('option', { name: 'Tavily Search' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Search provider'), 'tavily');
    fireEvent.change(within(dialog).getByLabelText('Search query'), { target: { value: 'LLMOps' } });
    fireEvent.change(within(dialog).getByLabelText('Maximum results'), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByLabelText('Limit to domains'), { target: { value: 'example.com' } });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Fetch results' }));
    await waitFor(() => expect(fetchWebSearch).toHaveBeenCalledWith({
      scope, provider: 'tavily', query: 'LLMOps', maxResults: 3, includeDomains: ['example.com'],
    }));
    expect(await within(dialog).findByText('Cached at 2026-07-20T00:00:00.000Z')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toMatchObject({
      cacheKey: 'cache-1', provider: 'tavily', query: 'LLMOps', maxResults: 3,
      includeDomains: ['example.com'], retrievedAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-07-20T00:15:00.000Z',
    });
  });

  it('domain絞り込み非対応providerでは絞り込み欄を出さず、未入力なら取得もしない', async () => {
    const fetchWebSearch = vi.fn();
    const client = fakeClient({ listSearchProviders: vi.fn().mockResolvedValue(providers), fetchWebSearch });
    addNode('web-search-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    await within(dialog).findByRole('option', { name: 'TinyFish' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Search provider'), 'tinyfish');
    expect(within(dialog).queryByLabelText('Limit to domains')).toBeNull();
    // 検索語が空のうちは取得ボタンを押せない。
    expect((within(dialog).getByRole('button', { name: 'Fetch results' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchWebSearch).not.toHaveBeenCalled();
  });

  it('取得失敗はダイアログ内のメッセージにする', async () => {
    const client = fakeClient({
      listSearchProviders: vi.fn().mockResolvedValue(providers),
      fetchWebSearch: vi.fn().mockRejectedValue(new Error('search provider is not configured')),
    });
    addNode('web-search-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    await within(dialog).findByRole('option', { name: 'Tavily Search' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Search provider'), 'tavily');
    fireEvent.change(within(dialog).getByLabelText('Search query'), { target: { value: 'LLMOps' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Fetch results' }));

    expect(await within(dialog).findByText('search provider is not configured')).toBeTruthy();
  });
});

describe('NodeInspector: 登録済みデータソースの選択', () => {
  const sources: readonly DataSourceDto[] = [
    { id: 'file-json', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 12, name: 'Rows JSON', tenant: scope, createdAt: 'now', updatedAt: 'now' },
    { id: 'file-csv', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 12, name: 'Sales CSV', tenant: scope, createdAt: 'now', updatedAt: 'now' },
    { id: 'db-sales', kind: 'database', connectionId: 'sales', driver: 'postgresql', name: 'Sales DB', tenant: scope, createdAt: 'now', updatedAt: 'now' },
  ];

  it('JSON入力は同形式の登録ソースだけを候補にし、選ぶとインライン編集を隠す', async () => {
    const client = fakeClient({ listDataSources: vi.fn().mockResolvedValue(sources) });
    const id = addNode('json-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    const picker = await within(dialog).findByLabelText('Registered data source');
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Inline editor', 'Rows JSON']);

    await userEvent.selectOptions(picker, 'file-json');
    expect(within(dialog).queryByLabelText('JSON rows')).toBeNull();
    expect(within(dialog).getByText(/never copied into the Tool definition/)).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)['dataSourceId']).toBe('file-json');
  });

  it('CSV入力はインライン編集へ戻すとCSV欄を出す', async () => {
    const client = fakeClient({ listDataSources: vi.fn().mockResolvedValue(sources) });
    const id = addNode('csv-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    const picker = await within(dialog).findByLabelText('Registered data source');
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Inline editor', 'Sales CSV']);
    await userEvent.selectOptions(picker, 'file-csv');
    await userEvent.selectOptions(picker, '');

    fireEvent.change(within(dialog).getByLabelText('Delimiter'), { target: { value: ';' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toMatchObject({ dataSourceId: undefined, delimiter: ';' });
  });

  it('データベース入力はtable・最大行数を編集し、DB種別の登録ソースだけを候補にする', async () => {
    const client = fakeClient({ listDataSources: vi.fn().mockResolvedValue(sources) });
    const id = addNode('database-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    const picker = await within(dialog).findByLabelText('Registered data source');
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Inline editor', 'Sales DB']);
    await userEvent.selectOptions(picker, 'db-sales');
    fireEvent.change(within(dialog).getByLabelText('Allowed table or view'), { target: { value: 'reporting.sales_daily' } });
    fireEvent.change(within(dialog).getByLabelText('Maximum rows'), { target: { value: '50' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)).toMatchObject({ dataSourceId: 'db-sales', table: 'reporting.sales_daily', limit: 50 });
  });

  it('データソース取得に失敗しても候補を空にして編集を続けられる', async () => {
    const client = fakeClient({
      listDataSources: vi.fn().mockRejectedValue(new Error('offline')),
      listSearchProviders: vi.fn().mockRejectedValue(new Error('offline')),
      analysisAssistantCapability: vi.fn().mockRejectedValue(new Error('offline')),
    });
    addNode('json-source');
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    await waitFor(() => expect(client.listDataSources).toHaveBeenCalledWith(scope));
    const picker = within(dialog).getByLabelText('Registered data source');
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Inline editor']);
    expect(within(dialog).getByLabelText('JSON rows')).toBeTruthy();
  });
});

describe('NodeInspector: インライン編集の残りの分岐', () => {
  it('列選択・重複排除は上流列の複数選択をそのままconfigへ書く', async () => {
    withUpstreamColumns();
    const selectId = addNode('select');
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Choose columns'), 'region');
    expect(configOf(selectId)['columns']).toEqual(['region']);
    cleanup();

    // 同じ上流（filter-1）へ重複排除ノードを足す。
    useToolBuilderStore.getState().selectNode('filter-1');
    const distinctId = addNode('distinct');
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Choose distinct columns'), 'amount');
    expect(configOf(distinctId)['columns']).toEqual(['amount']);
  });

  it('エージェント入力の不正なスキーマ・サンプルはインラインエラーにして書き戻さない', async () => {
    const id = addNode('agent-input');
    const before = configOf(id);
    render(<NodeInspector />);

    fireEvent.change(screen.getByLabelText('Input columns'), { target: { value: 'score:bogus:required' } });
    expect(screen.getByText('未対応の型です: bogus')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sample arguments'), { target: { value: '[1, 2]' } });
    expect(screen.getByText('JSON objectを入力してください')).toBeTruthy();
    expect(configOf(id)).toEqual(before);
  });

  it('CSV入力のヘッダー行・型推論のチェックを外すとconfigへ反映する', async () => {
    const id = addNode('csv-source');
    render(<NodeInspector />);

    await userEvent.click(screen.getByLabelText('Header row'));
    expect(configOf(id)['header']).toBe(false);
    await userEvent.click(screen.getByLabelText('Infer types'));
    expect(configOf(id)['inferTypes']).toBe(false);
  });
});
