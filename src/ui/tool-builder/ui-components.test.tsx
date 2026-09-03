// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { PreviewResultDto, PropagationResultDto, SerializedToolDto, ToolDiagnosticsDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { MetadataBar } from './MetadataBar';
import { NodeInspector } from './NodeInspector';
import { PreviewPanel } from './PreviewPanel';
import { buildSaveDto, useToolBuilderStore } from './store';
import { AgentChatPanel } from './AgentChatPanel';
import { NodePalette } from './NodePalette';
import { scope } from '../scope';

const propagation: PropagationResultDto = {
  order: ['source-1', 'filter-1'],
  terminalId: 'filter-1',
  hasErrors: false,
  nodes: {
    'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
    'filter-1': { nodeId: 'filter-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
  },
};
const preview: PreviewResultDto = {
  terminalId: 'filter-1',
  output: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] },
  nodes: {
    'filter-1': { nodeId: 'filter-1', truncated: false, table: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] } },
  },
};

beforeEach(() => useToolBuilderStore.getState().reset());
afterEach(cleanup);

describe('NodeInspector', () => {
  it('propagation更新後の上流列候補を購読しfilter configを編集する', async () => {
    render(<NodeInspector />);
    useToolBuilderStore.getState().setPropagation(propagation);
    expect(await screen.findByText('age: number')).toBeTruthy();
    const input = screen.getByLabelText('Column');
    await userEvent.clear(input);
    await userEvent.type(input, 'score');
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === 'filter-1')?.data.config['column']).toBe('score');
  });

  it('Agent inputのschemaとsampleを編集する', async () => {
    useToolBuilderStore.getState().addNode('agent-input');
    render(<NodeInspector />);
    fireEvent.change(screen.getByLabelText('Input columns'), { target: { value: 'name:string:required\nscore:number:optional' } });
    fireEvent.change(screen.getByLabelText('Sample arguments'), { target: { value: '{"name":"Alice","score":42}' } });
    const selected = useToolBuilderStore.getState().nodes.find((node) => node.id === useToolBuilderStore.getState().selectedNodeId);
    expect(selected?.data.config).toMatchObject({
      schema: { columns: [{ name: 'name', type: 'string', nullable: false }, { name: 'score', type: 'number', nullable: true }] },
      sample: { name: 'Alice', score: 42 },
    });
  });

  it('JSON sourceの不正JSONをinline表示する', async () => {
    useToolBuilderStore.getState().selectNode('source-1');
    render(<NodeInspector />);
    const input = screen.getByLabelText('JSON rows');
    fireEvent.change(input, { target: { value: '{bad' } });
    expect(document.querySelector('.field-error')?.textContent).toBeTruthy();
  });

  it('CSV sourceのtext/optionsをフォームから更新する', async () => {
    useToolBuilderStore.getState().addNode('csv-source');
    render(<NodeInspector />);
    await userEvent.clear(screen.getByLabelText('CSV text'));
    await userEvent.type(screen.getByLabelText('CSV text'), 'id\n3');
    await userEvent.click(screen.getByLabelText('Header row'));
    const selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toMatchObject({ text: 'id\n3', header: false });
  });

  it('select/rename/cast設定をテキストフォームから構造化する', () => {
    useToolBuilderStore.getState().addNode('select');
    const { rerender } = render(<NodeInspector />);
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: 'id, name' } });
    let selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({ columns: ['id', 'name'] });

    useToolBuilderStore.getState().addNode('rename');
    rerender(<NodeInspector />);
    fireEvent.change(screen.getByLabelText(/Renames/), { target: { value: 'name:full_name' } });
    selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({ renames: [{ from: 'name', to: 'full_name' }] });

    useToolBuilderStore.getState().addNode('cast');
    rerender(<NodeInspector />);
    fireEvent.change(screen.getByLabelText(/Casts/), { target: { value: 'age:number' } });
    selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({ casts: [{ column: 'age', to: 'number' }] });
  });

  it('joinのmode/キーペア/サフィックスを編集し左右の上流列を提示する', async () => {
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'joined', workingName: 'w', displayName: 'Joined', publishName: 'joined', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'left-1', type: 'json-source', config: { rows: [{ id: 1, name: 'Alice' }] } },
          { id: 'right-1', type: 'json-source', config: { rows: [{ id: 1, score: 90 }] } },
          { id: 'join-1', type: 'join', config: { mode: 'inner', keys: [], rightSuffix: '_right' } },
        ],
        edges: [{ from: 'left-1', to: 'join-1', toInput: 0 }, { from: 'right-1', to: 'join-1', toInput: 1 }],
      },
    } as SerializedToolDto);
    useToolBuilderStore.getState().setPropagation({
      order: ['left-1', 'right-1', 'join-1'], terminalId: 'join-1', hasErrors: false,
      nodes: {
        'left-1': { nodeId: 'left-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'name', type: 'string', nullable: false }] } },
        'right-1': { nodeId: 'right-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'score', type: 'number', nullable: false }] } },
        'join-1': { nodeId: 'join-1', state: 'confirmed', issues: [], schema: { columns: [] } },
      },
    });
    useToolBuilderStore.getState().selectNode('join-1');
    render(<NodeInspector />);

    // 左右それぞれの上流スキーマが列候補として提示される。
    expect(screen.getByText('Left input columns')).toBeTruthy();
    expect(screen.getByText('Right input columns')).toBeTruthy();
    expect(screen.getByText('score: number')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Join mode'), 'left');
    await userEvent.click(screen.getByRole('button', { name: 'Add key' }));
    await userEvent.type(screen.getByLabelText('Left key'), 'id');
    await userEvent.type(screen.getByLabelText('Right key'), 'id');
    await userEvent.clear(screen.getByLabelText('Right suffix'));
    await userEvent.type(screen.getByLabelText('Right suffix'), '_r');
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === 'join-1')?.data.config).toEqual({
      mode: 'left', keys: [{ left: 'id', right: 'id' }], rightSuffix: '_r',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === 'join-1')?.data.config).toMatchObject({ keys: [] });
  });

  it('fill-nullのルールを追加・編集し、drop-rowでvalueを外す', async () => {
    useToolBuilderStore.getState().addNode('fill-null');
    useToolBuilderStore.getState().setPropagation(propagation);
    render(<NodeInspector />);
    const nodeId = useToolBuilderStore.getState().selectedNodeId;

    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await userEvent.type(screen.getByLabelText('Rule column'), 'age');
    await userEvent.clear(screen.getByLabelText('Fill value'));
    await userEvent.type(screen.getByLabelText('Fill value'), '42');
    // 上流列型がnumberなのでvalueは数値化される。
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)?.data.config).toEqual({
      rules: [{ column: 'age', strategy: 'constant', value: 42 }],
    });

    await userEvent.selectOptions(screen.getByLabelText('Strategy'), 'drop-row');
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)?.data.config).toEqual({
      rules: [{ column: 'age', strategy: 'drop-row' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove rule' }));
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)?.data.config).toEqual({ rules: [] });
  });

  it('union/sort/distinct/replace設定をフォームから構造化する', async () => {
    useToolBuilderStore.getState().addNode('union');
    const { rerender } = render(<NodeInspector />);
    await userEvent.click(screen.getByLabelText(/Strict column match/));
    let selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({ strict: true });

    useToolBuilderStore.getState().addNode('sort');
    rerender(<NodeInspector />);
    fireEvent.change(screen.getByLabelText(/Sort keys/), { target: { value: 'age:desc:first\nname' } });
    selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({
      keys: [{ column: 'age', direction: 'desc', nulls: 'first' }, { column: 'name' }],
    });

    useToolBuilderStore.getState().addNode('distinct');
    rerender(<NodeInspector />);
    fireEvent.change(screen.getByLabelText(/Distinct columns/), { target: { value: 'id, name' } });
    selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({ columns: ['id', 'name'] });

    useToolBuilderStore.getState().addNode('replace');
    rerender(<NodeInspector />);
    fireEvent.change(screen.getByLabelText(/Replacements/), { target: { value: 'name:N/A:null' } });
    selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toEqual({
      rules: [{ column: 'name', from: 'N/A', to: null }],
    });
  });

  it('出力ノードの設定ダイアログで直接返却と専用グラフ出力を編集する', async () => {
    const { rerender } = render(<NodeInspector />);
    useToolBuilderStore.getState().addNode('agent-output');
    rerender(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    let dialog = within(screen.getByRole('dialog', { name: 'Node configuration' }));
    await userEvent.selectOptions(dialog.getByLabelText('Result shape'), 'single-value');
    expect(dialog.getByLabelText('Value column')).toBeTruthy();
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    useToolBuilderStore.getState().addNode('graph-output');
    rerender(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    dialog = within(screen.getByRole('dialog', { name: 'Node configuration' }));
    expect(dialog.getByText('Property graph mapping')).toBeTruthy();
    await userEvent.click(dialog.getByRole('button', { name: 'Apply settings' }));
    const selected = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === selected)?.data.config).toMatchObject({ graph: { sourceColumn: '', targetColumn: '' } });
  });
});

describe('NodePalette', () => {
  it('未設定providerではWeb検索を表示せず、設定済みproviderがあると表示する', async () => {
    const none = { listSearchProviders: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
    const { rerender } = render(<NodePalette client={none} />);
    await waitFor(() => expect(none.listSearchProviders).toHaveBeenCalled());
    expect(screen.queryByText('Web search')).toBeNull();
    const configured = { listSearchProviders: vi.fn().mockResolvedValue([{ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true }]) } as unknown as ToolApiClient;
    rerender(<NodePalette client={configured} />);
    expect(await screen.findByText('Web search')).toBeTruthy();
  });
});

describe('PreviewPanel', () => {
  it('選択nodeのschemaとsample rowsを表示する', () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    useToolBuilderStore.getState().setPreview(preview);
    render(<PreviewPanel />);
    expect(screen.getByRole('columnheader', { name: 'age' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '30' })).toBeTruthy();
  });

  it('自動検証のAPI errorとschema issueを表示する', () => {
    useToolBuilderStore.getState().setDraftIssue('server offline');
    useToolBuilderStore.getState().setPropagation({
      ...propagation,
      hasErrors: true,
      nodes: { ...propagation.nodes, 'filter-1': { ...propagation.nodes['filter-1']!, issues: [{ severity: 'error', message: 'missing age' }] } },
    });
    render(<PreviewPanel />);
    expect(screen.getByRole('alert').textContent).toContain('server offline');
    expect(screen.getByText('missing age')).toBeTruthy();
  });

  it('保存失敗はプレビュー領域に表示しない', () => {
    useToolBuilderStore.getState().setSaveError('SaveTool: invalid metadata');
    render(<PreviewPanel />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('日本語UIではnode issueの英語定型文を日本語化して表示する', () => {
    useToolBuilderStore.getState().setPropagation({
      ...propagation,
      hasErrors: true,
      nodes: {
        ...propagation.nodes,
        'filter-1': {
          ...propagation.nodes['filter-1']!,
          issues: [
            { severity: 'error', message: "chart-output: mapping 'timeColumn' is required" },
            { severity: 'error', message: "join: key type mismatch: id ('string') vs id ('number')" },
          ],
        },
      },
    });
    render(<I18nProvider initialLanguage="ja"><PreviewPanel /></I18nProvider>);
    expect(screen.getByText("chart-output: 「timeColumn」の設定が必要です")).toBeTruthy();
    expect(screen.getByText('結合キーの型が一致しません: id (文字列) と id (数値)')).toBeTruthy();
    expect(screen.queryByText("chart-output: mapping 'timeColumn' is required")).toBeNull();
  });

  it('英語UIではnode issueを原文のまま表示する（詳細を握りつぶさない）', () => {
    useToolBuilderStore.getState().setPropagation({
      ...propagation,
      hasErrors: true,
      nodes: { ...propagation.nodes, 'filter-1': { ...propagation.nodes['filter-1']!, issues: [{ severity: 'error', message: "chart-output: mapping 'timeColumn' is required" }] } },
    });
    render(<PreviewPanel />);
    expect(screen.getByText("chart-output: mapping 'timeColumn' is required")).toBeTruthy();
  });
});

function fillRequiredMetadata(): void {
  const { setMetadata } = useToolBuilderStore.getState();
  setMetadata('internalId', 'customer-filter');
  setMetadata('workingName', 'Customer filter draft');
  setMetadata('displayName', 'Customer filter');
  setMetadata('publishName', 'adult_customers');
  setMetadata('owner', 'owner@example.com');
}

describe('MetadataBar', () => {
  it('updates editable metadata, including the session-write side-effect selector', () => {
    render(<MetadataBar client={{} as ToolApiClient} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Workspace output' } });
    fireEvent.change(screen.getByLabelText('Internal ID'), { target: { value: 'workspace-output' } });
    fireEvent.change(screen.getByLabelText('Working name'), { target: { value: 'workspace-output-draft' } });
    fireEvent.change(screen.getByLabelText('Publish name'), { target: { value: 'workspace_output' } });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Side effect'), { target: { value: 'session-write' } });
    expect(useToolBuilderStore.getState().metadata).toMatchObject({
      displayName: 'Workspace output', internalId: 'workspace-output', workingName: 'workspace-output-draft',
      publishName: 'workspace_output', owner: 'owner@example.com', sideEffect: 'session-write',
    });
  });

  /**
   * テナント/ワークスペースは**入力欄として出さない**。
   * 以前は自由入力で、書き換えて保存したToolは他画面から永久に見えなくなった。
   * いま保存先を決めるのはサーバー側のPrincipalなので、ここは現在地の表示だけにする。
   */
  it('テナント・ワークスペースは編集できず、現在のスコープを表示するだけ', () => {
    render(<MetadataBar client={{} as ToolApiClient} />);
    expect(screen.queryByLabelText('Tenant')).toBeNull();
    expect(screen.queryByLabelText('Workspace')).toBeNull();
    expect(screen.getByText(scope.tenantId)).toBeTruthy();
    expect(screen.getByText(scope.workspaceId)).toBeTruthy();
  });

  it('明示Saveだけが保存APIを呼びversion履歴を更新する', async () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    fillRequiredMetadata();
    const metadata = useToolBuilderStore.getState().metadata;
    const tool = {
      metadata: { ...metadata, tenant: scope, version: '1.0.0', state: 'draft' },
      sideEffect: metadata.sideEffect,
      graph: { nodes: [], edges: [] },
    } as unknown as SerializedToolDto;
    const client = {
      saveTool: vi.fn().mockResolvedValue(tool),
      listVersions: vi.fn().mockResolvedValue(['1.0.0']),
    } as unknown as ToolApiClient;
    render(<MetadataBar client={client} />);
    expect(client.saveTool).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveTool).toHaveBeenCalledOnce());
    expect(useToolBuilderStore.getState()).toMatchObject({ currentVersion: '1.0.0', versions: ['1.0.0'] });
  });

  it('agent-inputとterminal propagationからInput/Output Schemaを保存する', async () => {
    fillRequiredMetadata();
    const metadata = useToolBuilderStore.getState().metadata;
    const input = { columns: [{ name: 'query', type: 'string' as const, nullable: false }] };
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: metadata.internalId, workingName: metadata.workingName, displayName: metadata.displayName, publishName: metadata.publishName, owner: metadata.owner, version: '1.0.0', state: 'draft', tenant: scope },
      sideEffect: 'read-only', graph: { nodes: [{ id: 'args', type: 'agent-input', config: { schema: input, sample: { query: 'x' } } }], edges: [] },
    });
    useToolBuilderStore.getState().setPropagation({ order: ['args'], terminalId: 'args', hasErrors: false, nodes: { args: { nodeId: 'args', state: 'confirmed', issues: [], schema: input } } });
    const saved = { metadata: { ...metadata, version: '1.0.1', state: 'draft', tenant: scope }, sideEffect: 'read-only', graph: { nodes: [], edges: [] } } as unknown as SerializedToolDto;
    const client = { saveTool: vi.fn().mockResolvedValue(saved), listVersions: vi.fn().mockResolvedValue(['1.0.0', '1.0.1']) } as unknown as ToolApiClient;
    render(<MetadataBar client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveTool).toHaveBeenCalled());
    expect(client.saveTool).toHaveBeenCalledWith(expect.objectContaining({ inputSchema: input, outputSchema: input }));
  });

  it('履歴versionを選ぶとGET結果をcanvasへ復元する', async () => {
    useToolBuilderStore.getState().setVersions(['1.0.0']);
    const metadata = useToolBuilderStore.getState().metadata;
    const tool = {
      metadata: { internalId: 'loaded', workingName: 'w', displayName: 'Loaded', publishName: 'loaded', owner: 'o', version: '1.0.0', state: 'draft', tenant: scope },
      sideEffect: 'read-only', graph: { nodes: [{ id: 'loaded-source', type: 'json-source', config: { rows: [] } }], edges: [] },
    } as SerializedToolDto;
    const client = { getTool: vi.fn().mockResolvedValue(tool) } as unknown as ToolApiClient;
    render(<MetadataBar client={client} />);
    await userEvent.selectOptions(screen.getByLabelText('Version history'), '1.0.0');
    await waitFor(() => expect(useToolBuilderStore.getState().metadata.internalId).toBe('loaded'));
  });

  it('Versionsボタンで履歴を明示refreshする', async () => {
    const client = { listVersions: vi.fn().mockResolvedValue(['1.0.0', '1.0.1']) } as unknown as ToolApiClient;
    render(<MetadataBar client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Versions' }));
    await waitFor(() => expect(useToolBuilderStore.getState().versions).toEqual(['1.0.0', '1.0.1']));
  });

  it('必須項目に印を付け、未入力なら保存を無効化して理由を近傍に示す', () => {
    // 検証結果は届いている状態にして、必須項目だけが保存を止めているのを見る。
    useToolBuilderStore.getState().setPropagation(propagation);
    render(<MetadataBar client={{} as ToolApiClient} />);
    expect(document.querySelectorAll('.required-mark')).toHaveLength(5);
    const save = () => screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Internal ID, Working name, Display name, Publish name, Owner required to save.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Internal ID'), { target: { value: 'customer-filter' } });
    fireEvent.change(screen.getByLabelText('Working name'), { target: { value: 'draft' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Customer filter' } });
    fireEvent.change(screen.getByLabelText('Publish name'), { target: { value: 'adult_customers' } });
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Owner required to save.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'owner@example.com' } });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(/required to save/)).toBeNull();
  });

  it('保存失敗を保存ボタン近傍に出し、状態バッジを草案検証のままにして再保存できる', async () => {
    fillRequiredMetadata();
    useToolBuilderStore.getState().setPropagation(propagation);
    const client = {
      saveTool: vi.fn().mockRejectedValue(new Error('SaveTool: graph validation failed')),
      listVersions: vi.fn().mockResolvedValue([]),
    } as unknown as ToolApiClient;
    render(<><MetadataBar client={client} /><PreviewPanel /></>);
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(document.querySelector('.metadata-bar .api-error')?.textContent).toBe('SaveTool: graph validation failed');
    expect(document.querySelector('.preview-panel .api-error')).toBeNull();
    // 保存失敗はメタデータ起因なので、草案バッジを「問題あり」にしない。
    expect(document.querySelector('.validation-status')?.className).toContain('good');
    // 行き止まりにしない: 失敗直後も保存ボタンは押せる。
    expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(client.saveTool).toHaveBeenCalledTimes(2));
  });

  it('保存成功をバージョン付きで保存ボタン近傍に知らせる', async () => {
    fillRequiredMetadata();
    useToolBuilderStore.getState().setPropagation(propagation);
    const metadata = useToolBuilderStore.getState().metadata;
    const tool = {
      metadata: { ...metadata, tenant: scope, version: '1.0.1', state: 'draft' },
      sideEffect: metadata.sideEffect, graph: { nodes: [], edges: [] },
    } as unknown as SerializedToolDto;
    const client = { saveTool: vi.fn().mockResolvedValue(tool), listVersions: vi.fn().mockResolvedValue(['1.0.0', '1.0.1']) } as unknown as ToolApiClient;
    render(<MetadataBar client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved version 1.0.1');
  });

  it('function 名として無効な publishName では保存を止め、エージェント向け名の設定を促す', () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    fillRequiredMetadata();
    // agentTool が無いときはサーバーが publishName を function 名として公開する。空白を含む名前は呼び出せない。
    useToolBuilderStore.getState().setMetadata('publishName', 'customer search');
    render(<MetadataBar client={{} as ToolApiClient} />);
    const save = () => screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/"customer search" is not a valid function name for models\. Set an agent-facing name/)).toBeTruthy();

    // 名前 + 説明の両方が入ると agentTool.name がモデルに見える名前になるので保存できる。
    act(() => useToolBuilderStore.getState().setMetadata('agentName', 'search_customers'));
    expect(save().disabled).toBe(true);
    act(() => useToolBuilderStore.getState().setMetadata('agentDescription', 'Search customers by age.'));
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(/is not a valid function name/)).toBeNull();
  });

  it('複数の Agent Input が違う引数を宣言していると保存を止める', () => {
    fillRequiredMetadata();
    useToolBuilderStore.getState().addNode('agent-input');
    useToolBuilderStore.getState().addNode('agent-input');
    const [first, second] = useToolBuilderStore.getState().nodes.filter((node) => node.data.nodeType === 'agent-input');
    useToolBuilderStore.getState().updateNodeConfig(second!.id, { schema: { columns: [{ name: 'other', type: 'number', nullable: false }] }, sample: { other: 1 } });
    useToolBuilderStore.getState().setPropagation(propagation);
    render(<MetadataBar client={{} as ToolApiClient} />);
    const save = () => screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Multiple Agent Input nodes declare different arguments. Keep a single Agent Input node.')).toBeTruthy();

    // 同じスキーマなら衝突ではない（先頭の宣言を inputSchema として保存する）。
    act(() => { useToolBuilderStore.getState().updateNodeConfig(second!.id, first!.data.config); useToolBuilderStore.getState().setPropagation(propagation); });
    expect(save().disabled).toBe(false);
  });

  it('グラフ検証の完了を待つ間と、検証エラーの間は保存を止める', () => {
    fillRequiredMetadata();
    render(<MetadataBar client={{} as ToolApiClient} />);
    const save = () => screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement;
    // 検証結果がまだ無い: 待つ。
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Waiting for graph validation…')).toBeTruthy();

    act(() => useToolBuilderStore.getState().setPropagation({ ...propagation, hasErrors: true }));
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Fix the graph errors before saving so the tool keeps its output contract.')).toBeTruthy();

    // 設定未完了（自動検証がサーバーへ送る前に止めた）も出力スキーマを確定できないので同じ扱い。
    act(() => { useToolBuilderStore.getState().setPropagation(undefined); useToolBuilderStore.getState().setDraftIssue('Configuration is incomplete: graph-output-1'); });
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Fix the graph errors before saving so the tool keeps its output contract.')).toBeTruthy();

    act(() => { useToolBuilderStore.getState().setDraftIssue(undefined); useToolBuilderStore.getState().setPropagation(propagation); });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(/Waiting for graph validation|Fix the graph errors/)).toBeNull();

    // グラフを編集すると、次の検証結果が届くまで再び待つ（デバウンス中の古い結果で保存しない）。
    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gt', value: 1 }));
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Waiting for graph validation…')).toBeTruthy();
  });

  it('呼び出し診断は保存と同じ DTO を diagnoseToolDraft へ送り、検証待ちでも押せる', async () => {
    fillRequiredMetadata();
    const metadata = useToolBuilderStore.getState().metadata;
    const result = { internalId: metadata.internalId, version: 'draft', source: 'direct', functionName: metadata.publishName, status: 'ok', checks: [{ id: 'function-definition', status: 'ok' }] };
    const tool = { metadata: { ...metadata, tenant: scope, version: '1.0.0', state: 'draft' }, sideEffect: metadata.sideEffect, graph: { nodes: [], edges: [] } } as unknown as SerializedToolDto;
    const diagnoseToolDraft = vi.fn().mockResolvedValue(result);
    const saveTool = vi.fn().mockResolvedValue(tool);
    const client = { diagnoseToolDraft, saveTool, listVersions: vi.fn().mockResolvedValue(['1.0.0']) } as unknown as ToolApiClient;
    render(<MetadataBar client={client} />);

    // 検証待ちでは Save は無効だが、診断は「どこで落ちるか」を知るためのものなので押せる。
    expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
    await waitFor(() => expect(diagnoseToolDraft).toHaveBeenCalledOnce());
    expect(useToolBuilderStore.getState().diagnostics).toEqual(result);

    act(() => useToolBuilderStore.getState().setPropagation(propagation));
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(saveTool).toHaveBeenCalledOnce());
    // 診断時点では outputSchema が未確定だっただけで、それ以外は保存と同じ内容を送っている。
    const diagnosed = diagnoseToolDraft.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(diagnosed).not.toHaveProperty('outputSchema');
    expect(saveTool.mock.calls[0]?.[0]).toEqual({ ...diagnosed, outputSchema: propagation.nodes['filter-1']!.schema });
  });

  it('呼び出し診断は必須メタデータが揃うまで押せず、失敗は理由つきで store に残す', async () => {
    const diagnoseToolDraft = vi.fn().mockRejectedValue(new Error('server unreachable'));
    render(<MetadataBar client={{ diagnoseToolDraft } as unknown as ToolApiClient} />);
    const check = () => screen.getByRole('button', { name: 'Check readiness' }) as HTMLButtonElement;
    expect(check().disabled).toBe(true);
    act(() => fillRequiredMetadata());
    expect(check().disabled).toBe(false);
    await userEvent.click(check());
    await waitFor(() => expect(useToolBuilderStore.getState().diagnostics).toEqual({ failed: 'server unreachable' }));
    // Error 以外の reject は既定文言。
    (diagnoseToolDraft as ReturnType<typeof vi.fn>).mockRejectedValueOnce('offline');
    await userEvent.click(check());
    await waitFor(() => expect(useToolBuilderStore.getState().diagnostics).toEqual({ failed: 'Request failed' }));
  });

  describe('呼び出し診断の境界', () => {
    const okResult: ToolDiagnosticsDto = { internalId: 'customer-filter', version: 'draft', source: 'direct', functionName: 'adult_customers', status: 'ok', checks: [{ id: 'function-definition', status: 'ok' }] };
    const check = () => screen.getByRole('button', { name: /Check readiness|Diagnosing…/ }) as HTMLButtonElement;
    type Deferred = { readonly resolve: (value: ToolDiagnosticsDto) => void; readonly reject: (cause: unknown) => void; readonly signal: AbortSignal | undefined };
    function deferredClient(): { readonly client: ToolApiClient; readonly pending: Deferred[] } {
      const pending: Deferred[] = [];
      const diagnoseToolDraft = vi.fn((_dto: unknown, signal?: AbortSignal) => new Promise<ToolDiagnosticsDto>((resolve, reject) => { pending.push({ resolve, reject, signal }); }));
      return { client: { diagnoseToolDraft } as unknown as ToolApiClient, pending };
    }

    it('要求中は押せず、グラフエラーがあっても押せて、送るのは buildSaveDto() そのもの', async () => {
      fillRequiredMetadata();
      useToolBuilderStore.getState().setPropagation({ ...propagation, hasErrors: true });
      const { client, pending } = deferredClient();
      render(<MetadataBar client={client} />);
      expect((screen.getByRole('button', { name: 'Save version' }) as HTMLButtonElement).disabled).toBe(true);
      expect(check().disabled).toBe(false);

      await userEvent.click(check());
      expect(client.diagnoseToolDraft).toHaveBeenCalledWith(buildSaveDto(), expect.any(AbortSignal));
      expect(check().disabled).toBe(true);
      expect(check().textContent).toBe('Diagnosing…');
      expect(useToolBuilderStore.getState().diagnostics).toBe('loading');

      await act(async () => { pending[0]?.resolve(okResult); });
      expect(check().disabled).toBe(false);
      expect(check().textContent).toBe('Check readiness');
      expect(useToolBuilderStore.getState().diagnostics).toEqual(okResult);
    });

    it('要求中にリセット・読み込みで診断が消えたら、遅れて届いた結果も失敗も捨てる', async () => {
      fillRequiredMetadata();
      const { client, pending } = deferredClient();
      render(<MetadataBar client={client} />);
      await userEvent.click(check());
      act(() => useToolBuilderStore.getState().reset());
      expect(useToolBuilderStore.getState().diagnostics).toBeUndefined();
      await act(async () => { pending[0]?.resolve(okResult); });
      expect(useToolBuilderStore.getState().diagnostics).toBeUndefined();

      act(() => fillRequiredMetadata());
      await userEvent.click(check());
      act(() => useToolBuilderStore.getState().loadTool({
        metadata: { internalId: 'other', workingName: 'w', displayName: 'Other', publishName: 'other', owner: 'o', version: '1.0.0', state: 'draft', tenant: scope },
        sideEffect: 'read-only', graph: { nodes: [], edges: [] },
      } as SerializedToolDto));
      await act(async () => { pending[1]?.reject(new Error('late failure')); });
      expect(useToolBuilderStore.getState().diagnostics).toBeUndefined();
    });

    it('リセット後に再要求したとき、前の要求を中断し、前の結果が先に届いても新しい結果を採る（取り違えない）', async () => {
      fillRequiredMetadata();
      const { client, pending } = deferredClient();
      render(<MetadataBar client={client} />);
      await userEvent.click(check());
      act(() => { useToolBuilderStore.getState().reset(); fillRequiredMetadata(); });
      await userEvent.click(check());
      expect(pending).toHaveLength(2);
      expect(pending[0]?.signal?.aborted).toBe(true);
      expect(pending[1]?.signal?.aborted).toBe(false);

      // 前の要求の結果（error）が後から届いても store は 'loading' のまま。
      const stale: ToolDiagnosticsDto = { ...okResult, internalId: 'stale', status: 'error', checks: [{ id: 'graph', status: 'error', detail: 'graph has a cycle' }] };
      await act(async () => { pending[0]?.resolve(stale); });
      expect(useToolBuilderStore.getState().diagnostics).toBe('loading');
      await act(async () => { pending[1]?.resolve(okResult); });
      expect(useToolBuilderStore.getState().diagnostics).toEqual(okResult);
    });

    it('中断された要求の AbortError は失敗として出さない', async () => {
      fillRequiredMetadata();
      const { client, pending } = deferredClient();
      const { unmount } = render(<MetadataBar client={client} />);
      await userEvent.click(check());
      unmount();
      expect(pending[0]?.signal?.aborted).toBe(true);
      await act(async () => { pending[0]?.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      expect(useToolBuilderStore.getState().diagnostics).toBe('loading');
    });
  });
});

describe('PreviewPanel の未接続ノード', () => {
  it('出力ノードへ至る流れに繋がっていないノードを名指しで示す', () => {
    // 選択中の filter-1 に対して source は自動接続されないため、終端（out-degree 0）が2つになる。
    useToolBuilderStore.getState().addNode('csv-source');
    const added = useToolBuilderStore.getState().nodes.at(-1)?.id ?? '';
    render(<PreviewPanel />);
    expect(screen.getByText(`Not connected: filter-1, ${added}. Connect every node into the flow that ends at the output node.`)).toBeTruthy();
    // 繋ぐと消える。
    act(() => useToolBuilderStore.getState().onConnect({ source: added, target: 'filter-1', sourceHandle: null, targetHandle: null }));
    expect(screen.queryByText(/Not connected:/)).toBeNull();
  });

  it('日本語UIでは未接続ノードの案内も日本語で出す', () => {
    useToolBuilderStore.getState().addNode('select');
    const select = useToolBuilderStore.getState().nodes.at(-1)?.id ?? '';
    useToolBuilderStore.getState().onEdgesChange([{ type: 'remove', id: `filter-1-${select}` }]);
    render(<I18nProvider initialLanguage="ja"><PreviewPanel /></I18nProvider>);
    expect(screen.getByText(`未接続のノード: filter-1、${select}。出力ノードへ至る流れにつなげてください`)).toBeTruthy();
  });
});

describe('AgentChatPanel', () => {
  it('保存前は実行を無効化し、保存versionでrunとtraceを表示する', async () => {
    const run = {
      runId: 'run-1', mode: 'preview', tool: { internalId: 'customer-filter', publishName: 'adult_customers', version: '1.0.0' }, response: 'Alice is included.', usage: {},
      trace: [
        { sequence: 1, kind: 'tool-call', name: 'adult_customers', arguments: { age: 30 } },
        { sequence: 2, kind: 'tool-result', name: 'adult_customers', terminalId: 'filter-1', nodes: [{ nodeId: 'filter-1', rowCount: 1, truncated: false }], outputPreview: [{}] },
      ],
    };
    const client = { runAgent: vi.fn().mockResolvedValue(run) } as unknown as ToolApiClient;
    useToolBuilderStore.getState().setMetadata('internalId', 'customer-filter');
    const { rerender } = render(<AgentChatPanel client={client} />);
    expect((screen.getByRole('button', { name: 'Run agent' }) as HTMLButtonElement).disabled).toBe(true);
    useToolBuilderStore.getState().setSavedVersion('1.0.0', ['1.0.0']);
    rerender(<AgentChatPanel client={client} />);
    await userEvent.type(screen.getByLabelText('Chat message'), 'Use the tool');
    await userEvent.click(screen.getByRole('button', { name: 'Run agent' }));
    await waitFor(() => expect(client.runAgent).toHaveBeenCalled());
    expect(await screen.findByText('Alice is included.')).toBeTruthy();
    expect(screen.getByText(/filter-1: 1 row/)).toBeTruthy();
    expect(client.runAgent).toHaveBeenCalledWith(expect.objectContaining({ tool: { internalId: 'customer-filter', version: '1.0.0' } }), expect.any(AbortSignal));
  });

  it('失敗runIdから永続traceを取得する', async () => {
    useToolBuilderStore.getState().setSavedVersion('1.0.0', ['1.0.0']);
    const failed = {
      runId: 'run-f', scope: { tenantId: 'local', workspaceId: 'default' }, status: 'failed', mode: 'preview', tool: { internalId: 'customer-filter', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', completedAt: '2026-07-03T00:00:01Z',
      trace: [{ sequence: 1, kind: 'error', code: 'MODEL_PROVIDER', message: 'offline' }], failure: { code: 'MODEL_PROVIDER', message: 'offline' },
    };
    const client = {
      runAgent: vi.fn().mockRejectedValue(new ApiError(502, 'MODEL_PROVIDER', 'offline', 'run-f')),
      getRunTrace: vi.fn().mockResolvedValue(failed),
    } as unknown as ToolApiClient;
    render(<AgentChatPanel client={client} />);
    await userEvent.type(screen.getByLabelText('Chat message'), 'Use the tool');
    await userEvent.click(screen.getByRole('button', { name: 'Run agent' }));
    expect(await screen.findByText(/Failed trace · run-f/)).toBeTruthy();
    expect(screen.getAllByText(/MODEL_PROVIDER/).length).toBeGreaterThan(0);
  });
});
