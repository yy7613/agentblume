/**
 * application層: ヒアリングで使う「迷うケース」の選択（純関数。docs/20 §4 / §7）。
 *
 * カタログ（`src/domain/journal/ambiguity-catalog.ts`）は 12 件あるが、**全部をプロンプトへ入れない**。
 * 関係のないケースまで見せると、モデルは「聞けることリスト」から適当に 3 問選び、
 * 帳票と関係のない質問（飲食のレシートに家事按分を聞く）を返す。ここで文書に当てはまるものだけを
 * 絞り込み、当てはまった理由（トリガ）と一緒に渡す。
 *
 * 選び方:
 * 1. Stage 1 の `ask-if` 理由が指す `questionId` と一致するカタログは**必ず入れる**
 *    （ルールが「この条件のときは確認せよ」と明示している＝利用者自身の設定）。
 * 2. 文書の摘要・発行者・明細・金額・種別からトリガ語で当てる。
 * 3. カタログの並び順で最大 `MAX_HEARING_AMBIGUITY_CASES` 件。
 *
 * 当てはまるものが 1 件も無いこともある（その場合はカタログ抜きで facts と判定理由だけを渡す）。
 * ここは純関数で、モデルにもリポジトリにも触らない。
 */
import { AMBIGUITY_CATALOG, type AmbiguityCase } from '../../domain/journal/ambiguity-catalog';
import type { DocumentFacts, DocumentKind, UndecidedReason } from '../../domain/journal/document';

/** プロンプトへ載せるカタログの上限（3 問しか聞かないので、候補は 5 件あれば足りる）。 */
export const MAX_HEARING_AMBIGUITY_CASES = 5;

/** 固定資産の確認に入る金額（docs/20 §4。1 単位 10 万円以上）。 */
const FIXED_ASSET_THRESHOLD = 100_000;

export interface AmbiguitySelectionInput {
  readonly kind: DocumentKind;
  readonly facts: DocumentFacts;
  /** Stage 1 が返した確定できない理由（`ask-if` は questionId でカタログを名指しする）。 */
  readonly reasons?: readonly UndecidedReason[];
}

/** 摘要・発行者・明細を 1 本の検索対象にする（NFKC + 小文字化で表記揺れを吸収する）。 */
function haystackOf(facts: DocumentFacts): string {
  const parts = [
    facts.descriptionNorm, facts.description, facts.issuerName, facts.recipientName,
    facts.counterpartyHint, facts.accountHint,
    ...(facts.lines ?? []).map((line) => line.description),
  ];
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

function maxLineAmount(facts: DocumentFacts): number {
  return (facts.lines ?? []).reduce((largest, line) => Math.max(largest, line.amount), 0);
}

function hasReducedRate(facts: DocumentFacts): boolean {
  return (facts.totalsByRate ?? []).some((entry) => entry.rate === 8)
    || (facts.lines ?? []).some((line) => line.taxRate === 8 || line.reducedRateMark === true);
}

/** 登録番号を載せない帳票（銀行明細など）は「番号が無い＝免税事業者」ではないので聞かない。 */
const INVOICE_LIKE_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(['invoice', 'simplified_invoice', 'receipt', 'expense_report']);
const STATEMENT_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(['bank_statement', 'card_statement']);

type Matcher = (input: AmbiguitySelectionInput, haystack: string) => boolean;

const MEAL = /飲食|レストラン|カフェ|居酒屋|食堂|寿司|焼肉|ラーメン|バル|ダイニング|珈琲|コーヒー|スターバックス|ドトール|マクドナルド|酒場|ビアガーデン|会食/u;
const EC = /amazon|アマゾン|楽天|ヨドバシ|ビックカメラ|モノタロウ|アスクル|たのめーる|メルカリ|ec|通販|オンラインストア/u;
const TRANSPORT = /タクシー|jr|鉄道|電車|地下鉄|メトロ|バス|新幹線|航空|ana|jal|suica|pasmo|icoca|高速|etc|駐車|旅費|交通/u;
const PREPAID = /年払|年間|1年|サブスク|subscription|保険|ライセンス|更新料|月額|プラン|契約期間/u;
const WITHHOLDING = /報酬|税理士|弁護士|司法書士|社労士|行政書士|原稿料|講演|デザイン料|コンサル|外注|業務委託/u;
const TAX_EXEMPT = /保険料|地代|家賃|切手|印紙|証紙|手数料|会費|寄付|寄附|行政|役所|登記/u;
const HOUSEHOLD = /家賃|電気|でんき|ガス|水道|光熱|通信|携帯|スマホ|インターネット|プロバイダ|wi-?fi/u;
const TRANSFER = /振替|引落|引き落とし|カード利用|atm|入出金|口座|資金移動|返済/u;

/** カタログ id → 「この文書で聞くべきか」。トリガ列（docs/20 §4 の表）をそのまま条件にしたもの。 */
const MATCHERS: Readonly<Record<string, Matcher>> = {
  meal_purpose: ({ facts }, haystack) => facts.direction !== 'in' && MEAL.test(haystack),
  ec_item_type: ({ facts }, haystack) => facts.direction !== 'in' && EC.test(haystack),
  fixed_asset_check: ({ facts }) => (facts.grandTotal ?? 0) >= FIXED_ASSET_THRESHOLD || maxLineAmount(facts) >= FIXED_ASSET_THRESHOLD,
  transport_kind: ({ facts }, haystack) => facts.direction !== 'in' && TRANSPORT.test(haystack),
  prepaid_period: (_input, haystack) => PREPAID.test(haystack),
  withholding_check: ({ facts }, haystack) => facts.direction !== 'in' && WITHHOLDING.test(haystack),
  invoice_registration: ({ kind, facts }) => facts.registrationNumber === undefined && facts.direction !== 'in' && INVOICE_LIKE_KINDS.has(kind),
  tax_exempt_kind: (_input, haystack) => TAX_EXEMPT.test(haystack),
  household_ratio: ({ facts }, haystack) => facts.direction !== 'in' && HOUSEHOLD.test(haystack),
  bank_transfer_in: ({ kind, facts }) => kind === 'bank_statement' && facts.direction === 'in',
  account_transfer: ({ kind }, haystack) => STATEMENT_KINDS.has(kind) && TRANSFER.test(haystack),
  reduced_rate_check: ({ facts }) => hasReducedRate(facts),
};

/** Stage 1 の `ask-if` がカタログを名指ししている場合の id 一覧。 */
function askedCatalogIds(reasons: readonly UndecidedReason[] | undefined): ReadonlySet<string> {
  return new Set((reasons ?? []).flatMap((reason) => (reason.code === 'ask-if' ? [reason.questionId] : [])));
}

/**
 * 文書に当てはまる「迷うケース」を選ぶ。`ask-if` が名指ししたものを先頭に、
 * 残りをカタログ順で最大 `MAX_HEARING_AMBIGUITY_CASES` 件返す。副作用なし。
 */
export function selectAmbiguityCases(input: AmbiguitySelectionInput): readonly AmbiguityCase[] {
  const haystack = haystackOf(input.facts);
  const asked = askedCatalogIds(input.reasons);
  const forced = AMBIGUITY_CATALOG.filter((entry) => asked.has(entry.id));
  const matched = AMBIGUITY_CATALOG.filter((entry) => !asked.has(entry.id) && (MATCHERS[entry.id]?.(input, haystack) ?? false));
  return [...forced, ...matched].slice(0, MAX_HEARING_AMBIGUITY_CASES);
}
