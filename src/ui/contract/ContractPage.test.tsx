// @vitest-environment jsdom
/**
 * 契約画面（docs/23 §7）の主要な手順。API は `request` だけの偽物で、パスごとに応答を返す。
 * 守りたいのは: 固定文言（法的判断ではない）・空状態の案内・理由の 3 点セットとボタンの行き先・人が押す操作の送信。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClauseTopicDto, ContractDocumentDto, LedgerDto, PlaybookDto, ReviewEnvelopeDto } from '../api/contract-types';
import type { ToolApiClient } from '../api/tool-api';
import { consumePendingOpen, requestOpenInScreen } from '../navigation';
import { ContractPage } from './ContractPage';

afterEach(cleanup);

const topics: ClauseTopicDto[] = [
  { id: 'term', label: '契約期間', valueKind: 'term', keywords: ['契約期間'], guidance: '', enabled: true, sortOrder: 10 },
  { id: 'payment', label: '支払条件', valueKind: 'payment_terms', keywords: ['支払'], guidance: '', enabled: true, sortOrder: 20 },
];

const playbook: PlaybookDto = {
  id: 'pb-1', name: '業務委託（発注者側）', isDefault: true, ourRole: 'client', ourCompanyNames: ['サンプル商事'], topics,
  criteria: [{ id: 'payment-max-days', topicId: 'payment', check: { type: 'legal', rule: 'payment-max-days' }, onFail: 'reject', recommendedText: '{us}は{paymentMaxDays}日以内に支払う。', rationale: 'r', enabled: true, sortOrder: 10 }],
  legal: { paymentMaxDays: 60, freelancePaymentMaxDays: 60, freelanceRedelegationMaxDays: 30, prohibitedPaymentMethods: ['promissory_note'], allowMonthEndNextMonthEnd: true, dueSoonDays: 60, sources: [{ label: '公正取引委員会', url: 'https://www.jftc.go.jp/toriteki_2025/' }] },
  stampDuty: { enabled: true, documentTypes: [{ code: 'no7', name: '第7号文書', natures: ['basic_transaction'], fixedAmount: 4000, sourceUrl: 'https://www.nta.go.jp/', note: '' }] },
  extraction: { scanAllArticles: false, chunkMaxChars: 4000 }, templateId: 'outsourcing-client', createdAt: 'c', updatedAt: 'u',
};

const BODY = '第2条（契約期間）\n本契約の有効期間は、2026年4月1日から2027年3月31日までとする。\n第4条（支払）\n翌々月末日に支払う。';

function documentOf(status: ContractDocumentDto['status'], extra: Partial<ContractDocumentDto> = {}): ContractDocumentDto {
  return {
    id: 'doc-1', title: '保守業務委託', source: { type: 'text' }, body: BODY, pages: [{ page: 1, start: 0, end: BODY.length, method: 'text-layer', warnings: [] }],
    articles: [{ ref: '第2条', heading: '契約期間', start: 0, end: 44, page: 1 }, { ref: '第4条', heading: '支払', start: 44, end: BODY.length, page: 1 }],
    parties: { A: { label: '甲', name: '株式会社サンプル商事' }, B: { label: '乙', name: '架空テック合同会社' } }, ourParty: 'A', ourRole: 'client',
    counterpartyProfile: { toriteki: 'yes', freelance: 'no' },
    clauses: [
      { topicId: 'term', present: true, articleRef: '第2条', evidence: [{ quote: '本契約の有効期間は', start: 11, end: 20, verified: true }], value: { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', startsOnSigning: false }, source: 'llm', warnings: [] },
      { topicId: 'payment', present: true, articleRef: '第4条', evidence: [{ quote: '翌々月末日払い', verified: false }], source: 'llm', warnings: [{ code: 'quote-not-found', message: 'not found', origin: 'extraction' }] },
    ],
    status, createdAt: 'c', updatedAt: 'u', ...extra,
  };
}

const review: ReviewEnvelopeDto = {
  notice: 'この結果は審査基準との照合です。法的な判断ではありません。',
  review: {
    id: 'rev-1', documentId: 'doc-1', playbookId: 'pb-1', playbookName: '業務委託（発注者側）', playbookSnapshot: playbook, playbookSnapshotAt: 'u',
    results: [
      { topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [], recommendedTexts: [] },
      { topicId: 'payment', topicLabel: '支払条件', verdict: 'reject', present: true, reasons: [{ code: 'payment-over-limit', criterionId: 'payment-max-days', topicId: 'payment', detail: { maxDays: 92, limit: 60, worstCase: '7/1 → 9/30' } }], criteria: [{ criterionId: 'payment-max-days', outcome: 'fail', reasonCode: 'payment-over-limit' }], recommendedTexts: ['当社は60日以内に支払う。'] },
    ],
    documentFindings: [{ code: 'stamp-duty-candidate', detail: { name: '第7号文書', nature: 'basic_transaction', amount: 4000 } }],
    overall: 'reject', status: 'draft', stale: false, createdAt: 'c', updatedAt: 'u',
  },
};

const ledger: LedgerDto = {
  today: '2026-09-15', dueSoonDays: 60,
  rows: [{ contractId: 'con-1', title: '保守業務委託', counterpartyName: '架空テック合同会社', deadline: { id: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2026-10-31', basis: '第3条: 満了の3か月前まで', termIndex: 1, status: 'open' }, daysLeft: 46, state: 'due-soon', autoRenewal: true, contractStatus: 'active' }],
};

interface Setup {
  readonly status?: ContractDocumentDto['status']; readonly documents?: boolean; readonly unsaved?: boolean; readonly withReview?: boolean;
  /** 締結登録の期限プレビューに載せる警告（理由コードのボタンの振り分けを見るため）。 */
  readonly previewWarnings?: readonly { readonly code?: string; readonly message: string }[];
  readonly emptyLedger?: boolean;
}

function setup(options: Setup = {}) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let current = documentOf(options.status ?? 'extracted', options.withReview === true ? { reviewId: 'rev-1' } : {});
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    const route = path.split('?')[0]!;
    if (route === '/runtime/capabilities') return { contract: { extraction: { enabled: false, vision: false }, review: { llm: false } } };
    if (route === '/contracts/documents' && method === 'GET') return { documents: options.documents === false ? [] : [{ id: 'doc-1', title: '保守業務委託', status: current.status, sourceType: 'text', bodyLength: BODY.length, clauseCount: 2, counterpartyName: '架空テック合同会社', createdAt: 'c', updatedAt: 'u' }] };
    if (route === '/contracts/documents' && method === 'POST') return { document: { ...current, id: 'doc-2', title: String(body?.['title']) }, warnings: [] };
    if (route === '/contracts/documents/doc-1' || route === '/contracts/documents/doc-2') return { document: current };
    if (route === '/contracts/documents/doc-1/clauses') { current = { ...current, status: 'confirmed' }; return { document: current }; }
    if (route === '/contracts/playbooks' && method === 'GET') return { playbooks: [{ id: options.unsaved === true ? 'template-default' : 'pb-1', name: playbook.name, isDefault: true, ourRole: 'client', topicCount: 2, criterionCount: 1, updatedAt: 'u' }], unsaved: options.unsaved === true };
    if (route.startsWith('/contracts/playbooks/') && method === 'GET') return { playbook, unsaved: false };
    if (route === '/contracts/playbooks/from-template') return { playbook };
    if (route === '/contracts/playbooks' && method === 'POST') return { playbook: { ...playbook, name: String(body?.['name']) } };
    if (route === '/contracts/playbook-templates') return { templates: [{ id: 'outsourcing-client', name: '業務委託（発注者側）', description: 'd', ourRole: 'client', topicCount: 8, criterionCount: 9 }] };
    if (route === '/contracts/reviews/rev-1' || route === '/contracts/documents/doc-1/reviews') return review;
    if (route === '/contracts/reviews/rev-1/decisions') return review;
    if (route === '/contracts/deadlines/preview') return { preview: { deadlines: [{ id: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31', basis: '第2条: 満了日', status: 'open' }], warnings: options.previewWarnings ?? [{ code: 'notice-deadline-passed', message: '通知期限は過ぎています' }], autoRenewal: true, termEnd: '2027-03-31', stampDutyCandidates: [{ code: 'stamp-duty-candidate', documentTypeCode: 'no7', name: '第7号文書', amount: 4000, nature: 'basic_transaction', electronic: false, sourceUrl: '' }], review: 'none', counterpartyName: '架空テック合同会社' } };
    if (route === '/contracts/signed' && method === 'POST') return { contract: { id: 'con-1' }, warnings: [] };
    if (route === '/contracts/deadlines') return { ledger: options.emptyLedger === true ? { ...ledger, rows: [] } : ledger };
    if (route === '/contracts/signed/con-1/deadlines/renewal_notice-1/complete') return { contract: { id: 'con-1' } };
    if (route === '/contracts/signed/con-1') return { contract: { id: 'con-1', documentId: 'doc-1', title: '保守業務委託', counterpartyName: '架空テック合同会社', signedDate: '2026-03-20', signingMethod: 'paper', clauses: [], deadlines: ledger.rows.map((row) => row.deadline), status: 'active', displayStatus: 'active', reviewVerdicts: {}, warnings: [], createdAt: 'c', updatedAt: 'u' } };
    throw new Error(`unexpected request ${method} ${path}`);
  });
  render(<ContractPage client={{ request } as unknown as ToolApiClient} />);
  return { calls, request };
}

async function openDocument(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: '保守業務委託' }));
  await screen.findByText('Contract: 保守業務委託');
}

describe('ContractPage', () => {
  it('正常: 最初は取込を開き、固定文言（法的判断ではない）と空状態の案内を出す', async () => {
    setup({ documents: false });
    expect(screen.getByRole('tab', { name: 'Import', selected: true })).toBeTruthy();
    expect(screen.getAllByText(/It is not legal advice/).length).toBeGreaterThan(0);
    expect(await screen.findByText('Import a contract to extract its clauses and check them against your playbook.')).toBeTruthy();
  });

  it('正常: 貼り付けたテキストを取り込み、前文から甲乙を初期値に入れて送る', async () => {
    const { calls } = setup({ documents: false });
    const textarea = screen.getByLabelText('Contract text');
    fireEvent.change(textarea, { target: { value: `株式会社サンプル商事（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は\n${BODY}` } });
    fireEvent.change(screen.getAllByLabelText('Title').at(-1)!, { target: { value: '新しい契約' } });
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/contracts/documents' && call.method === 'POST')).toBe(true));
    const posted = calls.find((call) => call.path === '/contracts/documents' && call.method === 'POST')!.body!;
    expect(posted).toMatchObject({ title: '新しい契約', source: { type: 'text' }, parties: { A: '株式会社サンプル商事', B: '架空テック合同会社' }, counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' } });
  });

  it('正常: 審査基準が 0 件ならテンプレートからの作成を案内し、作成すると編集できる', async () => {
    const { calls } = setup({ unsaved: true });
    await userEvent.click(screen.getByRole('tab', { name: 'Playbook' }));
    expect(await screen.findByText(/No playbook yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create from template: 業務委託（発注者側）' }));
    expect(await screen.findByDisplayValue('業務委託（発注者側）')).toBeTruthy();
    expect(calls.find((call) => call.path === '/contracts/playbooks/from-template')?.body).toMatchObject({ templateId: 'outsourcing-client', isDefault: true });
    await userEvent.click(screen.getByRole('tab', { name: 'Legal settings' }));
    expect(screen.getByText(/These are initial values/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '公正取引委員会' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Criteria' }));
    expect(screen.getByText(/Preview/).parentElement?.textContent).toContain('当社は60日以内に支払う。');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/contracts/playbooks' && call.method === 'POST')).toBe(true));
  });

  it('正常: 条項抽出はモデルが無いとき設定への導線を出し、理由の 3 点セットと手入力で確定できる', async () => {
    const { calls } = setup({ status: 'extracted' });
    await openDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Clauses' }));
    expect(await screen.findByText(/AI extraction is not available/)).toBeTruthy();
    const card = screen.getByRole('heading', { name: '支払条件' }).closest('article')!;
    expect(within(card).getByText(/The sentence the AI cited as evidence is not in the contract/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Select the evidence in the text' })).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Months after closing'), { target: { value: '2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/contracts/documents/doc-1/clauses')).toBe(true));
    const sent = calls.find((call) => call.path === '/contracts/documents/doc-1/clauses')!.body!['clauses'] as { topicId: string; value?: Record<string, unknown>; source: string }[];
    expect(sent.find((clause) => clause.topicId === 'payment')).toMatchObject({ source: 'manual', value: { kind: 'payment_terms', payMonthOffset: 2 } });
  });

  it('正常: レビューは総合判定・理由の 3 点セット・推奨文案を出し、ボタンで審査基準の法令設定へ移る', async () => {
    setup({ status: 'confirmed', withReview: true });
    await openDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByText('この結果は審査基準との照合です。法的な判断ではありません。')).toBeTruthy();
    const card = screen.getByRole('heading', { name: '支払条件' }).closest('article')!;
    expect(within(card).getByText(/Payment can fall up to day 92 after receipt, beyond the setting of 60 days/)).toBeTruthy();
    expect(within(card).getByText('当社は60日以内に支払う。')).toBeTruthy();
    expect(screen.getByText(/This may be a taxable document \(第7号文書/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Open the legal settings' }));
    expect(await screen.findByRole('tab', { name: 'Playbook', selected: true })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Legal settings', selected: true })).toBeTruthy();
  });

  it('境界: 条項を確定していない文書ではレビューを開かず、条項抽出へ案内する', async () => {
    setup({ status: 'extracted' });
    await openDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByText('Confirm the clauses first.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the clauses step' }));
    expect(screen.getByRole('tab', { name: 'Clauses', selected: true })).toBeTruthy();
  });

  it('正常: 締結登録は期限のプレビューと警告を出し、登録すると台帳を開く', async () => {
    const { calls } = setup({ status: 'reviewed' });
    await openDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Sign' }));
    expect(await screen.findByText('2027-03-31')).toBeTruthy();
    expect(screen.getByText(/has not been reviewed/)).toBeTruthy();
    expect(screen.getByText(/The renewal notice deadline has already passed/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Counterparty') as HTMLInputElement).value).toBe('架空テック合同会社'));
    await userEvent.click(screen.getByRole('button', { name: 'Register as signed' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/contracts/signed' && call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.path === '/contracts/signed')?.body).toMatchObject({ documentId: 'doc-1', signingMethod: 'paper', counterpartyName: '架空テック合同会社', stampDuty: { affixed: null } });
    expect(await screen.findByRole('tab', { name: 'Ledger', selected: true })).toBeTruthy();
  });

  it('正常: 期限台帳は状態チップを出し、通知済みにする・契約を開くを押せる', async () => {
    const { calls } = setup();
    await userEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Due soon')).toBeTruthy();
    expect(within(table).getByText('46 days left')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as notified' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/complete'))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Open contract' }));
    expect(await screen.findByRole('button', { name: 'Terminate' })).toBeTruthy();
  });

  it('正常: 締結登録の理由ボタンは、全条文・読み直しを条項抽出へ、再レビューをレビューへ、モデルを設定へ振り分ける', async () => {
    setup({ status: 'reviewed', previewWarnings: [{ code: 'clause-missing', message: 'm' }, { code: 'extraction-failed', message: 'm' }, { code: 'review-stale', message: 'm' }] });
    await openDocument();
    const openSign = async () => { await userEvent.click(screen.getByRole('tab', { name: 'Sign' })); await screen.findByText('2027-03-31'); };
    await openSign();
    await userEvent.click(screen.getByRole('button', { name: 'Read all articles' }));
    expect(screen.getByRole('tab', { name: 'Clauses', selected: true })).toBeTruthy();
    await openSign();
    await userEvent.click(screen.getByRole('button', { name: 'Read this article again' }));
    expect(screen.getByRole('tab', { name: 'Clauses', selected: true })).toBeTruthy();
    await openSign();
    await userEvent.click(screen.getByRole('button', { name: 'Run the review again' }));
    expect(screen.getByRole('tab', { name: 'Review', selected: true })).toBeTruthy();
    await openSign();
    await userEvent.click(screen.getByRole('button', { name: 'Change the model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
  });

  it('正常: レビューを実行すると文書を読み直し、台帳が空なら取込へ戻れる', async () => {
    const { calls } = setup({ status: 'confirmed', emptyLedger: true });
    await openDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Run the review' }));
    // レビューで文書の状態（reviewed）が変わるので、画面は文書を取り直す。
    await waitFor(() => expect(calls.filter((call) => call.method === 'GET' && call.path.startsWith('/contracts/documents/doc-1?')).length).toBeGreaterThan(1));
    await userEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import a contract' }));
    expect(screen.getByRole('tab', { name: 'Import', selected: true })).toBeTruthy();
  });

  it('正常: ディープリンク（section: ledger）で台帳を開く', async () => {
    requestOpenInScreen('Contract', { internalId: 'con-1', section: 'ledger' });
    setup();
    expect(await screen.findByRole('tab', { name: 'Ledger', selected: true })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Terminate' })).toBeTruthy();
  });
});
