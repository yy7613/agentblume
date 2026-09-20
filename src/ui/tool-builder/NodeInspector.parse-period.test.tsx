// @vitest-environment jsdom
/**
 * 期間の解釈ノード（parse-period）の設定UI。
 *
 * 設定は「どの列か」「出力列の名前」「年度の開始月」だけなので、ダイアログを持たずサイドバーへ
 * 直接置く（ADR-0028 の単純な設定はインライン側）。ここで固定するのは、上流の列から選べること・
 * 変更が config へ入ること・足した 2 列の使い道（粒度で絞ってから開始日で範囲指定・並べ替え）が
 * 画面に書かれていること。
 */
import { cleanup, render, screen } from '@testing-library/react';
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
    { name: '時点', type: 'string' as const, nullable: true },
    { name: '値', type: 'number' as const, nullable: true },
  ],
};

/** 上流（csv-source、スキーマ確定済み）+ parse-period を置き、parse-period を選択した状態にする。 */
function addParsePeriod(): string {
  useToolBuilderStore.getState().addNode('csv-source');
  const sourceId = useToolBuilderStore.getState().selectedNodeId!;
  const propagation: PropagationResultDto = {
    order: [sourceId], terminalId: sourceId, hasErrors: false,
    nodes: { [sourceId]: { nodeId: sourceId, state: 'inferred', issues: [], schema: upstream } },
  };
  useToolBuilderStore.getState().setPropagation(propagation);
  useToolBuilderStore.getState().addNode('parse-period');
  return useToolBuilderStore.getState().selectedNodeId!;
}

/** 上流を繋がない parse-period（空状態の案内を見るため）。 */
function addParsePeriodWithoutUpstream(): string {
  useToolBuilderStore.getState().addNode('parse-period');
  return useToolBuilderStore.getState().selectedNodeId!;
}

function configOf(nodeId: string): Readonly<Record<string, unknown>> {
  return useToolBuilderStore.getState().nodes.find((node) => node.id === nodeId)!.data.config;
}

describe('NodeInspector: parse-period の設定', () => {
  it('正常: 既定configは periodStart / periodGranularity / 年度開始月4 で、欄に出る', () => {
    const id = addParsePeriod();
    render(<NodeInspector />);

    expect(configOf(id)).toEqual({ column: '', startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4 });
    expect((screen.getByLabelText('Period start column') as HTMLInputElement).value).toBe('periodStart');
    expect((screen.getByLabelText('Granularity column') as HTMLInputElement).value).toBe('periodGranularity');
    expect((screen.getByLabelText('Fiscal year start month') as HTMLInputElement).value).toBe('4');
  });

  it('正常: 期間ラベルの列は上流の列から選べて、選ぶとconfigへ入る', async () => {
    const id = addParsePeriod();
    render(<NodeInspector />);
    const select = screen.getByLabelText('Period label column') as HTMLSelectElement;

    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', '時点', '値']);
    await userEvent.selectOptions(select, '時点');
    expect(configOf(id)['column']).toBe('時点');
  });

  it('正常: 出力列名と年度の開始月の変更がconfigへ入る', async () => {
    const id = addParsePeriod();
    render(<NodeInspector />);

    await userEvent.clear(screen.getByLabelText('Period start column'));
    await userEvent.type(screen.getByLabelText('Period start column'), '開始日');
    await userEvent.clear(screen.getByLabelText('Granularity column'));
    await userEvent.type(screen.getByLabelText('Granularity column'), '粒度');
    await userEvent.clear(screen.getByLabelText('Fiscal year start month'));
    await userEvent.type(screen.getByLabelText('Fiscal year start month'), '10');

    expect(configOf(id)['startColumn']).toBe('開始日');
    expect(configOf(id)['granularityColumn']).toBe('粒度');
    expect(configOf(id)['fiscalYearStartMonth']).toBe(10);
  });

  it('境界: 年度の開始月の入力欄は 1..12 に制限されている', () => {
    addParsePeriod();
    render(<NodeInspector />);
    const input = screen.getByLabelText('Fiscal year start month') as HTMLInputElement;
    expect(input.min).toBe('1');
    expect(input.max).toBe('12');
  });

  it('正常: 足した2列の使い道（粒度で絞る → 開始日で範囲指定・並べ替え）を画面に書く', () => {
    addParsePeriod();
    render(<NodeInspector />);
    expect(screen.getByText(/periodGranularity eq month/)).toBeTruthy();
    expect(screen.getByText(/day \/ month \/ quarter \/ half \/ year \/ fiscal-year \/ unknown/)).toBeTruthy();
  });

  it('異常: 列が未選択のあいだは、選ぶよう促す', () => {
    addParsePeriod();
    render(<NodeInspector />);
    expect(screen.getByText('Choose the column that holds the period labels.')).toBeTruthy();
  });

  it('境界: 上流未接続では列の選択肢が空で、接続の案内を出す', () => {
    addParsePeriodWithoutUpstream();
    render(<NodeInspector />);
    expect((screen.getByLabelText('Period label column') as HTMLSelectElement).options).toHaveLength(1);
    expect(screen.getByText('Connect an upstream node to choose a column.')).toBeTruthy();
  });

  it('境界: 保存済みの列名が上流に無くなっても選択は消えない（黙って別の列に化けない）', () => {
    const id = addParsePeriod();
    useToolBuilderStore.getState().updateNodeConfig(id, { ...configOf(id), column: '年月' });
    render(<NodeInspector />);
    const select = screen.getByLabelText('Period label column') as HTMLSelectElement;
    expect(select.value).toBe('年月');
  });

  it('正常: 日本語UIではノード名・欄・案内を日本語で出す（ダイアログは持たない）', () => {
    addParsePeriod();
    render(<I18nProvider initialLanguage="ja"><NodeInspector /></I18nProvider>);

    expect(screen.getByText('期間の解釈')).toBeTruthy();
    expect(screen.getByLabelText('期間ラベルの列')).toBeTruthy();
    expect(screen.getByLabelText('開始日の列')).toBeTruthy();
    expect(screen.getByLabelText('粒度の列')).toBeTruthy();
    expect(screen.getByLabelText('年度の開始月')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '設定を開く' })).toBeNull();
  });
});
