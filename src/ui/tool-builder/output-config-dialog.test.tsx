// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

describe('output configuration dialog', () => {
  beforeEach(() => useToolBuilderStore.getState().reset());
  afterEach(cleanup);

  it('edits output configuration in a local draft and applies it atomically', async () => {
    useToolBuilderStore.getState().addNode('agent-output');
    const id = useToolBuilderStore.getState().selectedNodeId as string;
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Node configuration' });
    const maxRows = within(dialog).getByLabelText('Maximum rows');
    fireEvent.change(maxRows, { target: { value: '7' } });
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === id)?.data.config['maxRows']).toBe(100);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === id)?.data.config['maxRows']).toBe(7);
  });

  it('configures graph source and target columns in the Graph Output dialog', async () => {
    useToolBuilderStore.getState().addNode('graph-output');
    const id = useToolBuilderStore.getState().selectedNodeId as string;
    useToolBuilderStore.getState().setPropagation({
      order: ['source-1', 'filter-1', id], hasErrors: false,
      nodes: {
        'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'name', type: 'string', nullable: false }] } },
        'filter-1': { nodeId: 'filter-1', state: 'confirmed', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'name', type: 'string', nullable: false }] } },
        [id]: { nodeId: id, state: 'confirmed', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'name', type: 'string', nullable: false }] } },
      },
    });
    render(<NodeInspector />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Node configuration' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Source column'), 'id');
    await userEvent.selectOptions(within(dialog).getByLabelText('Target column'), 'name');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === id)?.data.config).toMatchObject({ graph: { sourceColumn: 'id', targetColumn: 'name' } });
  });
});
