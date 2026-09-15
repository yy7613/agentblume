/**
 * 経費精算を合成根ごと一本通す E2E（docs/21 §15 composition 行）。
 *
 * 1. サンプル（`samples/expense/`）の規程 CSV を取り込み → 汎用 CSV を取り込み → チェックした結果が `expected-checks.json` と一致する。
 *    サンプルの期待値が実装とずれたまま放置されないよう、ここで固定する。
 * 2. 取込 → 確認済み → 承認 → 仕訳下書き → 仕訳の一覧に draft・tags・**科目マスタの科目名**で出る → 精算 CSV → 精算済み。
 *    科目を無効化したときの部分作成と「続きを作成」での再開（二重に作らない）。
 *
 * 判定日は業務のタイムゾーンで決まるので、時計（Date だけ）を 2026-09-30 の日本時間に固定する。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseClaim } from '../domain/expense/claim';
import { ExpenseJournalLinkError } from '../domain/expense/errors';
import { allReasons } from '../domain/expense/judgment';
import { defaultExpensePolicy } from '../domain/expense/default-policy';
import { createApp, type App } from './root';

const scope = { tenantId: 'local', workspaceId: 'default' };
const by = 'keiri@example.com';
const period = { from: '2026-09-01', to: '2026-09-30' };
const SAMPLES = join(process.cwd(), 'samples', 'expense');

interface ExpectedRow { readonly row: number; readonly claimant: string; readonly verdict: string; readonly codes: readonly string[] }
const expected = JSON.parse(readFileSync(join(SAMPLES, 'expected-checks.json'), 'utf8')) as { readonly today: string; readonly files: Readonly<Record<string, readonly ExpectedRow[]>> };

const sample = (name: string): string => readFileSync(join(SAMPLES, name), 'utf8');

/** 明細ごとの理由コード（順不同で比べるので並べ替える）と判定。 */
function outcomes(claim: ExpenseClaim): readonly { readonly verdict: string; readonly codes: readonly string[] }[] {
  const judgment = claim.judgment;
  if (judgment === undefined) throw new Error(`claim ${claim.id} is not checked`);
  return claim.items.map((item) => {
    const check = judgment.items.find((entry) => entry.itemId === item.id);
    return { verdict: check?.verdict ?? 'missing', codes: [...(check?.reasons ?? []).map((reason) => reason.code)].sort() };
  });
}

function expectedFor(file: string, claimant: string): readonly { readonly verdict: string; readonly codes: readonly string[] }[] {
  return (expected.files[file] ?? []).filter((row) => row.claimant === claimant).map((row) => ({ verdict: row.verdict, codes: [...row.codes].sort() }));
}

describe('経費精算の一本通し（E2E）', () => {
  let app: App;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 判定日 2026-09-30（日本時間 12:00）。
    vi.setSystemTime(new Date(`${expected.today}T03:00:00.000Z`));
    app = createApp({ profile: 'test' });
  });

  afterEach(() => {
    app.close();
    vi.useRealTimers();
  });

  it('正常: サンプルの規程 CSV を取り込むと規程が保存され、初期テンプレートの費目と一致する', async () => {
    expect((await app.getExpensePolicy.execute(scope)).saved).toBe(false);
    const policy = await app.importExpensePolicyCsv.execute({ scope, content: sample('policy-template.csv') });
    expect((await app.getExpensePolicy.execute(scope)).saved).toBe(true);
    expect(policy.categories).toEqual(defaultExpensePolicy().categories);
  });

  it('正常: サンプル CSV を取り込んでチェックした結果が expected-checks.json と一致する（Shift-JIS 版は同じ内容）', async () => {
    await app.importExpensePolicyCsv.execute({ scope, content: sample('policy-template.csv') });

    const generic = await app.importExpenseCsv.execute({ scope, content: sample('claims-generic.csv'), period, fileName: 'claims-generic.csv', by });
    expect(generic.skippedRows).toEqual([]);
    expect(generic.claims.map((claim) => claim.claimant.name)).toEqual(['テスト太郎', 'テスト花子']);
    const english = await app.importExpenseCsv.execute({ scope, content: sample('claims-english-headers.csv'), period, fileName: 'claims-english-headers.csv', by });
    expect(english.columnMatches.every((match) => match.field !== null)).toBe(true);

    expect(await app.checkExpenseClaims.execute({ scope, by })).toMatchObject({ checked: 3, skipped: 0 });
    for (const [file, ref] of [['claims-generic.csv', generic.claims[0]], ['claims-generic.csv', generic.claims[1]], ['claims-english-headers.csv', english.claims[0]]] as const) {
      const claim = await app.getExpenseClaim.execute(scope, ref!.id);
      expect(outcomes(claim), `${file} ${claim.claimant.name}`).toEqual(expectedFor(file, claim.claimant.name));
      // 規程を保存したので policy-unreviewed は出ない。
      expect(allReasons(claim.judgment!).map((reason) => reason.code)).not.toContain('policy-unreviewed');
    }

    // チェック済みの申請と同じ明細を再提出すると、申請間の重複が差し戻しの重さで出る。
    const resubmit = await app.importExpenseCsv.execute({ scope, content: sample('claims-resubmit.csv'), period, fileName: 'claims-resubmit.csv', by });
    await app.checkExpenseClaims.execute({ scope, claimIds: [resubmit.claims[0]!.id], by });
    const resubmitted = await app.getExpenseClaim.execute(scope, resubmit.claims[0]!.id);
    expect(outcomes(resubmitted)).toEqual(expectedFor('claims-resubmit.csv', 'テスト太郎'));
    expect(allReasons(resubmitted.judgment!).find((reason) => reason.code === 'duplicate-across-claims')?.severity).toBe('return');

    const sjis = new TextDecoder('shift_jis').decode(readFileSync(join(SAMPLES, 'claims-generic.sjis.csv')));
    expect(sjis).toBe(sample('claims-generic.csv'));
  });

  it('正常: 確認済み → 承認 → 仕訳下書き（科目を無効化して部分作成 → 有効に戻して続きを作成）→ 精算 CSV → 精算済み', async () => {
    // 日当の科目を福利厚生費へ変えた規程を保存し、仕訳の科目マスタで福利厚生費を無効にしておく。
    const base = defaultExpensePolicy();
    await app.saveExpensePolicy.execute({
      scope, claimRules: base.claimRules, preApprovalRules: base.preApprovalRules, severityOverrides: base.severityOverrides, journal: base.journal,
      categories: base.categories.map((category) => (category.id === 'travel.per_diem' ? { ...category, accountId: 'expense.welfare' } : category)),
    });
    const { chart } = await app.getJournalChart.execute(scope);
    const setWelfare = (enabled: boolean) => app.saveJournalChart.execute({ scope, dimensions: chart.dimensions, taxCategories: chart.taxCategories, accounts: chart.accounts.map((account) => (account.id === 'expense.welfare' ? { ...account, enabled } : account)) });
    await setWelfare(false);

    const csv = [
      '申請者,日付,支払先,金額,費目,目的,日数',
      'テスト三郎,2026/09/02,東京メトロ,420,電車・バス,客先訪問,',
      'テスト三郎,2026/09/03,,900,電車・バス,客先訪問,',
      'テスト三郎,2026/09/15,テスト工業株式会社（出張旅費規程）,6000,日当,大阪出張,2',
    ].join('\r\n');
    const imported = await app.importExpenseCsv.execute({ scope, content: csv, period, by });
    const claimId = imported.claims[0]!.id;
    await app.checkExpenseClaims.execute({ scope, claimIds: [claimId], by });

    // 支払先の無い明細は要確認。確認済みにするまで承認できない。
    let claim = await app.getExpenseClaim.execute(scope, claimId);
    expect(claim.judgment?.verdict).toBe('needs-review');
    const review = allReasons(claim.judgment!).find((reason) => reason.code === 'payee-missing')!;
    await expect(app.approveExpenseClaim.execute({ scope, claimId, by: 'shonin@example.com' })).rejects.toThrow(/cannot be approved/u);
    await app.acknowledgeExpenseReason.execute({ scope, claimId, itemId: review.itemId!, code: 'payee-missing', note: '券売機の領収書で支払先の印字が無い', by: 'shonin@example.com' });
    claim = await app.approveExpenseClaim.execute({ scope, claimId, by: 'shonin@example.com' });
    expect(claim.status).toBe('approved');

    // 3 件目（日当 → 福利厚生費）で仕訳側に拒否される。作れた 2 件は記録され、理由と直す場所が返る。
    const failure = await app.draftExpenseJournalEntries.execute({ scope, claimId, by }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExpenseJournalLinkError);
    expect((failure as ExpenseJournalLinkError).createdEntryIds).toHaveLength(2);
    expect((failure as ExpenseJournalLinkError).problems[0]).toMatchObject({ code: 'journal-rejected', fixTarget: 'journal-chart', categoryId: 'travel.per_diem', accountId: 'expense.welfare' });
    expect((await app.getExpenseClaim.execute(scope, claimId)).journalLink).toMatchObject({ complete: false });
    expect(await app.listJournalEntries.execute(scope)).toHaveLength(2);

    // 科目を有効に戻して続きを作成すると、残りの 1 件だけが作られる。
    await setWelfare(true);
    const resumed = await app.draftExpenseJournalEntries.execute({ scope, claimId, by });
    expect(resumed.entryIds).toHaveLength(1);
    expect(resumed.claim.journalLink).toMatchObject({ complete: true });
    const entries = await app.listJournalEntries.execute(scope);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.status).toBe('draft');
      expect(entry.tags).toEqual(expect.arrayContaining(['expense', `expense-claim:${claimId}`]));
    }
    // 科目名はクライアントの申告ではなく科目マスタから写る。
    expect(entries.flatMap((entry) => entry.lines.map((line) => line.accountName))).toEqual(expect.arrayContaining(['旅費交通費', '福利厚生費', '未払金']));
    await expect(app.draftExpenseJournalEntries.execute({ scope, claimId, by })).rejects.toThrow(/already created/u);

    // 精算 CSV は状態を変えず、精算済みの印で settled になる。
    const detail = await app.exportExpenseSettlement.execute({ scope, format: 'detail' });
    expect(detail).toMatchObject({ claimCount: 1, itemCount: 3, totalAmount: 7320 });
    for (const entry of entries) expect(detail.content).toContain(entry.id);
    expect((await app.getExpenseClaim.execute(scope, claimId)).status).toBe('approved');
    const [settled] = await app.settleExpenseClaims.execute({ scope, claimIds: [claimId], exportFileName: detail.fileName, by });
    expect(settled).toMatchObject({ status: 'settled', settlement: { exportFileName: 'expense-detail-2026-09-30.csv' } });
  });
});
