// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { PreviewResultDto, PropagationResultDto, SerializedToolDto } from '../api/types';
import { MetadataBar } from './MetadataBar';
import { NodeInspector } from './NodeInspector';
import { PreviewPanel } from './PreviewPanel';
import { useToolBuilderStore } from './store';
import { AgentChatPanel } from './AgentChatPanel';

const propagation: PropagationResultDto = {
  order: ['source-1', 'filter-1'],
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
      order: ['left-1', 'right-1', 'join-1'], hasErrors: false,
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
});

describe('PreviewPanel', () => {
  it('選択nodeのschemaとsample rowsを表示する', () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    useToolBuilderStore.getState().setPreview(preview);
    render(<PreviewPanel />);
    expect(screen.getByRole('columnheader', { name: 'age' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '30' })).toBeTruthy();
  });

  it('API errorとschema issueを表示する', () => {
    useToolBuilderStore.getState().setError('server offline');
    useToolBuilderStore.getState().setPropagation({
      ...propagation,
      hasErrors: true,
      nodes: { ...propagation.nodes, 'filter-1': { ...propagation.nodes['filter-1']!, issues: [{ severity: 'error', message: 'missing age' }] } },
    });
    render(<PreviewPanel />);
    expect(screen.getByRole('alert').textContent).toContain('server offline');
    expect(screen.getByText('missing age')).toBeTruthy();
  });
});

describe('MetadataBar', () => {
  it('updates editable metadata, including the session-write side-effect selector', () => {
    render(<MetadataBar client={{} as ToolApiClient} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Workspace output' } });
    fireEvent.change(screen.getByLabelText('Internal ID'), { target: { value: 'workspace-output' } });
    fireEvent.change(screen.getByLabelText('Working name'), { target: { value: 'workspace-output-draft' } });
    fireEvent.change(screen.getByLabelText('Publish name'), { target: { value: 'workspace_output' } });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: 'tenant-b' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'workspace-b' } });
    fireEvent.change(screen.getByLabelText('Side effect'), { target: { value: 'session-write' } });
    expect(useToolBuilderStore.getState().metadata).toMatchObject({
      displayName: 'Workspace output', internalId: 'workspace-output', workingName: 'workspace-output-draft',
      publishName: 'workspace_output', owner: 'owner@example.com', tenantId: 'tenant-b', workspaceId: 'workspace-b', sideEffect: 'session-write',
    });
  });

  it('明示Saveだけが保存APIを呼びversion履歴を更新する', async () => {
    useToolBuilderStore.getState().setPropagation(propagation);
    const metadata = useToolBuilderStore.getState().metadata;
    const tool = {
      metadata: { ...metadata, tenant: { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId }, version: '1.0.0', state: 'draft' },
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
    const metadata = useToolBuilderStore.getState().metadata;
    const input = { columns: [{ name: 'query', type: 'string' as const, nullable: false }] };
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: metadata.internalId, workingName: metadata.workingName, displayName: metadata.displayName, publishName: metadata.publishName, owner: metadata.owner, version: '1.0.0', state: 'draft', tenant: { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId } },
      sideEffect: 'read-only', graph: { nodes: [{ id: 'args', type: 'agent-input', config: { schema: input, sample: { query: 'x' } } }], edges: [] },
    });
    useToolBuilderStore.getState().setPropagation({ order: ['args'], hasErrors: false, nodes: { args: { nodeId: 'args', state: 'confirmed', issues: [], schema: input } } });
    const saved = { metadata: { ...metadata, version: '1.0.1', state: 'draft', tenant: { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId } }, sideEffect: 'read-only', graph: { nodes: [], edges: [] } } as unknown as SerializedToolDto;
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
      metadata: { internalId: 'loaded', workingName: 'w', displayName: 'Loaded', publishName: 'loaded', owner: 'o', version: '1.0.0', state: 'draft', tenant: { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId } },
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
    expect(screen.getByText(/MODEL_PROVIDER/)).toBeTruthy();
  });
});
