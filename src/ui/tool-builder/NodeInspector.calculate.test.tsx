// @vitest-environment jsdom
/**
 * 関数電卓ノード（calculate）の設定UI（ADR-0045 / implementation/v39-calculate-node.md §3, §4）。
 *
 * サイドバーは要約（displayExpression の1行）だけで、実編集はダイアログ側という分担は他ノードと同じ
 * （ADR-0028）。ダイアログはキーパッド・関数ボタン・列チップ・式のtextareaで、押した位置へ挿入する
 * （末尾追記だけでは不足という契約の要件）ことをここで固定する。式の妥当性そのもの（inferSchemaの
 * issue表示）はプレビュー側の責務なので、ここで見るのは括弧の対応だけ。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PropagationResultDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

const upstream = {
  columns: [
    { name: 'amount', type: 'number' as const, nullable: true },
    { name: 'name', type: 'string' as const, nullable: false },
    { name: 'active', type: 'boolean' as const, nullable: false },
    { name: 'created', type: 'date' as const, nullable: true },
  ],
};

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

/** 上流列を持たない calculate ノード（列チップの空状態を見るため）。 */
function addCalculateWithoutUpstream(): string {
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

describe('NodeInspector: calculate のサイドバー要約', () => {
  it('正常: 出力列名と displayExpression の1行を表示する（保存値は×÷にしない）', () => {
    const id = addCalculate();
    patchConfig(id, { outputColumn: 'taxed', expression: '[amount]*1.1' });
    render(<NodeInspector />);

    expect(screen.getByText('taxed = [amount]×1.1')).toBeTruthy();
    // サマリーは表示専用。configの保存値そのものは * のままであること（displayExpressionは変換しない）。
    expect(configOf(id)['expression']).toBe('[amount]*1.1');
  });

  it('例外: 式が空のときは「式を入力してください」を出す（既定は英語UI）', () => {
    addCalculate();
    render(<NodeInspector />);
    expect(screen.getByText('Enter a formula.')).toBeTruthy();
  });

  it('正常: 日本語UIでは要約とキーパッドのラベルを日本語で出す', async () => {
    const id = addCalculate();
    patchConfig(id, { outputColumn: 'taxed', expression: '[amount]*1.1' });
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);

    expect(screen.getByText('関数電卓')).toBeTruthy();
    expect(screen.getByText('taxed = [amount]×1.1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '設定を開く' }));
    const dialog = screen.getByRole('dialog', { name: 'ノード設定' });
    expect(within(dialog).getByLabelText('出力列名')).toBeTruthy();
    expect(within(dialog).getByLabelText('式')).toBeTruthy();
    expect(within(dialog).getByRole('group', { name: 'キーパッド' })).toBeTruthy();
    expect(within(dialog).getByRole('group', { name: '値として使える入力' })).toBeTruthy();
  });
});

describe('NodeInspector: calculate ダイアログ', () => {
  it('正常: キーパッドと列チップで 7×[amount] を組み立てられる（式には * を書く）', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const keypad = within(dialog).getByRole('group', { name: 'Keypad' });
    const columnsGroup = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.click(within(keypad).getByRole('button', { name: '7' }));
    await userEvent.click(within(keypad).getByRole('button', { name: '×' }));
    await userEvent.click(within(columnsGroup).getByRole('button', { name: 'amount' }));

    expect(textarea.value).toBe('7*[amount]');
  });

  it('正常: 関数ボタンを押すと "name(" が挿入される', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.click(within(dialog).getByRole('button', { name: 'sqrt' }));
    expect(textarea.value).toBe('sqrt(');
  });

  it('正常: 出力列名・評価不能時・小数桁の変更を適用するとconfigへ反映される', async () => {
    const id = addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();

    await userEvent.clear(within(dialog).getByLabelText('Output column'));
    await userEvent.type(within(dialog).getByLabelText('Output column'), 'total');
    await userEvent.selectOptions(within(dialog).getByLabelText('On error'), 'fail');
    await userEvent.type(within(dialog).getByLabelText('Precision'), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));

    expect(configOf(id)['outputColumn']).toBe('total');
    expect(configOf(id)['onError']).toBe('fail');
    expect(configOf(id)['precision']).toBe(2);
  });

  it('境界: カーソルが式の途中にあるとき、そこへ挿入する（末尾追記ではない）', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.type(textarea, '12');
    // カーソルを "1" と "2" の間へ戻す。
    textarea.setSelectionRange(1, 1);
    fireEvent.select(textarea);
    await userEvent.click(within(dialog).getByRole('button', { name: '9' }));

    expect(textarea.value).toBe('192');
  });

  it('境界: ← は挿入と同じ位置から1文字だけ消す', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.type(textarea, '12');
    await userEvent.click(within(dialog).getByRole('button', { name: '←' }));
    expect(textarea.value).toBe('1');
  });

  it('境界: C で式を空にする', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.type(textarea, '1+2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'C' }));
    expect(textarea.value).toBe('');
  });

  it('境界: 上流未接続では列チップの代わりに案内を出す', async () => {
    addCalculateWithoutUpstream();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const columnsGroup = within(dialog).getByRole('group', { name: 'Inputs usable as values' });

    expect(within(columnsGroup).getByText('Connect an upstream node to see columns.')).toBeTruthy();
    expect(within(columnsGroup).queryByRole('button')).toBeNull();
  });

  it('異常: 開き括弧が余ると個数付きで警告する', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.type(textarea, '((1+2)');
    expect(within(dialog).getByText('1 extra opening parenthesis.')).toBeTruthy();
  });

  it('異常: 閉じ括弧が余ると個数付きで警告する', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.type(textarea, '(1+2))');
    expect(within(dialog).getByText('1 extra closing parenthesis.')).toBeTruthy();
  });

  it('例外: number以外の列チップは calc-column-dim になり、実行時の扱いをtitleで伝える', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const columnsGroup = within(dialog).getByRole('group', { name: 'Inputs usable as values' });

    const numberChip = within(columnsGroup).getByRole('button', { name: 'amount' });
    expect(numberChip.className).not.toContain('calc-column-dim');

    const stringChip = within(columnsGroup).getByRole('button', { name: 'name' });
    expect(stringChip.className).toContain('calc-column-dim');
    expect(stringChip.title).toBe('Coerced to a number at run time.');

    const booleanChip = within(columnsGroup).getByRole('button', { name: 'active' });
    expect(booleanChip.title).toBe('Becomes null at run time.');
    const dateChip = within(columnsGroup).getByRole('button', { name: 'created' });
    expect(dateChip.title).toBe('Becomes null at run time.');
  });

  it('例外: Cancelで閉じると括弧の途中入力は破棄される（ダイアログの外へ漏れない）', async () => {
    const id = addCalculate();
    const before = configOf(id);
    render(<NodeInspector />);
    const dialog = await openDialog();
    const textarea = within(dialog).getByLabelText('Expression') as HTMLTextAreaElement;

    await userEvent.type(textarea, '((broken');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(configOf(id)).toEqual(before);
  });
});

describe('NodeInspector: calculate の「値として使える入力」', () => {
  /** 上流ノードのプレビュー行を置く（例の値の元）。 */
  function setUpstreamPreview(): void {
    const state = useToolBuilderStore.getState();
    const calculateId = state.selectedNodeId!;
    const sourceId = state.edges.find((edge) => edge.target === calculateId)!.source;
    const rows = [
      { amount: 18400, name: 'A社 会食', active: true, created: '2026-09-01' },
      { amount: 18400, name: 'B社 手土産', active: false, created: null },
      { amount: null, name: 'C社', active: true, created: '2026-09-03' },
      { amount: 3240, name: 'D社', active: true, created: '2026-09-04' },
      { amount: 500, name: 'E社', active: true, created: '2026-09-05' },
    ];
    state.setPreview({ terminalId: sourceId, output: { schema: upstream, rows }, nodes: { [sourceId]: { nodeId: sourceId, table: { schema: upstream, rows }, truncated: false, rowCount: rows.length } } });
  }

  it('正常: 入力ごとに型と例の値（null を除いた相異なる値を先頭から 3 つ）を添える', async () => {
    addCalculate();
    setUpstreamPreview();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const group = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    const amount = within(group).getByRole('button', { name: 'amount' });
    expect(amount.textContent).toContain('[amount]');
    expect(amount.textContent).toContain('number · e.g. 18400, 3240, 500');
    const name = within(group).getByRole('button', { name: 'name' });
    expect(name.textContent).toContain('string · e.g. "A社 会食", "B社 手土産", "C社"');
  });

  it('境界: プレビューが無ければ型だけを添え、例の値は出さない', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const group = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    const amount = within(group).getByRole('button', { name: 'amount' });
    expect(amount.textContent).toBe('[amount]number');
  });

  it('正常: 入力区画は式の直下・キーパッドの前にあり、number 以外があれば型変換の案内を出す', async () => {
    addCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const group = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    const keypad = within(dialog).getByRole('group', { name: 'Keypad' });
    expect(group.compareDocumentPosition(keypad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group).getByText(/Add a cast node upstream/)).toBeTruthy();
  });

  it('正常: サイドバーの要約にも値として使える入力を [列名] で出す（number を先に）', () => {
    addCalculate();
    render(<NodeInspector />);
    const summary = screen.getByText('Inputs usable as values:').parentElement!;
    const codes = Array.from(summary.querySelectorAll('code')).map((code) => code.textContent);
    expect(codes).toEqual(['[amount]', '[name]', '[active]', '[created]']);
    expect(summary.querySelectorAll('code.calc-column-dim')).toHaveLength(3);
  });

  it('境界: 上流未接続のサイドバーでは入力の代わりに接続の案内を出す', () => {
    addCalculateWithoutUpstream();
    render(<NodeInspector />);
    expect(screen.getByText('Connect an upstream node to see the inputs you can use as values.')).toBeTruthy();
  });
});

describe('NodeInspector: calculate の上流が CSV のとき', () => {
  // 実サーバーの /tool-drafts/infer-schema と /tool-drafts/preview が csv-source に返した形そのまま
  // （日本語・記号入りの列名、数値と文字列が混ざって unknown 型になった列、空セルの null を含む）。
  const csvSchema = {
    columns: [
      { name: '品名', type: 'string' as const, nullable: false },
      { name: '数量', type: 'number' as const, nullable: true },
      { name: '単価', type: 'number' as const, nullable: false },
      { name: '金額(税抜)', type: 'unknown' as const, nullable: false },
      { name: '備考', type: 'string' as const, nullable: true },
    ],
  };
  const csvRows = [
    { 品名: 'りんご', 数量: 3, 単価: 120, '金額(税抜)': '1,200', 備考: '特売' },
    { 品名: 'みかん', 数量: 10, 単価: 45.5, '金額(税抜)': 455, 備考: null },
    { 品名: 'ぶどう', 数量: null, 単価: 980, '金額(税抜)': 980, 備考: null },
  ];

  function addCsvThenCalculate(): void {
    const store = useToolBuilderStore.getState();
    store.addNode('csv-source');
    const csvId = useToolBuilderStore.getState().selectedNodeId!;
    store.setPropagation({ order: [csvId], terminalId: csvId, hasErrors: false, nodes: { [csvId]: { nodeId: csvId, state: 'inferred', issues: [], schema: csvSchema } } });
    store.setPreview({ terminalId: csvId, output: { schema: csvSchema, rows: csvRows }, nodes: { [csvId]: { nodeId: csvId, table: { schema: csvSchema, rows: csvRows }, truncated: false, rowCount: csvRows.length } } });
    useToolBuilderStore.getState().addNode('calculate');
  }

  it('正常: CSV の列が「値として使える入力」に型と例の値つきで並び、number を先に出す', async () => {
    addCsvThenCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const group = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    const names = within(group).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['数量', '単価', '品名', '金額(税抜)', '備考']);
    expect(within(group).getByRole('button', { name: '数量' }).textContent).toBe('[数量]number · e.g. 3, 10');
    expect(within(group).getByRole('button', { name: '単価' }).textContent).toBe('[単価]number · e.g. 120, 45.5, 980');
    const mixed = within(group).getByRole('button', { name: '金額(税抜)' });
    expect(mixed.className).toContain('calc-column-dim');
    expect(mixed.textContent).toBe('[金額(税抜)]unknown · e.g. "1,200", 455, 980');
  });

  it('正常: 記号入りの日本語列名も押せば [列名] のまま式へ入る', async () => {
    addCsvThenCalculate();
    render(<NodeInspector />);
    const dialog = await openDialog();
    const group = within(dialog).getByRole('group', { name: 'Inputs usable as values' });
    await userEvent.click(within(group).getByRole('button', { name: '数量' }));
    await userEvent.click(within(within(dialog).getByRole('group', { name: 'Keypad' })).getByRole('button', { name: '×' }));
    await userEvent.click(within(group).getByRole('button', { name: '金額(税抜)' }));
    expect((within(dialog).getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('[数量]*[金額(税抜)]');
  });
});
