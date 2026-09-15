/**
 * 契約画面（docs/23 §7）の純粋関数。画面の部品から描画以外の判断を抜き出してテストできるようにする。
 *
 * UI は domain を import しない（`ui-http-boundary-only`）。置換子や甲乙の検出など、サーバーと同じ規則が要るものは
 * ここに小さく写す（サーバー側が正本で、保存時に同じ規則で検証される）。
 */
import type {
  ClauseDto, ClauseValueDto, ConditionDto, ConditionOpDto, ContractArticleDto, ContractDocumentDto, ContractDocumentStatusDto, DeadlineKindDto, DeadlineStateDto,
  OurRoleDto, PlaybookCriterionDto, PlaybookDto, SavePlaybookDto, SignedContractStatusDto, ValueKindDto, VerdictDto,
} from '../api/contract-types';
import type { OpenTarget } from '../navigation';

export type Translate = (english: string, japanese: string) => string;

export const CONTRACT_STEPS = ['playbook', 'import', 'clauses', 'review', 'sign', 'ledger'] as const;
export type ContractStep = (typeof CONTRACT_STEPS)[number];

/** 画面の固定文言（docs/23 §4.3）。API の `notice` が無いときもこれを出す。 */
export function legalNotice(text: Translate): string {
  return text(
    'This result compares the contract with the criteria and settings registered in your workspace (for example a 60-day payment period). It is not legal advice. Whether a law applies and the final decision are for the person in charge or a professional.',
    'この結果は、ワークスペースに登録された審査基準と設定値（支払期日 60 日など）との照合です。法的な判断ではありません。適用の有無と最終判断は担当者・専門家が行ってください。',
  );
}

export function isContractStep(value: unknown): value is ContractStep {
  return typeof value === 'string' && (CONTRACT_STEPS as readonly string[]).includes(value);
}

/** ディープリンク（`OpenTarget`）→ 開くステップと対象。section が未知なら undefined。 */
export function parseContractTarget(target: OpenTarget): { readonly step: ContractStep; readonly id?: string; readonly nodeId?: string } | undefined {
  if (!isContractStep(target.section)) return undefined;
  return { step: target.section, ...(target.internalId === '' ? {} : { id: target.internalId }), ...(target.nodeId === undefined ? {} : { nodeId: target.nodeId }) };
}

/** その文書でステップを開けるか。開けないときは理由（空状態の文言に使う）。 */
export function stepBlocker(step: ContractStep, document: Pick<ContractDocumentDto, 'status'> | undefined, text: Translate): string | undefined {
  if (step === 'playbook' || step === 'import' || step === 'ledger') return undefined;
  if (document === undefined) return text('Import a contract first, then pick it from the list.', '先に契約書を取り込み、一覧から選んでください。');
  if (step === 'clauses') return undefined;
  if (document.status === 'imported' || document.status === 'extracted') return text('Confirm the clauses first.', '先に条項を確認して確定してください。');
  return undefined;
}

export function verdictLabel(verdict: VerdictDto, text: Translate): string {
  return { accept: text('Acceptable', '受け入れ可'), negotiate: text('Negotiate', '要交渉'), reject: text('Not acceptable', '不可'), unresolved: text('Needs a decision', '要確認') }[verdict];
}

export function documentStatusLabel(status: ContractDocumentStatusDto, text: Translate): string {
  return { imported: text('Imported', '取込済み'), extracted: text('Extracted', '抽出済み'), confirmed: text('Clauses confirmed', '条項確定'), reviewed: text('Reviewed', 'レビュー確定'), signed: text('Signed', '締結登録済み') }[status];
}

export function deadlineKindLabel(kind: DeadlineKindDto, text: Translate): string {
  return { expiry: text('Expiry', '満了日'), renewal_notice: text('Renewal notice deadline', '更新拒絶の通知期限'), renewal: text('Renewal', '更新日'), custom: text('Custom', 'その他') }[kind];
}

export function deadlineStateLabel(state: DeadlineStateDto, text: Translate): string {
  return { overdue: text('Overdue', '期限切れ'), 'due-soon': text('Due soon', '期限が近い'), upcoming: text('Upcoming', '予定') }[state];
}

export function contractStatusLabel(status: SignedContractStatusDto, text: Translate): string {
  return { active: text('Active', '有効'), expired: text('Expired', '満了'), terminated: text('Terminated', '終了') }[status];
}

export function roleLabel(role: OurRoleDto, text: Translate): string {
  return { client: text('Client (we order the work)', '発注・委託者（自社が依頼する側）'), vendor: text('Vendor (we do the work)', '受注・受託者（自社が請ける側）'), mutual: text('Mutual (NDA etc.)', '双方向（秘密保持契約など）') }[role];
}

export function daysLeftLabel(days: number, text: Translate): string {
  if (days < 0) return text(`${-days} days overdue`, `${-days} 日超過`);
  if (days === 0) return text('Due today', '今日が期限');
  return text(`${days} days left`, `あと ${days} 日`);
}

/** 期限の表示状態（サーバーと同じ規則: 当日は due-soon、翌日から overdue）。 */
export function deadlineState(daysLeft: number, dueSoonDays: number): DeadlineStateDto {
  if (daysLeft < 0) return 'overdue';
  return daysLeft <= dueSoonDays ? 'due-soon' : 'upcoming';
}

/* ---------------------------------------------------------------------------
 * 本文のハイライト
 * ------------------------------------------------------------------------ */

export interface TextSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly highlighted: boolean;
  /** 強調中のトピック（複数重なるときは先のもの）。 */
  readonly topicId?: string;
}

export interface HighlightRange {
  readonly start: number;
  readonly end: number;
  readonly topicId: string;
}

/** 条項の根拠の位置（照合できたものだけ）。 */
export function evidenceRanges(clauses: readonly ClauseDto[], topicId?: string): readonly HighlightRange[] {
  return clauses.filter((clause) => topicId === undefined || clause.topicId === topicId)
    .flatMap((clause) => clause.evidence.filter((entry) => entry.start !== undefined && entry.end !== undefined).map((entry) => ({ start: entry.start!, end: entry.end!, topicId: clause.topicId })));
}

/** 本文を「強調あり / なし」の区間に割る（重なりは先の区間を優先し、区間の外は素の文字列）。 */
export function highlightSegments(body: string, ranges: readonly HighlightRange[]): readonly TextSegment[] {
  const sorted = [...ranges].filter((range) => range.start < range.end && range.start >= 0 && range.end <= body.length).sort((left, right) => left.start - right.start || right.end - left.end);
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.end <= cursor) continue;
    const start = Math.max(range.start, cursor);
    if (start > cursor) segments.push({ start: cursor, end: start, text: body.slice(cursor, start), highlighted: false });
    segments.push({ start, end: range.end, text: body.slice(start, range.end), highlighted: true, topicId: range.topicId });
    cursor = range.end;
  }
  if (cursor < body.length) segments.push({ start: cursor, end: body.length, text: body.slice(cursor), highlighted: false });
  return segments;
}

export function articleAt(articles: readonly ContractArticleDto[], position: number): ContractArticleDto | undefined {
  return articles.find((article) => position >= article.start && position < article.end);
}

/** 本文で選んだ範囲を、そのトピックの根拠にした条項（手指定。値は利用者がこのあとフォームで入れる）。 */
export function clauseFromSelection(existing: ClauseDto | undefined, topicId: string, document: Pick<ContractDocumentDto, 'body' | 'articles'>, start: number, end: number): ClauseDto | undefined {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(document.body.length, Math.max(start, end));
  const quote = document.body.slice(from, to);
  if (quote.trim() === '') return undefined;
  const article = articleAt(document.articles, from);
  return {
    topicId, present: true,
    ...(article === undefined ? (existing?.articleRef === undefined ? {} : { articleRef: existing.articleRef }) : { articleRef: article.ref }),
    evidence: [{ quote: quote.slice(0, 2000), start: from, end: from + Math.min(quote.length, 2000), verified: true }],
    ...(existing?.value === undefined ? {} : { value: existing.value }),
    source: 'manual',
    // 手で根拠を付け直したので、引用の照合と競合の警告は外す（値の読み取りの警告は残す）。
    warnings: (existing?.warnings ?? []).filter((warning) => warning.code !== 'quote-not-found' && warning.code !== 'conflicting-clauses' && warning.code !== 'extraction-failed' && warning.code !== 'clause-missing'),
  };
}

/* ---------------------------------------------------------------------------
 * 値のフォーム
 * ------------------------------------------------------------------------ */

export interface ValueField {
  readonly key: string;
  readonly label: string;
  readonly input: 'date' | 'number' | 'boolean' | 'select' | 'text' | 'day';
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export function valueFields(kind: ValueKindDto, text: Translate): readonly ValueField[] {
  switch (kind) {
    case 'term': return [
      { key: 'startDate', label: text('Start date', '始期'), input: 'date' }, { key: 'endDate', label: text('End date', '満了日'), input: 'date' },
      { key: 'durationMonths', label: text('Duration (months)', '期間（月数）'), input: 'number' }, { key: 'startsOnSigning', label: text('Starts on signing', '締結日から始まる'), input: 'boolean' },
    ];
    case 'auto_renewal': return [
      { key: 'renews', label: text('Renews automatically', '自動更新する'), input: 'boolean' }, { key: 'renewalMonths', label: text('Renewal period (months)', '更新期間（月数）'), input: 'number' },
      { key: 'sameAsInitial', label: text('Same period as the initial term', '初回と同じ期間で更新'), input: 'boolean' },
    ];
    case 'notice': return [
      { key: 'amount', label: text('Notice period', '通知期間'), input: 'number' },
      { key: 'unit', label: text('Unit', '単位'), input: 'select', options: [{ value: 'month', label: text('months', 'か月') }, { value: 'day', label: text('days', '日') }] },
      { key: 'anchor', label: text('Counted from', '起点'), input: 'select', options: [{ value: 'expiry', label: text('expiry', '満了') }, { value: 'renewal', label: text('renewal', '更新日') }] },
      { key: 'businessDays', label: text('Business days', '営業日'), input: 'boolean' },
    ];
    case 'payment_terms': return [
      { key: 'basis', label: text('Counted from', '基準日'), input: 'select', options: [{ value: 'delivery', label: text('delivery', '納品・受領') }, { value: 'acceptance', label: text('acceptance', '検収') }, { value: 'invoice', label: text('invoice', '請求') }, { value: 'unknown', label: text('unknown', '不明') }] },
      { key: 'closingDay', label: text('Closing day', '締め日'), input: 'day' },
      { key: 'payMonthOffset', label: text('Months after closing', '締めの何か月後'), input: 'number' },
      { key: 'payDay', label: text('Payment day', '支払日'), input: 'day' },
      { key: 'daysAfterBasis', label: text('Days after the base date', '基準日から何日以内'), input: 'number' },
      { key: 'method', label: text('Payment method', '支払手段'), input: 'select', options: [
        { value: '', label: text('— not stated —', '— 記載なし —') }, { value: 'bank_transfer', label: text('bank transfer', '振込') }, { value: 'promissory_note', label: text('promissory note', '手形') },
        { value: 'electronic_record', label: text('electronic record', '電子記録債権') }, { value: 'factoring', label: text('factoring', 'ファクタリング') }, { value: 'cash', label: text('cash', '現金') }, { value: 'other', label: text('other', 'その他') },
      ] },
    ];
    case 'liability_cap': return [
      { key: 'capKind', label: text('Cap', '上限'), input: 'select', options: [{ value: 'none', label: text('no cap', '上限なし') }, { value: 'fixed_amount', label: text('fixed amount', '定額') }, { value: 'fees_paid', label: text('fees paid', '支払済み委託料') }, { value: 'fees_months', label: text('months of fees', '委託料の何か月分') }, { value: 'unspecified', label: text('unclear', '不明確') }] },
      { key: 'amount', label: text('Amount (JPY)', '金額（円）'), input: 'number' }, { key: 'months', label: text('Months', '月数'), input: 'number' },
      { key: 'excludesWillfulOrGross', label: text('Wilful misconduct / gross negligence excluded from the cap', '故意・重過失は上限の対象外'), input: 'boolean' },
    ];
    case 'permission': return [{ key: 'policy', label: text('Policy', '扱い'), input: 'select', options: [{ value: 'free', label: text('free', '自由') }, { value: 'prior_consent', label: text('prior consent', '事前承諾') }, { value: 'notify', label: text('notify', '通知') }, { value: 'prohibited', label: text('prohibited', '禁止') }] }];
    case 'ip_ownership': return [
      { key: 'owner', label: text('Owner', '帰属'), input: 'select', options: [{ value: 'A', label: text('Party A (甲)', '甲') }, { value: 'B', label: text('Party B (乙)', '乙') }, { value: 'shared', label: text('shared', '共有') }, { value: 'unspecified', label: text('unclear', '不明確') }] },
      { key: 'transferOn', label: text('Transfers on', '移転の時期'), input: 'select', options: [{ value: '', label: text('— not stated —', '— 記載なし —') }, { value: 'delivery', label: text('delivery', '納品時') }, { value: 'payment', label: text('payment', '支払完了時') }, { value: 'creation', label: text('creation', '発生時') }] },
      { key: 'moralRightsNotExercised', label: text('Moral rights not exercised', '著作者人格権を行使しない'), input: 'boolean' },
    ];
    case 'jurisdiction': return [{ key: 'court', label: text('Court', '裁判所'), input: 'text' }, { key: 'exclusive', label: text('Exclusive', '専属的'), input: 'boolean' }];
    case 'text': return [{ key: 'summary', label: text('Summary', '要約'), input: 'text' }];
  }
}

/** 値の型の既定（手入力を始めるとき）。必須のキーだけを埋める。 */
export function emptyValue(kind: ValueKindDto): ClauseValueDto {
  switch (kind) {
    case 'term': return { kind, startsOnSigning: false };
    case 'auto_renewal': return { kind, renews: true, sameAsInitial: true };
    case 'notice': return { kind, amount: 3, unit: 'month', anchor: 'expiry', businessDays: false };
    case 'payment_terms': return { kind, basis: 'delivery' };
    case 'liability_cap': return { kind, capKind: 'unspecified' };
    case 'permission': return { kind, policy: 'prior_consent' };
    case 'ip_ownership': return { kind, owner: 'unspecified' };
    case 'jurisdiction': return { kind };
    case 'text': return { kind, summary: '' };
  }
}

/** フォームの 1 項目の入力 → 値（空は項目ごと消す。締め日・支払日は「末日」を month_end にする）。 */
export function setValueField(value: ClauseValueDto, field: ValueField, raw: string | boolean): ClauseValueDto {
  const next: Record<string, string | number | boolean | undefined> = { ...value };
  if (field.input === 'boolean') next[field.key] = raw === true;
  else if (raw === '') delete next[field.key];
  else if (field.input === 'number') { const parsed = Number(raw); if (Number.isFinite(parsed)) next[field.key] = Math.trunc(parsed); else delete next[field.key]; }
  else if (field.input === 'day') next[field.key] = raw === 'month_end' || raw === 'none' ? raw : Math.trunc(Number(raw));
  else next[field.key] = String(raw);
  return next as ClauseValueDto;
}

/* ---------------------------------------------------------------------------
 * 審査基準
 * ------------------------------------------------------------------------ */

export const VALUE_KINDS: readonly ValueKindDto[] = ['term', 'auto_renewal', 'notice', 'payment_terms', 'liability_cap', 'permission', 'ip_ownership', 'jurisdiction', 'text'];

/** 基準（condition）から参照できるパス（サーバーの `FIELD_PATHS` と同じ。保存時にサーバーでも検証される）。 */
export const FIELD_PATHS: Readonly<Record<ValueKindDto, readonly string[]>> = {
  term: ['term.months', 'term.startDate', 'term.endDate', 'term.startsOnSigning'],
  auto_renewal: ['renewal.renews', 'renewal.months'],
  notice: ['notice.days', 'notice.amount', 'notice.unit', 'notice.businessDays'],
  payment_terms: ['payment.maxDays', 'payment.method', 'payment.basis'],
  liability_cap: ['cap.kind', 'cap.amount', 'cap.months', 'cap.excludesWillfulOrGross', 'cap.present'],
  permission: ['permission.policy'],
  ip_ownership: ['ip.owner', 'ip.transferOn', 'ip.moralRightsNotExercised'],
  jurisdiction: ['jurisdiction.court', 'jurisdiction.exclusive'],
  text: [],
};

export const CONDITION_OPS: readonly ConditionOpDto[] = ['equals', 'notEquals', 'in', 'notIn', 'gte', 'lte', 'exists', 'notExists', 'isTrue', 'isFalse', 'contains'];
const VALUELESS_OPS: readonly ConditionOpDto[] = ['exists', 'notExists', 'isTrue', 'isFalse'];

export function opTakesValue(op: ConditionOpDto): boolean {
  return !VALUELESS_OPS.includes(op);
}

/** 条件の値の入力（文字列）→ 送る値。in / notIn はカンマ区切り、gte / lte は数値、true/false は真偽。 */
export function parseConditionValue(op: ConditionOpDto, raw: string): ConditionDto['value'] {
  if (!opTakesValue(op)) return undefined;
  const scalar = (entry: string): string | number | boolean => {
    const trimmed = entry.trim();
    if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
    return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
  };
  if (op === 'in' || op === 'notIn') return raw.split(',').map(scalar).filter((entry) => entry !== '');
  if (op === 'gte' || op === 'lte') return Number(raw);
  if (op === 'contains') return raw;
  return scalar(raw);
}

export function formatConditionValue(value: ConditionDto['value']): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** 印紙税の階層（`upTo,amount` の行）⇔ 配列。上限なしは `-`。 */
export function tiersToText(tiers: readonly { readonly upTo: number | null; readonly amount: number }[] | undefined): string {
  return (tiers ?? []).map((tier) => `${tier.upTo === null ? '-' : tier.upTo},${tier.amount}`).join('\n');
}

export function textToTiers(value: string): readonly { readonly upTo: number | null; readonly amount: number }[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => {
    const [upTo, amount] = line.split(',').map((part) => part.trim());
    return { upTo: upTo === '-' || upTo === undefined || upTo === '' ? null : Number(upTo), amount: Number(amount ?? 0) };
  });
}

export const PLACEHOLDERS = ['counterparty', 'us', 'paymentMaxDays', 'articleRef'] as const;

export function unknownPlaceholders(textValue: string): readonly string[] {
  return [...textValue.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1]!).filter((name) => !(PLACEHOLDERS as readonly string[]).includes(name));
}

/** 推奨文案の置換子のプレビュー（サーバーの展開と同じ規則）。 */
export function previewRecommendedText(textValue: string, values: { readonly counterparty?: string; readonly us?: string; readonly paymentMaxDays?: number; readonly articleRef?: string } = {}): string {
  const table: Record<string, string> = { counterparty: values.counterparty ?? '相手方', us: values.us ?? '当社', paymentMaxDays: String(values.paymentMaxDays ?? 60), articleRef: values.articleRef ?? '該当条項' };
  return textValue.replace(/\{(counterparty|us|paymentMaxDays|articleRef)\}/gu, (_whole, name: string) => table[name]!);
}

export function playbookToSave(playbook: PlaybookDto, unsaved: boolean): SavePlaybookDto {
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = playbook;
  return unsaved ? rest : { ...rest, id };
}

export function nextCriterionId(criteria: readonly PlaybookCriterionDto[], topicId: string): string {
  let index = criteria.length + 1;
  while (criteria.some((criterion) => criterion.id === `${topicId}-${index}`)) index += 1;
  return `${topicId}-${index}`;
}

/** 前文の「〇〇（以下「甲」という。）」を拾う（サーバーの検出と同じ規則。取込フォームの初期値だけに使う）。 */
export function previewParties(body: string): { readonly A?: string; readonly B?: string } {
  const found: { A?: string; B?: string } = {};
  const pattern = /([^\s、。「」（）()]{2,60}?)(?:\s*[（(][^（）()\n]{1,20}[）)])?\s*[（(]\s*以下[、,]?\s*[「『]?\s*(甲|乙)\s*[」』]?\s*という/gu;
  for (const match of body.slice(0, 3000).matchAll(pattern)) {
    const key = match[2] === '甲' ? 'A' : 'B';
    if (found[key] === undefined) found[key] = match[1]!.replace(/^(?:本契約は|と|、)/u, '').trim();
  }
  return found;
}

export function formatYen(amount: number | null | undefined, text: Translate): string {
  if (amount === null || amount === undefined) return text('unknown', '不明');
  return amount === 0 ? text('non-taxable / 0', '非課税・0 円') : `${new Intl.NumberFormat('ja-JP').format(amount)} 円`;
}

/** 条項のカードに出す値の短い要約（詳細はフォーム）。 */
export function valueSummary(value: ClauseValueDto | undefined, text: Translate): string {
  if (value === undefined) return text('No value yet', '値はまだありません');
  const entries = Object.entries(value).filter(([key, entry]) => key !== 'kind' && entry !== undefined && entry !== '');
  return entries.length === 0 ? text('No value yet', '値はまだありません') : entries.map(([key, entry]) => `${key}: ${String(entry)}`).join(' / ');
}
