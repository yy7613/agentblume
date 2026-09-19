// @vitest-environment jsdom
/**
 * 関数電卓ノード（calculate）の式提案（v41・ADR-0046）。
 *
 * `NodeInspector.calculate.test.tsx` がキーパッド・関数ボタン・列チップなど電卓本体を担い、
 * `NodeInspector.analysis-output.test.tsx` が分析ノードの設定補助（同じ形の機能）を担う。
 * ここでは calculate ダイアログの上に出る「ローカルLLMで式を作る」区画（.calc-assistant）だけを見る:
 * 能力の出し分け、提案の取得・表示、適用（式・出力列名だけを書き換え、onError/precisionは保つ）、
 * 失敗時の導線、修復回の表示、キャンセルで親のconfigが変わらないこと。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { CalculateExpressionProposalDto, PropagationResultDto } from '../api/types';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const scope = { tenantId: 'local', workspaceId: 'default' };
const upstream = {
  columns: [
    { name: 'price', type: 'number' as const, nullable: false },
    { name: 'qty', type: 'number' as const, nullable: false },
  ],
};

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

/** 上流ノード（json-source, スキーマ確定済み）+ calculate ノードを置き、calculate を選択した状態にする。 */
function addCalculate(): string {
  useToolBuilderStore.getState().addNode('json-source');
  const sourceId = useToolBuilderStore.getState().selectedNodeId!;
  const propagation: PropagationResultDto = {
    order: [sourceId], terminalId: sourceId, hasErrors: false,
    nodes: { [sourceId]: { nodeId: sourceId, state: 'inferred', issues: [], schema: upstream } },
  };
  useToolBuilderStore.getState().setPropagation(propagation);
  useToolBuilderStore.getState().addNode('calculate');
  return useToolBuilderStore.getState().selectedNodeId!;
}

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

function patchConfig(nodeId: string, patch: Readonly<Record<string, unknown>>): void {
  useToolBuilderStore.getState().updateNodeConfig(nodeId, { ...configOf(nodeId), ...patch });
}

async function openDialog(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  return screen.getByRole('dialog', { name: 'Node configuration' });
}

/** NodeInspector が起動時に叩く3本を満たす最小のクライアント。calculateAssistantCapability は既定で未実装（旧クライアント相当）。 */
function fakeClient(overrides: Readonly<Record<string, unknown>> = {}): ToolApiClient {
  return {
    listDataSources: vi.fn().mockResolvedValue([]),
    listSearchProviders: vi.fn().mockResolvedValue([]),
    analysisAssistantCapability: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as ToolApiClient;
}

function sampleProposal(overrides: Partial<CalculateExpressionProposalDto> = {}): CalculateExpressionProposalDto {
  return {
    nodeId: 'n', nodeType: 'calculate',
    config: { outputColumn: 'total', expression: '[price]*[qty]' },
    rationale: ['price times qty gives the line total'],
    warnings: [],
    validation: { references: ['price', 'qty'], diagnostics: [] },
    preview: { rows: 3, evaluated: 3, failed: 0, failureCounts: {}, sample: [] },
    repaired: false,
    promptTemplateVersion: 'calculate-expression/v1',
    ...overrides,
  };
}

describe('NodeInspector: 関数電卓ノードの式提案（v41）', () => {
  it('正常: 能力が真なら区画が出て、提案を取得しダイアログへ適用できる（onErrorは保つ）', async () => {
    const id = addCalculate();
    patchConfig(id, { onError: 'fail' });
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({ nodeId: id }));
    const client = fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(true), suggestCalculateExpression });
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    await within(dialog).findByText('Build the expression with the local LLM');
    const suggestButton = within(dialog).getByRole('button', { name: 'Suggest expression' });
    expect((suggestButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: 'unit price times quantity' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));

    await within(dialog).findByText('[price]*[qty]');
    expect(within(dialog).getByText('• price times qty gives the line total')).toBeTruthy();
    expect(within(dialog).getByText('3 of 3 sample rows calculated.')).toBeTruthy();
    expect(suggestCalculateExpression).toHaveBeenCalledWith(expect.objectContaining({ nodeId: id, intent: 'unit price times quantity', scope }));
    const sent = suggestCalculateExpression.mock.calls[0]![0] as { graph: { nodes: { id: string; config: unknown }[] } };
    expect(sent.graph.nodes.find((node) => node.id === id)?.config).toEqual(configOf(id));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply expression to this dialog' }));
    expect(within(dialog).queryByRole('button', { name: 'Apply expression to this dialog' })).toBeNull();
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('[price]*[qty]');
    expect((within(dialog).getByLabelText('Output column') as HTMLInputElement).value).toBe('total');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toMatchObject({ expression: '[price]*[qty]', outputColumn: 'total', onError: 'fail' });
  });

  it('異常: 能力が偽なら区画を出さない', async () => {
    addCalculate();
    const client = fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(false) });
    render(<NodeInspector client={client} />);
    await waitFor(() => expect(client.calculateAssistantCapability).toHaveBeenCalled());
    const dialog = await openDialog();
    expect(within(dialog).queryByText('Build the expression with the local LLM')).toBeNull();
  });

  it('[回帰固定] 異常: 旧サーバー（calculateAssistantCapability を持たないクライアント）でも区画を出さない', async () => {
    addCalculate();
    const client = fakeClient();
    render(<NodeInspector client={client} />);
    await waitFor(() => expect(client.analysisAssistantCapability).toHaveBeenCalled());
    const dialog = await openDialog();
    expect(within(dialog).queryByText('Build the expression with the local LLM')).toBeNull();
  });

  it('異常: 提案の取得が拒否されたら文言と「指示を具体的に」の導線を出し、ダイアログの式は変えない', async () => {
    const id = addCalculate();
    patchConfig(id, { expression: '[price]', outputColumn: 'result' });
    const before = configOf(id);
    const client = fakeClient({
      calculateAssistantCapability: vi.fn().mockResolvedValue(true),
      suggestCalculateExpression: vi.fn().mockRejectedValue(new Error('calculate assistant is not configured')),
    });
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    fireEvent.change(await within(dialog).findByLabelText('What to calculate'), { target: { value: 'tax included amount' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));

    expect(await within(dialog).findByText('calculate assistant is not configured')).toBeTruthy();
    expect(within(dialog).getByText('Make the instruction more specific (which columns to use, rounding, units) and try again.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('[price]');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(configOf(id)).toEqual(before);
  });

  it('境界: 指示が空白のときボタンはdisabled。repaired なら「1回直しました」、warningsはfield-errorで出る', async () => {
    const id = addCalculate();
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({
      nodeId: id, repaired: true, warnings: ['1/3 rows could not be calculated (divide-by-zero 1)'],
    }));
    const client = fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(true), suggestCalculateExpression });
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    const suggestButton = within(dialog).getByRole('button', { name: 'Suggest expression' }) as HTMLButtonElement;
    expect(suggestButton.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: '   ' } });
    expect(suggestButton.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: 'price divided by qty' } });
    expect(suggestButton.disabled).toBe(false);
    await userEvent.click(suggestButton);

    await within(dialog).findByText('The first proposal was repaired once.');
    const warning = within(dialog).getByText('• 1/3 rows could not be calculated (divide-by-zero 1)');
    expect(warning.className).toContain('field-error');
  });

  it('例外: 提案を受け取った後にキャンセルしても、適用していない限り親のconfigは変わらない', async () => {
    const id = addCalculate();
    const before = configOf(id);
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({ nodeId: id }));
    const client = fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(true), suggestCalculateExpression });
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();

    fireEvent.change(await within(dialog).findByLabelText('What to calculate'), { target: { value: 'unit price times quantity' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));
    await within(dialog).findByText('[price]*[qty]');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(configOf(id)).toEqual(before);
  });
});
