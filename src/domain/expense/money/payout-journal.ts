/**
 * ドメイン: 振込データを確定したときの支払の仕訳下書き（docs/21 §20.12「振込の支払（任意）」。UC3。純関数）。
 *
 * 借方: 申請の分と追加支給の分は未払金（`policy.journal.creditAccountId`）、仮払の支払の分は仮払金（`policy.advance.advanceAccountId`）を、
 * 従業員（取引先）ごとにまとめる。貸方: 振込元の設定の `journal.sourceAccountId`（普通預金）に合計。
 * 振込元の設定 `journal.createPaymentEntry` が on のときだけ application が呼ぶ（既定 off。§20.17-6）。
 */
import type { ExpenseJournalDraft, ExpenseJournalDraftLine } from '../journal-draft';
import type { ExpensePayoutBatch } from '../payout';
import type { ExpensePolicy } from '../policy';

export function buildPayoutJournalDraft(batch: ExpensePayoutBatch, policy: Pick<ExpensePolicy, 'journal' | 'advance'>): ExpenseJournalDraft {
  const debit = new Map<string, ExpenseJournalDraftLine>();
  for (const line of batch.lines) {
    for (const source of line.sources) {
      const accountId = source.kind === 'advance-payment' ? policy.advance.advanceAccountId : policy.journal.creditAccountId;
      const key = `${accountId}${line.name}`;
      const current = debit.get(key);
      debit.set(key, { side: 'debit', accountId, taxCode: 'JP-NA', amount: (current?.amount ?? 0) + source.amount, partner: line.name });
    }
  }
  return {
    source: { kind: 'payout', id: batch.id },
    date: batch.transferDate,
    description: `振込 ${batch.fileName}`,
    invoiceStatus: 'not_required',
    lines: [...debit.values(), { side: 'credit', accountId: batch.settingsSnapshot.journal.sourceAccountId, taxCode: 'JP-NA', amount: batch.totalAmount }],
    tags: ['expense', `expense-payout:${batch.id}`],
  };
}
