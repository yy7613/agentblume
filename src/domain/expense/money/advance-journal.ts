/**
 * ドメイン: 仮払の仕訳下書きの組み立て（docs/21 §20.12。UC4。純関数）。
 *
 * - 支払: 借方 仮払金（取引先 = 従業員）/ 貸方 普通預金（現金なら規程の支払の科目を現金にする）。
 * - 精算: 承認額合計 C・仮払額 A。C ≥ A なら「未払金 A / 仮払金 A」（残りの未払金 C − A は追加支給で払う）。
 *   C < A なら「未払金 C + 普通預金 (A − C) / 仮払金 A」。明細の下書き（費用 / 未払金）は別に作る前提。
 * インボイス区分は `not_required`、税区分は `JP-NA`。出所は `source.kind`（`advance-payment` / `advance-settlement`）とタグで表す。
 */
import type { ExpenseAdvance } from '../advance';
import type { ExpenseJournalLinkProblem } from '../errors';
import type { ExpenseJournalDraft, ExpenseJournalDraftLine } from '../journal-draft';
import type { ExpensePolicy } from '../policy';

export type AdvanceJournalStage = 'payment' | 'settlement';

export const ADVANCE_JOURNAL_TAX_CODE = 'JP-NA';

export interface AdvanceJournalDraftResult {
  readonly draft?: ExpenseJournalDraft;
  readonly problems: readonly ExpenseJournalLinkProblem[];
}

function tags(advance: ExpenseAdvance, stage: AdvanceJournalStage): readonly string[] {
  return ['expense', `expense-advance:${advance.id}`, stage === 'payment' ? 'expense-advance-payment' : 'expense-advance-settlement'];
}

function line(side: 'debit' | 'credit', accountId: string, amount: number, partner?: string): ExpenseJournalDraftLine {
  return { side, accountId, taxCode: ADVANCE_JOURNAL_TAX_CODE, amount, ...(partner === undefined ? {} : { partner }) };
}

/** 仕訳の科目マスタにある有効な科目 id（照合しないなら undefined）。 */
export type KnownAccounts = ReadonlySet<string> | undefined;

function accountProblems(accounts: readonly string[], known: KnownAccounts): readonly ExpenseJournalLinkProblem[] {
  if (known === undefined) return [];
  return [...new Set(accounts)].filter((accountId) => !known.has(accountId)).map((accountId) => ({
    code: 'account-not-in-chart', accountId, fixTarget: 'journal-chart' as const,
    message: `科目「${accountId}」が仕訳の科目マスタに無いか無効です。科目マスタで有効にするか、規程の「カード・仮払」節で仮払の科目を選び直してください`,
  }));
}

/** 仮払の仕訳下書き（支払 / 精算）。作れない理由があれば `problems`（1 件でもあれば下書きは作らない）。 */
export function buildAdvanceJournalDraft(advance: ExpenseAdvance, policy: Pick<ExpensePolicy, 'advance' | 'journal'>, stage: AdvanceJournalStage, known?: KnownAccounts): AdvanceJournalDraftResult {
  const settings = policy.advance;
  const partner = advance.employeeSnapshot.name;
  if (stage === 'payment') {
    if (advance.payment === undefined) {
      return { problems: [{ code: 'advance-not-paid', fixTarget: 'item', message: `仮払 ${advance.id} はまだ支払済みではありません。支払済みにしてから支払の仕訳下書きを作ってください` }] };
    }
    if (advance.journalLink?.paymentEntryId !== undefined) {
      return { problems: [{ code: 'advance-journal-exists', fixTarget: 'item', message: `仮払 ${advance.id} の支払の仕訳下書きは作成済みです（${advance.journalLink.paymentEntryId}）。仕訳画面で確認してください` }] };
    }
    const problems = accountProblems([settings.advanceAccountId, settings.paymentAccountId], known);
    if (problems.length > 0) return { problems };
    return {
      problems: [],
      draft: {
        source: { kind: 'advance-payment', id: advance.id },
        date: advance.payment.paidOn,
        description: `仮払 ${partner} ${advance.purpose}`,
        invoiceStatus: 'not_required',
        lines: [line('debit', settings.advanceAccountId, advance.amount, partner), line('credit', settings.paymentAccountId, advance.amount)],
        tags: tags(advance, stage),
      },
    };
  }
  const settlement = advance.settlement;
  if (settlement === undefined) {
    return { problems: [{ code: 'advance-not-settled', fixTarget: 'item', message: `仮払 ${advance.id} はまだ精算していません。精算してから精算の仕訳下書きを作ってください` }] };
  }
  if (advance.journalLink?.settlementEntryId !== undefined) {
    return { problems: [{ code: 'advance-journal-exists', fixTarget: 'item', message: `仮払 ${advance.id} の精算の仕訳下書きは作成済みです（${advance.journalLink.settlementEntryId}）。仕訳画面で確認してください` }] };
  }
  const payable = policy.journal.creditAccountId;
  const claimed = settlement.claimsTotal;
  const debit: ExpenseJournalDraftLine[] = [];
  if (claimed >= advance.amount) {
    debit.push(line('debit', payable, advance.amount, partner));
  } else {
    if (claimed > 0) debit.push(line('debit', payable, claimed, partner));
    debit.push(line('debit', settings.refundAccountId, advance.amount - claimed));
  }
  const problems = accountProblems([...debit.map((entry) => entry.accountId), settings.advanceAccountId], known);
  if (problems.length > 0) return { problems };
  return {
    problems: [],
    draft: {
      source: { kind: 'advance-settlement', id: advance.id },
      date: settlement.settledOn ?? settlement.computedAt.slice(0, 10),
      description: `仮払精算 ${partner} ${advance.purpose}`,
      invoiceStatus: 'not_required',
      lines: [...debit, line('credit', settings.advanceAccountId, advance.amount, partner)],
      tags: tags(advance, stage),
    },
  };
}
