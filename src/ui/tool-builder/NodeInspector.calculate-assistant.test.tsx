// @vitest-environment jsdom
/**
 * 関数電卓ノード（calculate）の式提案（v41・ADR-0046）。
 *
 * `NodeInspector.calculate.test.tsx` がキーパッド・関数ボタン・列チップなど電卓本体を担い、
 * `NodeInspector.analysis-output.test.tsx` が分析ノードの設定補助（同じ形の機能）を担う。
 * ここでは電卓の中に入った「AIで式を書く」区画（.calc-ai）だけを見る:
 * 置き場所（式の直下・入力キーとキーパッドの前）、鍵ボタンでの開閉、使えないときの案内、
 * 提案の取得・表示、適用（式・出力列名だけを書き換え、onError/precisionは保つ）、
 * 入力キーの挿入先の切り替え（指示文 ⇄ 式）、失敗時の導線、キャンセルで親のconfigが変わらないこと。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { CalculateExpressionProposalDto, PropagationResultDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const scope = { tenantId: 'local', workspaceId: 'default' };
const upstream = {
  columns: [
    { name: 'price', type: 'number' as const, nullable: false },
    { name: 'qty', type: 'number' as const, nullable: false },
  ],
};
/** AI の鍵ボタン（表示は絵文字つき）。 */
const KEY_EN = /Have AI write the formula/;
const KEY_JA = /AIに式を書かせる/;
const UNAVAILABLE_EN = 'The local LLM is not configured. Set the main model slot in Settings > Models, then reload, to let AI write formulas.';

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

async function openDialog(name = 'Open settings', dialogName = 'Node configuration'): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('dialog', { name: dialogName });
}

/** 鍵が使えるようになる（能力の問い合わせが返る）のを待ってから押し、パネルを開く。 */
async function openAiPanel(dialog: HTMLElement, name: RegExp = KEY_EN): Promise<HTMLButtonElement> {
  const key = within(dialog).getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(key.disabled).toBe(false));
  await userEvent.click(key);
  return key;
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

/** 能力あり + 指定の提案を返すクライアント。 */
function assistantClient(suggest: ReturnType<typeof vi.fn>): ToolApiClient {
  return fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(true), suggestCalculateExpression: suggest });
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
    promptTemplateVersion: 'calculate-expression/v2',
    ...overrides,
  };
}

describe('NodeInspector: 関数電卓の中のAI（置き場所と入口）', () => {
  it('正常: AI区画は式の直下、「値として使える入力」とキーパッドより前にある', async () => {
    addCalculate();
    render(<NodeInspector client={assistantClient(vi.fn())} />);
    const dialog = await openDialog();

    const expression = within(dialog).getByLabelText('Expression');
    const aiGroup = within(dialog).getByRole('group', { name: 'AI formula writer' });
    const inputs = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    const keypad = within(dialog).getByRole('group', { name: 'Keypad' });

    expect(expression.compareDocumentPosition(aiGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aiGroup.compareDocumentPosition(inputs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aiGroup.compareDocumentPosition(keypad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('正常: 鍵ボタンでパネルを開閉できる（aria-expanded が追従する）', async () => {
    addCalculate();
    render(<NodeInspector client={assistantClient(vi.fn())} />);
    const dialog = await openDialog();

    const key = within(dialog).getByRole('button', { name: KEY_EN }) as HTMLButtonElement;
    await waitFor(() => expect(key.disabled).toBe(false));
    expect(key.getAttribute('aria-expanded')).toBe('false');
    expect(within(dialog).queryByLabelText('What to calculate')).toBeNull();

    await userEvent.click(key);
    expect(key.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByLabelText('What to calculate')).toBeTruthy();
    expect(within(dialog).getByText('While you are writing here, the input keys below insert [column] into this instruction. If a formula is already written, AI revises it.')).toBeTruthy();

    await userEvent.click(key);
    expect(key.getAttribute('aria-expanded')).toBe('false');
    expect(within(dialog).queryByLabelText('What to calculate')).toBeNull();
  });

  it('異常: 能力が偽なら鍵は押せず、直し方（設定 > モデル）の案内を出す', async () => {
    addCalculate();
    const client = fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(false) });
    render(<NodeInspector client={client} />);
    await waitFor(() => expect(client.calculateAssistantCapability).toHaveBeenCalled());
    const dialog = await openDialog();

    const key = within(dialog).getByRole('button', { name: KEY_EN }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(key.getAttribute('aria-expanded')).toBe('false');
    expect(within(dialog).getByText(UNAVAILABLE_EN)).toBeTruthy();
    expect(within(dialog).queryByLabelText('What to calculate')).toBeNull();
  });

  it('異常: 旧サーバー（calculateAssistantCapability を持たないクライアント）でも鍵は押せず、案内だけを出す', async () => {
    addCalculate();
    const client = fakeClient();
    render(<NodeInspector client={client} />);
    await waitFor(() => expect(client.analysisAssistantCapability).toHaveBeenCalled());
    const dialog = await openDialog();

    const key = within(dialog).getByRole('button', { name: KEY_EN }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(within(dialog).getByText(UNAVAILABLE_EN)).toBeTruthy();
  });
});

describe('NodeInspector: 関数電卓ノードの式提案（v41）', () => {
  it('正常: パネルで提案を取得し、ダイアログへ適用できる（onErrorは保ち、カーソルは式の末尾へ）', async () => {
    const id = addCalculate();
    patchConfig(id, { onError: 'fail' });
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({ nodeId: id }));
    render(<NodeInspector client={assistantClient(suggestCalculateExpression)} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

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
    const expressionBox = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;
    expect(expressionBox.value).toBe('[price]*[qty]');
    expect(expressionBox.selectionStart).toBe('[price]*[qty]'.length);
    expect((within(dialog).getByLabelText('Output column') as HTMLInputElement).value).toBe('total');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(id)).toMatchObject({ expression: '[price]*[qty]', outputColumn: 'total', onError: 'fail' });
  });

  it('正常: 要求にはダイアログの下書き（いまの式を含む）が載り、式があると指示文の例示が「直す」側へ変わる', async () => {
    const id = addCalculate();
    patchConfig(id, { expression: '[price]', outputColumn: 'result' });
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({ nodeId: id }));
    render(<NodeInspector client={assistantClient(suggestCalculateExpression)} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    const intentBox = within(dialog).getByLabelText('What to calculate') as HTMLTextAreaElement;
    expect(intentBox.placeholder).toBe('e.g. Change this formula to include 10% tax and round to 0 decimals');

    fireEvent.change(intentBox, { target: { value: 'multiply the current formula by qty' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));
    await within(dialog).findByText('[price]*[qty]');

    const sent = suggestCalculateExpression.mock.calls[0]![0] as { graph: { nodes: { id: string; config: Record<string, unknown> }[] } };
    expect(sent.graph.nodes.find((node) => node.id === id)?.config).toMatchObject({ expression: '[price]', outputColumn: 'result' });
  });

  it('境界: 式が空なら指示文の例示は「新しく書く」側（式を書くと入れ替わる）', async () => {
    addCalculate();
    render(<NodeInspector client={assistantClient(vi.fn())} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    const intentBox = within(dialog).getByLabelText('What to calculate') as HTMLTextAreaElement;
    expect(intentBox.placeholder).toBe('e.g. Tax-included amount from unit price × quantity, rounded to 0 decimals');

    fireEvent.change(within(dialog).getByLabelText('Expression'), { target: { value: '[price]' } });
    expect((within(dialog).getByLabelText('What to calculate') as HTMLTextAreaElement).placeholder)
      .toBe('e.g. Change this formula to include 10% tax and round to 0 decimals');
  });

  it('正常: 適用したあとも続けて2回目の提案を頼める（2回目には適用済みの式が載る）', async () => {
    const id = addCalculate();
    const suggestCalculateExpression = vi.fn()
      .mockResolvedValueOnce(sampleProposal({ nodeId: id }))
      .mockResolvedValueOnce(sampleProposal({ nodeId: id, config: { outputColumn: 'taxed', expression: 'round([price]*[qty]*1.1)' } }));
    render(<NodeInspector client={assistantClient(suggestCalculateExpression)} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: 'unit price times quantity' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));
    await within(dialog).findByText('[price]*[qty]');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply expression to this dialog' }));

    // パネルは開いたままで、指示を書き換えてもう一度頼める。
    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: 'make it tax included' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));
    await within(dialog).findByText('round([price]*[qty]*1.1)');

    expect(suggestCalculateExpression).toHaveBeenCalledTimes(2);
    const second = suggestCalculateExpression.mock.calls[1]![0] as { intent: string; graph: { nodes: { id: string; config: Record<string, unknown> }[] } };
    expect(second.intent).toBe('make it tax included');
    expect(second.graph.nodes.find((node) => node.id === id)?.config).toMatchObject({ expression: '[price]*[qty]', outputColumn: 'total' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply expression to this dialog' }));
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('round([price]*[qty]*1.1)');
  });

  it('異常: 提案の取得が拒否されたら文言と「指示を具体的に」の導線を出し、ダイアログの式は変えない', async () => {
    const id = addCalculate();
    patchConfig(id, { expression: '[price]', outputColumn: 'result' });
    const before = configOf(id);
    const client = assistantClient(vi.fn().mockRejectedValue(new Error('calculate assistant is not configured')));
    render(<NodeInspector client={client} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: 'tax included amount' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));

    expect(await within(dialog).findByText('calculate assistant is not configured')).toBeTruthy();
    expect(within(dialog).getByText('Make the instruction more specific (which columns to use, rounding, units) and try again.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('[price]');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(configOf(id)).toEqual(before);
  });

  it('境界: 指示が空白のときボタンはdisabled。repaired なら「1回直しました」、warningsと検分の警告はfield-errorで出る', async () => {
    const id = addCalculate();
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({
      nodeId: id, repaired: true, warnings: ['1/3 rows could not be calculated (divide-by-zero 1)'],
      validation: { references: ['price', 'qty'], diagnostics: [{ severity: 'warning', code: 'non-numeric-column', category: 'column', message: 'qty is not numeric in the sample rows' }] },
    }));
    render(<NodeInspector client={assistantClient(suggestCalculateExpression)} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

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
    expect(within(dialog).getByText('qty is not numeric in the sample rows').className).toContain('field-error');
  });

  it('例外: 提案を受け取った後にキャンセルしても、適用していない限り親のconfigは変わらない', async () => {
    const id = addCalculate();
    const before = configOf(id);
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({ nodeId: id }));
    render(<NodeInspector client={assistantClient(suggestCalculateExpression)} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    fireEvent.change(within(dialog).getByLabelText('What to calculate'), { target: { value: 'unit price times quantity' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suggest expression' }));
    await within(dialog).findByText('[price]*[qty]');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(configOf(id)).toEqual(before);
  });
});

describe('NodeInspector: 入力キーの挿入先（式 ⇄ AIへの指示文）', () => {
  it('正常: 指示文を編集中なら入力キーはカーソル位置の指示文へ入り、式には触らない', async () => {
    addCalculate();
    render(<NodeInspector client={assistantClient(vi.fn())} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    const intentBox = within(dialog).getByLabelText('What to calculate') as HTMLTextAreaElement;
    const inputs = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    await userEvent.click(intentBox);
    fireEvent.change(intentBox, { target: { value: 'tax on ' } });
    intentBox.setSelectionRange(7, 7);
    fireEvent.select(intentBox);

    await userEvent.click(within(inputs).getByRole('button', { name: 'price' }));
    expect(intentBox.value).toBe('tax on [price]');
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('');

    // 末尾追記ではなく、指示文のカーソル位置へ入る。
    intentBox.setSelectionRange(0, 0);
    fireEvent.select(intentBox);
    await userEvent.click(within(inputs).getByRole('button', { name: 'qty' }));
    expect(intentBox.value).toBe('[qty]tax on [price]');
  });

  it('正常: 式の欄に触れば挿入先は式へ戻る（指示文は変わらない）', async () => {
    addCalculate();
    render(<NodeInspector client={assistantClient(vi.fn())} />);
    const dialog = await openDialog();
    await openAiPanel(dialog);

    const intentBox = within(dialog).getByLabelText('What to calculate') as HTMLTextAreaElement;
    const inputs = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    await userEvent.click(intentBox);
    fireEvent.change(intentBox, { target: { value: 'tax on ' } });
    await userEvent.click(within(inputs).getByRole('button', { name: 'price' }));
    expect(intentBox.value).toBe('tax on [price]');

    const expressionBox = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;
    await userEvent.click(expressionBox);
    await userEvent.click(within(inputs).getByRole('button', { name: 'qty' }));

    expect(expressionBox.value).toBe('[qty]');
    expect(intentBox.value).toBe('tax on [price]');
  });

  it('境界: パネルを閉じていれば入力キーは式へ入る', async () => {
    addCalculate();
    render(<NodeInspector client={assistantClient(vi.fn())} />);
    const dialog = await openDialog();
    const key = await openAiPanel(dialog);

    const intentBox = within(dialog).getByLabelText('What to calculate') as HTMLTextAreaElement;
    await userEvent.click(intentBox);
    await userEvent.click(key); // 閉じる

    await userEvent.click(within(within(dialog).getByRole('group', { name: 'Inputs usable as values' })).getByRole('button', { name: 'price' }));
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('[price]');
  });
});

describe('NodeInspector: 式提案の日本語UI', () => {
  it('正常: 鍵・指示文・提案・適用のラベルを日本語で出す', async () => {
    const id = addCalculate();
    const suggestCalculateExpression = vi.fn().mockResolvedValue(sampleProposal({ nodeId: id }));
    render(<I18nProvider initialLanguage="ja"><NodeInspector client={assistantClient(suggestCalculateExpression)} /></I18nProvider>);
    const dialog = await openDialog('設定を開く', 'ノード設定');

    expect(within(dialog).getByRole('group', { name: 'AIで式を書く' })).toBeTruthy();
    await openAiPanel(dialog, KEY_JA);

    fireEvent.change(within(dialog).getByLabelText('計算したいこと'), { target: { value: '単価×数量' } });
    await userEvent.click(within(dialog).getByRole('button', { name: '式を提案' }));

    await within(dialog).findByText('[price]*[qty]');
    expect(within(dialog).getByText('標本 3 行のうち 3 行が計算できました。')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'この式をダイアログへ適用' }));
    expect((within(dialog).getByLabelText('式') as HTMLTextAreaElement).value).toBe('[price]*[qty]');
  });

  it('異常: 使えないときの案内も日本語で出す', async () => {
    addCalculate();
    const client = fakeClient({ calculateAssistantCapability: vi.fn().mockResolvedValue(false) });
    render(<I18nProvider initialLanguage="ja"><NodeInspector client={client} /></I18nProvider>);
    await waitFor(() => expect(client.calculateAssistantCapability).toHaveBeenCalled());
    const dialog = await openDialog('設定を開く', 'ノード設定');

    expect((within(dialog).getByRole('button', { name: KEY_JA }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('ローカルLLMが未設定です。設定 > モデル で main スロットを設定して再読み込みすると、AIに式を書かせられます。')).toBeTruthy();
  });
});
