// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { I18nProvider, type Language } from '../i18n';
import { DatasetsTab, binaryLevels } from './DatasetsTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };
const rubricSummary = { internalId: 'quality-rubric', displayName: 'Quality rubric', publishName: 'quality_rubric', latestVersion: '1.0.0', state: 'draft', criterionCount: 1 };
const savedRubric = {
  metadata: { internalId: 'quality-rubric', workingName: 'Saved draft', displayName: 'Quality rubric', publishName: 'quality_rubric', owner: 'owner', version: '1.0.0' },
  instructions: 'Judge accuracy.', referencePolicy: 'optional', reasonRequired: true,
  criteria: [{ id: 'accuracy', label: 'Accuracy', description: 'Factual correctness', weight: 1, levels: [{ score: 0, label: 'Wrong', description: 'Incorrect' }, { score: 0.5, label: 'Partly', description: 'Partly correct' }, { score: 1, label: 'Correct', description: 'Fully correct' }] }],
};

function makeClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listEvaluationDatasets: vi.fn().mockResolvedValue([]),
    listEvaluatorProfiles: vi.fn().mockResolvedValue([]),
    listJudgeRubrics: vi.fn().mockResolvedValue([]),
    listScenarios: vi.fn().mockResolvedValue([]),
    saveJudgeRubric: vi.fn().mockResolvedValue({ metadata: { internalId: 'default-quality-rubric', version: '1.0.0' } }),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderTab(client: ToolApiClient, language?: Language): void {
  const tab = <DatasetsTab client={client} scope={scope} />;
  render(language === undefined ? tab : <I18nProvider initialLanguage={language}>{tab}</I18nProvider>);
}

const savedInput = (client: ToolApiClient): Record<string, unknown> => (client.saveJudgeRubric as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;

describe('DatasetsTab の Judge Rubric 編集（実行履歴ポリシー・二値化・重みの説明）', () => {
  it('実行履歴ポリシーの select は既定 optional で、未操作でも保存 DTO に tracePolicy を常に含める', async () => {
    const client = makeClient();
    renderTab(client);
    const select = await screen.findByRole('combobox', { name: 'Judge trace policy' }) as HTMLSelectElement;
    expect(select.value).toBe('optional');
    expect(select.options.length).toBe(3);
    await userEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
    await waitFor(() => expect(client.saveJudgeRubric).toHaveBeenCalled());
    expect(savedInput(client)).toMatchObject({ referencePolicy: 'optional', tracePolicy: 'optional' });
  });

  it('実行履歴ポリシーを required に変えると保存 DTO の tracePolicy が required になる', async () => {
    const client = makeClient();
    renderTab(client);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Judge trace policy' }), 'required');
    await userEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
    await waitFor(() => expect(client.saveJudgeRubric).toHaveBeenCalled());
    expect(savedInput(client)).toMatchObject({ tracePolicy: 'required' });
  });

  it('保存済みルーブリックを開くと tracePolicy が復元され、tracePolicy の無い旧ルーブリックは optional に戻る', async () => {
    const getJudgeRubric = vi.fn()
      .mockResolvedValueOnce({ ...savedRubric, tracePolicy: 'forbidden' })
      .mockResolvedValueOnce(savedRubric);
    const client = makeClient({ listJudgeRubrics: vi.fn().mockResolvedValue([rubricSummary]), getJudgeRubric });
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: /Quality rubric/ }));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Judge trace policy' }) as HTMLSelectElement).value).toBe('forbidden'));
    await userEvent.click(screen.getByRole('button', { name: /Quality rubric/ }));
    await waitFor(() => expect(getJudgeRubric).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Judge trace policy' }) as HTMLSelectElement).value).toBe('optional'));
  });

  it('「二値にする」は 3 水準の基準を 0 = Not met / 1 = Met の 2 水準へ置き換え、他の基準には触れない', async () => {
    const client = makeClient({ listJudgeRubrics: vi.fn().mockResolvedValue([rubricSummary]), getJudgeRubric: vi.fn().mockResolvedValue(savedRubric) });
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: /Quality rubric/ }));
    await screen.findByDisplayValue('Partly');
    await userEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    await userEvent.click(screen.getByRole('button', { name: 'Make criterion 1 binary' }));
    expect(screen.queryByDisplayValue('Partly')).toBeNull();
    expect((screen.getByRole('spinbutton', { name: 'Criterion 1 level 1 score' }) as HTMLInputElement).value).toBe('0');
    expect((screen.getByRole('textbox', { name: 'Criterion 1 level 1 label' }) as HTMLInputElement).value).toBe('Not met');
    expect((screen.getByRole('spinbutton', { name: 'Criterion 1 level 2 score' }) as HTMLInputElement).value).toBe('1');
    expect((screen.getByRole('textbox', { name: 'Criterion 1 level 2 label' }) as HTMLInputElement).value).toBe('Met');
    expect(screen.queryByRole('spinbutton', { name: 'Criterion 1 level 3 score' })).toBeNull();
    // 追加した基準 2 はテンプレートのまま。
    expect((screen.getByRole('textbox', { name: 'Criterion 2 level 1 label' }) as HTMLInputElement).value).toBe('Does not meet');
    await userEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
    await waitFor(() => expect(client.saveJudgeRubric).toHaveBeenCalled());
    expect((savedInput(client).criteria as { levels: unknown }[])[0]?.levels).toEqual(binaryLevels('en'));
  });

  it('日本語 UI では「二値にする」が 未達 / 達成 のラベルを入れる', async () => {
    const client = makeClient();
    renderTab(client, 'ja');
    await userEvent.click(await screen.findByRole('button', { name: '基準 1 を二値にする' }));
    expect((screen.getByRole('textbox', { name: '基準 1 ラベル' }) as HTMLInputElement).value).toBe('Criterion 1');
    expect((screen.getByRole('textbox', { name: '基準 1 レベル 1 ラベル' }) as HTMLInputElement).value).toBe('未達');
    expect((screen.getByRole('textbox', { name: '基準 1 レベル 2 説明' }) as HTMLInputElement).value).toBe('基準を満たしている');
  });

  it('既に二値の基準に「二値にする」を押しても 2 水準のまま（境界: 冪等）', async () => {
    const client = makeClient();
    renderTab(client);
    const button = await screen.findByRole('button', { name: 'Make criterion 1 binary' });
    await userEvent.click(button); await userEvent.click(button);
    expect(screen.getAllByRole('spinbutton', { name: /Criterion 1 level \d score/ })).toHaveLength(2);
  });

  it('重みの意味（合成スコアの式）と二値推奨の案内、実行履歴ポリシーの一行説明を表示する', async () => {
    const client = makeClient();
    renderTab(client);
    expect(await screen.findByText(/Composite score = Σ weight × level ÷ Σ weight \(criteria the judge could not assess are excluded\)/)).toBeTruthy();
    expect(screen.getByText(/Binary 0 \/ 1 levels are recommended/)).toBeTruthy();
    expect(screen.getByText(/Trace policy: optional = show the tool calls/)).toBeTruthy();
  });

  it('保存が失敗すると原因をアラートで出し、フォームの値は保持する（例外）', async () => {
    const client = makeClient({ saveJudgeRubric: vi.fn().mockRejectedValue(new Error('rubric rejected')) });
    renderTab(client);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Judge trace policy' }), 'forbidden');
    await userEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect((await screen.findByRole('alert')).textContent).toBe('rubric rejected');
    expect((screen.getByRole('combobox', { name: 'Judge trace policy' }) as HTMLSelectElement).value).toBe('forbidden');
  });

  it('正常: 所有者を空欄にしても Save は有効のままで、空欄のまま保存 DTO に渡す（サーバーが利用者名で埋める）', async () => {
    const client = makeClient();
    renderTab(client);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Judge rubric owner' }), { target: { value: '' } });
    const save = screen.getByRole('button', { name: 'Save rubric' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(client.saveJudgeRubric).toHaveBeenCalled());
    expect(savedInput(client)).toMatchObject({ owner: '' });
  });

  it('二値化しても Save は有効のままで、基準 ID を空にすると無効になる（既存の検証は変えない）', async () => {
    const client = makeClient();
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Make criterion 1 binary' }));
    expect((screen.getByRole('button', { name: 'Save rubric' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Criterion 1 ID' }), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Save rubric' }) as HTMLButtonElement).disabled).toBe(true);
  });
});


describe('DatasetsTab の軌跡ポリシー「必須」の注意と openRubric 依頼', () => {
  it('軌跡ポリシーを required にすると注意が出て、optional / forbidden に戻すと消える', async () => {
    renderTab(makeClient());
    const select = await screen.findByRole('combobox', { name: 'Judge trace policy' });
    expect(screen.queryByText(/"required" works with turn cases only/)).toBeNull();
    await userEvent.selectOptions(select, 'required');
    const hint = screen.getByRole('note');
    expect(hint.getAttribute('data-hint')).toBe('trace-required');
    expect(hint.textContent).toBe('"required" works with turn cases only. Scenario cases never produce a tool trace, so the judgement fails for them.');
    await userEvent.selectOptions(select, 'optional');
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.selectOptions(select, 'forbidden');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('日本語 UI では注意が日本語になり、required の保存済みルーブリックを開いたときも出る', async () => {
    const getJudgeRubric = vi.fn().mockResolvedValue({ ...savedRubric, tracePolicy: 'required' });
    renderTab(makeClient({ listJudgeRubrics: vi.fn().mockResolvedValue([rubricSummary]), getJudgeRubric }), 'ja');
    await userEvent.click(await screen.findByRole('button', { name: /Quality rubric/ }));
    expect((await screen.findByRole('note')).textContent).toBe('「必須」はターン事例だけで使えます。シナリオ事例では軌跡が得られず判定が失敗します');
  });

  it('openRubric 依頼でそのルーブリック（版つき）を読み込み、同じ ID でも新しい依頼オブジェクトなら読み直す', async () => {
    const getJudgeRubric = vi.fn().mockResolvedValue(savedRubric);
    const client = makeClient({ getJudgeRubric });
    const { rerender } = render(<DatasetsTab client={client} scope={scope} openRubric={{ internalId: 'quality-rubric', version: '1.0.0' }} />);
    await waitFor(() => expect(getJudgeRubric).toHaveBeenCalledWith('quality-rubric', scope, '1.0.0'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Judge rubric internal ID' }) as HTMLInputElement).value).toBe('quality-rubric'));
    rerender(<DatasetsTab client={client} scope={scope} openRubric={{ internalId: 'quality-rubric' }} />);
    await waitFor(() => expect(getJudgeRubric).toHaveBeenCalledTimes(2));
    expect(getJudgeRubric).toHaveBeenLastCalledWith('quality-rubric', scope);
  });

  it('境界: openRubric が無ければ getJudgeRubric を呼ばない。例外: 読み込み失敗はアラートで出しフォームは既定値のまま', async () => {
    const getJudgeRubric = vi.fn().mockRejectedValue(new Error('rubric gone'));
    const client = makeClient({ getJudgeRubric });
    const { rerender } = render(<DatasetsTab client={client} scope={scope} />);
    await screen.findByRole('combobox', { name: 'Judge trace policy' });
    expect(getJudgeRubric).not.toHaveBeenCalled();
    rerender(<DatasetsTab client={client} scope={scope} openRubric={{ internalId: 'missing' }} />);
    expect((await screen.findByRole('alert')).textContent).toBe('rubric gone');
    expect((screen.getByRole('textbox', { name: 'Judge rubric internal ID' }) as HTMLInputElement).value).toBe('default-quality-rubric');
  });
});
