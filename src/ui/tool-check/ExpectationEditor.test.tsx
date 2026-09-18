// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { ExpectationEditor } from './ExpectationEditor';
import { EMPTY_EXPECTATIONS, MAX_JUDGMENT_EXPECTATIONS, MAX_ROW_CELLS, MAX_ROW_EXPECTATIONS, buildExpectations, type AiJudgeNodeInfo, type ExpectationDraft } from './tool-check-model';

/**
 * 期待の編集欄のうち、行の期待と AI判定の期待。編集した下書きが **buildExpectations でそのまま
 * サーバーの DTO になる**ことまで確かめる（画面の状態は ToolCheckPage が持つので、ここでは
 * onChange で返る下書きを次の描画へ渡す小さな親を用意する）。
 */

afterEach(() => { cleanup(); });

const outputSchema: SchemaDto = { columns: [{ name: 'id', type: 'string', nullable: false }, { name: 'amount', type: 'number', nullable: false }] };
const yesNoNode: AiJudgeNodeInfo = { nodeId: 'judge', question: 'この問い合わせはクレームですか？', verdicts: ['yes', 'no', 'unclear'], columns: ['id', 'body'] };
const classifyNode: AiJudgeNodeInfo = { nodeId: 'classify', question: '種類は？', verdicts: ['クレーム', '問い合わせ', 'unclear'], columns: [] };

/** onChange で返った下書きを保持して描き直す（本番の ToolCheckPage と同じ流れ）。 */
function renderEditor(judgeNodes: readonly AiJudgeNodeInfo[] = [], initial: ExpectationDraft = EMPTY_EXPECTATIONS) {
  const latest = { draft: initial };
  function Host() {
    const [draft, setDraft] = useState(initial);
    latest.draft = draft;
    return <ExpectationEditor draft={draft} outputSchema={outputSchema} judgeNodes={judgeNodes} disabled={false} onChange={setDraft} />;
  }
  render(<I18nProvider initialLanguage="ja"><Host /></I18nProvider>);
  return latest;
}

describe('ExpectationEditor: 行の期待', () => {
  it('正常: 列・値・条件を入れると row[] の DTO になる（present は既定なので載せない）', async () => {
    const user = userEvent.setup();
    const latest = renderEditor();
    await user.click(screen.getByRole('button', { name: '行の期待を追加' }));
    await user.selectOptions(screen.getByLabelText('行の期待 1 の列'), 'id');
    await user.type(screen.getByLabelText('行の期待 1 の値'), 'E1');
    await user.click(screen.getByRole('button', { name: '行の期待 1 に条件を追加' }));
    await user.selectOptions(screen.getByLabelText('行の期待 1 の条件 1 の列'), 'amount');
    await user.selectOptions(screen.getByLabelText('行の期待 1 の条件 1 の演算子'), 'gte');
    await user.type(screen.getByLabelText('行の期待 1 の条件 1 の値'), '10000');

    expect(buildExpectations(latest.draft, outputSchema)).toEqual({
      rows: [{ where: { column: 'id', value: 'E1' }, cells: [{ column: 'amount', op: 'gte', value: 10000 }] }],
    });
  });

  it('正常: 「存在しない」を選ぶと present: false を送り、セル条件の欄は消える', async () => {
    const user = userEvent.setup();
    const latest = renderEditor(undefined, {
      ...EMPTY_EXPECTATIONS,
      rows: [{ column: 'id', value: 'E2', present: true, cells: [{ column: 'amount', op: 'eq', value: '1' }] }],
    });
    expect(screen.queryByLabelText('行の期待 1 の条件 1 の列')).not.toBeNull();
    await user.selectOptions(screen.getByLabelText('行の期待 1 の有無'), 'absent');

    expect(screen.queryByLabelText('行の期待 1 の条件 1 の列')).toBeNull();
    expect(buildExpectations(latest.draft, outputSchema)).toEqual({ rows: [{ where: { column: 'id', value: 'E2' }, present: false }] });
  });

  it('正常: 行の期待と条件は削除できる', async () => {
    const user = userEvent.setup();
    const latest = renderEditor(undefined, {
      ...EMPTY_EXPECTATIONS,
      rows: [
        { column: 'id', value: 'E1', present: true, cells: [{ column: 'amount', op: 'eq', value: '1' }, { column: 'amount', op: 'gte', value: '2' }] },
        { column: 'id', value: 'E2', present: false, cells: [] },
      ],
    });
    await user.click(screen.getByRole('button', { name: '行の期待 1 の条件 1 を削除' }));
    expect(buildExpectations(latest.draft, outputSchema)?.rows?.[0]?.cells).toEqual([{ column: 'amount', op: 'gte', value: 2 }]);
    await user.click(screen.getByRole('button', { name: '行の期待 1 を削除' }));
    expect(buildExpectations(latest.draft, outputSchema)).toEqual({ rows: [{ where: { column: 'id', value: 'E2' }, present: false }] });
  });

  it('境界: 上限（行 50 / 条件 20）に達したら追加ボタンを無効にする', () => {
    const rows = Array.from({ length: MAX_ROW_EXPECTATIONS }, () => ({
      column: 'id', value: 'E', present: true,
      cells: Array.from({ length: MAX_ROW_CELLS }, () => ({ column: 'amount', op: 'eq' as const, value: '1' })),
    }));
    renderEditor(undefined, { ...EMPTY_EXPECTATIONS, rows });
    expect(screen.getByRole('button', { name: '行の期待を追加' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '行の期待 1 に条件を追加' }).hasAttribute('disabled')).toBe(true);
  });

  it('境界: 出力スキーマが分からなければ列は自由入力にする', () => {
    render(
      <I18nProvider initialLanguage="ja">
        <ExpectationEditor draft={{ ...EMPTY_EXPECTATIONS, rows: [{ column: '', value: '', present: true, cells: [] }] }} outputSchema={undefined} disabled={false} onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect((screen.getByLabelText('行の期待 1 の列') as HTMLElement).tagName).toBe('INPUT');
  });
});

describe('ExpectationEditor: AI判定の期待', () => {
  it('境界: AI判定ノードが無いツールでは従来どおり節ごと出さない', () => {
    renderEditor([]);
    expect(screen.queryByText('AI判定の期待')).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI判定の期待を追加' })).toBeNull();
  });

  it('正常: AI判定ノードがあれば節を出し、判定が揺れることを説明する', () => {
    renderEditor([yesNoNode]);
    expect(screen.getByText('AI判定の期待')).toBeTruthy();
    expect(screen.getByText(/AIの判定は実行ごとに揺れる/)).toBeTruthy();
  });

  it('正常: ノードの選択肢は ai-judge ノードだけで、ラベルに質問の抜粋を添える', async () => {
    const user = userEvent.setup();
    renderEditor([yesNoNode, classifyNode]);
    await user.click(screen.getByRole('button', { name: 'AI判定の期待を追加' }));
    const node = screen.getByLabelText('AI判定の期待 1 のノード') as HTMLSelectElement;
    expect([...node.options].map((option) => option.textContent)).toEqual(['ノード…', 'judge — この問い合わせはクレームですか？', 'classify — 種類は？']);
  });

  it('正常: はい/いいえのノードは yes / no / unclear を、分類のノードはカテゴリ名 + unclear を選択肢にする', async () => {
    const user = userEvent.setup();
    renderEditor([yesNoNode, classifyNode]);
    await user.click(screen.getByRole('button', { name: 'AI判定の期待を追加' }));
    // 既定は先頭のノード（はい/いいえ）。
    expect(screen.getByLabelText('AI判定の期待 1 の判定値 yes')).toBeTruthy();
    expect(screen.getByLabelText('AI判定の期待 1 の判定値 unclear')).toBeTruthy();
    expect(screen.queryByLabelText('AI判定の期待 1 の判定値 クレーム')).toBeNull();

    await user.selectOptions(screen.getByLabelText('AI判定の期待 1 のノード'), 'classify');
    expect(screen.getByLabelText('AI判定の期待 1 の判定値 クレーム')).toBeTruthy();
    expect(screen.getByLabelText('AI判定の期待 1 の判定値 問い合わせ')).toBeTruthy();
    expect(screen.queryByLabelText('AI判定の期待 1 の判定値 yes')).toBeNull();
  });

  it('正常: ノード・行の特定・判定値（複数可）・理由が judgments[] の DTO になる', async () => {
    const user = userEvent.setup();
    const latest = renderEditor([yesNoNode, classifyNode]);
    await user.click(screen.getByRole('button', { name: 'AI判定の期待を追加' }));
    await user.selectOptions(screen.getByLabelText('AI判定の期待 1 の列'), 'id');
    await user.type(screen.getByLabelText('AI判定の期待 1 の値'), 'E2');
    await user.click(screen.getByLabelText('AI判定の期待 1 の判定値 no'));
    await user.click(screen.getByLabelText('AI判定の期待 1 の判定値 unclear'));
    await user.type(screen.getByLabelText('AI判定の期待 1 の理由に含まれる文字列'), '重複');

    expect(buildExpectations(latest.draft, outputSchema)).toEqual({
      judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no', 'unclear'], reasonContains: '重複' }],
    });
  });

  it('正常: 判定値のチェックを外すと DTO から消え、全部外せば未完成として送らない', async () => {
    const user = userEvent.setup();
    const latest = renderEditor([yesNoNode], {
      ...EMPTY_EXPECTATIONS,
      judgments: [{ nodeId: 'judge', column: 'id', value: 'E2', verdicts: ['no', 'unclear'], reasonContains: '' }],
    });
    await user.click(screen.getByLabelText('AI判定の期待 1 の判定値 unclear'));
    expect(buildExpectations(latest.draft, outputSchema)?.judgments?.[0]?.verdict).toEqual(['no']);
    await user.click(screen.getByLabelText('AI判定の期待 1 の判定値 no'));
    expect(buildExpectations(latest.draft, outputSchema)).toBeUndefined();
  });

  it('境界: モデルに見せる列が未指定のノードは列を自由入力にする', async () => {
    const user = userEvent.setup();
    renderEditor([classifyNode]);
    await user.click(screen.getByRole('button', { name: 'AI判定の期待を追加' }));
    expect((screen.getByLabelText('AI判定の期待 1 の列') as HTMLElement).tagName).toBe('INPUT');
  });

  it('境界: 上限 100 件に達したら追加ボタンを無効にする', () => {
    const judgments = Array.from({ length: MAX_JUDGMENT_EXPECTATIONS }, () => ({ nodeId: 'judge', column: 'id', value: 'E', verdicts: ['yes'], reasonContains: '' }));
    renderEditor([yesNoNode], { ...EMPTY_EXPECTATIONS, judgments });
    expect(screen.getByRole('button', { name: 'AI判定の期待を追加' }).hasAttribute('disabled')).toBe(true);
  });

  it('正常: AI判定の期待は削除できる', async () => {
    const user = userEvent.setup();
    const latest = renderEditor([yesNoNode], {
      ...EMPTY_EXPECTATIONS,
      judgments: [{ nodeId: 'judge', column: 'id', value: 'E1', verdicts: ['yes'], reasonContains: '' }, { nodeId: 'judge', column: 'id', value: 'E2', verdicts: ['no'], reasonContains: '' }],
    });
    await user.click(screen.getByRole('button', { name: 'AI判定の期待 1 を削除' }));
    expect(buildExpectations(latest.draft, outputSchema)?.judgments).toEqual([{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'] }]);
  });
});
