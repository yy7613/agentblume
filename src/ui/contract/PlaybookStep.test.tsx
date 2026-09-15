// @vitest-environment jsdom
/**
 * 審査基準（プレイブック）の一覧と編集。基準・日数・税額表は利用者が編集するデータなので、
 * 各タブの編集が保存の本文へ正しく載ること、テンプレートからの作成、削除、ディープリンクのタブ選択を守る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractApi } from '../api/contract-api';
import type { PlaybookDto, PlaybookSummaryDto, SavePlaybookDto } from '../api/contract-types';
import { PlaybookStep } from './PlaybookStep';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fakeApi(overrides: Partial<Record<keyof ContractApi, unknown>>): ContractApi {
  const cache = new Map<PropertyKey, unknown>(Object.entries(overrides));
  return new Proxy({}, {
    get: (_target, key) => {
      if (!cache.has(key)) cache.set(key, vi.fn(async () => { throw new Error(`unexpected call ${String(key)}`); }));
      return cache.get(key);
    },
  }) as ContractApi;
}

const playbook: PlaybookDto = {
  id: 'pb-1', name: '業務委託（発注者側）', isDefault: true, ourRole: 'client', ourCompanyNames: ['サンプル商事'],
  topics: [
    { id: 'term', label: '契約期間', valueKind: 'term', keywords: ['契約期間'], guidance: '', enabled: true, sortOrder: 10 },
    { id: 'payment', label: '支払条件', valueKind: 'payment_terms', keywords: ['支払'], guidance: '', enabled: true, sortOrder: 20 },
  ],
  criteria: [
    { id: 'term-required', topicId: 'term', check: { type: 'required' }, onFail: 'negotiate', rationale: '', enabled: true, sortOrder: 10 },
    { id: 'term-cond', topicId: 'term', check: { type: 'condition', conditions: [{ field: 'term.months', op: 'lte', value: 12 }] }, onFail: 'negotiate', recommendedText: '{foo}を直す', rationale: '', enabled: true, sortOrder: 20 },
    { id: 'payment-max-days', topicId: 'payment', check: { type: 'legal', rule: 'payment-max-days' }, onFail: 'reject', recommendedText: '{us}は{paymentMaxDays}日以内に支払う。', rationale: 'r', enabled: true, sortOrder: 30 },
    { id: 'payment-llm', topicId: 'payment', check: { type: 'llm', question: 'q', passWhen: 'yes' }, onFail: 'negotiate', rationale: '', enabled: true, sortOrder: 40 },
  ],
  legal: { paymentMaxDays: 60, freelancePaymentMaxDays: 60, freelanceRedelegationMaxDays: 30, prohibitedPaymentMethods: ['promissory_note'], allowMonthEndNextMonthEnd: true, dueSoonDays: 60, sources: [{ label: '公正取引委員会', url: 'https://www.jftc.go.jp/toriteki_2025/' }] },
  stampDuty: { enabled: true, documentTypes: [{ code: 'no7', name: '第7号文書', natures: ['basic_transaction'], fixedAmount: 4000, sourceUrl: 'https://www.nta.go.jp/', note: '' }] },
  extraction: { scanAllArticles: false, chunkMaxChars: 4000 }, templateId: 'outsourcing-client', createdAt: 'c', updatedAt: 'u',
};

const summary: PlaybookSummaryDto = { id: 'pb-1', name: playbook.name, isDefault: true, ourRole: 'client', topicCount: 2, criterionCount: 4, updatedAt: 'u' };
const template = { id: 'outsourcing-client', name: '業務委託（発注者側）', description: 'd', ourRole: 'client' as const, topicCount: 8, criterionCount: 9 };

interface Setup {
  readonly unsaved?: boolean;
  readonly summaries?: readonly PlaybookSummaryDto[];
  readonly focus?: { readonly playbookId?: string; readonly nodeId?: string; readonly seq: number };
  readonly overrides?: Partial<Record<keyof ContractApi, unknown>>;
}

function setup(options: Setup = {}) {
  const unsaved = options.unsaved === true;
  const api = fakeApi({
    listPlaybooks: vi.fn(async () => ({ playbooks: options.summaries ?? (unsaved ? [{ ...summary, id: 'template-default' }] : [summary, { ...summary, id: 'pb-2', name: '第二基準', isDefault: false }]), unsaved })),
    listTemplates: vi.fn(async () => [template]),
    getPlaybook: vi.fn(async (_scope: unknown, id: string) => ({ playbook: { ...playbook, id }, unsaved })),
    savePlaybook: vi.fn(async (_scope: unknown, draft: SavePlaybookDto) => ({ ...playbook, ...draft, id: draft.id ?? 'pb-new' })),
    deletePlaybook: vi.fn(async () => undefined),
    createPlaybookFromTemplate: vi.fn(async () => playbook),
    ...options.overrides,
  });
  const onChanged = vi.fn();
  const view = render(<PlaybookStep api={api} {...(options.focus === undefined ? {} : { focus: options.focus })} onChanged={onChanged} />);
  return { api, onChanged, view };
}

async function openEditor(name = playbook.name): Promise<void> {
  await userEvent.click((await screen.findAllByRole('button', { name }))[0]!);
  await screen.findByLabelText('Name');
}

const saved = (api: ContractApi) => vi.mocked(api.savePlaybook).mock.calls.at(-1)?.[1];
const fieldsetOf = (legend: string) => screen.getByText(legend, { selector: 'legend' }).closest('fieldset')!;
const change = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });

describe('PlaybookStep: 一覧と基本情報', () => {
  it('正常: 一覧に既定バッジと件数を出し、開いて名前・立場・自社名・トピックを編集して保存する', async () => {
    const { api, onChanged } = setup();
    expect(await screen.findByText('Default')).toBeTruthy();
    expect(screen.getAllByText('2 clause types · 4 criteria')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    await openEditor();
    change(screen.getByLabelText('Name'), '改訂版');
    change(screen.getByLabelText('Our role'), 'vendor');
    change(screen.getByLabelText(/^Our company names/), 'A社\n\n B社 ');
    await userEvent.click(screen.getByLabelText('Default playbook'));

    expect(screen.getByRole('tab', { name: 'Clause types', selected: true })).toBeTruthy();
    const term = fieldsetOf('契約期間');
    change(within(term).getByLabelText('id'), 'term2');
    change(within(term).getByLabelText('Label'), '');
    // 表示名が空なら凡例は id を出す（どのトピックか分からなくならない）。
    expect(within(term).getByText('term2', { selector: 'legend' })).toBeTruthy();
    change(within(term).getByLabelText('Label'), '期間');
    change(within(term).getByLabelText('Value type'), 'notice');
    await userEvent.click(within(term).getByLabelText('Enabled'));
    change(within(term).getByLabelText('Keywords (comma separated)'), '期間, 有効期間, ');
    change(within(term).getByLabelText('Reading guidance for the AI'), '満了日を読む');
    await userEvent.click(within(fieldsetOf('支払条件')).getByRole('button', { name: 'Remove this clause type' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add a clause type' }));
    expect(fieldsetOf('New clause type')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Reviews run from now on use these criteria.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(api.listPlaybooks).toHaveBeenCalledTimes(2);
    expect(saved(api)).toMatchObject({
      id: 'pb-1', name: '改訂版', ourRole: 'vendor', ourCompanyNames: ['A社', 'B社'], isDefault: false,
      topics: [
        { id: 'term2', label: '期間', valueKind: 'notice', enabled: false, keywords: ['期間', '有効期間'], guidance: '満了日を読む' },
        { id: 'topic_2', label: 'New clause type', valueKind: 'text', keywords: [], enabled: true, sortOrder: 20 },
      ],
    });
  });

  it('正常: 保存済みの基準があるときテンプレートから作ると既定にしない', async () => {
    const { api, onChanged } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Create from template: 業務委託（発注者側）' }));
    expect(await screen.findByText('Created from the template. Edit it to fit your company.')).toBeTruthy();
    expect(api.createPlaybookFromTemplate).toHaveBeenCalledWith(expect.anything(), { templateId: 'outsourcing-client', isDefault: false });
    expect(onChanged).toHaveBeenCalled();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(playbook.name);
  });

  it('正常: 未保存（テンプレートのまま）は空状態を案内し、削除を出さず、保存すると id 無しで送って通常の保存に戻る', async () => {
    const { api } = setup({ unsaved: true });
    expect(await screen.findByText(/No playbook yet/)).toBeTruthy();
    expect(screen.getByText('Template (not saved)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Save this template as a playbook' }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
    expect(saved(api)).not.toHaveProperty('id');
  });

  it('正常: 確認して削除すると編集を閉じて親へ知らせ、取り消すと何もしない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { api, onChanged } = setup();
    await openEditor();
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    expect(api.deletePlaybook).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.deletePlaybook).toHaveBeenCalledWith(expect.anything(), 'pb-1');
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('異常: 一覧・取得・保存・テンプレート作成・削除の失敗はそれぞれ案内を出す', async () => {
    const fail = (message: string) => vi.fn(async () => { throw new Error(message); });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ overrides: { savePlaybook: fail('save failed'), createPlaybookFromTemplate: fail('create failed'), deletePlaybook: fail('delete failed') } });
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('save failed');
    await userEvent.click(screen.getByRole('button', { name: 'Create from template: 業務委託（発注者側）' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('create failed'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('delete failed'));
    cleanup();
    setup({ overrides: { listPlaybooks: fail('list failed') } });
    expect((await screen.findByRole('alert')).textContent).toContain('list failed');
    cleanup();
    setup({ overrides: { getPlaybook: fail('get failed') } });
    await userEvent.click(await screen.findByRole('button', { name: playbook.name }));
    expect((await screen.findByRole('alert')).textContent).toContain('get failed');
  });
});

describe('PlaybookStep: 基準', () => {
  it('正常: 条件・法令・AI 質問の各フォームを編集し、未知の置換子を警告し、推奨文案をプレビューする', async () => {
    const { api } = setup();
    await openEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Criteria' }));

    const condition = fieldsetOf('term-cond');
    expect(within(condition).getByRole('alert').textContent).toContain('Unknown placeholders: foo.');
    change(within(condition).getByLabelText('Field'), 'term.endDate');
    change(within(condition).getByLabelText('Operator'), 'exists');
    // 値を取らない演算子では値の入力を出さない。
    expect(within(condition).queryByLabelText('Value')).toBeNull();
    change(within(condition).getByLabelText('Operator'), 'gte');
    change(within(condition).getByLabelText('Value'), '24');
    change(within(condition).getByLabelText(/^Suggested wording/), '');
    expect(within(condition).queryByRole('alert')).toBeNull();
    expect(within(condition).queryByText(/Preview/)).toBeNull();

    const legal = fieldsetOf('payment-max-days');
    expect(within(legal).getByText(/Preview/).parentElement?.textContent).toContain('当社は60日以内に支払う。');
    change(within(legal).getByLabelText('Rule'), 'prohibited-payment-method');
    change(within(legal).getByLabelText('When it fails'), 'negotiate');

    const llm = fieldsetOf('payment-llm');
    change(within(llm).getByLabelText('Question'), '再委託を禁止しているか');
    change(within(llm).getByLabelText('Passes when the answer is'), 'no');
    change(within(llm).getByLabelText('Internal rationale'), '社内規程');
    change(within(llm).getByLabelText(/^Suggested wording/), '{articleRef}を削除する');
    await userEvent.click(within(llm).getByLabelText('Enabled'));

    await userEvent.click(within(fieldsetOf('term-required')).getByRole('button', { name: 'Remove this criterion' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add a criterion' }));
    expect(fieldsetOf('term-4')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.savePlaybook).toHaveBeenCalled());
    const criteria = saved(api)!.criteria;
    expect(criteria.map((criterion) => criterion.id)).toEqual(['term-cond', 'payment-max-days', 'payment-llm', 'term-4']);
    expect(criteria[0]).toMatchObject({ check: { type: 'condition', conditions: [{ field: 'term.endDate', op: 'gte', value: 24 }] } });
    expect(criteria[0]!.recommendedText).toBeUndefined();
    expect(criteria[1]).toMatchObject({ check: { type: 'legal', rule: 'prohibited-payment-method' }, onFail: 'negotiate' });
    expect(criteria[2]).toMatchObject({ check: { type: 'llm', question: '再委託を禁止しているか', passWhen: 'no' }, rationale: '社内規程', recommendedText: '{articleRef}を削除する', enabled: false });
    expect(criteria[3]).toMatchObject({ topicId: 'term', check: { type: 'required' }, onFail: 'negotiate', enabled: true, sortOrder: 40 });
  });

  it('正常: 検査の種類を切り替えると種類ごとの初期値に入れ替わる（条件の項目は対象トピックの値の型から選ぶ）', async () => {
    const { api } = setup();
    await openEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Criteria' }));
    const target = fieldsetOf('term-required');
    change(within(target).getByLabelText('Clause type'), 'payment');
    change(within(target).getByLabelText('Check'), 'condition');
    expect((within(target).getByLabelText('Field') as HTMLSelectElement).value).toBe('payment.maxDays');
    change(within(target).getByLabelText('Check'), 'legal');
    expect(within(target).getByLabelText('Rule')).toBeTruthy();
    change(within(target).getByLabelText('Check'), 'llm');
    expect(within(target).getByLabelText('Question')).toBeTruthy();
    change(within(target).getByLabelText('Check'), 'required');
    expect(within(target).queryByLabelText('Question')).toBeNull();
    expect(within(target).queryByLabelText('Rule')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.savePlaybook).toHaveBeenCalled());
    expect(saved(api)!.criteria[0]).toMatchObject({ id: 'term-required', topicId: 'payment', check: { type: 'required' } });
  });

  it('境界: トピックが 1 つも無ければ基準を追加できず、消えたトピックを指す条件は present だけを選べる', async () => {
    setup();
    await openEditor();
    await userEvent.click(within(fieldsetOf('契約期間')).getByRole('button', { name: 'Remove this clause type' }));
    await userEvent.click(within(fieldsetOf('支払条件')).getByRole('button', { name: 'Remove this clause type' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Criteria' }));
    expect((screen.getByRole('button', { name: 'Add a criterion' }) as HTMLButtonElement).disabled).toBe(true);
    const options = within(within(fieldsetOf('term-cond')).getByLabelText('Field')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['present']);
  });
});

describe('PlaybookStep: 法令設定と印紙税表', () => {
  it('正常: 法令設定は固定文言と出典を出し、日数・禁止する支払手段・月末締めの扱いを保存する', async () => {
    const { api } = setup();
    await openEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Legal settings' }));
    expect(screen.getByRole('note').textContent).toContain('It is not legal advice');
    expect(screen.getByRole('link', { name: '公正取引委員会' }).getAttribute('href')).toBe('https://www.jftc.go.jp/toriteki_2025/');
    change(screen.getByLabelText('Payment period limit (Toriteki Act, days from receipt)'), '45');
    change(screen.getByLabelText('Payment period limit (Freelance Act)'), '50');
    change(screen.getByLabelText('Re-delegation limit (Freelance Act)'), '20');
    change(screen.getByLabelText('Days before a deadline counts as due soon'), '30');
    await userEvent.click(screen.getByLabelText('promissory_note'));
    await userEvent.click(screen.getByLabelText('cash'));
    await userEvent.click(screen.getByLabelText(/^Treat month-end closing/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.savePlaybook).toHaveBeenCalled());
    expect(saved(api)!.legal).toMatchObject({ paymentMaxDays: 45, freelancePaymentMaxDays: 50, freelanceRedelegationMaxDays: 20, dueSoonDays: 30, prohibitedPaymentMethods: ['cash'], allowMonthEndNextMonthEnd: false });
  });

  it('正常: 印紙税表は区分ごとのコード・金額・性質・階層・注記を編集し、空欄はその項目を消して保存する', async () => {
    const { api } = setup();
    await openEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Stamp duty table' }));
    expect(screen.getByRole('link', { name: 'Source' }).getAttribute('href')).toBe('https://www.nta.go.jp/');
    await userEvent.click(screen.getByLabelText('Show stamp duty candidates'));
    const type = fieldsetOf('第7号文書');
    change(within(type).getByLabelText('Code'), 'no7-2');
    change(within(type).getByLabelText('Fixed amount (JPY)'), '');
    change(within(type).getByLabelText('No amount stated (JPY)'), '200');
    await userEvent.click(within(type).getByLabelText('ukeoi'));
    await userEvent.click(within(type).getByLabelText('basic_transaction'));
    change(within(type).getByLabelText(/^Tiers/), '10000,200\n-,4000');
    change(within(type).getByLabelText('Note'), '注記');
    change(within(type).getByLabelText('Name'), '第7号');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.savePlaybook).toHaveBeenCalledTimes(1));
    const first = saved(api)!.stampDuty;
    expect(first.enabled).toBe(false);
    expect(first.documentTypes[0]).toMatchObject({ code: 'no7-2', name: '第7号', natures: ['ukeoi'], noAmountStated: 200, tiers: [{ upTo: 10000, amount: 200 }, { upTo: null, amount: 4000 }], note: '注記' });
    expect(first.documentTypes[0]!.fixedAmount).toBeUndefined();

    change(within(type).getByLabelText(/^Tiers/), '  ');
    change(within(type).getByLabelText('No amount stated (JPY)'), '');
    change(within(type).getByLabelText('Fixed amount (JPY)'), '400');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.savePlaybook).toHaveBeenCalledTimes(2));
    const second = saved(api)!.stampDuty.documentTypes[0]!;
    expect(second.tiers).toBeUndefined();
    expect(second.noAmountStated).toBeUndefined();
    expect(second.fixedAmount).toBe(400);
  });
});

describe('PlaybookStep: ディープリンク', () => {
  it('正常: nodeId=legal は既定の基準を開いて法令設定タブにする', async () => {
    const { api } = setup({ focus: { nodeId: 'legal', seq: 1 } });
    expect(await screen.findByRole('tab', { name: 'Legal settings', selected: true })).toBeTruthy();
    expect(api.getPlaybook).toHaveBeenCalledWith(expect.anything(), 'pb-1');
  });

  it('正常: playbookId と nodeId=stampDuty はその基準の印紙税表タブを開く', async () => {
    const { api } = setup({ focus: { playbookId: 'pb-2', nodeId: 'stampDuty', seq: 1 } });
    expect(await screen.findByRole('tab', { name: 'Stamp duty table', selected: true })).toBeTruthy();
    expect(api.getPlaybook).toHaveBeenCalledWith(expect.anything(), 'pb-2');
    expect(api.getPlaybook).not.toHaveBeenCalledWith(expect.anything(), 'pb-1');
  });

  it('正常: 基準 id は基準タブを開いてその基準を目立たせる', async () => {
    setup({ focus: { nodeId: 'payment-max-days', seq: 1 } });
    expect(await screen.findByRole('tab', { name: 'Criteria', selected: true })).toBeTruthy();
    expect(fieldsetOf('payment-max-days').className).toContain('focused');
    expect(fieldsetOf('term-cond').className).not.toContain('focused');
  });

  it('境界: 既定の基準が無ければ先頭を開き、nodeId が無ければタブは変えない', async () => {
    const { api } = setup({ summaries: [{ ...summary, id: 'pb-9', isDefault: false }], focus: { seq: 1 } });
    await screen.findByLabelText('Name');
    expect(api.getPlaybook).toHaveBeenCalledWith(expect.anything(), 'pb-9');
    expect(screen.getByRole('tab', { name: 'Clause types', selected: true })).toBeTruthy();
  });
});
