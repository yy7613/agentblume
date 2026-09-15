/**
 * application層: 添付の領収書を読み取り、保存済みの規程で試算チェックして「指摘の表」にする（docs/21 §13.1）。
 *
 * 画面の 取込 → チェック を 1 本のツールとして通すためのもの。読み取りは `ExtractReceiptUseCase`（取込タブと同じ）、
 * 判定は domain の `checkReceipt`（画面のチェックと同じ純関数。申請に依存するチェックだけを除く）。**保存しない**。
 * 1 行 = 1 指摘。指摘の無い明細は `verdict = 'pass'`・`code = null` の 1 行（空表だと「読めなかった」と区別できない）。
 */
import type { Row } from '../../domain/data/types';
import { EXPENSE_RECEIPT_CHECK_SCHEMA } from '../../domain/etl/nodes/expense-receipt-check';
import { businessDateOf, DEFAULT_BUSINESS_TIME_ZONE } from '../../domain/expense/business-date';
import { checkReceipt } from '../../domain/expense/check';
import type { ExpenseItem } from '../../domain/expense/claim';
import { findCategory } from '../../domain/expense/policy';
import { usableAmount } from '../../domain/expense/receipt-facts';
import type { ExpenseClaimRepository, ExpensePolicyRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExtractReceiptInput, ExtractReceiptResult } from './extract-receipt';
import { loadExpensePolicy } from './manage-policy';
import { reasonText } from './reason-messages';
import { receiptSha256 } from './receipt-hash';

/** いまの実行に添付された画像（`ResolveAttachment` と同形）。 */
export interface ExpenseReceiptAttachment {
  readonly name: string;
  readonly dataUrl: string;
}

export class ExpenseReceiptCheckRowsProvider {
  constructor(
    private readonly extract: { execute(input: ExtractReceiptInput, signal?: AbortSignal): Promise<ExtractReceiptResult> },
    private readonly policies: ExpensePolicyRepository,
    private readonly claims: ExpenseClaimRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
  ) {}

  async rows(scope: TenantScope, attachments: readonly ExpenseReceiptAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]> {
    const targets = options?.limit === undefined ? attachments : attachments.slice(0, options.limit);
    if (targets.length === 0) return [];
    const { policy, saved } = await loadExpensePolicy(this.policies, scope);
    const today = businessDateOf(this.now(), this.timeZone);
    const rows: Row[] = [];
    // 1 枚ずつ読む（別々の領収書なので、まとめて 1 回の読み取りにすると混ざる）。
    for (const [attachmentIndex, attachment] of targets.entries()) {
      const read = await this.extract.execute({ scope, images: [attachment.dataUrl], fileName: attachment.name });
      const sha = receiptSha256(attachment.dataUrl);
      for (const [index, draft] of read.drafts.entries()) {
        const item: ExpenseItem = { id: `attachment-${attachmentIndex + 1}-${index + 1}`, ...draft };
        const amount = usableAmount(item.facts);
        const date = item.facts.transactionDate;
        const candidates = await this.claims.findDuplicateCandidates(scope, { keys: date === undefined || amount === undefined ? [] : [{ transactionDate: date, amount }], sha256s: [sha] });
        const check = checkReceipt({ item, index, policy, duplicateCandidates: candidates, today, hasReceipt: true, receiptSha256: sha });
        const category = findCategory(policy, item.categoryId);
        const base = {
          file_name: attachment.name,
          item_no: index + 1,
          verdict: check.verdict,
          category_id: category?.id ?? null,
          category: category?.name ?? null,
          transaction_date: date ?? null,
          payee: item.facts.payeeName ?? null,
          amount: item.facts.amount ?? null,
          registration_number: item.facts.registrationNumber ?? null,
          attendees: item.facts.attendees?.count ?? null,
          search_keys_complete: date !== undefined && amount !== undefined && item.facts.payeeName !== undefined,
          policy_saved: saved,
          warnings: item.extraction.warnings.join(' / '),
          facts_json: JSON.stringify(item.facts),
        };
        if (check.reasons.length === 0) {
          rows.push(this.row(base, { severity: null, code: null, message: null, fix: null }));
          continue;
        }
        for (const reason of check.reasons) {
          const text = reasonText(reason);
          rows.push(this.row(base, { severity: reason.severity, code: reason.code, message: text.cause, fix: text.fix }));
        }
      }
    }
    return rows;
  }

  /** 列の並びをノードの固定スキーマに揃える。 */
  private row(base: Record<string, unknown>, finding: Record<string, unknown>): Row {
    const merged = { ...base, ...finding };
    return Object.fromEntries(EXPENSE_RECEIPT_CHECK_SCHEMA.columns.map((column) => [column.name, merged[column.name] ?? null])) as Row;
  }
}
