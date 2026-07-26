// @vitest-environment jsdom
/**
 * `current-datetime`（入力カテゴリのソースノード）の設定UI。
 * timezone は任意入力で、空欄なら config からキーを落として（= サーバーのローカルtimezone）扱う。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { NodeInspector } from './NodeInspector';
import { useToolBuilderStore } from './store';

const LABEL = 'Timezone (optional)';

afterEach(cleanup);
beforeEach(() => useToolBuilderStore.getState().reset());

/** current-datetime を1つ追加し、その id を返す。 */
function addCurrentDatetime(): string {
  useToolBuilderStore.getState().addNode('current-datetime');
  return useToolBuilderStore.getState().selectedNodeId!;
}

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

describe('NodeInspector: current-datetime', () => {
  it('カタログ既定configは空で、timezone入力も空で始まる', () => {
    const nodeId = addCurrentDatetime();
    render(<NodeInspector />);
    expect(configOf(nodeId)).toEqual({});
    expect((screen.getByLabelText(LABEL) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(LABEL) as HTMLInputElement).placeholder).toBe('Asia/Tokyo');
  });

  it('入力カテゴリのノードとして名称・説明・出力列を案内する', () => {
    addCurrentDatetime();
    render(<NodeInspector />);
    expect(screen.getByRole('heading', { name: 'Current datetime' })).toBeTruthy();
    expect(screen.getByText('Return the date and time at run time as a single row.')).toBeTruthy();
    expect(screen.getByText('Returns one row: now, date, yearMonth, time, weekday.')).toBeTruthy();
  });

  it('IANA timezoneを入力するとconfigへ書き戻す', async () => {
    const nodeId = addCurrentDatetime();
    render(<NodeInspector />);

    await userEvent.type(screen.getByLabelText(LABEL), 'UTC');
    expect(configOf(nodeId)).toEqual({ timezone: 'UTC' });
  });

  it('保存済みtimezoneを表示し、空欄に戻すとキーを落とす', async () => {
    const nodeId = addCurrentDatetime();
    useToolBuilderStore.getState().updateNodeConfig(nodeId, { timezone: 'Asia/Tokyo' });
    render(<NodeInspector />);
    const input = screen.getByLabelText(LABEL) as HTMLInputElement;
    expect(input.value).toBe('Asia/Tokyo');

    await userEvent.clear(input);
    expect(configOf(nodeId)['timezone']).toBeUndefined();
  });

  it('空白だけの入力はtimezone未指定として扱う', async () => {
    const nodeId = addCurrentDatetime();
    render(<NodeInspector />);

    await userEvent.type(screen.getByLabelText(LABEL), '   ');
    expect(configOf(nodeId)['timezone']).toBeUndefined();
  });

  it('日本語表示でもラベル・説明を出す', () => {
    addCurrentDatetime();
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);
    expect(screen.getByLabelText('タイムゾーン（任意）')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '現在日時' })).toBeTruthy();
    expect(screen.getByText('実行時点の日時を1行で返します。')).toBeTruthy();
  });
});
