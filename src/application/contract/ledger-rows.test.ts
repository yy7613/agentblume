import { describe, expect, it, vi } from 'vitest';
import { COUNTERPARTY, inMemoryContractRepositories, playbookFixture, QUOTES, scope, signedClausesFixture, signedContractFixture } from '../../adapters/storage/contract-repository.fixtures';
import type { SignedClause } from '../../domain/contract/signed-contract';
import { CONTRACT_CLAUSES_SCHEMA } from '../../domain/etl/nodes/contract-clauses-source';
import { CONTRACT_DEADLINES_SCHEMA } from '../../domain/etl/nodes/contract-deadlines-source';
import { clockAt } from './contract.fixtures';
import { ContractClauseRowsProvider, ContractDeadlineRowsProvider } from './ledger-rows';
import { ContractPlaybookResolver } from './manage-playbooks';
import { ListContractDeadlinesUseCase, type Ledger, type LedgerRow } from './signed-contracts';

const clock = clockAt('2026-09-15');
const columnsOf = (schema: { columns: readonly { name: string }[] }) => schema.columns.map((column) => column.name).sort();

describe('ContractDeadlineRowsProvider', () => {
  const row = (overrides: Partial<LedgerRow>): LedgerRow => ({
    contractId: 'sc-1', title: '業務委託契約', counterpartyName: COUNTERPARTY, daysLeft: 107, state: 'upcoming', autoRenewal: true, contractStatus: 'active',
    deadline: { id: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2026-12-31', basis: '第3条: 満了の3か月前まで', termIndex: 1, termEnd: '2027-03-31', status: 'open' },
    ...overrides,
  });
  const stub = (ledger: Ledger) => ({ execute: vi.fn().mockResolvedValue(ledger) }) as unknown as ListContractDeadlinesUseCase & { execute: ReturnType<typeof vi.fn> };

  it('正常: 台帳の行を固定列へ平坦化し、有効な契約の期限だけを出す（手入力の期限は期の列が null）', async () => {
    const ledger = stub({
      today: '2026-09-15', dueSoonDays: 60,
      rows: [
        row({}),
        row({ contractId: 'sc-2', deadline: { id: 'custom-1', kind: 'custom', dueDate: '2026-09-01', basis: '報告書', status: 'open' }, daysLeft: -14, state: 'overdue', autoRenewal: false }),
        row({ contractId: 'sc-expired', contractStatus: 'expired' }),
      ],
    });
    const rows = await new ContractDeadlineRowsProvider(ledger).rows(scope);
    expect(rows).toEqual([
      { contract_id: 'sc-1', title: '業務委託契約', counterparty: COUNTERPARTY, kind: 'renewal_notice', due_date: '2026-12-31', days_left: 107, state: 'upcoming', term_index: 1, term_end: '2027-03-31', auto_renewal: true, basis: '第3条: 満了の3か月前まで', today: '2026-09-15' },
      { contract_id: 'sc-2', title: '業務委託契約', counterparty: COUNTERPARTY, kind: 'custom', due_date: '2026-09-01', days_left: -14, state: 'overdue', term_index: null, term_end: null, auto_renewal: false, basis: '報告書', today: '2026-09-15' },
    ]);
    for (const entry of rows) expect(Object.keys(entry).sort()).toEqual(columnsOf(CONTRACT_DEADLINES_SCHEMA));
  });

  it('正常: 既定は過ぎた期限も含め、horizonDays → withinDays・limit をそのまま渡す', async () => {
    const ledger = stub({ today: '2026-09-15', dueSoonDays: 60, rows: [] });
    const provider = new ContractDeadlineRowsProvider(ledger);
    expect(await provider.rows(scope)).toEqual([]);
    expect(ledger.execute).toHaveBeenLastCalledWith({ scope, includeOverdue: true });
    await provider.rows(scope, { horizonDays: 90, includeOverdue: false, limit: 5 });
    expect(ledger.execute).toHaveBeenLastCalledWith({ scope, withinDays: 90, includeOverdue: false, limit: 5 });
  });

  it('正常: 本物の台帳と組み合わせると、締結済み契約の未完了の期限が期限の近い順に出る', async () => {
    const repos = inMemoryContractRepositories();
    await repos.signed.save(signedContractFixture('sc-1'));
    const ledger = new ListContractDeadlinesUseCase(repos.signed, new ContractPlaybookResolver(repos.playbooks, clock), clock);
    const rows = await new ContractDeadlineRowsProvider(ledger).rows(scope, { horizonDays: 3650 });
    expect(rows.map((entry) => [entry['kind'], entry['due_date'], entry['days_left'], entry['state']])).toEqual([
      ['renewal_notice', '2026-12-31', 107, 'upcoming'], ['expiry', '2027-03-31', 197, 'upcoming'], ['renewal', '2027-04-01', 198, 'upcoming'],
    ]);
  });
});

describe('ContractClauseRowsProvider', () => {
  const ipOurs: SignedClause = { topicId: 'ip_ownership', topicLabel: '成果物の知的財産権', valueKind: 'ip_ownership', present: true, articleRef: '第7条', quote: '権利は甲に帰属する', quoteVerified: true, value: { kind: 'ip_ownership', owner: 'A' } };
  const fixedTerm: readonly SignedClause[] = [
    { topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, quoteVerified: true, value: { kind: 'term', startDate: '2025-07-01', endDate: '2026-06-30', startsOnSigning: false } },
    { topicId: 'auto_renewal', topicLabel: '自動更新', valueKind: 'auto_renewal', present: true, quoteVerified: true, value: { kind: 'auto_renewal', renews: false, sameAsInitial: false } },
  ];

  async function setup() {
    const repos = inMemoryContractRepositories();
    await repos.playbooks.save(playbookFixture('pb-1', { isDefault: true }));
    await repos.signed.save(signedContractFixture('sc-1', { signedDate: '2026-03-15', clauses: [...signedClausesFixture(), ipOurs] }));
    await repos.signed.save(signedContractFixture('sc-2', { signedDate: '2026-02-01', ourParty: undefined, clauses: [...signedClausesFixture(), ipOurs], reviewVerdicts: {} }));
    await repos.signed.save(signedContractFixture('sc-old', { signedDate: '2025-07-01', clauses: fixedTerm, deadlines: [{ id: 'expiry-1', kind: 'expiry', dueDate: '2026-06-30', basis: '第2条: 満了日', termIndex: 1, termEnd: '2026-06-30', status: 'open' }] }));
    return { ...repos, provider: new ContractClauseRowsProvider(repos.signed, new ContractPlaybookResolver(repos.playbooks, clock), clock) };
  }

  it('正常: 締結時の条項の写し + 今の審査基準にしか無い種類（present: false）を、決定的なタグつきで 1 行ずつ出す', async () => {
    const { provider } = await setup();
    const rows = await provider.rows(scope);
    for (const entry of rows) expect(Object.keys(entry).sort()).toEqual(columnsOf(CONTRACT_CLAUSES_SCHEMA));
    // 既定は有効な契約だけ（満了した sc-old は出ない）。締結日の新しい順。
    expect([...new Set(rows.map((entry) => entry['contract_id']))]).toEqual(['sc-1', 'sc-2']);
    const first = rows.filter((entry) => entry['contract_id'] === 'sc-1');
    expect(first.map((entry) => entry['topic_id'])).toEqual(['term', 'auto_renewal', 'renewal_notice', 'liability_cap', 'subcontracting', 'ip_ownership', 'payment', 'jurisdiction']);

    expect(first[0]).toEqual({
      contract_id: 'sc-1', title: '業務委託契約 sc-1', counterparty: COUNTERPARTY, signed_date: '2026-03-15', contract_status: 'active',
      topic_id: 'term', topic_label: '契約期間', present: true, value_summary: '2026-04-01〜2027-03-31（12か月）', tags: '', article_ref: '第2条', quote: QUOTES.term,
      review_verdict: 'accept', value_json: JSON.stringify({ kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false }),
    });
    // タグは前後にもカンマを付ける（contains で 1 タグだけを当てやすくする）。
    expect(first.find((entry) => entry['topic_id'] === 'auto_renewal')?.['tags']).toBe(',auto-renewal,');
    expect(first.find((entry) => entry['topic_id'] === 'liability_cap')?.['tags']).toBe(',no-cap,unverified,');
    expect(first.find((entry) => entry['topic_id'] === 'ip_ownership')?.['tags']).toBe(',ip-ours,');
    // 写しの中で条項が無かった種類と、今の基準にしか無い種類は、どちらも missing の行。
    expect(first.find((entry) => entry['topic_id'] === 'subcontracting')).toMatchObject({ present: false, tags: ',missing,', value_summary: null, value_json: null, article_ref: null, quote: null, review_verdict: null });
    expect(first.find((entry) => entry['topic_id'] === 'payment')).toMatchObject({ topic_label: '支払条件', present: false, tags: ',missing,', value_json: null, article_ref: null, quote: null });
    // 自社側が分からなければ知財の帰属は ours / theirs を決めない。
    expect(rows.find((entry) => entry['contract_id'] === 'sc-2' && entry['topic_id'] === 'ip_ownership')?.['tags']).toBe(',ip-unspecified,');
  });

  it('正常 / 境界: status で満了・終了の契約も読め、limit は契約の件数で切る。今日で満了したかを判定し直す', async () => {
    const { provider, signed } = await setup();
    const expired = await provider.rows(scope, { status: 'expired' });
    expect([...new Set(expired.map((entry) => entry['contract_id']))]).toEqual(['sc-old']);
    expect(expired.every((entry) => entry['contract_status'] === 'expired')).toBe(true);
    expect(expired.find((entry) => entry['topic_id'] === 'auto_renewal')?.['tags']).toBe(',no-auto-renewal,');
    expect(await provider.rows(scope, { status: 'terminated' })).toEqual([]);
    await signed.save(signedContractFixture('sc-t', { status: 'terminated', terminatedAt: '2026-08-01' }));
    expect([...new Set((await provider.rows(scope, { status: 'terminated' })).map((entry) => entry['contract_id']))]).toEqual(['sc-t']);
    const limited = await provider.rows(scope, { limit: 1 });
    expect([...new Set(limited.map((entry) => entry['contract_id']))]).toEqual(['sc-1']);
    expect(await inMemoryContractRepositories().signed.list(scope)).toEqual([]);
  });

  it('境界: 締結済み契約が無ければ行は 0 件', async () => {
    const repos = inMemoryContractRepositories();
    expect(await new ContractClauseRowsProvider(repos.signed, new ContractPlaybookResolver(repos.playbooks, clock), clock).rows(scope)).toEqual([]);
  });
});
