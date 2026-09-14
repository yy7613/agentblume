// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto, JournalDocumentDto, JournalDocumentSummaryDto, JournalEntryDto, JournalRuleDto } from '../api/types';
import { NavigationProvider, consumePendingOpen, requestOpenInScreen } from '../navigation';
import { JournalPage } from './JournalPage';

afterEach(() => { cleanup(); consumePendingOpen('Journal'); consumePendingOpen('Settings'); });

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const rule: JournalRuleDto = {
  id: 'r1', name: 'カフェ', enabled: true, mode: 'auto', priority: 10, scope: { direction: 'out' },
  conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
  outcome: { lines: [{ side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: 'total' }] },
  askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

const noRuleSummary: JournalDocumentSummaryDto = {
  id: 'doc-nr', kind: 'receipt', status: 'undecided', sourceType: 'structured', transactionDate: '2026-09-01', issuerName: 'サンプルカフェ', description: 'コーヒー', grandTotal: 1100, direction: 'out',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};
const unknownAccountSummary: JournalDocumentSummaryDto = { ...noRuleSummary, id: 'doc-ua', issuerName: 'サンプル商事' };

function documentOf(id: string): JournalDocumentDto {
  const reasons = id === 'doc-ua'
    ? [{ code: 'unknown-account' as const, ruleId: 'r1', accountIds: ['ghost'] }]
    : [{ code: 'no-rule' as const }];
  return {
    id, kind: 'receipt', source: { type: 'structured' }, facts: { direction: 'out', issuerName: id === 'doc-ua' ? 'サンプル商事' : 'サンプルカフェ', description: 'コーヒー', grandTotal: 1100, transactionDate: '2026-09-01' },
    extraction: { method: 'manual', warnings: [] }, status: 'undecided',
    judgment: { stage: 'undecided', reasons, candidates: [], judgedAt: '2026-09-02T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const entry: JournalEntryDto = {
  id: 'entry-1', date: '2026-09-01', description: 'コーヒー', invoiceStatus: 'not_required', status: 'draft', decidedBy: 'rule',
  lines: [{ side: 'debit', accountId: 'meeting', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100 }, { side: 'credit', accountId: 'cash', accountName: '現金', taxCode: 'JP-IN-10-S', amount: 1100 }],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    getJournalChart: vi.fn().mockResolvedValue(chart),
    listJournalRules: vi.fn().mockResolvedValue([rule]),
    journalCapabilities: vi.fn().mockResolvedValue({ extraction: { enabled: false, vision: false }, hearing: { enabled: false } }),
    listJournalCsvPresets: vi.fn().mockResolvedValue([]),
    listJournalDocuments: vi.fn().mockResolvedValue([noRuleSummary, unknownAccountSummary]),
    getJournalDocument: vi.fn().mockImplementation((id: string) => Promise.resolve(documentOf(id))),
    listJournalEntries: vi.fn().mockResolvedValue([entry]),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderPage(client: ToolApiClient, navigate = vi.fn()) {
  render(<NavigationProvider navigate={navigate}><JournalPage client={client} /></NavigationProvider>);
  return navigate;
}

describe('JournalPage', () => {
  it('正常: 取込 / 判定 / ルール / 科目 / 出力の 5 サブタブを切り替えて表示する', async () => {
    renderPage(stubClient());
    const tabs = screen.getAllByRole('tab');
    // 読み上げ用の名前は素のラベルのまま。並びは設定する順（科目が先）。
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Chart', 'Ingest', 'Judge', 'Rules', 'Export']);
    expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Import a bank / card CSV' })).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(await screen.findByRole('heading', { name: /^Rules/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(await screen.findByRole('heading', { name: /^Accounts/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Export' }));
    expect(await screen.findByRole('heading', { name: 'Entries' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Export' }).getAttribute('aria-selected')).toBe('true');
  });

  it('正常: 左上の戻る導線から業務テンプレートの一覧へ帰れる', async () => {
    // 仕訳は業務テンプレートの一覧から入るので、帰り道を画面側に持たせる。
    // hash を直接書き換えず遷移の仕組みを通すのは、未保存の編集があるときの確認を飛び越えないため。
    const navigate = renderPage(stubClient());
    await userEvent.click(screen.getByRole('button', { name: '← Business templates' }));
    expect(navigate).toHaveBeenCalledWith('Templates');
  });

  it('例外: 科目マスタとルールの初回読込が失敗してもエラーを出し、画面は使えたままにする', async () => {
    const client = stubClient({
      getJournalChart: vi.fn().mockRejectedValue(new Error('chart down')),
      listJournalRules: vi.fn().mockRejectedValue(new Error('rules down')),
      journalCapabilities: vi.fn().mockRejectedValue(new Error('capabilities down')),
    });
    renderPage(client);
    expect(await screen.findByText(/Could not load the chart of accounts/)).toBeTruthy();
    expect(await screen.findByText(/Could not load the rules/)).toBeTruthy();
    expect(screen.getByText(/chart down/)).toBeTruthy();
    // 画面は使えるので、赤い失敗ではなく「次の一手つきの通知」で出す。
    expect(document.querySelector('.journal-load-notice')).toBeTruthy();
    expect(document.querySelector('.api-error')).toBeNull();

    // タブ切り替えは生きている。科目タブは「読み込み中」を出して落ちない。
    await userEvent.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(await screen.findByText('Loading the chart of accounts…')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeTruthy();

    // 再試行でもう一度読みにいく。
    const retry = screen.getAllByRole('button', { name: 'Retry' })[0];
    await userEvent.click(retry as HTMLElement);
    await waitFor(() => expect((client.getJournalChart as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it('正常: 他画面からの section: document のディープリンクは判定タブでその帳票を開く', async () => {
    const client = stubClient();
    requestOpenInScreen('Journal', { internalId: 'doc-ua', section: 'document' });
    renderPage(client);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Judge' }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(client.getJournalDocument).toHaveBeenCalledWith('doc-ua', expect.anything()));
    expect(await screen.findByText(/refers to accounts missing or disabled in the chart/)).toBeTruthy();
  });

  it('正常: section: rule のディープリンクはルールタブでそのルールを編集に開く', async () => {
    requestOpenInScreen('Journal', { internalId: 'r1', section: 'rule' });
    renderPage(stubClient());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('heading', { name: 'Edit rule "カフェ"' })).toBeTruthy();
  });

  it('正常: section: account のディープリンクは科目タブでその科目を開く', async () => {
    requestOpenInScreen('Journal', { internalId: 'meeting', section: 'account' });
    renderPage(stubClient());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chart' }).getAttribute('aria-selected')).toBe('true'));
    const row = (await screen.findByLabelText('Account 2 name')) as HTMLInputElement;
    expect(row.value).toBe('会議費');
    expect(row.closest('tr')?.className).toContain('selected');
  });

  it('正常: section: entry のディープリンクは出力タブでその仕訳を開く', async () => {
    requestOpenInScreen('Journal', { internalId: 'entry-1', section: 'entry' });
    renderPage(stubClient());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Export' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('table', { name: 'Lines of entry-1' })).toBeTruthy();
  });

  it('境界: 未知の section のディープリンクは無視して取込タブのままにする', async () => {
    requestOpenInScreen('Journal', { internalId: 'x', section: 'hearing' });
    renderPage(stubClient());
    expect(await screen.findByRole('heading', { name: 'Import a bank / card CSV' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true');
  });

  it('正常: 未確定の「ルールを作る」はルールタブへ移り、帳票から名前と条件を埋める', async () => {
    renderPage(stubClient());
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'サンプルカフェ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create a rule' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true'));
    expect(((await screen.findByLabelText('Rule name')) as HTMLInputElement).value).toBe('コーヒー');
    expect((screen.getByLabelText('Condition 1 value') as HTMLInputElement).value).toBe('コーヒー');
  });

  it('正常: unknown-account の「科目マスタを開く」は科目タブへ移り、その id の追加を促す', async () => {
    renderPage(stubClient());
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'サンプル商事' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open the chart' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chart' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByText('Account "ghost" is not in the chart.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add account "ghost"' })).toBeTruthy();
  });

  it('正常: 未確定の「項目を編集」は取込タブの事実フォームでその帳票を開く', async () => {
    const client = stubClient();
    renderPage(client);
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'サンプルカフェ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit facts' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('heading', { name: 'Edit facts of document doc-nr' })).toBeTruthy();
    expect(((await screen.findByLabelText('Issuer name')) as HTMLInputElement).value).toBe('サンプルカフェ');
  });
});

describe('JournalPage（読み込めないときの伝え方）', () => {
  /** 経路そのものが無い（= API サーバーが古い）ときの失敗。 */
  function routeMissing(): Error {
    const error = new Error('Route GET:/journal/chart not found');
    Reflect.set(error, 'status', 404);
    Reflect.set(error, 'name', 'ApiError');
    return error;
  }

  it('異常: 経路が無い（404）ときは「API サーバーを再起動」を案内する', async () => {
    const client = stubClient({
      getJournalChart: vi.fn().mockRejectedValue(routeMissing()),
      listJournalRules: vi.fn().mockRejectedValue(routeMissing()),
    });
    renderPage(client);

    expect(await screen.findByText(/Restart the API server/)).toBeTruthy();
    // 生の Fastify 文言をそのまま突きつけない。
    expect(screen.queryByText(/Route GET/)).toBeNull();
  });

  it('正常: 読み込めていれば通知は出さない（未設定でも赤くしない）', async () => {
    renderPage(stubClient({ listJournalRules: vi.fn().mockResolvedValue([]) }));

    await screen.findByRole('tab', { name: 'Ingest' });
    expect(document.querySelector('.journal-load-notice')).toBeNull();
    expect(document.querySelector('.api-error')).toBeNull();
  });

  it('境界: 再試行で読み直せたら通知は消える', async () => {
    const getJournalChart = vi.fn().mockRejectedValueOnce(new Error('chart down')).mockResolvedValue(chart);
    const client = stubClient({ getJournalChart });
    renderPage(client);

    await screen.findByText(/Could not load the chart of accounts/);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Could not load the chart of accounts/)).toBeNull());
  });
});

describe('JournalPage（手順の流れ図）', () => {
  it('正常: 設定する順に番号つきの四角が並び、間に矢印が入る', async () => {
    renderPage(stubClient());

    const steps = screen.getAllByRole('tab');
    expect(steps.map((step) => step.getAttribute('aria-label'))).toEqual(['Chart', 'Ingest', 'Judge', 'Rules', 'Export']);
    expect(steps.map((step) => step.querySelector('.journal-step-no')?.textContent)).toEqual(['1', '2', '3', '4', '5']);
    // 矢印は四角の間だけ（4 本）。読み上げからは外す。
    const arrows = document.querySelectorAll('.journal-step-arrow');
    expect(arrows).toHaveLength(4);
    for (const arrow of arrows) expect(arrow.getAttribute('aria-hidden')).toBe('true');
  });

  it('正常: 各四角に「ここで何をするか」を添え、分かっている件数を出す', async () => {
    renderPage(stubClient());

    expect(await screen.findByText('Define accounts and tax categories')).toBeTruthy();
    expect(screen.getByText('Turn undecided documents into rules')).toBeTruthy();
    // 科目数とルール件数はこの画面が既に持っている値なので出す（判定・出力の件数は各タブが持つ）。
    // 既定の科目マスタは未保存（標準セット）なので、件数ではなくその旨を出す。
    expect(screen.getByText('default set')).toBeTruthy();
    expect(screen.getByText('1 rules')).toBeTruthy();
  });

  it('正常: 四角をクリックするとその設定に移り、選択中が分かる', async () => {
    renderPage(stubClient());

    await userEvent.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(await screen.findByRole('heading', { name: /^Accounts/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Chart' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('false');
  });

  it('境界: 科目マスタを読めていないときは件数を出さず、手順は並べたままにする', async () => {
    renderPage(stubClient({ getJournalChart: vi.fn().mockRejectedValue(new Error('chart down')) }));

    await screen.findByText(/Could not load the chart of accounts/);
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.queryByText(/accounts$/)).toBeNull();
  });
});

describe('JournalPage（科目マスタが未設定か保存済みか）', () => {
  it('正常: 保存済みの科目マスタなら件数を出す', async () => {
    renderPage(stubClient({ getJournalChart: vi.fn().mockResolvedValue({ ...chart, saved: true }) }));

    expect(await screen.findByText('2 accounts')).toBeTruthy();
    expect(screen.queryByText('default set')).toBeNull();
  });

  it('境界: 標準セットのままなら件数を出さず「標準のまま」と示す（設定済みに見せない）', async () => {
    renderPage(stubClient({ getJournalChart: vi.fn().mockResolvedValue({ ...chart, saved: false }) }));

    expect(await screen.findByText('default set')).toBeTruthy();
    expect(screen.queryByText('2 accounts')).toBeNull();
  });

  it('異常: 旗が無い応答（古いサーバー）は未保存として扱い、件数を装わない', async () => {
    renderPage(stubClient({ getJournalChart: vi.fn().mockResolvedValue(chart) }));

    expect(await screen.findByText('default set')).toBeTruthy();
  });
});
