/**
 * ドメイン: 契約 BC の小さな列挙（葉モジュール）。
 *
 * 文書・審査基準・印紙税表・判定が共有する語彙だけを置く。循環 import を避けるため他のファイルを import しない。
 * **条項の種類や基準の文言はここに置かない**（それはデータ。`playbook-templates.ts` の初期値だけが持つ）。
 */

/** 自社の立場。発注・委託者 / 受注・受託者 / NDA 等の双方向。 */
export const OUR_ROLES = ['client', 'vendor', 'mutual'] as const;
export type OurRole = (typeof OUR_ROLES)[number];

/** 甲 = A、乙 = B。 */
export const PARTY_KEYS = ['A', 'B'] as const;
export type PartyKey = (typeof PARTY_KEYS)[number];

/** 相手方の区分の申告（取適法 / フリーランス法）。モデルにも決定的ロジックにも推定させない。 */
export const PROFILE_ANSWERS = ['yes', 'no', 'unknown'] as const;
export type ProfileAnswer = (typeof PROFILE_ANSWERS)[number];

/** 契約の性質（印紙税の候補の手掛かり）。 */
export const CONTRACT_NATURES = ['ukeoi', 'jun_inin', 'sale', 'nda', 'license', 'basic_transaction', 'other', 'unknown'] as const;
export type ContractNature = (typeof CONTRACT_NATURES)[number];

export const SIGNING_METHODS = ['paper', 'electronic', 'unknown'] as const;
export type SigningMethod = (typeof SIGNING_METHODS)[number];

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
