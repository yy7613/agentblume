/**
 * application層: 帳票の読取結果 → 経費の明細下書き（純粋。docs/21 §6.1 の「事実の写し方」）。
 *
 * - 経費精算書・伝票の発行者は（読取プロンプトの定義で）申請者・作成者なので支払先にせず、申請者の候補にする（自動では入れない）。
 * - 精算書の明細行が 2 行以上なら行ごとに下書きを作る。行には日付欄が無いので**日付は空**にする（文言から推測しない）。
 * - 参加人数・目的は読めたときだけの候補で、確認を促す警告を足す。
 * - 読み取った値は**自動で補正しない**。仕訳側の警告はそのまま写す。
 */
import type { ExpenseItem } from '../../domain/expense/claim';
import { isIsoDate } from '../../domain/journal/document';
import { guessCategory, type ExpensePolicy } from '../../domain/expense/policy';
import { sanitizeReceiptFacts, type ReceiptFacts } from '../../domain/expense/receipt-facts';
import type { ReceiptReadResult } from './receipt-read';

/** 保存前の明細（id・証憑本体・取込日は保存時に決まる）。 */
export type ExpenseItemDraft = Pick<ExpenseItem, 'categoryId' | 'categoryText' | 'facts' | 'extraction'> & {
  readonly source: { readonly type: 'image' | 'pdf'; readonly fileName?: string };
};

export interface ReceiptDraftsResult {
  readonly drafts: readonly ExpenseItemDraft[];
  /** 精算書・伝票の発行者（申請者欄の候補）。 */
  readonly claimantHint?: string;
  readonly warnings: readonly string[];
}

const ISSUER_IS_CLAIMANT_KINDS: ReadonlySet<string> = new Set(['expense_report', 'slip_transfer', 'slip_cash_in', 'slip_cash_out']);
const TEXT_MAX = 500;

function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, TEXT_MAX);
}

/** 読取の事実を検証済みの形にする。1 項目の不正で全体を落とさず、落とした理由を警告に残す。 */
function safeFacts(raw: ReceiptFacts, warnings: string[]): { readonly facts: ReceiptFacts; readonly rejected?: string } {
  try {
    const sanitized = sanitizeReceiptFacts(raw);
    warnings.push(...sanitized.warnings);
    return { facts: sanitized.facts, ...(sanitized.rejectedRegistrationNumber === undefined ? {} : { rejected: sanitized.rejectedRegistrationNumber }) };
  } catch (error) {
    // 縮退側でも形の悪い値を持ち込むと同じ検証でまた落ちる（壊れていたのが日付や金額だった場合）。
    // 形に合う金額と日付だけを拾い直し、読取全体は落とさない。
    const fallback = {
      ...(typeof raw.amount === 'number' && Number.isSafeInteger(raw.amount) ? { amount: raw.amount } : {}),
      ...(isIsoDate(raw.transactionDate) ? { transactionDate: raw.transactionDate } : {}),
      ...(isIsoDate(raw.issueDate) ? { issueDate: raw.issueDate } : {}),
    };
    warnings.push(`読み取った項目の一部が形に合わなかったので、形に合う金額と日付だけを残しました（残した項目: ${Object.keys(fallback).join(', ') || 'なし'}）: ${error instanceof Error ? error.message : String(error)}`);
    return { facts: sanitizeReceiptFacts(fallback).facts };
  }
}

export function receiptDraftsFromRead(read: ReceiptReadResult, policy: Pick<ExpensePolicy, 'categories'>, fileName?: string): ReceiptDraftsResult {
  const facts = read.facts;
  const issuerIsClaimant = ISSUER_IS_CLAIMANT_KINDS.has(read.documentKind);
  const claimantHint = issuerIsClaimant ? clip(facts.issuerName) : undefined;
  const sourceType: 'image' | 'pdf' = fileName?.toLowerCase().endsWith('.pdf') === true ? 'pdf' : 'image';
  const source = { type: sourceType, ...(fileName === undefined ? {} : { fileName }) };
  const baseExtraction = {
    method: 'llm' as const,
    ...(read.model === undefined ? {} : { model: read.model }),
    ...(read.confidence === undefined ? {} : { confidence: read.confidence }),
    documentKind: read.documentKind,
  };
  const paymentMethod = facts.paymentMethod === 'unknown' ? undefined : facts.paymentMethod;

  const lines = facts.lines ?? [];
  if (read.documentKind === 'expense_report' && lines.length >= 2) {
    const drafts = lines.map((line): ExpenseItemDraft => {
      const warnings = [...read.warnings, '精算書の明細には日付が無いため、利用日を入力してください'];
      const { facts: lineFacts, rejected } = safeFacts({
        amount: line.amount,
        ...(line.taxRate === undefined ? {} : { totalsByRate: [{ rate: line.taxRate, taxableAmount: line.amount, amountIncludesTax: true }] }),
        ...(clip(line.description) === undefined ? {} : { description: clip(line.description) }),
      }, warnings);
      const category = guessCategory(policy, [line.description]);
      return {
        ...(category === undefined ? {} : { categoryId: category.id }),
        facts: lineFacts,
        source,
        extraction: { ...baseExtraction, warnings, ...(rejected === undefined ? {} : { rejectedRegistrationNumber: rejected }) },
      };
    });
    return { drafts, ...(claimantHint === undefined ? {} : { claimantHint }), warnings: [...read.warnings] };
  }

  const warnings = [...read.warnings];
  const purpose = typeof facts.extra?.['purpose'] === 'string' ? clip(facts.extra['purpose']) : undefined;
  const headcount = facts.extra?.['headcount'];
  const count = typeof headcount === 'number' && Number.isInteger(headcount) && headcount >= 1 ? headcount : undefined;
  if (count !== undefined) warnings.push('参加人数は読取値です。確認してください');
  if (purpose !== undefined) warnings.push('目的は読取値です。確認してください');
  const { facts: itemFacts, rejected } = safeFacts({
    ...(facts.transactionDate === undefined ? {} : { transactionDate: facts.transactionDate, dateSource: 'read' as const }),
    ...(facts.issueDate === undefined ? {} : { issueDate: facts.issueDate }),
    ...(issuerIsClaimant || clip(facts.issuerName) === undefined ? {} : { payeeName: clip(facts.issuerName) }),
    ...(facts.registrationNumber === undefined ? {} : { registrationNumber: facts.registrationNumber }),
    ...(facts.grandTotal === undefined ? {} : { amount: facts.grandTotal }),
    ...(facts.totalsByRate === undefined ? {} : { totalsByRate: facts.totalsByRate }),
    ...(paymentMethod === undefined ? {} : { paymentMethod }),
    ...(clip(facts.description) === undefined ? {} : { description: clip(facts.description) }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(count === undefined ? {} : { attendees: { count } }),
  }, warnings);
  const category = guessCategory(policy, [facts.description, issuerIsClaimant ? undefined : facts.issuerName]);
  return {
    drafts: [{
      ...(category === undefined ? {} : { categoryId: category.id }),
      facts: itemFacts,
      source,
      extraction: { ...baseExtraction, warnings, ...(rejected === undefined ? {} : { rejectedRegistrationNumber: rejected }) },
    }],
    ...(claimantHint === undefined ? {} : { claimantHint }),
    warnings: [...read.warnings],
  };
}
