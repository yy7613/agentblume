// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalCapabilitiesDto, JournalChartOfAccountsDto, JournalDocumentDto, JournalDocumentSummaryDto, JournalEntryDto, JournalJudgmentDto, JournalRuleDto, JournalUndecidedReasonDto } from '../api/types';
import { JudgeTab } from './JudgeTab';

afterEach(cleanup);

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const rules: readonly JournalRuleDto[] = [
  { id: 'r1', name: 'カフェ', enabled: true, mode: 'auto', priority: 10, scope: {}, conditions: [], outcome: { lines: [] }, askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
  { id: 'r2', name: '喫茶', enabled: true, mode: 'suggest', priority: 10, scope: {}, conditions: [], outcome: { lines: [] }, askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
];

const capabilities: JournalCapabilitiesDto = { extraction: { enabled: false, vision: false }, hearing: { enabled: false } };

const summary: JournalDocumentSummaryDto = {
  id: 'doc-1', kind: 'receipt', status: 'undecided', sourceType: 'structured', transactionDate: '2026-09-01', issuerName: 'サンプルカフェ', description: 'コーヒー', grandTotal: 1100, direction: 'out',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

function detail(judgment: JournalJudgmentDto | undefined, overrides: Partial<JournalDocumentDto> = {}): JournalDocumentDto {
  return {
    id: 'doc-1', kind: 'receipt', source: { type: 'structured' },
    facts: { direction: 'out', issuerName: 'サンプルカフェ', description: 'コーヒー', grandTotal: 1100, transactionDate: '2026-09-01' },
    extraction: { method: 'manual', warnings: [] }, status: 'undecided',
    ...(judgment === undefined ? {} : { judgment }),
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

function undecided(reason: JournalUndecidedReasonDto): JournalJudgmentDto {
  return { stage: 'undecided', reasons: [reason], candidates: [], judgedAt: '2026-09-02T00:00:00.000Z' };
}

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listJournalDocuments: vi.fn().mockResolvedValue([summary]),
    getJournalDocument: vi.fn().mockResolvedValue(detail(undefined)),
    listJournalEntries: vi.fn().mockResolvedValue([]),
    judgeJournalDocuments: vi.fn().mockResolvedValue({ judged: [summary], decided: 1, undecided: 0, skipped: 0 }),
    saveJournalDocument: vi.fn().mockImplementation((_scope: unknown, document: JournalDocumentDto) => Promise.resolve(document)),
    deleteJournalDocument: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderTab(client: ToolApiClient, onAction = vi.fn()) {
  render(<JudgeTab client={client} chart={chart} rules={rules} capabilities={capabilities} focus={undefined} onAction={onAction} />);
  return onAction;
}

/** 帳票を 1 件選んで詳細（判定カード）を出す。 */
async function selectDocument() {
  await userEvent.click(await screen.findByRole('button', { name: 'サンプルカフェ' }));
}

/** 理由 1 件の未確定帳票を開き、原因カードが出るまで待つ。 */
async function openReason(reason: JournalUndecidedReasonDto, onAction = vi.fn()) {
  const client = stubClient({ getJournalDocument: vi.fn().mockResolvedValue(detail(undecided(reason))) });
  renderTab(client, onAction);
  await selectDocument();
  const card = await screen.findByRole('alert');
  return { client, onAction, card };
}

describe('JudgeTab', () => {
  it('正常: 確定した帳票は仕訳行を科目マスタの科目名で出す', async () => {
    const entry: JournalEntryDto = {
      id: 'entry-1', date: '2026-09-01', description: 'コーヒー', invoiceStatus: 'not_required', status: 'draft', decidedBy: 'rule',
      // accountName はサーバー保存時の名前。マスタで改名されていればマスタの名前が優先される。
      lines: [{ side: 'debit', accountId: 'meeting', accountName: '古い名前', taxCode: 'JP-IN-10-S', amount: 1100 }, { side: 'credit', accountId: 'cash', accountName: '現金', taxCode: 'JP-IN-10-S', amount: 1100 }],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const judgment: JournalJudgmentDto = { stage: 'decided', ruleId: 'r1', entryId: 'entry-1', specificity: 4, candidates: [], judgedAt: '2026-09-02T00:00:00.000Z' };
    const client = stubClient({
      listJournalDocuments: vi.fn().mockResolvedValue([{ ...summary, status: 'decided', entryId: 'entry-1' }]),
      getJournalDocument: vi.fn().mockResolvedValue(detail(judgment, { status: 'decided', entryId: 'entry-1' })),
      listJournalEntries: vi.fn().mockResolvedValue([entry]),
    });
    renderTab(client);
    await selectDocument();

    expect(await screen.findByText(/Rule "カフェ" matched \(specificity 4\)/)).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Entry lines' });
    expect(within(table).getByText('会議費')).toBeTruthy();
    expect(within(table).queryByText('古い名前')).toBeNull();
    expect(within(table).getByText('現金')).toBeTruthy();
  });

  it('正常: no-rule は原因と次の一手を出し、「ルールを作る」で new-rule を要求する（ヒアリングは使えないので無効）', async () => {
    const { onAction, card } = await openReason({ code: 'no-rule' });
    expect(card.textContent).toContain('No enabled rule matched this document.');
    expect(card.textContent).toContain('Create a rule from this document');
    expect(screen.getByRole('button', { name: 'Start a hearing' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Hearing is not available yet|Hearing \(Stage 2\)/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Create a rule' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'new-rule' }, summary);
  });

  it('正常: multiple-rules は同点のルール名を出し、ボタンごとにそのルールを開く', async () => {
    const { onAction, card } = await openReason({ code: 'multiple-rules', ruleIds: ['r1', 'r2'] });
    expect(card.textContent).toContain('2 rules tie: カフェ, 喫茶.');
    expect(card.textContent).toContain('Raise the priority of the intended rule');

    await userEvent.click(screen.getByRole('button', { name: 'Open rule "喫茶"' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-rule', ruleId: 'r2' }, summary);
  });

  it('正常: missing-fact は不足項目を並べ、「項目を編集」で取込タブへ送る', async () => {
    const { onAction, card } = await openReason({ code: 'missing-fact', ruleId: 'r1', facts: ['grandTotal', 'transactionDate'] });
    expect(card.textContent).toContain('Rule "カフェ" needs: grandTotal, transactionDate.');
    expect(card.textContent).toContain('Fill the missing facts on this document');

    await userEvent.click(within(card).getByRole('button', { name: 'Edit facts' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'edit-facts' }, summary);
  });

  it('正常: rule-suggest-mode は推測ルールを開くボタンを出す', async () => {
    const { onAction, card } = await openReason({ code: 'rule-suggest-mode', ruleIds: ['r2'] });
    expect(card.textContent).toContain('Only suggest-mode rules matched: 喫茶.');
    expect(card.textContent).toContain('Switch the rule to auto mode');

    await userEvent.click(screen.getByRole('button', { name: 'Open rule "喫茶"' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-rule', ruleId: 'r2' }, summary);
  });

  it('正常: unknown-account は欠けた科目 id を出し、「科目マスタを開く」で科目タブへ送る', async () => {
    const { onAction, card } = await openReason({ code: 'unknown-account', ruleId: 'r1', accountIds: ['ghost', 'lost'] });
    expect(card.textContent).toContain('accounts missing or disabled in the chart: ghost, lost.');
    expect(card.textContent).toContain('Re-enable or re-create the account in the chart');

    await userEvent.click(screen.getByRole('button', { name: 'Open the chart' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-chart', accountIds: ['ghost', 'lost'] }, summary);
  });

  it('正常: unbalanced は貸借不一致を説明し、そのルールを開くボタンだけを出す', async () => {
    const { onAction, card } = await openReason({ code: 'unbalanced', ruleId: 'r1' });
    expect(card.textContent).toContain('debit and credit totals differ');
    expect(card.textContent).toContain('Check the amount specs of the outcome lines');

    await userEvent.click(within(card).getByRole('button', { name: 'Open the rule' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-rule', ruleId: 'r1' }, summary);
  });

  it('正常: ask-if は質問に答えると facts.extra へ書いて再判定する', async () => {
    const reason: JournalUndecidedReasonDto = { code: 'ask-if', ruleId: 'r1', questionId: 'fixed_asset_check', prompt: '固定資産ですか？' };
    const { client, card } = await openReason(reason);
    expect(card.textContent).toContain('Rule "カフェ" asks: 固定資産ですか？');
    expect(card.textContent).toContain('Answer the question');

    await userEvent.click(screen.getByRole('button', { name: 'Answer and judge again' }));
    await userEvent.type(await screen.findByLabelText('Answer'), 'はい');
    expect(screen.getByText('Stored as extra.fixed_asset_check')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save answer and judge again' }));

    await waitFor(() => expect(client.saveJournalDocument).toHaveBeenCalled());
    const saved = (client.saveJournalDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { facts: { extra?: Record<string, unknown> } };
    expect(saved.facts.extra).toEqual({ fixed_asset_check: 'はい' });
    await waitFor(() => expect(client.judgeJournalDocuments).toHaveBeenCalledWith(expect.anything(), { documentIds: ['doc-1'] }));
  });

  it('異常: 回答が空のまま送ると保存せず入力を促す', async () => {
    const reason: JournalUndecidedReasonDto = { code: 'ask-if', ruleId: 'r1', questionId: 'fixed_asset_check', prompt: '固定資産ですか？' };
    const { client } = await openReason(reason);
    await userEvent.click(screen.getByRole('button', { name: 'Answer and judge again' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save answer and judge again' }));

    expect(await screen.findByText('Enter an answer first.')).toBeTruthy();
    expect(client.saveJournalDocument).not.toHaveBeenCalled();
  });

  it('正常: 見積書・納品書は仕訳しないことを説明し、判定ボタンを出さない', async () => {
    const skipped: JournalDocumentSummaryDto = { ...summary, id: 'doc-1', kind: 'quotation', status: 'skipped', issuerName: 'サンプル商事' };
    const client = stubClient({
      listJournalDocuments: vi.fn().mockResolvedValue([skipped]),
      getJournalDocument: vi.fn().mockResolvedValue(detail({ stage: 'skipped', reason: 'document-kind', judgedAt: '2026-09-02T00:00:00.000Z' }, { kind: 'quotation', status: 'skipped' })),
    });
    renderTab(client);
    expect(await screen.findByText('not journalized')).toBeTruthy();

    await userEvent.click(await screen.findByRole('button', { name: 'サンプル商事' }));
    expect(await screen.findByText('Quotations and delivery notes are not journalized.')).toBeTruthy();
    expect(screen.getByText(/If the kind is wrong, edit the facts/)).toBeTruthy();
  });

  it('境界: 帳票が 0 件なら空状態を出し、「未判定を判定」を無効にする', async () => {
    const client = stubClient({ listJournalDocuments: vi.fn().mockResolvedValue([]) });
    renderTab(client);
    expect(await screen.findByText('No documents yet. Import a CSV or enter facts in the Ingest tab.')).toBeTruthy();
    const judgeAll = screen.getByRole('button', { name: 'Judge pending (0)' });
    expect(judgeAll.hasAttribute('disabled')).toBe(true);
    await userEvent.click(judgeAll);
    expect(client.judgeJournalDocuments).not.toHaveBeenCalled();
  });

  it('例外: 判定の呼び出しが失敗したらそのメッセージを出し、一覧は残す', async () => {
    const client = stubClient({
      listJournalDocuments: vi.fn().mockResolvedValue([{ ...summary, status: 'extracted' }]),
      judgeJournalDocuments: vi.fn().mockRejectedValue(new Error('judge failed: model not configured')),
    });
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Judge pending (1)' }));

    expect(await screen.findByText('judge failed: model not configured')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'サンプルカフェ' })).toBeTruthy();
  });

  it('例外: 一覧の取得が失敗したらエラーと再試行ボタンを出す', async () => {
    const listJournalDocuments = vi.fn().mockRejectedValueOnce(new Error('list down')).mockResolvedValue([summary]);
    renderTab(stubClient({ listJournalDocuments }));
    expect(await screen.findByText(/list down/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'サンプルカフェ' })).toBeTruthy();
  });

  it('境界: 削除は確認ダイアログを経由し、キャンセルすれば消さない', async () => {
    const client = stubClient();
    renderTab(client);
    await selectDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('サンプルカフェ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(client.deleteJournalDocument).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteJournalDocument).toHaveBeenCalledWith('doc-1', expect.anything()));
  });
});
