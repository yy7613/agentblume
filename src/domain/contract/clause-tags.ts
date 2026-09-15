/**
 * ドメイン: 締結済み契約の条項を検索するための決定的なタグ（docs/23 §9.3）。
 *
 * 語彙は valueKind ごとに固定（組込みツール `contract_clauses` の description と一致させる）。
 * `missing`（条項が無い）と `no-cap`（条項はあるが上限の定めが無い）を分けるのは、
 * 「上限が無い契約は？」に両方を答える必要があるため。
 */
import { paymentMaxDays } from './legal-checks';
import type { LegalSettings } from './legal-checks';
import { withinPaymentLimit } from './legal-checks';
import type { SignedClause } from './signed-contract';
import type { PartyKey } from './vocabulary';

export const CLAUSE_TAGS = [
  'missing', 'no-cap', 'cap-fixed', 'cap-fees-paid', 'cap-unspecified', 'auto-renewal', 'no-auto-renewal', 'payment-over-limit', 'promissory-note',
  'subcontract-free', 'subcontract-consent', 'subcontract-notify', 'subcontract-prohibited', 'ip-ours', 'ip-theirs', 'ip-shared', 'ip-unspecified',
  'court-exclusive', 'court-non-exclusive', 'unverified',
] as const;
export type ClauseTag = (typeof CLAUSE_TAGS)[number];

export function clauseTags(clause: SignedClause, context: { readonly legal: LegalSettings; readonly ourParty?: PartyKey }): readonly ClauseTag[] {
  if (!clause.present) return ['missing'];
  const tags: ClauseTag[] = [];
  const value = clause.value;
  switch (value?.kind) {
    case 'liability_cap':
      tags.push(({ none: 'no-cap', fixed_amount: 'cap-fixed', fees_paid: 'cap-fees-paid', fees_months: 'cap-fees-paid', unspecified: 'cap-unspecified' } as const)[value.capKind]);
      break;
    case 'auto_renewal':
      tags.push(value.renews ? 'auto-renewal' : 'no-auto-renewal');
      break;
    case 'payment_terms': {
      const result = paymentMaxDays(value);
      // 相手方の区分に依らず、設定値（取適法の日数）を超える定めかどうかで付ける（検索の手掛かりであって判定ではない）。
      if (result.kind !== 'indeterminate' && !withinPaymentLimit(result, context.legal.paymentMaxDays, context.legal)) tags.push('payment-over-limit');
      if (value.method === 'promissory_note') tags.push('promissory-note');
      break;
    }
    case 'permission':
      tags.push(({ free: 'subcontract-free', prior_consent: 'subcontract-consent', notify: 'subcontract-notify', prohibited: 'subcontract-prohibited' } as const)[value.policy]);
      break;
    case 'ip_ownership':
      if (value.owner === 'shared') tags.push('ip-shared');
      else if (value.owner === 'unspecified' || context.ourParty === undefined) tags.push('ip-unspecified');
      else tags.push(value.owner === context.ourParty ? 'ip-ours' : 'ip-theirs');
      break;
    case 'jurisdiction':
      if (value.exclusive === true) tags.push('court-exclusive');
      else if (value.exclusive === false) tags.push('court-non-exclusive');
      break;
    default:
      break;
  }
  if (!clause.quoteVerified) tags.push('unverified');
  return tags;
}

/** 前後にもカンマを付ける（`,no-cap,`）。`contains` で 1 タグだけを当てやすくする。 */
export function formatTags(tags: readonly string[]): string {
  return tags.length === 0 ? '' : `,${tags.join(',')},`;
}
