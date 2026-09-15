/**
 * application層: 消込の理由コード → 利用者向けの「原因」文言（日本語。docs/22 §4.5）。
 *
 * エージェント用ツール（`receivables_match_candidates` の `reason_message`）が使う。画面は同じ表を
 * `ui/receivables/receivables-model.ts` に日英で持つ（UI はバックエンドの層を import できないため）。
 */
import type { MatchJudgment } from '../../domain/receivables/matching';

export interface ReasonContext {
  readonly payerName: string;
  readonly amount: number;
  readonly customerName: (customerId: string) => string;
  readonly invoiceNumber: (invoiceId: string) => string;
}

const yen = (value: number) => value.toLocaleString('ja-JP');

export function matchReasonMessage(judgment: MatchJudgment, context: ReasonContext): string {
  const first = judgment.candidates[0];
  const customer = first === undefined ? '' : context.customerName(first.customerId);
  const numbers = first === undefined ? '' : first.invoiceIds.map(context.invoiceNumber).join('、');
  const payer = context.payerName === '' ? '（名義なし）' : context.payerName;
  const ids = String(judgment.params?.['customerIds'] ?? '').split(',').filter((id) => id !== '');
  switch (judgment.reason) {
    case 'exact-amount-and-name': return `「${payer}」は ${customer} の ${numbers}（${yen(first!.candidateTotal)} 円）と金額・名義が一致しました`;
    case 'fee-difference': return `${numbers} の残高より ${yen(first!.difference)} 円少ない入金です。振込手数料を差し引かれた可能性があります`;
    case 'combined-payment': return `${customer} の請求 ${first!.invoiceIds.length} 件（${numbers}）の合計が入金額と一致しました`;
    case 'combined-payment-with-fee': return `${first!.invoiceIds.length} 件の合計より ${yen(first!.difference)} 円少ない入金です（合算 + 振込手数料）`;
    case 'partial-payment': return `${numbers}（残高 ${yen(first!.candidateTotal)} 円）に対して ${yen(context.amount)} 円の入金です。一部入金の可能性があります`;
    case 'name-partial': return `名義「${payer}」が ${customer} と一部だけ一致し、金額は ${numbers} と一致しました`;
    case 'amount-only': return `名義「${payer}」はどの取引先とも一致しませんが、${customer} の ${numbers} と金額が一致しました`;
    case 'no-candidate': return '金額・名義が一致する未入金の請求がありません';
    case 'no-open-invoice': return ids.length === 0 ? '未入金の請求がありません' : `未入金の請求がありません（${ids.map(context.customerName).join('、')} の請求はすべて入金済み、または入金日より後に発行）`;
    case 'multiple-candidates': return `同じ金額の未入金請求が ${judgment.params?.['count'] ?? judgment.candidates.length} 件あり、どれか決められません`;
    case 'ambiguous-combination': return `合計が入金額になる請求の組み合わせが ${judgment.params?.['count'] ?? judgment.candidates.length} 通りあります`;
    case 'search-limit': return `未入金請求が多すぎて、組み合わせを探しきれませんでした（${judgment.params?.['pool']} 件 / ${yen(Number(judgment.params?.['evaluations'] ?? 0))} 通りで打ち切り）`;
    case 'alias-conflict': return `名義「${payer}」が複数の取引先（${ids.map(context.customerName).join('、')}）の別名 / カナに登録されています`;
    case 'overpayment': return `${numbers} の残高 ${yen(first!.candidateTotal)} 円より ${yen(Number(judgment.params?.['excess'] ?? 0))} 円多い入金です`;
  }
}
