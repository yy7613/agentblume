// @vitest-environment jsdom
/**
 * 第2波ノードの設定UI:
 * - group-by（グループ列の複数選択 + 集計行の追加/削除）
 * - limit（行数・スキップ行数）
 * - filter の複数条件（条件追加 / AND・OR / 1条件へ戻すと旧形式のフラットconfigに戻る）
 *
 * 単一条件 filter の既存フィールド（Column / Operator / Value / エージェント入力参照）の
 * 回帰は ui-components.test.tsx が担う。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// domain の正準リスト。UI ソースは domain を import しない方針だが、テストからのピン留め import は可。
import { CASE_FOLD_OPS as DOMAIN_CASE_FOLD_OPS, FILTER_OPS as DOMAIN_FILTER_OPS, ORDER_OPS as DOMAIN_ORDER_OPS, VALUELESS_OPS as DOMAIN_VALUELESS_OPS } from '../../domain/etl/nodes/filter';
import type { PropagationResultDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { FILTER_CASE_FOLD_OPS, FILTER_OPS, FILTER_ORDER_OPS, FILTER_VALUELESS_OPS, NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const upstream = { columns: [
  { name: 'region', type: 'string' as const, nullable: false },
  { name: 'amount', type: 'number' as const, nullable: true },
] };
const propagation: PropagationResultDto = {
  order: ['source-1', 'filter-1'],
  hasErrors: false,
  nodes: {
    // filter-1 の下流に追加したノード（group-by / limit）は filter-1 の出力列を見る。
    'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: upstream },
    'filter-1': { nodeId: 'filter-1', state: 'inferred', issues: [], schema: upstream },
  },
};

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

/** starterグラフの filter-1（上流 source-1）を選択したまま、上流列を配る。 */
function withUpstreamColumns(): void {
  useToolBuilderStore.getState().setPropagation(propagation);
}

/** 指定typeのノードを追加し、その id を返す。 */
function addNode(type: Parameters<ReturnType<typeof useToolBuilderStore.getState>['addNode']>[0]): string {
  useToolBuilderStore.getState().addNode(type);
  return useToolBuilderStore.getState().selectedNodeId!;
}

describe('NodeInspector: group-by', () => {
  it('カタログ既定configを表示し、グループ列を選ぶとconfigへ書き戻す', async () => {
    withUpstreamColumns();
    const nodeId = addNode('group-by');
    render(<NodeInspector />);
    expect(configOf(nodeId)).toEqual({ groupBy: [], aggregates: [{ op: 'count', as: 'count' }] });

    await userEvent.selectOptions(screen.getByLabelText('Group columns'), 'region');
    expect(configOf(nodeId)['groupBy']).toEqual(['region']);
  });

  it('集計行を追加・編集・削除する（countは列選択を出さない）', async () => {
    withUpstreamColumns();
    const nodeId = addNode('group-by');
    render(<NodeInspector />);

    // 既定の1行目は count なので対象列のselectは無い。
    expect(screen.queryByLabelText('Aggregate column')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Add aggregate' }));
    // 既定名は衝突しないよう count2 になる。
    expect(configOf(nodeId)['aggregates']).toEqual([{ op: 'count', as: 'count' }, { op: 'count', as: 'count2' }]);

    const ops = screen.getAllByLabelText('Aggregate operation');
    await userEvent.selectOptions(ops[1]!, 'sum');
    await userEvent.selectOptions(screen.getByLabelText('Aggregate column'), 'amount');
    const names = screen.getAllByLabelText('Output column name');
    await userEvent.clear(names[1]!);
    await userEvent.type(names[1]!, 'total');
    expect(configOf(nodeId)['aggregates']).toEqual([
      { op: 'count', as: 'count' },
      { op: 'sum', column: 'amount', as: 'total' },
    ]);

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove aggregate' })[1]!);
    expect(configOf(nodeId)['aggregates']).toEqual([{ op: 'count', as: 'count' }]);
  });

  it('sum/meanでは数値列だけを候補にし、countへ戻すとcolumnを外す', async () => {
    withUpstreamColumns();
    const nodeId = addNode('group-by');
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Aggregate operation'), 'mean');
    const options = Array.from(screen.getByLabelText('Aggregate column').querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toEqual(['Select column', 'amount · number']);

    await userEvent.selectOptions(screen.getByLabelText('Aggregate column'), 'amount');
    expect(configOf(nodeId)['aggregates']).toEqual([{ op: 'mean', column: 'amount', as: 'count' }]);
    await userEvent.selectOptions(screen.getByLabelText('Aggregate operation'), 'count');
    expect(configOf(nodeId)['aggregates']).toEqual([{ op: 'count', as: 'count' }]);
  });

  it('保存済みconfigが配列でない場合も空として描画する（設定ダイアログを持たない）', () => {
    const nodeId = addNode('group-by');
    useToolBuilderStore.getState().updateNodeConfig(nodeId, {});
    render(<NodeInspector />);
    expect(screen.getByRole('button', { name: 'Add aggregate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
  });

  it('日本語UIでは日本語ラベルを出す', () => {
    addNode('group-by');
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);
    expect(screen.getByText('グループ集計')).toBeTruthy();
    expect(screen.getByLabelText('集計方法')).toBeTruthy();
    expect(screen.getByRole('button', { name: '集計を追加' })).toBeTruthy();
  });
});

describe('NodeInspector: limit', () => {
  it('行数とスキップ行数を編集する', async () => {
    const nodeId = addNode('limit');
    render(<NodeInspector />);
    expect(configOf(nodeId)).toEqual({ count: 100, offset: 0 });

    const count = screen.getByLabelText('Row count');
    await userEvent.clear(count);
    await userEvent.type(count, '10');
    expect(configOf(nodeId)['count']).toBe(10);

    const offset = screen.getByLabelText('Skip rows');
    await userEvent.clear(offset);
    await userEvent.type(offset, '5');
    expect(configOf(nodeId)).toEqual({ count: 10, offset: 5 });
  });

  it('未設定configでも既定値を表示する', () => {
    const nodeId = addNode('limit');
    useToolBuilderStore.getState().updateNodeConfig(nodeId, {});
    render(<NodeInspector />);
    expect((screen.getByLabelText('Row count') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText('Skip rows') as HTMLInputElement).value).toBe('0');
  });
});

describe('NodeInspector: filter の演算子ラベル', () => {
  /** option の value(opコード) と表示ラベルの組。 */
  function operatorOptions(index = 0, label = 'Operator'): [string, string][] {
    const select = screen.getAllByLabelText(label)[index] as HTMLSelectElement;
    return Array.from(select.querySelectorAll('option')).map((option) => [option.value, option.textContent ?? '']);
  }

  it('比較演算子は記号、その他は英語テキストで表示し、valueはopコードのまま', () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    expect(operatorOptions()).toEqual([
      ['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'],
      ['contains', 'contains'], ['isNull', 'is empty'], ['notNull', 'is not empty'],
    ]);
  });

  it('日本語表示では記号以外を日本語にする', () => {
    withUpstreamColumns();
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);
    expect(operatorOptions(0, '演算子')).toEqual([
      ['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'],
      ['contains', '含む'], ['isNull', 'が空'], ['notNull', 'が空でない'],
    ]);
  });

  it('複数条件の2つ目のselectも同じラベルを使い、opコードで選択できる', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(operatorOptions(1)).toEqual(operatorOptions(0));

    await userEvent.selectOptions(screen.getAllByLabelText('Operator')[1]!, 'contains');
    expect((configOf('filter-1')['conditions'] as { op: string }[])[1]?.op).toBe('contains');
  });
});

describe('NodeInspector: filter の複数条件', () => {
  it('1条件のときはAND/OR選択も条件削除も出さない（従来と同じ見た目）', () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    expect(screen.getByLabelText('Column')).toBeTruthy();
    expect(screen.getByLabelText('Condition value')).toBeTruthy();
    expect(screen.queryByLabelText('Combine conditions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove condition' })).toBeNull();
    expect(screen.queryByText('Condition 1')).toBeNull();
  });

  it('条件を追加するとconditions形式へ切り替わり、AND/ORを選べる', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(configOf('filter-1')).toEqual({
      conditions: [{ column: 'age', op: 'gte', value: 18 }, { column: '', op: 'eq', value: '' }],
      combine: 'and',
    });
    expect(screen.getByText('Condition 1')).toBeTruthy();
    expect(screen.getByText('Condition 2')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Combine conditions'), 'or');
    expect(configOf('filter-1')['combine']).toBe('or');
  });

  it('2条件目の列・演算子・値を個別に編集する（東京 or 大阪）', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await userEvent.selectOptions(screen.getByLabelText('Combine conditions'), 'or');

    const columnInputs = screen.getAllByLabelText('Column');
    await userEvent.clear(columnInputs[0]!);
    await userEvent.type(columnInputs[0]!, 'region');
    await userEvent.type(screen.getAllByLabelText('Column')[1]!, 'region');

    const values = screen.getAllByLabelText('Value');
    await userEvent.clear(values[0]!);
    await userEvent.type(values[0]!, 'Tokyo');
    await userEvent.type(screen.getAllByLabelText('Value')[1]!, 'Osaka');

    expect(configOf('filter-1')).toEqual({
      conditions: [
        { column: 'region', op: 'gte', value: 'Tokyo' },
        { column: 'region', op: 'eq', value: 'Osaka' },
      ],
      combine: 'or',
    });

    await userEvent.selectOptions(screen.getAllByLabelText('Operator')[0]!, 'eq');
    expect((configOf('filter-1')['conditions'] as { op: string }[])[0]?.op).toBe('eq');
  });

  it('複数条件では値が数値列の型に合わせて数値化される', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await userEvent.type(screen.getAllByLabelText('Column')[1]!, 'amount');
    await userEvent.type(screen.getAllByLabelText('Value')[1]!, '42');
    expect((configOf('filter-1')['conditions'] as { value: unknown }[])[1]?.value).toBe(42);
  });

  it('1条件へ戻すと旧形式のフラットconfigへ戻る（保存済みTool互換）', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[1]!);
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'gte', value: 18 });
    expect(screen.queryByLabelText('Combine conditions')).toBeNull();
  });

  it('保存済みのconditions形式を読み込んでそのまま表示・編集できる', async () => {
    useToolBuilderStore.getState().updateNodeConfig('filter-1', {
      conditions: [{ column: 'region', op: 'eq', value: 'Tokyo' }, { column: 'region', op: 'eq', value: 'Osaka' }],
      combine: 'or',
    });
    withUpstreamColumns();
    render(<NodeInspector />);
    expect((screen.getByLabelText('Combine conditions') as HTMLSelectElement).value).toBe('or');
    expect(screen.getAllByLabelText('Column').map((input) => (input as HTMLInputElement).value)).toEqual(['region', 'region']);

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[0]!);
    expect(configOf('filter-1')).toEqual({ column: 'region', op: 'eq', value: 'Osaka' });
  });

  it('値を要さない演算子では値入力を出さない（複数条件でも）', async () => {
    withUpstreamColumns();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', {
      conditions: [{ column: 'region', op: 'isNull' }, { column: 'amount', op: 'notNull' }],
      combine: 'and',
    });
    render(<NodeInspector />);
    expect(screen.queryByLabelText('Value')).toBeNull();
    expect(screen.queryByLabelText('Condition value')).toBeNull();
  });

  it('空のconditions配列は1条件として復帰でき、編集で旧形式へ戻る', async () => {
    withUpstreamColumns();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { conditions: [], combine: 'or' });
    render(<NodeInspector />);
    await userEvent.type(screen.getByLabelText('Column'), 'region');
    expect(configOf('filter-1')).toEqual({ column: 'region', op: 'eq' });
  });

  it('エージェント入力参照は複数条件でも各条件で選べる', async () => {
    withUpstreamColumns();
    useToolBuilderStore.getState().addNode('agent-input');
    useToolBuilderStore.getState().selectNode('filter-1');
    render(<NodeInspector />);

    await userEvent.selectOptions(screen.getByLabelText('Condition value'), 'agent-input');
    expect(configOf('filter-1')['valueBinding']).toEqual({ source: 'agent-input', field: 'query' });
    await userEvent.selectOptions(screen.getByLabelText('Agent input field'), 'query');
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'query' } });

    // conditions形式でも1条件目のバインディングを保ち、2条件目も同じUIで束縛できる
    // （実行時は conditions[].valueBinding が実引数へ差し替わる）。
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(screen.getAllByLabelText('Condition value')).toHaveLength(2);
    await userEvent.selectOptions(screen.getAllByLabelText('Condition value')[1]!, 'agent-input');
    expect(configOf('filter-1')['conditions']).toEqual([
      { column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'query' } },
      { column: '', op: 'eq', value: '', valueBinding: { source: 'agent-input', field: 'query' } },
    ]);

    // 1条件へ戻しても取得元を選べ、固定値へ戻すとバインディングが外れる。
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[1]!);
    await userEvent.selectOptions(screen.getByLabelText('Condition value'), 'constant');
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'gte', value: 18 });
  });

  it('エージェント入力を選んだときだけ、任意引数を省略すると条件がスキップされる旨を補足する', async () => {
    withUpstreamColumns();
    useToolBuilderStore.getState().addNode('agent-input');
    useToolBuilderStore.getState().selectNode('filter-1');
    render(<NodeInspector />);

    expect(screen.queryByText(/leaving it out at run time skips this condition/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Condition value'), 'agent-input');
    expect(screen.getByText('If the argument is optional (nullable), leaving it out at run time skips this condition.')).toBeTruthy();
  });

  it('日本語UIでは条件見出しとAND/ORを日本語で出す', async () => {
    withUpstreamColumns();
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);
    await userEvent.click(screen.getByRole('button', { name: '条件を追加' }));
    expect(screen.getByText('条件1')).toBeTruthy();
    expect(screen.getByLabelText('条件の結合')).toBeTruthy();
  });
});

describe('NodeInspector: filter の演算子バインディング（opBinding）', () => {
  /** agent-input ノードを追加して filter-1 を選択し直す（スキーマ省略時は既定の query:string）。 */
  function withAgentInput(schemaColumns?: readonly { name: string; type: 'string' | 'number'; nullable: boolean }[]): void {
    withUpstreamColumns();
    const agentInputId = addNode('agent-input');
    if (schemaColumns !== undefined) useToolBuilderStore.getState().updateNodeConfig(agentInputId, { schema: { columns: schemaColumns } });
    useToolBuilderStore.getState().selectNode('filter-1');
  }

  it('取得元をエージェント入力にすると opBinding が書かれる（number列では contains を除いた8演算子を明示する）', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18 });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    expect(configOf('filter-1')).toEqual({
      column: 'amount', op: 'gte', value: 18,
      opBinding: { source: 'agent-input', field: 'query', allowed: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'] },
    });
    // 数値列での contains は String 化包含になり直感に反するため、既定で外した理由をヒントで補足する。
    expect(screen.getByText('The contains operator is meant for string columns.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'contains' }) as HTMLInputElement).checked).toBe(false);
  });

  it('string 列では大小比較を外した allowed を初期値にし、既定演算子を許可内へsnapする', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'gte', value: 18 });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    expect(configOf('filter-1')).toEqual({
      column: 'region', op: 'eq', value: 18,
      opBinding: { source: 'agent-input', field: 'query', allowed: ['eq', 'neq', 'contains', 'isNull', 'notNull'] },
    });
    expect(screen.getByText('Order operators need a number or date column.')).toBeTruthy();
  });

  it('列型が未解決の間は allowed を絞らず op も書き換えない。固定へ戻すと元のconfigへ復元される', async () => {
    withAgentInput();
    // starter条件の column 'age' は上流スキーマ（region:string / amount:number）に無く、列型を解決できない。
    // string と同一視して大小比較を黙って外す破壊的スナップ（gte→eq）をしてはいけない。
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'query' } });
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'fixed');
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'gte', value: 18 });
  });

  it('contains を再チェックすると全許可となり allowed キーが消え、外すと FILTER_OPS 順の部分集合へ戻る', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18 });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    // number列の初期値は contains 抜きの8演算子（opt-outではなくopt-in）。
    await userEvent.click(screen.getByRole('checkbox', { name: 'contains' }));
    expect(configOf('filter-1')['opBinding']).toEqual({ source: 'agent-input', field: 'query' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'contains' }));
    expect(configOf('filter-1')['opBinding']).toEqual({
      source: 'agent-input', field: 'query',
      allowed: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'],
    });
  });

  it('フィールド候補は string 型の agent-input 列に限定され、先頭の string 列が初期値になる', async () => {
    withAgentInput([{ name: 'limit', type: 'number', nullable: true }, { name: 'opField', type: 'string', nullable: false }]);
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18 });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    const options = Array.from(screen.getByLabelText('Agent input field (operator)').querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toEqual(['Select an input field', 'opField · string']);
    expect((configOf('filter-1')['opBinding'] as { field: string }).field).toBe('opField');
  });

  it('string 型の引数が無ければ宣言を促す案内と field 未選択警告を出し、field は空で書く', async () => {
    withAgentInput([{ name: 'limit', type: 'number', nullable: true }]);
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18 });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    expect(screen.getByText('Declare a string-typed argument on the Agent Input node first.')).toBeTruthy();
    expect(screen.getByText('Select an agent input field.')).toBeTruthy();
    expect((configOf('filter-1')['opBinding'] as { field: string }).field).toBe('');
  });

  it('string 候補があっても field 未選択ならインライン警告を出し、選択すると消える', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: '' } });
    render(<NodeInspector />);
    expect(screen.getByText('Select an agent input field.')).toBeTruthy();
    // 候補はあるので「宣言してください」の方は出さない。
    expect(screen.queryByText('Declare a string-typed argument on the Agent Input node first.')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Agent input field (operator)'), 'query');
    expect(screen.queryByText('Select an agent input field.')).toBeNull();
  });

  it('既定の演算子は許可演算子に限定され、除外時は先頭の許可演算子へsnapする', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18 });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'agent-input');
    // number列の初期 allowed は contains 抜き。さらに eq を外すと7演算子になる。
    await userEvent.click(screen.getByRole('checkbox', { name: '=' }));
    expect(Array.from((screen.getByLabelText('Default operator') as HTMLSelectElement).options).map((option) => option.value))
      .toEqual(['neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull']);
    expect((screen.getByLabelText('Default operator') as HTMLSelectElement).value).toBe('gte');

    await userEvent.click(screen.getByRole('checkbox', { name: '≥' }));
    expect((configOf('filter-1') as { op: string }).op).toBe('neq');
    expect((screen.getByLabelText('Default operator') as HTMLSelectElement).value).toBe('neq');
  });

  it('許可演算子の最後の1つは外せない（disabledになる）', () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'eq', value: 'Tokyo', opBinding: { source: 'agent-input', field: 'query', allowed: ['eq'] } });
    render(<NodeInspector />);
    expect((screen.getByRole('checkbox', { name: '=' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: '≠' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('固定へ戻すと opBinding キーが消える', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'query' } });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator source'), 'fixed');
    expect(configOf('filter-1')).toEqual({ column: 'amount', op: 'gte', value: 18 });
  });

  it('許可演算子がすべて isNull/notNull のときだけ値エリアを消す', () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'isNull', opBinding: { source: 'agent-input', field: 'query', allowed: ['isNull', 'notNull'] } });
    const { unmount } = render(<NodeInspector />);
    expect(screen.queryByLabelText('Condition value')).toBeNull();
    expect(screen.queryByLabelText('Value')).toBeNull();
    unmount();

    // op が値不要の isNull でも、値を要する演算子が1つでも許可されていれば値エリアを出す（実行時に値が要り得る）。
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'isNull', opBinding: { source: 'agent-input', field: 'query', allowed: ['eq', 'isNull'] } });
    render(<NodeInspector />);
    expect(screen.getByLabelText('Condition value')).toBeTruthy();
  });

  it('固定 op を isNull にする書き込みで valueBinding を落とす（value はサンプルとして残す）', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'eq', value: 'Tokyo', valueBinding: { source: 'agent-input', field: 'query' } });
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator'), 'isNull');
    // 値エリアが消えた後に不可視の valueBinding が残ると、後の保存（nullable 検証）を塞ぐ。
    expect(configOf('filter-1')).toEqual({ column: 'region', op: 'isNull', value: 'Tokyo' });
  });

  it('許可演算子を isNull/notNull だけへ絞る書き込みでも valueBinding を落とす', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', {
      column: 'region', op: 'isNull', value: 'Tokyo',
      valueBinding: { source: 'agent-input', field: 'query' },
      opBinding: { source: 'agent-input', field: 'query', allowed: ['eq', 'isNull', 'notNull'] },
    });
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('checkbox', { name: '=' }));
    expect(configOf('filter-1')).toEqual({
      column: 'region', op: 'isNull', value: 'Tokyo',
      opBinding: { source: 'agent-input', field: 'query', allowed: ['isNull', 'notNull'] },
    });
  });

  it('壊れた allowed（未知の演算子だけ）は全演算子へフォールバックして警告を出し、編集で自己修復する', async () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'eq', value: 'Tokyo', opBinding: { source: 'agent-input', field: 'query', allowed: ['approximately'] } });
    render(<NodeInspector />);
    expect(screen.getByText('The saved allowed-operator list was invalid, so all operators are shown.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'contains' }) as HTMLInputElement).checked).toBe(true);
    // 1つ外すと認識できる8演算子の allowed が書き戻され、警告も消える。
    await userEvent.click(screen.getByRole('checkbox', { name: 'contains' }));
    expect(configOf('filter-1')['opBinding']).toEqual({
      source: 'agent-input', field: 'query',
      allowed: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'],
    });
    expect(screen.queryByText('The saved allowed-operator list was invalid, so all operators are shown.')).toBeNull();
  });

  it('既定の演算子 select は op が候補外でも op 自身を option に含めて表示と config を一致させる', () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'query', allowed: ['eq', 'neq'] } });
    render(<NodeInspector />);
    const select = screen.getByLabelText('Default operator') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['eq', 'neq', 'gt']);
    expect(select.value).toBe('gt');
  });

  it('日本語UIでは取得元・フィールド・許可演算子・既定演算子のラベルを日本語で出す', async () => {
    withAgentInput();
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);
    await userEvent.selectOptions(screen.getByLabelText('演算子の取得元'), 'agent-input');
    expect(screen.getByLabelText('エージェント入力フィールド（演算子）')).toBeTruthy();
    expect(screen.getByText('AIに許可する演算子')).toBeTruthy();
    expect(screen.getByLabelText('既定の演算子')).toBeTruthy();
    expect(screen.getByText('既定の演算子は設計時プレビューのサンプルです。引数が任意 (nullable) の場合、実行時に省略されるとこの既定が使われます。')).toBeTruthy();
  });

  it('日本語UIでは新ヒント（field未選択・contains説明・壊れた許可リスト）を日本語で出す', () => {
    withAgentInput();
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'amount', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: '', allowed: ['approximately'] } });
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);
    expect(screen.getByText('エージェント入力フィールドを選択してください。')).toBeTruthy();
    expect(screen.getByText('許可リストが壊れていたため全演算子を表示しています。')).toBeTruthy();
    expect(screen.getByText('contains は文字列列向けです。')).toBeTruthy();
  });
});

describe('NodeInspector: filter 演算子定数のピン留め（domain との一致）', () => {
  it('UI の FILTER_OPS / FILTER_VALUELESS_OPS / FILTER_ORDER_OPS / FILTER_CASE_FOLD_OPS は domain の正準リストと一致する', () => {
    expect([...FILTER_OPS]).toEqual([...DOMAIN_FILTER_OPS]);
    expect([...FILTER_VALUELESS_OPS].sort()).toEqual([...DOMAIN_VALUELESS_OPS].sort());
    expect([...FILTER_ORDER_OPS].sort()).toEqual([...DOMAIN_ORDER_OPS].sort());
    expect([...FILTER_CASE_FOLD_OPS].sort()).toEqual([...DOMAIN_CASE_FOLD_OPS].sort());
  });
});

describe('NodeInspector: filter の大文字小文字を区別しない', () => {
  it('文字列比較の演算子でだけチェックボックスを出し、チェックで caseInsensitive: true を書き戻す', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    // 既定 op（gte）は大小比較なのでチェックボックスを出さない。
    expect(screen.queryByLabelText('Ignore case')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Operator'), 'eq');
    await userEvent.click(screen.getByLabelText('Ignore case'));
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'eq', value: 18, caseInsensitive: true });

    // チェックを外すとフラグは書き戻されない（既定 false をキーとして残さない）。
    await userEvent.click(screen.getByLabelText('Ignore case'));
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'eq', value: 18 });
  });

  it('大小比較の演算子へ戻すとフラグを書き戻さない（見えない残留設定を防ぐ）', async () => {
    withUpstreamColumns();
    render(<NodeInspector />);
    await userEvent.selectOptions(screen.getByLabelText('Operator'), 'contains');
    await userEvent.click(screen.getByLabelText('Ignore case'));
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'contains', value: 18, caseInsensitive: true });

    await userEvent.selectOptions(screen.getByLabelText('Operator'), 'gte');
    expect(configOf('filter-1')).toEqual({ column: 'age', op: 'gte', value: 18 });
    expect(screen.queryByLabelText('Ignore case')).toBeNull();
  });

  it('保存済みの caseInsensitive を読み込んでチェック済みで表示する', () => {
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'region', op: 'eq', value: 'tokyo', caseInsensitive: true });
    withUpstreamColumns();
    render(<NodeInspector />);
    expect((screen.getByLabelText('Ignore case') as HTMLInputElement).checked).toBe(true);
  });
});
