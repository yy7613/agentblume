// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { AgentToolContextPanel } from './AgentToolContextPanel';
import { useToolBuilderStore } from './store';

function renderPanel() {
  return render(<I18nProvider><AgentToolContextPanel /></I18nProvider>);
}

beforeEach(() => useToolBuilderStore.getState().reset());
afterEach(cleanup);

describe('Tool Calling契約の引数編集', () => {
  it('引数名を連続入力しても1文字ごとにフォーカスを失わない', async () => {
    // 行のReact keyに column.name を混ぜていた頃は、1文字入力するたびに行が再マウントされて
    // input が作り直され、"category" と打っても "c" しか入らなかった。
    useToolBuilderStore.getState().addNode('agent-input');
    renderPanel();

    const user = userEvent.setup();
    const nameInput = screen.getByLabelText('Argument name 1');
    await user.clear(nameInput);
    await user.type(nameInput, 'category');

    expect((nameInput as HTMLInputElement).value).toBe('category');
    expect(document.activeElement).toBe(nameInput);
    const inputNode = useToolBuilderStore.getState().nodes.find((node) => node.data.nodeType === 'agent-input');
    const columns = (inputNode?.data.config['schema'] as { columns: { name: string }[] }).columns;
    expect(columns[0]?.name).toBe('category');
  });

  it('引数を2つ宣言しても、後から前の行の名前を編集できる', async () => {
    useToolBuilderStore.getState().addNode('agent-input');
    renderPanel();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add argument' }));

    const first = screen.getByLabelText('Argument name 1');
    await user.clear(first);
    await user.type(first, 'minRating');

    expect((first as HTMLInputElement).value).toBe('minRating');
    expect(screen.getByLabelText('Argument name 2')).toBeTruthy();
  });
});
