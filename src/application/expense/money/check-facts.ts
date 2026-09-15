/**
 * application層: 判定に要る「お金の流れ」の事実を集める（docs/21 §20.3.3 / §20.3.5）。
 *
 * - 仮払: `claim.advanceId` の仮払の要約（従業員・状態・精算日・精算に含めた申請）。
 * - カード: 明細の取引日の範囲 ± 許容日数・金額 ± 許容差のカード利用を索引から引き、「未照合、またはこの申請に照合済み」だけを渡す
 *   （他の申請に照合済みのカード利用は奪わない。対象外は渡さない）。会社払いの明細を受け入れる運用なら取込範囲も渡す。
 * カードが 1 枚も登録されていなければカードの事実を集めない（MVP と同じ判定）。画像本体は読まない。
 */
import type { CheckExtensionsInput } from '../../../domain/expense/check-extensions';
import type { ExpenseClaim } from '../../../domain/expense/claim';
import type { MoneyAdvanceFact, MoneyCardFacts, MoneyCheckFacts } from '../../../domain/expense/money/check-facts';
import type { ExpensePolicy } from '../../../domain/expense/policy';
import { usableAmount } from '../../../domain/expense/receipt-facts';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseCheckFactsProvider } from '../ports';
import type { ExpenseSystemDeps } from '../system-deps';

/** `YYYY-MM-DD` を日数だけずらす。 */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export class MoneyCheckFactsProvider implements ExpenseCheckFactsProvider {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async gather(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy, _today?: string): Promise<Partial<CheckExtensionsInput>> {
    const [advance, card] = await Promise.all([this.advanceFact(scope, claim), this.cardFacts(scope, claim, policy)]);
    if (advance === undefined && card === undefined) return {};
    const money: MoneyCheckFacts = { ...(advance === undefined ? {} : { advance }), ...(card === undefined ? {} : { card }) };
    return { money };
  }

  private async advanceFact(scope: TenantScope, claim: ExpenseClaim): Promise<MoneyAdvanceFact | undefined> {
    if (claim.advanceId === undefined) return undefined;
    const advance = await this.deps.repositories.advances.findById(scope, claim.advanceId);
    if (advance === null) return undefined;
    const settledOn = advance.settlement?.settledOn ?? (advance.status === 'settling' ? advance.settlement?.computedAt.slice(0, 10) : undefined);
    return {
      id: advance.id, employeeId: advance.employeeId, employeeName: advance.employeeSnapshot.name, status: advance.status,
      settledClaimIds: advance.settlement?.claimIds ?? [], ...(settledOn === undefined ? {} : { settledOn }),
    };
  }

  private async cardFacts(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy): Promise<MoneyCardFacts | undefined> {
    const items = claim.items.flatMap((item) => {
      const amount = usableAmount(item.facts);
      return amount === undefined || item.facts.transactionDate === undefined ? [] : [{ amount, date: item.facts.transactionDate, corporate: item.facts.corporatePayment === true }];
    });
    if (items.length === 0) return undefined;
    const settings = (await this.deps.settings.load(scope, 'cards')).value;
    if (settings.cards.length === 0) return undefined;
    const { dateToleranceDays, amountToleranceYen } = policy.card;
    const dates = items.map((item) => item.date).sort();
    const found = await this.deps.repositories.cards.findTransactionsForMatching(scope, {
      from: addDays(dates[0] as string, -dateToleranceDays),
      to: addDays(dates[dates.length - 1] as string, dateToleranceDays),
      amounts: items.map((item) => ({ min: item.amount - amountToleranceYen, max: item.amount + amountToleranceYen })),
    });
    const transactions = found
      .filter((transaction) => transaction.status === 'unmatched' || (transaction.status === 'matched' && transaction.match?.claimId === claim.id))
      .map((transaction) => ({
        id: transaction.id, cardId: transaction.cardId, usedOn: transaction.usedOn, merchantRaw: transaction.merchantRaw, merchantKey: transaction.merchantKey, amount: transaction.amount,
        ...(transaction.match?.manual === true ? { manualItemId: transaction.match.itemId } : {}),
      }));
    const needsCoverage = policy.card.acceptCorporatePaymentItems && items.some((item) => item.corporate);
    const coverage = needsCoverage ? await this.deps.repositories.cards.coverage(scope) : [];
    return {
      cards: settings.cards.map((entry) => ({ id: entry.id, label: entry.label, last4: entry.last4, ...(entry.holderEmployeeId === undefined ? {} : { holderEmployeeId: entry.holderEmployeeId }) })),
      transactions,
      coverage,
    };
  }
}
