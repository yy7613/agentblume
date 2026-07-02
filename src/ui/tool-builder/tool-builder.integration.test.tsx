// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { PreviewResultDto, PropagationResultDto } from '../api/types';
import { ToolBuilder } from './ToolBuilder';
import { useToolBuilderStore } from './store';

vi.mock('./FlowCanvas', () => ({ FlowCanvas: () => <div aria-label="ETL canvas" /> }));
vi.mock('./NodePalette', () => ({ NodePalette: () => <aside aria-label="Node palette" /> }));

const valid: PropagationResultDto = {
  order: ['source-1', 'filter-1'], hasErrors: false,
  nodes: {
    'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
    'filter-1': { nodeId: 'filter-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
  },
};
const sample: PreviewResultDto = {
  terminalId: 'filter-1', output: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] },
  nodes: { 'filter-1': { nodeId: 'filter-1', truncated: false, table: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] } } },
};

beforeEach(() => { useToolBuilderStore.getState().reset(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ToolBuilder preview integration', () => {
  it('debounce infer→previewでsampleを描画し、次のissueではpreviewを抑止する', async () => {
    const invalid: PropagationResultDto = {
      ...valid, hasErrors: true,
      nodes: { ...valid.nodes, 'filter-1': { ...valid.nodes['filter-1']!, state: 'mismatch', issues: [{ severity: 'error', message: 'age is missing', column: 'age' }] } },
    };
    const client = {
      inferDraft: vi.fn().mockResolvedValueOnce(valid).mockResolvedValueOnce(invalid),
      previewDraft: vi.fn().mockResolvedValue(sample),
    } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('cell', { name: '30' })).toBeTruthy();
    expect(client.previewDraft).toHaveBeenCalledOnce();

    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'missing', op: 'eq', value: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getAllByText('age is missing').length).toBeGreaterThan(0);
    expect(client.previewDraft).toHaveBeenCalledOnce();
  });
});
