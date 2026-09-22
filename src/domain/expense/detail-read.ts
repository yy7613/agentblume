/**
 * ドメイン: 経費専用の追加読取（UC7）の応答の形と、明細に残す読取の印（docs/21 §20.2.4 / §20.7.1。骨格）。
 *
 * 追加読取は「印字どおりの文字列」だけをモデルに書き写させ、数値化・日付化・桁数の判定・支払先キーの比較はコードが行う
 * （12B 級のモデルに正規化をさせない。ADR-0043 §10）。変換と照合（`mergeExpenseDetail`）は C の `input/detail-merge.ts`。
 * ここは応答スキーマ（プロンプト版 `expense-detail/v1`）と、明細の `extraction.flags` / `extraction.detail` の形と検証だけを持つ。
 */
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ExpenseDomainError } from './errors';

/** 構造化した読取メタ（判定は flags だけを見る）。人がその欄を編集して保存したら、画面が対応する印を外して送る。 */
export const EXTRACTION_FLAGS = [
  'transaction-date-substituted', 'registration-number-rejected', 'payee-from-report', 'reads-disagree',
  'attendees-read', 'purpose-read', 'route-read', 'payee-read', 'detail-read-failed',
] as const;
export type ExtractionFlag = (typeof EXTRACTION_FLAGS)[number];

/** §20.7.1 の応答（strict スキーマ）そのもの。 */
export interface ExpenseDetailRead {
  readonly registrationNumberText: string | null;
  readonly payeeNameText: string | null;
  readonly transactionDateText: string | null;
  readonly issueDateText: string | null;
  readonly attendees: { readonly countText: string | null; readonly names: readonly string[] };
  readonly purposeClues: readonly string[];
  readonly route: { readonly from: string | null; readonly to: string | null; readonly via: readonly string[]; readonly fareType: 'ic' | 'ticket' | null };
  readonly notes: readonly string[];
}

/** 構造化出力に渡す JSON Schema（§20.7.1。変えるときはプロンプト版を上げる）。 */
export const EXPENSE_DETAIL_READ_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['registrationNumberText', 'payeeNameText', 'transactionDateText', 'issueDateText', 'attendees', 'purposeClues', 'route', 'notes'],
  properties: {
    registrationNumberText: { type: ['string', 'null'], description: 'T で始まる登録番号を印字どおり（ハイフン・空白も含めて）' },
    payeeNameText: { type: ['string', 'null'], description: '領収書を発行した店・会社の名前（精算書なら利用した店の名前。作成者の氏名は入れない）' },
    transactionDateText: { type: ['string', 'null'], description: '利用日・取引日として印字された日付の文字列（無ければ null。発行日で代用しない）' },
    issueDateText: { type: ['string', 'null'] },
    attendees: {
      type: 'object', additionalProperties: false, required: ['countText', 'names'],
      properties: { countText: { type: ['string', 'null'], description: '人数の印字・手書き（例 4名）' }, names: { type: 'array', items: { type: 'string' }, maxItems: 20 } },
    },
    purposeClues: { type: 'array', items: { type: 'string' }, maxItems: 5, description: '但し書き・メモ・手書きの用途' },
    route: {
      type: 'object', additionalProperties: false, required: ['from', 'to', 'via', 'fareType'],
      properties: { from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] }, via: { type: 'array', items: { type: 'string' }, maxItems: 10 }, fareType: { type: ['string', 'null'], enum: ['ic', 'ticket', null] } },
    },
    notes: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
} as const;

export const DETAIL_DISAGREEMENT_FIELDS = ['registrationNumber', 'transactionDate', 'issueDate', 'payeeName'] as const;
export type DetailDisagreementField = (typeof DETAIL_DISAGREEMENT_FIELDS)[number];

/** 明細に残す追加読取の記録（監査・再表示用）。 */
export interface ExpenseDetailRecord {
  readonly promptVersion: string;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly readAt: IsoDateTime;
  readonly raw: ExpenseDetailRead;
  readonly disagreements: readonly { readonly field: DetailDisagreementField; readonly journalValue: string | null; readonly detailValue: string | null }[];
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const stringArray = (value: unknown, max: number): boolean => Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string');

/** 応答の形だけを見る（値の正規化はしない）。形が違えば undefined（呼び出し側は `detail-read-failed` の印にする）。 */
export function parseExpenseDetailRead(value: unknown): ExpenseDetailRead | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const attendees = raw['attendees'] as Record<string, unknown> | null | undefined;
  const route = raw['route'] as Record<string, unknown> | null | undefined;
  const ok = nullableString(raw['registrationNumberText']) && nullableString(raw['payeeNameText']) && nullableString(raw['transactionDateText']) && nullableString(raw['issueDateText'])
    && attendees !== null && typeof attendees === 'object' && nullableString(attendees['countText']) && stringArray(attendees['names'], 20)
    && stringArray(raw['purposeClues'], 5)
    && route !== null && typeof route === 'object' && nullableString(route['from']) && nullableString(route['to']) && stringArray(route['via'], 10)
    && (route['fareType'] === null || route['fareType'] === 'ic' || route['fareType'] === 'ticket')
    && stringArray(raw['notes'], 5);
  if (!ok || attendees === undefined || route === undefined) return undefined;
  return {
    registrationNumberText: raw['registrationNumberText'] as string | null,
    payeeNameText: raw['payeeNameText'] as string | null,
    transactionDateText: raw['transactionDateText'] as string | null,
    issueDateText: raw['issueDateText'] as string | null,
    attendees: { countText: attendees['countText'] as string | null, names: [...(attendees['names'] as string[])] },
    purposeClues: [...(raw['purposeClues'] as string[])],
    route: { from: route['from'] as string | null, to: route['to'] as string | null, via: [...(route['via'] as string[])], fareType: route['fareType'] as 'ic' | 'ticket' | null },
    notes: [...(raw['notes'] as string[])],
  };
}

export function validateExtractionFlags(value: unknown, label: string): readonly ExtractionFlag[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((flag) => !(EXTRACTION_FLAGS as readonly unknown[]).includes(flag))) throw fail(`${label} must be an array of ${EXTRACTION_FLAGS.join(', ')}`);
  // 空の配列は書かない（既存の record_json の再直列化をバイト同一に保つ。§20.2.13）。
  const flags = [...new Set(value as ExtractionFlag[])];
  return flags.length === 0 ? undefined : flags;
}

export function validateDetailRecord(value: unknown, label: string): ExpenseDetailRecord | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw['promptVersion'] !== 'string' || raw['promptVersion'] === '') throw fail(`${label}.promptVersion must be a non-empty string`);
  assertIsoDateTime(raw['readAt'], `${label}.readAt`, fail);
  const read = parseExpenseDetailRead(raw['raw']);
  if (read === undefined) throw fail(`${label}.raw must match the expense detail read response schema`);
  let model: ExpenseDetailRecord['model'];
  if (raw['model'] !== undefined) {
    const candidate = raw['model'] as Record<string, unknown> | null;
    if (candidate === null || typeof candidate !== 'object' || typeof candidate['provider'] !== 'string' || typeof candidate['model'] !== 'string') throw fail(`${label}.model must be { provider, model }`);
    model = { provider: candidate['provider'], model: candidate['model'] };
  }
  if (!Array.isArray(raw['disagreements'])) throw fail(`${label}.disagreements must be an array`);
  const disagreements = raw['disagreements'].map((entry: unknown, index) => {
    const item = entry as Record<string, unknown> | null;
    if (item === null || typeof item !== 'object' || !(DETAIL_DISAGREEMENT_FIELDS as readonly unknown[]).includes(item['field']) || !nullableString(item['journalValue']) || !nullableString(item['detailValue'])) {
      throw fail(`${label}.disagreements[${index}] must be { field, journalValue, detailValue }`);
    }
    return { field: item['field'] as DetailDisagreementField, journalValue: item['journalValue'] as string | null, detailValue: item['detailValue'] as string | null };
  });
  return { promptVersion: raw['promptVersion'], ...(model === undefined ? {} : { model }), readAt: raw['readAt'] as string, raw: read, disagreements };
}
