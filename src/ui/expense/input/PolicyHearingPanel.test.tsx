// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from '../../api/business-api';
import type { ExpensePolicyDiffDto, ExpensePolicyHearingDto, ExpensePolicyHearingSummaryDto } from '../../api/expense-input-types';
import type { ExpenseCapabilitiesDto, ExpensePolicyDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import { NavigationProvider, consumePendingOpen } from '../../navigation';
import { scope } from '../../scope';
import { PolicyHearingPanel } from './PolicyHearingPanel';
import { compactValue } from './input-shared';

afterEach(() => { cleanup(); consumePendingOpen('Settings'); });

const ON: ExpenseCapabilitiesDto = { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: false }, policyHearing: { enabled: true } };
const policy = { categories: [], updatedAt: '2026-09-01T00:00:00.000Z' } as unknown as ExpensePolicyDto;
const savedPolicy = { categories: [], updatedAt: '2026-09-15T00:00:00.000Z' } as unknown as ExpensePolicyDto;

const base = { source: {}, turns: [], basePolicyUpdatedAt: '2026-09-01T00:00:00.000Z', promptVersion: 'expense-policy-hearing/v1', createdAt: 'x', updatedAt: 'x' };
const proposed = {
  ...base, id: 'h1', mode: 'document', status: 'proposed',
  proposal: { candidate: {}, rationales: [], dropped: [{ path: 'categories.taxi.limits.perItem', reason: '負の金額は使えません' }], warnings: ['規程文に根拠が見つからない数値です'] },
} as unknown as ExpensePolicyHearingDto;
const diff: ExpensePolicyDiffDto = {
  basePolicyUpdatedAt: '2026-09-02T00:00:00.000Z', stale: true,
  changes: [
    { id: 'c1', kind: 'update', section: 'category', key: 'meal', path: 'categories.meal.limits.perPerson', before: 5000, after: 10000, rationale: { path: 'categories.meal.limits.perPerson', quote: '1人あたり1万円', quoteFound: true, note: '第5条' } },
    { id: 'c2', kind: 'add', section: 'claim-rule', key: 'deadline', path: 'claimRules.submissionDeadlineDays', before: undefined, after: 60, rationale: { path: 'claimRules.submissionDeadlineDays', quote: '60日', quoteFound: false } },
    { id: 'c3', kind: 'disable', section: 'category', key: 'misc', path: 'categories.misc.enabled', before: { enabled: true, name: 'x'.repeat(200) }, after: false },
  ],
};
const questioning = {
  ...base, id: 'h2', mode: 'questions', status: 'open',
  turns: [{ askedAt: 'x', questions: [
    { id: 'q1', text: '交際費の基準は？', kind: 'single', options: ['税込', '税抜'], topic: 'entertainment' },
    { id: 'q2', text: '領収書が要らない費目は？', kind: 'multi', options: ['交通費', '会議費'], topic: 'receipt' },
    { id: 'q3', text: '提出期限（日）', kind: 'number', topic: 'deadline' },
    { id: 'q4', text: '通勤定期を控除しますか？', kind: 'confirm', topic: 'commuter' },
    { id: 'q5', text: 'タクシーの利用条件', kind: 'text', topic: 'taxi' },
  ] }],
} as unknown as ExpensePolicyHearingDto;

type Handler = (path: string, init: RequestInit | undefined) => unknown;

function renderPanel(handler: Handler, options: { readonly capabilities?: ExpenseCapabilitiesDto | undefined; readonly dirty?: boolean } = {}) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  const onPolicySaved = vi.fn();
  const navigate = vi.fn();
  render(<NavigationProvider navigate={navigate}>
    <PolicyHearingPanel transport={{ request } as unknown as ApiTransport} scope={scope} onOpen={vi.fn()} policy={policy} dirty={options.dirty ?? false}
      capabilities={'capabilities' in options ? options.capabilities : ON} onPolicySaved={onPolicySaved} />
  </NavigationProvider>);
  return { request, onPolicySaved, navigate };
}

/** 既定の応答。`overrides` の path（前方一致）が先に当たる。 */
function routes(overrides: Record<string, Handler> = {}): Handler {
  return (path, init) => {
    for (const [prefix, handle] of Object.entries(overrides)) if (path.startsWith(prefix)) return handle(path, init);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/expense/policy-hearings?')) return { hearings: [] };
    if (method === 'POST' && path === '/expense/policy-hearings') return { hearing: proposed };
    if (path.startsWith('/expense/policy-hearings/h1/diff?')) return diff;
    if (path === '/expense/policy-hearings/h1/accept') return { hearing: { ...proposed, status: 'accepted' }, policy: savedPolicy };
    if (path === '/expense/policy-hearings/h1/cancel' || path === '/expense/policy-hearings/h2/cancel') return { hearing: { ...proposed, status: 'cancelled' } };
    if (path === '/expense/policy-hearings/h2/answers') return { hearing: proposed };
    if (method === 'GET' && path.startsWith('/expense/policy-hearings/h1?')) return { hearing: proposed };
    throw new Error(`unexpected ${method} ${path}`);
  };
}

const bodyOf = (request: ReturnType<typeof vi.fn>, path: string) => JSON.parse(String(request.mock.calls.find(([candidate]) => candidate === path)?.[1]?.body)) as Record<string, unknown>;
const callsTo = (request: ReturnType<typeof vi.fn>, prefix: string) => request.mock.calls.filter(([path]) => String(path).startsWith(prefix)).length;

async function startDocument(text = '第5条 交際費は1人あたり1万円まで') {
  await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Rules text' }), text);
  await userEvent.click(screen.getByRole('button', { name: 'Create a proposal' }));
}

describe('PolicyHearingPanel', () => {
  it('境界: 使えないときはボタンを押せず「設定でモデルを選ぶと使えます」+ 設定を開く（alert にしない）', async () => {
    const { request, navigate } = renderPanel(routes(), { capabilities: undefined });
    expect((screen.getByRole('button', { name: 'Draft from company rules' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Available once a model is chosen in Settings')).toBeTruthy();
    expect(screen.getByText('The server has not reported whether drafting is available yet.')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Choose a model in Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
    expect(request).not.toHaveBeenCalled();
    cleanup();
    renderPanel(routes(), { capabilities: { ...ON, policyHearing: { enabled: false } } });
    expect(screen.getByText('Drafting the policy needs a main model with structured output.')).toBeTruthy();
  });

  it('正常: 文書モード → 差分（既定は何も選ばない）→ 根拠のある変更をすべて選ぶ → 選んだ変更を保存', async () => {
    const { request, onPolicySaved } = renderPanel(routes());
    await startDocument();
    expect(screen.getByText('If the main model is an external provider, the rule text you paste is sent to that provider.')).toBeTruthy();
    expect(await screen.findByText('Proposed changes')).toBeTruthy();
    expect(bodyOf(request, '/expense/policy-hearings')).toEqual({ scope, mode: 'document', documentText: '第5条 交際費は1人あたり1万円まで' });

    expect(await screen.findByText('categories.meal.limits.perPerson')).toBeTruthy();
    expect(screen.getByText('The policy changed after the proposal was made (the diff was recreated against the current policy).')).toBeTruthy();
    expect(screen.getByText('規程文に根拠が見つからない数値です')).toBeTruthy();
    expect(screen.getByText(/負の金額は使えません/)).toBeTruthy();
    expect(screen.getByText('Source found')).toBeTruthy();
    expect(screen.getByText('Source not found')).toBeTruthy();
    expect(screen.getByText('No source')).toBeTruthy();
    expect(screen.getByText('Change')).toBeTruthy();
    expect(screen.getByText('Add')).toBeTruthy();
    expect(screen.getByText('Disable')).toBeTruthy();
    expect(screen.getByText('0 of 3 selected')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save the selected changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Select all changes with a source' }));
    expect((screen.getByLabelText('Use categories.meal.limits.perPerson') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Use claimRules.submissionDeadlineDays') as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByLabelText('Use categories.misc.enabled'));
    await userEvent.click(screen.getByLabelText('Use categories.misc.enabled'));
    expect(screen.getByText('1 of 3 selected')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Save the selected changes' }));
    await waitFor(() => expect(onPolicySaved).toHaveBeenCalledWith({ policy: savedPolicy, saved: true }));
    expect(bodyOf(request, '/expense/policy-hearings/h1/accept')).toEqual({ scope, changeIds: ['c1'], basePolicyUpdatedAt: '2026-09-02T00:00:00.000Z' });
    expect(await screen.findByText('Saved 1 change(s) to the policy. Check the claims again to apply them.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start another hearing' }));
    expect(screen.getByRole('button', { name: 'Create a proposal' })).toBeTruthy();
  });

  it('正常: 規程タブに未保存の変更があれば、保存の前に「読み直しで消えます」の確認を挟む', async () => {
    const { onPolicySaved } = renderPanel(routes(), { dirty: true });
    await startDocument();
    await userEvent.click(await screen.findByLabelText('Use claimRules.submissionDeadlineDays'));
    await userEvent.click(screen.getByRole('button', { name: 'Save the selected changes' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Unsaved changes on the policy tab will be lost when the policy is reloaded.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onPolicySaved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save the selected changes' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save the selected changes' }));
    await waitFor(() => expect(onPolicySaved).toHaveBeenCalledWith({ policy: savedPolicy, saved: true }));
  });

  it('異常: 保存が 409 EXPENSE_POLICY_CONFLICT なら「差分を作り直す」で差分を読み直し、選択を外す', async () => {
    const { request, onPolicySaved } = renderPanel(routes({ '/expense/policy-hearings/h1/accept': () => { throw new ApiError(409, 'EXPENSE_POLICY_CONFLICT', 'conflict', undefined, { details: { currentUpdatedAt: 'z' } }); } }));
    await startDocument();
    await userEvent.click(await screen.findByLabelText('Use categories.meal.limits.perPerson'));
    await userEvent.click(screen.getByRole('button', { name: 'Save the selected changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The policy changed after the proposal was made');
    expect(onPolicySaved).not.toHaveBeenCalled();
    expect(callsTo(request, '/expense/policy-hearings/h1/diff')).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Recreate the diff' }));
    await waitFor(() => expect(callsTo(request, '/expense/policy-hearings/h1/diff')).toBe(2));
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
    expect((screen.getByLabelText('Use categories.meal.limits.perPerson') as HTMLInputElement).checked).toBe(false);
  });

  it('異常: 502 EXPENSE_HEARING_SCHEMA は「もう一度試す」と「別のモデルで試す（設定を開く）」', async () => {
    let calls = 0;
    const { navigate } = renderPanel(routes({
      '/expense/policy-hearings': (path, init) => {
        if (path !== '/expense/policy-hearings' || init?.method !== 'POST') return routes()(path, init);
        calls += 1;
        if (calls === 1) throw new ApiError(502, 'EXPENSE_HEARING_SCHEMA', 'bad schema', undefined, { details: { issues: ['x'] } });
        return { hearing: proposed };
      },
    }));
    await startDocument();
    expect((await screen.findByRole('alert')).textContent).toContain('The proposal did not fit the expected form');
    await userEvent.click(screen.getByRole('button', { name: 'Try another model (open Settings)' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Proposed changes')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('異常: 409 EXPENSE_HEARING_UNAVAILABLE は設定を開くボタンつきの案内。その他の失敗は「もう一度試す」', async () => {
    renderPanel(routes({ '/expense/policy-hearings': (path, init) => {
      if (init?.method === 'POST') throw new ApiError(409, 'EXPENSE_HEARING_UNAVAILABLE', 'no model', undefined, { details: { missing: 'model' } });
      return routes()(path, init);
    } }));
    await startDocument();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Available once a model is chosen in Settings');
    expect(within(alert).getByRole('button', { name: 'Choose a model in Settings' })).toBeTruthy();
    cleanup();

    let calls = 0;
    renderPanel(routes({ '/expense/policy-hearings': (path, init) => {
      if (init?.method !== 'POST') return routes()(path, init);
      calls += 1;
      if (calls === 1) throw new Error('server is busy');
      return { hearing: proposed };
    } }));
    await startDocument();
    expect(await screen.findByText('server is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Proposed changes')).toBeTruthy();
  });

  it('正常: 質問モードは質問の種類ごとに答えて回答を送り、案ができたら差分を読む', async () => {
    const { request } = renderPanel(routes({ '/expense/policy-hearings': (path, init) => (path === '/expense/policy-hearings' && init?.method === 'POST' ? { hearing: questioning } : routes()(path, init)) }));
    await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
    await userEvent.click(screen.getByLabelText('Answer questions'));
    expect(screen.queryByRole('textbox', { name: 'Rules text' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start the questions' }));
    expect(await screen.findByText('交際費の基準は？')).toBeTruthy();
    expect(bodyOf(request, '/expense/policy-hearings')).toEqual({ scope, mode: 'questions' });

    await userEvent.click(screen.getByLabelText('税抜'));
    await userEvent.click(screen.getByLabelText('税込'));
    await userEvent.click(screen.getByLabelText('交通費'));
    await userEvent.click(screen.getByLabelText('会議費'));
    await userEvent.click(screen.getByLabelText('会議費'));
    await userEvent.type(screen.getByRole('spinbutton', { name: '提出期限（日）' }), '30');
    await userEvent.click(screen.getByLabelText('No'));
    await userEvent.click(screen.getByLabelText('Yes'));
    await userEvent.type(screen.getByRole('textbox', { name: 'タクシーの利用条件' }), '終電後');
    await userEvent.click(screen.getByRole('button', { name: 'Send the answers' }));

    expect(await screen.findByText('categories.meal.limits.perPerson')).toBeTruthy();
    expect(bodyOf(request, '/expense/policy-hearings/h2/answers')).toEqual({ scope, answers: [
      { questionId: 'q1', value: '税込' }, { questionId: 'q2', value: ['交通費'] }, { questionId: 'q3', value: 30 }, { questionId: 'q4', value: true }, { questionId: 'q5', value: '終電後' },
    ] });
  });

  it('正常: 「このヒアリングをやめる」は取り消しを送り、始め方の画面に戻る', async () => {
    const { request } = renderPanel(routes({ '/expense/policy-hearings': (path, init) => (path === '/expense/policy-hearings' && init?.method === 'POST' ? { hearing: questioning } : routes()(path, init)) }));
    await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
    await userEvent.click(screen.getByLabelText('Answer questions'));
    await userEvent.click(screen.getByRole('button', { name: 'Start the questions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop this hearing' }));
    expect(await screen.findByText('The hearing was cancelled. The policy was not changed.')).toBeTruthy();
    expect(callsTo(request, '/expense/policy-hearings/h2/cancel')).toBe(1);
    expect(screen.getByRole('button', { name: 'Start the questions' })).toBeTruthy();
  });

  it('正常: 開くと直近の open / proposed を再開でき、差分を読む。一覧の失敗は画面を止めない', async () => {
    const summaries: ExpensePolicyHearingSummaryDto[] = [
      { id: 'h1', mode: 'document', status: 'proposed', fileName: '旅費規程.md', turnCount: 0, proposedItemCount: 3, droppedCount: 1, createdAt: 'x', updatedAt: 'x' },
      { id: 'h3', mode: 'questions', status: 'open', turnCount: 1, proposedItemCount: 0, droppedCount: 0, createdAt: 'x', updatedAt: 'x' },
      { id: 'h4', mode: 'document', status: 'open', turnCount: 0, proposedItemCount: 0, droppedCount: 0, createdAt: 'x', updatedAt: 'x' },
      { id: 'h9', mode: 'document', status: 'accepted', fileName: 'old.md', turnCount: 0, proposedItemCount: 1, droppedCount: 0, createdAt: 'x', updatedAt: 'x' },
    ];
    renderPanel(routes({ '/expense/policy-hearings?': () => ({ hearings: summaries }) }));
    await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
    expect(await screen.findByText('Continue a hearing')).toBeTruthy();
    expect(screen.getByText(/旅費規程\.md/)).toBeTruthy();
    expect(screen.getByText(/Questions \(answering\)/)).toBeTruthy();
    expect(screen.getByText(/Pasted rules/)).toBeTruthy();
    expect(screen.queryByText(/old\.md/)).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'Resume' })[0] as HTMLElement);
    expect(await screen.findByText('categories.meal.limits.perPerson')).toBeTruthy();
    cleanup();

    renderPanel(routes({ '/expense/policy-hearings?': () => { throw new Error('list failed'); } }));
    await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
    await waitFor(() => expect(screen.queryByText('Continue a hearing')).toBeNull());
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('例外: 実行中は「中断」を出し、中断は失敗として扱わない', async () => {
    renderPanel(routes({ '/expense/policy-hearings': (path, init) => {
      if (init?.method !== 'POST') return routes()(path, init);
      return new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }); });
    } }));
    await startDocument();
    expect(screen.getByText('Working with the model… this can take a few minutes.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped. Nothing was changed.')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('境界: 50,000 字を超えると案を作れず、空でも作れない。ファイル名とテキストファイルの読み込みを本文に載せ、閉じられる', async () => {
    const { request } = renderPanel(routes());
    await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
    const create = screen.getByRole('button', { name: 'Create a proposal' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const area = screen.getByRole('textbox', { name: 'Rules text' });
    fireEvent.change(area, { target: { value: 'a'.repeat(50_001) } });
    expect(screen.getByText(/50,001 \/ 50,000/).textContent).toContain('too long');
    expect(create.disabled).toBe(true);
    fireEvent.change(area, { target: { value: 'a'.repeat(50_000) } });
    expect(create.disabled).toBe(false);

    const content = '# 旅費規程\n第1条 日当は3000円';
    const file = new File([content], '旅費規程.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
    await userEvent.upload(screen.getByLabelText('Load a text file'), file);
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Rules text' }) as HTMLTextAreaElement).value).toBe(content));
    expect((screen.getByLabelText('File name (optional)') as HTMLInputElement).value).toBe('旅費規程.md');
    await userEvent.click(create);
    await screen.findByText('Proposed changes');
    expect(bodyOf(request, '/expense/policy-hearings')).toEqual({ scope, mode: 'document', documentText: content, fileName: '旅費規程.md' });
    cleanup();

    renderPanel(routes());
    await userEvent.click(screen.getByRole('button', { name: 'Draft from company rules' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: 'Create a proposal' })).toBeNull();
  });

  it('境界: 差分が空なら「変更はありません」、差分の読み込みに失敗したら「差分を読み込む」で読み直せる。質問の無い open も案内する', async () => {
    renderPanel(routes({ '/expense/policy-hearings/h1/diff?': () => ({ changes: [], basePolicyUpdatedAt: 'y', stale: false }) }));
    await startDocument();
    expect(await screen.findByText('The proposal matches the current policy. There is nothing to change.')).toBeTruthy();
    expect(screen.queryByText(/The policy changed after the proposal was made/)).toBeNull();
    cleanup();

    let diffCalls = 0;
    renderPanel(routes({ '/expense/policy-hearings/h1/diff?': () => { diffCalls += 1; if (diffCalls === 1) throw new Error('diff failed'); return diff; } }));
    await startDocument();
    expect(await screen.findByText('diff failed')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load the diff' }));
    expect(await screen.findByText('categories.meal.limits.perPerson')).toBeTruthy();
    cleanup();

    renderPanel(routes({ '/expense/policy-hearings': (path, init) => (path === '/expense/policy-hearings' && init?.method === 'POST' ? { hearing: { ...questioning, turns: [] } } : routes()(path, init)) }));
    await startDocument();
    expect(await screen.findByText('There are no questions to answer right now.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send the answers' })).toBeNull();
  });

  it('境界: 前後の値は短く整形し、長い JSON は切って全文を title に残す', () => {
    expect(compactValue(undefined)).toEqual({ short: '—', full: '—' });
    expect(compactValue('税込').short).toBe('税込');
    const long = compactValue({ name: 'x'.repeat(200) });
    expect(long.short).toHaveLength(120);
    expect(long.short.endsWith('…')).toBe(true);
    expect(long.full.length).toBeGreaterThan(200);
  });
});
