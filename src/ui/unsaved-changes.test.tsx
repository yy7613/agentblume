// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider, useReportUnsavedChanges, useUnsavedChangesRegistry } from './unsaved-changes';

afterEach(cleanup);

function Editor({ id, unsaved }: { readonly id: string; readonly unsaved: boolean }) {
  useReportUnsavedChanges(id, unsaved);
  return <p>{id} editor</p>;
}

function Host({ initialUnsaved = false }: { readonly initialUnsaved?: boolean }) {
  const [unsaved, setUnsaved] = useState(initialUnsaved);
  const [mounted, setMounted] = useState(true);
  const registry = useUnsavedChangesRegistry();
  return <div>
    <span data-testid="state">{registry.unsaved ? 'unsaved' : 'clean'}</span>
    <button type="button" onClick={() => setUnsaved((current) => !current)}>Toggle</button>
    <button type="button" onClick={() => setMounted(false)}>Unmount</button>
    <UnsavedChangesProvider value={registry.value}>
      {mounted && <Editor id="agent-builder" unsaved={unsaved} />}
    </UnsavedChangesProvider>
  </div>;
}

describe('unsaved changes registry', () => {
  it('画面が未保存を報告している間だけ unsaved になる', async () => {
    render(<Host />);
    expect(screen.getByTestId('state').textContent).toBe('clean');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.getByTestId('state').textContent).toBe('unsaved');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.getByTestId('state').textContent).toBe('clean');
  });

  it('画面がアンマウントされたら未保存フラグを取り下げる', async () => {
    render(<Host initialUnsaved />);
    expect(screen.getByTestId('state').textContent).toBe('unsaved');
    await userEvent.click(screen.getByRole('button', { name: 'Unmount' }));
    expect(screen.getByTestId('state').textContent).toBe('clean');
  });

  it('未保存の間だけ beforeunload を登録し、解消したら外す', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    try {
      render(<Host />);
      expect(add.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
      expect(add.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(1);
      await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
      expect(remove.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('登録した beforeunload はブラウザの離脱警告を要求する', async () => {
    render(<Host initialUnsaved />);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Providerの外で報告しても落ちない', () => {
    expect(() => render(<Editor id="orphan" unsaved />)).not.toThrow();
  });
});
