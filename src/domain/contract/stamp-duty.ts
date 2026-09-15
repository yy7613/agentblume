/**
 * ドメイン: 印紙税の課税文書の**候補**（docs/23 §4.4）。
 *
 * 判定は候補の提示だけで、トピックの verdict に影響しない（severity info）。税額表は審査基準のデータで、
 * 同梱の値は初期値に過ぎない（国税庁の最新の税額表で確かめ、改正時は画面から更新する）。
 * 複数候補（請負かつ基本契約）は両方を並べ、どちらに所属するかは通則に従い担当者が確かめる。
 * 電子契約（電磁的記録）は課税文書の作成に当たらないとされるので、候補の代わりにその旨を返す。
 */
import type { ContractNature, SigningMethod } from './vocabulary';

export interface StampDutyTier {
  /** この金額以下（円）。null は上限なし。 */
  readonly upTo: number | null;
  readonly amount: number;
}

export interface StampDutyDocumentType {
  readonly code: string;
  readonly name: string;
  readonly natures: readonly ContractNature[];
  readonly condition?: { readonly excludeTermMonthsAtMost?: number; readonly unlessRenewal?: boolean };
  readonly fixedAmount?: number;
  readonly tiers?: readonly StampDutyTier[];
  /** 契約金額の記載のないもの。 */
  readonly noAmountStated?: number;
  readonly sourceUrl: string;
  readonly note: string;
}

export interface StampDutySettings {
  readonly enabled: boolean;
  readonly documentTypes: readonly StampDutyDocumentType[];
}

export interface StampDutyInput {
  readonly nature: ContractNature | undefined;
  /** 契約金額（円）。読めていなければ undefined。 */
  readonly contractAmount?: number;
  readonly termMonths?: number;
  readonly renews?: boolean;
  readonly signingMethod?: SigningMethod;
}

export interface StampDutyCandidate {
  readonly code: 'stamp-duty-candidate' | 'stamp-duty-amount-unknown';
  readonly documentTypeCode: string;
  readonly name: string;
  /** 税額（円）。決まらなければ null。0 は非課税。 */
  readonly amount: number | null;
  readonly nature: ContractNature;
  readonly electronic: boolean;
  readonly sourceUrl: string;
}

/** 金額 → 階層の税額。階層は upTo の昇順で見る。 */
export function tierAmount(tiers: readonly StampDutyTier[], contractAmount: number): number | undefined {
  const sorted = [...tiers].sort((left, right) => (left.upTo ?? Number.POSITIVE_INFINITY) - (right.upTo ?? Number.POSITIVE_INFINITY));
  return sorted.find((tier) => tier.upTo === null || contractAmount <= tier.upTo)?.amount;
}

export function stampDutyCandidates(input: StampDutyInput, settings: StampDutySettings): readonly StampDutyCandidate[] {
  if (!settings.enabled || input.nature === undefined) return [];
  const nature = input.nature;
  const electronic = input.signingMethod === 'electronic';
  const candidates: StampDutyCandidate[] = [];
  for (const type of settings.documentTypes) {
    if (!type.natures.includes(nature)) continue;
    const condition = type.condition;
    if (condition?.excludeTermMonthsAtMost !== undefined && input.termMonths !== undefined && input.termMonths <= condition.excludeTermMonthsAtMost && !(condition.unlessRenewal === true && input.renews === true)) continue;
    const base = { documentTypeCode: type.code, name: type.name, nature, electronic, sourceUrl: type.sourceUrl };
    if (type.fixedAmount !== undefined) { candidates.push({ ...base, code: 'stamp-duty-candidate', amount: electronic ? 0 : type.fixedAmount }); continue; }
    if (type.tiers === undefined || type.tiers.length === 0) { candidates.push({ ...base, code: 'stamp-duty-candidate', amount: null }); continue; }
    if (input.contractAmount === undefined) { candidates.push({ ...base, code: 'stamp-duty-amount-unknown', amount: electronic ? 0 : type.noAmountStated ?? null }); continue; }
    const amount = tierAmount(type.tiers, input.contractAmount);
    candidates.push({ ...base, code: 'stamp-duty-candidate', amount: electronic ? 0 : amount ?? null });
  }
  return candidates;
}
