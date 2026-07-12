// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

describe('structured node configuration dialogs', () => {
  it('opens structured editors for complex nodes and keeps Cancel changes out of the graph', async () => {
    const user = userEvent.setup();
    const cases: Array<{ type: 'agent-input' | 'json-source' | 'csv-source' | 'database-source' | 'rename' | 'cast' | 'join' | 'sort' | 'fill-null' | 'replace' | 'workspace-output'; add?: string }> = [
      { type: 'agent-input', add: 'Add column' }, { type: 'json-source' }, { type: 'csv-source' }, { type: 'database-source' },
      { type: 'rename', add: 'Add rename' }, { type: 'cast', add: 'Add cast' }, { type: 'join', add: 'Add key' },
      { type: 'sort', add: 'Add key' }, { type: 'fill-null', add: 'Add rule' }, { type: 'replace', add: 'Add replacement' }, { type: 'workspace-output' },
    ];
    for (const item of cases) {
      useToolBuilderStore.getState().reset();
      useToolBuilderStore.getState().addNode(item.type);
      const before = structuredClone(useToolBuilderStore.getState().nodes.find((node) => node.id === useToolBuilderStore.getState().selectedNodeId)?.data.config);
      const view = render(<NodeInspector />);
      await user.click(screen.getByRole('button', { name: 'Open settings' }));
      const dialog = screen.getByRole('dialog', { name: 'Node configuration' });
      if (item.add !== undefined) await user.click(within(dialog).getByRole('button', { name: item.add }));
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(useToolBuilderStore.getState().nodes.find((node) => node.id === useToolBuilderStore.getState().selectedNodeId)?.data.config).toEqual(before);
      view.unmount();
    }
  });
});
