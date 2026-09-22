// @vitest-environment jsdom
/**
 * join ノードの `coerceKeys`（キーを文字列として比較）と `maxRows`（v46: 結合ごとの行数上限）設定 UI。
 * 既存の join フィールド（mode / キーペア / サフィックス）の回帰は ui-components.test.tsx が担う。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// domain の正準値。UI ソースは domain を import しない方針だが、テストからのピン留め import は可
// （NodeInspector.group-limit-filter.test.tsx と同じ方針）。ずれると片方だけ更新されて上限が食い違う。
import { JOIN_MAX_ROWS_CEILING as DOMAIN_JOIN_MAX_ROWS_CEILING } from '../../domain/etl/nodes/join';
import { JOIN_MAX_ROWS_CEILING, NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const CHECKBOX_LABEL = 'Compare keys as text (join 001 with 1)';
const MAX_ROWS_LABEL = 'Maximum rows';

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

/** join ノードを1つ追加し、その id を返す。 */
function addJoin(): string {
  useToolBuilderStore.getState().addNode('join');
  return useToolBuilderStore.getState().selectedNodeId!;
}

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

/** jest-dom を使わないため、checked は input 要素から直接読む。 */
function isChecked(name: string): boolean {
  return (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;
}

describe('NodeInspector: join coerceKeys', () => {
  it('starts unchecked for a saved config without coerceKeys', () => {
    const nodeId = addJoin();
    expect(configOf(nodeId)).not.toHaveProperty('coerceKeys');
    render(<NodeInspector />);
    expect(isChecked(CHECKBOX_LABEL)).toBe(false);
  });

  it("writes 'string' when checked and 'none' when unchecked again", async () => {
    const nodeId = addJoin();
    render(<NodeInspector />);
    const checkbox = screen.getByRole('checkbox', { name: CHECKBOX_LABEL });

    await userEvent.click(checkbox);
    expect(configOf(nodeId)['coerceKeys']).toBe('string');
    expect(configOf(nodeId)).toMatchObject({ mode: 'inner', keys: [], rightSuffix: '_right' });

    await userEvent.click(screen.getByRole('checkbox', { name: CHECKBOX_LABEL }));
    expect(configOf(nodeId)['coerceKeys']).toBe('none');
  });

  it("renders as checked when the config already has coerceKeys 'string'", () => {
    const nodeId = addJoin();
    useToolBuilderStore.getState().updateNodeConfig(nodeId, { ...configOf(nodeId), coerceKeys: 'string' });
    render(<NodeInspector />);
    expect(isChecked(CHECKBOX_LABEL)).toBe(true);
  });

  it("renders as unchecked for an explicit 'none'", () => {
    const nodeId = addJoin();
    useToolBuilderStore.getState().updateNodeConfig(nodeId, { ...configOf(nodeId), coerceKeys: 'none' });
    render(<NodeInspector />);
    expect(isChecked(CHECKBOX_LABEL)).toBe(false);
  });

  it('applies the dialog toggle only after Apply settings', async () => {
    const nodeId = addJoin();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Node configuration' });

    await userEvent.click(within(dialog).getByRole('checkbox', { name: CHECKBOX_LABEL }));
    expect(configOf(nodeId)).not.toHaveProperty('coerceKeys');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(nodeId)['coerceKeys']).toBe('string');
  });

  it('discards the dialog toggle on Cancel', async () => {
    const nodeId = addJoin();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Node configuration' });

    await userEvent.click(within(dialog).getByRole('checkbox', { name: CHECKBOX_LABEL }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(configOf(nodeId)).not.toHaveProperty('coerceKeys');
  });

  it('keeps the existing join fields and their aria labels', () => {
    addJoin();
    render(<NodeInspector />);
    expect(screen.getByLabelText('Join mode')).toBeTruthy();
    expect(screen.getByLabelText('Right suffix')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add key' })).toBeTruthy();
  });
});

describe('NodeInspector: join maxRows（v46: 結合ごとの行数上限）', () => {
  it('正常: 保存済みconfigにmaxRowsが無ければ欄は空欄（既定を使う）', () => {
    const nodeId = addJoin();
    expect(configOf(nodeId)).not.toHaveProperty('maxRows');
    render(<NodeInspector />);
    expect((screen.getByRole('spinbutton', { name: MAX_ROWS_LABEL }) as HTMLInputElement).value).toBe('');
  });

  it('正常: 数値を入力するとconfigのmaxRowsへ書き戻す', async () => {
    const nodeId = addJoin();
    render(<NodeInspector />);
    const input = screen.getByRole('spinbutton', { name: MAX_ROWS_LABEL });

    await userEvent.type(input, '500000');
    expect(configOf(nodeId)['maxRows']).toBe(500_000);
  });

  it('境界: 欄を空にするとconfigからmaxRowsが外れる（既定に戻る）', async () => {
    const nodeId = addJoin();
    useToolBuilderStore.getState().updateNodeConfig(nodeId, { ...configOf(nodeId), maxRows: 500_000 });
    render(<NodeInspector />);
    const input = screen.getByRole('spinbutton', { name: MAX_ROWS_LABEL });

    await userEvent.clear(input);
    expect(configOf(nodeId)['maxRows']).toBeUndefined();
  });

  it('異常: 範囲外（0以下・1,000万超）はその場で欄の下に指摘し、範囲内では指摘が消える', async () => {
    // 上限の定数(NodeInspector側)が domain の JOIN_MAX_ROWS_CEILING とずれていないことも
    // あわせて確認する（ずれると UI とサーバーの範囲外判定が食い違う）。
    expect(JOIN_MAX_ROWS_CEILING).toBe(DOMAIN_JOIN_MAX_ROWS_CEILING);
    // このファイルは I18nProvider を被せていないため text() は英語文言を返す（既存テストの
    // CHECKBOX_LABEL と同じ前提）。範囲外の指摘もそこに合わせて英語文言で検査する。
    const outOfRange = `Enter a whole number between 1 and ${JOIN_MAX_ROWS_CEILING.toLocaleString('en-US')}.`;
    const nodeId = addJoin();
    render(<NodeInspector />);
    const input = screen.getByRole('spinbutton', { name: MAX_ROWS_LABEL });

    await userEvent.type(input, '0');
    expect(configOf(nodeId)['maxRows']).toBe(0);
    expect(screen.getByText(outOfRange)).toBeTruthy();

    await userEvent.clear(input);
    await userEvent.type(input, String(JOIN_MAX_ROWS_CEILING + 1));
    expect(screen.getByText(outOfRange)).toBeTruthy();

    await userEvent.clear(input);
    await userEvent.type(input, String(JOIN_MAX_ROWS_CEILING));
    expect(screen.queryByText(outOfRange)).toBeNull();
  });

  it('applies the dialog maxRows only after Apply settings', async () => {
    const nodeId = addJoin();
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Node configuration' });

    await userEvent.type(within(dialog).getByRole('spinbutton', { name: MAX_ROWS_LABEL }), '250000');
    expect(configOf(nodeId)).not.toHaveProperty('maxRows');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(configOf(nodeId)['maxRows']).toBe(250_000);
  });
});
