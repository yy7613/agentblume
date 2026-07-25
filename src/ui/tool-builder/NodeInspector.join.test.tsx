// @vitest-environment jsdom
/**
 * join ノードの `coerceKeys`（キーを文字列として比較）設定 UI。
 * 既存の join フィールド（mode / キーペア / サフィックス）の回帰は ui-components.test.tsx が担う。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const CHECKBOX_LABEL = 'Compare keys as text (join 001 with 1)';

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
