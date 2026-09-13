import type {
  JournalAccountCategoryDto, JournalAccountDto, JournalAmountSpecDto, JournalChartOfAccountsDto, JournalConditionOpDto, JournalCsvPresetDto, JournalDocumentDto,
  JournalDocumentFactsDto, JournalDocumentKindDto, JournalDocumentStatusDto, JournalDocumentSummaryDto, JournalJsonValueDto, JournalJudgmentDto, JournalPaymentMethodDto,
  JournalRuleDto, JournalTaxCategoryDto, SaveJournalChartOfAccountsDto, SaveJournalRuleDto,
} from '../api/types';
import type { OpenTarget } from '../navigation';

/**
 * 仕訳画面の純粋ロジック。React から切り離し、CSV プリセット判定・文字コード・特異度・判定理由の
 * 「原因 → 次の一手 → ボタン」・JSON 検証・貸借・科目マスタの整合を単体テストで固定する。
 * 画面（JournalPage と各タブ）は状態の保持と描画だけを担う。
 *
 * 科目名・税区分はここに一切ハードコードしない。すべて `JournalChartOfAccountsDto`（利用者定義のマスタ）から引く。
 */

export type Translate = (english: string, japanese: string) => string;
export type JournalTab = 'ingest' | 'judge' | 'rules' | 'chart' | 'export';

/* ---------------------------------------------------------------------------
 * 選択肢（DTO の union と対で保守する）
 * ------------------------------------------------------------------------- */

export const DOCUMENT_KINDS: readonly JournalDocumentKindDto[] = ['invoice', 'simplified_invoice', 'receipt', 'delivery_note', 'quotation', 'bank_statement', 'card_statement', 'expense_report', 'payslip', 'slip_transfer', 'slip_cash_in', 'slip_cash_out', 'other', 'unknown'];
export const PAYMENT_METHODS: readonly JournalPaymentMethodDto[] = ['cash', 'credit_card', 'bank_transfer', 'qr', 'e_money', 'direct_debit', 'unknown'];
export const CONDITION_OPS: readonly JournalConditionOpDto[] = ['equals', 'contains', 'startsWith', 'endsWith', 'regex', 'between', 'gte', 'lte', 'in', 'exists', 'notExists', 'isTrue', 'isFalse'];
export const ACCOUNT_CATEGORIES: readonly JournalAccountCategoryDto[] = ['asset', 'liability', 'equity', 'revenue', 'expense', 'other'];
/** ルール条件の field 候補（facts のパス）。自由入力も許すので、ここは補完用。 */
export const FACT_FIELDS: readonly string[] = ['descriptionNorm', 'description', 'counterpartyHint', 'issuerName', 'recipientName', 'registrationNumber', 'grandTotal', 'paymentMethod', 'transactionDate', 'issueDate', 'accountHint', 'direction', 'lines[].description', 'extra.'];
/** 金額指定の固定選択肢。fixed / ratio は数値入力を伴う。 */
export const AMOUNT_SPEC_CHOICES = ['total', 'taxable:10', 'taxable:8', 'tax:10', 'tax:8', 'remainder', 'fixed', 'ratio'] as const;
export type AmountSpecChoice = (typeof AMOUNT_SPEC_CHOICES)[number];
/** 判定キューに乗らない種別（docs/20 §2.1）。 */
export const SKIPPED_KINDS: readonly JournalDocumentKindDto[] = ['quotation', 'delivery_note'];

/* ---------------------------------------------------------------------------
 * 表示ラベル
 * ------------------------------------------------------------------------- */

export function kindLabel(kind: JournalDocumentKindDto, text: Translate): string {
  switch (kind) {
    case 'invoice': return text('Invoice', '適格請求書');
    case 'simplified_invoice': return text('Receipt (simplified invoice)', 'レシート（簡易適格請求書）');
    case 'receipt': return text('Handwritten receipt', '手書き領収書');
    case 'delivery_note': return text('Delivery note', '納品書');
    case 'quotation': return text('Quotation', '見積書');
    case 'bank_statement': return text('Bank statement', '銀行明細');
    case 'card_statement': return text('Card statement', 'カード明細');
    case 'expense_report': return text('Expense report', '立替金精算書');
    case 'payslip': return text('Payslip', '給与明細');
    case 'slip_transfer': return text('Transfer slip', '振替伝票');
    case 'slip_cash_in': return text('Cash receipt slip', '入金伝票');
    case 'slip_cash_out': return text('Cash payment slip', '出金伝票');
    case 'other': return text('Other', 'その他');
    default: return text('Unknown', '不明');
  }
}

export function statusLabel(status: JournalDocumentStatusDto, text: Translate): string {
  switch (status) {
    case 'extracted': return text('Not judged', '未判定');
    case 'decided': return text('Decided', '確定');
    case 'undecided': return text('Undecided', '未確定');
    case 'hearing': return text('Hearing', 'ヒアリング中');
    case 'skipped': return text('Skipped', '対象外');
    default: return text('Exported', '出力済');
  }
}

export function directionLabel(direction: 'in' | 'out' | undefined, text: Translate): string {
  return direction === 'in' ? text('Income', '収入') : direction === 'out' ? text('Expense', '支出') : '—';
}

export function paymentMethodLabel(method: JournalPaymentMethodDto, text: Translate): string {
  switch (method) {
    case 'cash': return text('Cash', '現金');
    case 'credit_card': return text('Credit card', 'クレジットカード');
    case 'bank_transfer': return text('Bank transfer', '銀行振込');
    case 'qr': return text('QR payment', 'QR 決済');
    case 'e_money': return text('E-money', '電子マネー');
    case 'direct_debit': return text('Direct debit', '口座引落');
    default: return text('Unknown', '不明');
  }
}

export function categoryLabel(category: JournalAccountCategoryDto, text: Translate): string {
  switch (category) {
    case 'asset': return text('Asset', '資産');
    case 'liability': return text('Liability', '負債');
    case 'equity': return text('Equity', '純資産');
    case 'revenue': return text('Revenue', '収益');
    case 'expense': return text('Expense', '費用');
    default: return text('Other', 'その他');
  }
}

export function opLabel(op: JournalConditionOpDto, text: Translate): string {
  switch (op) {
    case 'equals': return text('equals', 'と等しい');
    case 'contains': return text('contains', 'を含む');
    case 'startsWith': return text('starts with', 'で始まる');
    case 'endsWith': return text('ends with', 'で終わる');
    case 'regex': return text('matches regex', '正規表現に一致');
    case 'between': return text('between', 'の範囲内');
    case 'gte': return text('≥', '以上');
    case 'lte': return text('≤', '以下');
    case 'in': return text('is one of', 'のいずれか');
    case 'exists': return text('exists', 'がある');
    case 'notExists': return text('does not exist', 'がない');
    case 'isTrue': return text('is true', 'が真');
    default: return text('is false', 'が偽');
  }
}

/** 金額（円）の表示。undefined は '—'。 */
export function formatYen(amount: number | undefined): string {
  return amount === undefined ? '—' : `¥${amount.toLocaleString('en-US')}`;
}

/* ---------------------------------------------------------------------------
 * CSV 取込
 * ------------------------------------------------------------------------- */

/** ヘッダー名の正規化: BOM 除去 → NFKC → 引用符除去 → 前後空白除去 → 連続空白の圧縮。 */
export function normalizeHeader(header: string): string {
  return header.replace(/﻿/g, '').normalize('NFKC').replace(/^["']+|["']+$/g, '').trim().replace(/\s+/g, ' ');
}

/**
 * ヘッダー行から CSV プリセットを判定する。署名の列がすべて含まれるプリセットのうち、署名が最も長い（＝最も具体的な）ものを選ぶ。
 * どれにも当たらなければ undefined（画面は列マッピング入力か手動選択へ倒す）。
 */
export function detectCsvPreset(headers: readonly string[], presets: readonly JournalCsvPresetDto[]): JournalCsvPresetDto | undefined {
  const normalized = new Set(headers.map(normalizeHeader));
  let best: JournalCsvPresetDto | undefined;
  for (const preset of presets) {
    if (preset.headerSignature.length === 0) continue;
    if (!preset.headerSignature.every((column) => normalized.has(normalizeHeader(column)))) continue;
    if (best === undefined || preset.headerSignature.length > best.headerSignature.length) best = preset;
  }
  return best;
}

/**
 * CSV バイト列を文字列にする。UTF-8 で読んで置換文字（U+FFFD）が混ざれば Shift_JIS として読み直す
 * （銀行・カード会社の CSV は Shift_JIS が多い）。Shift_JIS デコーダが無い環境では UTF-8 の結果をそのまま返す。
 * 返り値の `encoding` は画面の表示用。
 */
export function decodeCsvText(bytes: Uint8Array, decoderFactory: (label: string) => { decode(input: Uint8Array): string } = (label) => new TextDecoder(label)): { readonly content: string; readonly encoding: 'utf-8' | 'shift_jis' } {
  const utf8 = decoderFactory('utf-8').decode(bytes);
  if (!utf8.includes('�')) return { content: utf8, encoding: 'utf-8' };
  try {
    const sjis = decoderFactory('shift_jis').decode(bytes);
    return { content: sjis, encoding: 'shift_jis' };
  } catch {
    return { content: utf8, encoding: 'utf-8' };
  }
}

/** 引用符（"..." と "" のエスケープ）と CRLF を扱う簡易 CSV 分割。空行は捨てる。limit 指定時はその行数で止める（ヘッダー含まず）。 */
export function parseCsvRows(content: string, limit?: number): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = content.replace(/^﻿/, '');
  const push = () => { row.push(cell); cell = ''; };
  const endRow = () => {
    push();
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') push();
    else if (char === '\r') { /* CRLF の \r は無視して \n で行を閉じる。 */ }
    else if (char === '\n') { endRow(); if (limit !== undefined && rows.length >= limit + 1) return rows; }
    else cell += char;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export interface CsvPreview { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly totalRows: number }

/** 先頭 `limit` 行のプレビュー（ヘッダーは別枠）。totalRows はデータ行の総数。 */
export function previewRows(content: string, limit = 5): CsvPreview {
  const all = parseCsvRows(content);
  const headers = (all[0] ?? []).map((header) => normalizeHeader(header));
  return { headers, rows: all.slice(1, 1 + limit), totalRows: Math.max(0, all.length - 1) };
}

/* ---------------------------------------------------------------------------
 * ルール
 * ------------------------------------------------------------------------- */

/** 特異度（docs/20 §2.3）: 条件数 + equals 2 / startsWith・endsWith 1.5 / contains・regex 1 + scope の指定ごとに 1。 */
export function ruleSpecificity(rule: Pick<SaveJournalRuleDto, 'conditions' | 'scope'>): number {
  let score = rule.conditions.length;
  for (const condition of rule.conditions) {
    if (condition.op === 'equals') score += 2;
    else if (condition.op === 'startsWith' || condition.op === 'endsWith') score += 1.5;
    else if (condition.op === 'contains' || condition.op === 'regex') score += 1;
  }
  if ((rule.scope.documentKinds?.length ?? 0) > 0) score += 1;
  if (rule.scope.direction !== undefined) score += 1;
  if ((rule.scope.accountHints?.length ?? 0) > 0) score += 1;
  return score;
}

/** 一覧の並び: priority 降順 → 特異度 降順 → createdAt 昇順（競合解決と同じ順）。 */
export function sortRules(rules: readonly JournalRuleDto[]): readonly JournalRuleDto[] {
  return [...rules].sort((a, b) => b.priority - a.priority || ruleSpecificity(b) - ruleSpecificity(a) || a.createdAt.localeCompare(b.createdAt));
}

export function summarizeScope(scope: JournalRuleDto['scope'], text: Translate): string {
  const parts: string[] = [];
  if ((scope.documentKinds?.length ?? 0) > 0) parts.push((scope.documentKinds ?? []).map((kind) => kindLabel(kind, text)).join('/'));
  if (scope.direction !== undefined) parts.push(directionLabel(scope.direction, text));
  if ((scope.accountHints?.length ?? 0) > 0) parts.push((scope.accountHints ?? []).join(', '));
  return parts.length === 0 ? text('Any document', '共通') : parts.join(' · ');
}

export function summarizeConditions(conditions: JournalRuleDto['conditions'], text: Translate): string {
  if (conditions.length === 0) return text('No conditions (always matches within scope)', '条件なし（scope 内なら常に一致）');
  return conditions.map((condition) => `${condition.field} ${opLabel(condition.op, text)}${condition.value === undefined ? '' : ` ${conditionValueToInput(condition.op, condition.value)}`}`).join(' AND ');
}

/** 摘要から相手先の手掛かりを 1 語取り出す（counterpartyHint が無いとき）。 */
export function firstWord(description: string | undefined): string {
  return (description ?? '').normalize('NFKC').trim().split(/\s+/)[0] ?? '';
}

type DocumentLike = JournalDocumentSummaryDto | JournalDocumentDto;
function isFullDocument(document: DocumentLike): document is JournalDocumentDto { return 'facts' in document; }

/** 文書（一覧の要約 / 全体）から、判定に効いた事実だけを取り出す。 */
export function documentFacts(document: DocumentLike): JournalDocumentFactsDto {
  if (isFullDocument(document)) return document.facts;
  return {
    ...(document.direction === undefined ? {} : { direction: document.direction }),
    ...(document.issuerName === undefined ? {} : { issuerName: document.issuerName }),
    ...(document.description === undefined ? {} : { description: document.description }),
    ...(document.grandTotal === undefined ? {} : { grandTotal: document.grandTotal }),
    ...(document.transactionDate === undefined ? {} : { transactionDate: document.transactionDate }),
  };
}

/**
 * 文書から新規ルールの雛形を作る（`no-rule` の「ルールを作る」）。
 * scope は文書の方向と種別、条件は `descriptionNorm contains <相手先の手掛かり>`（手掛かりが無ければ issuerName equals、それも無ければ条件なし）。
 * 行は借方 1 行 + 貸方 1 行で科目は空（利用者が科目マスタから選ぶ。科目名はハードコードしない）。
 */
export function newRuleFromDocument(document: DocumentLike, chart: Pick<JournalChartOfAccountsDto, 'taxCategories'>): SaveJournalRuleDto {
  const facts = documentFacts(document);
  const hint = facts.counterpartyHint?.trim() || firstWord(facts.descriptionNorm ?? facts.description);
  const conditions: SaveJournalRuleDto['conditions'] = hint !== ''
    ? [{ field: 'descriptionNorm', op: 'contains', value: hint }]
    : facts.issuerName !== undefined && facts.issuerName.trim() !== '' ? [{ field: 'issuerName', op: 'equals', value: facts.issuerName.trim() }] : [];
  const name = hint !== '' ? hint : facts.issuerName?.trim() ?? '';
  const taxSide = facts.direction === 'in' ? 'out' : 'in';
  const defaultTax = chart.taxCategories.find((tax) => tax.enabled && tax.side === taxSide)?.code ?? '';
  const emptyLine = { accountId: '', taxCode: defaultTax, amount: 'total' as const };
  return {
    name, enabled: true, mode: 'auto', priority: 0,
    scope: { ...(document.kind === 'unknown' ? {} : { documentKinds: [document.kind] }), ...(facts.direction === undefined ? {} : { direction: facts.direction }), ...(facts.accountHint === undefined ? {} : { accountHints: [facts.accountHint] }) },
    conditions,
    outcome: { lines: [{ side: 'debit', ...emptyLine, partnerFrom: facts.counterpartyHint !== undefined ? 'counterpartyHint' : 'issuerName' }, { side: 'credit', ...emptyLine }], descriptionTemplate: '{description}', invoiceStatus: 'auto' },
    askIf: [], requiredFacts: [],
    provenance: { origin: 'manual', exampleDocumentIds: [document.id] },
  };
}

/** 空のルール雛形（一覧の「新規」）。 */
export function emptyRule(): SaveJournalRuleDto {
  return { name: '', enabled: true, mode: 'auto', priority: 0, scope: {}, conditions: [], outcome: { lines: [{ side: 'debit', accountId: '', taxCode: '', amount: 'total' }, { side: 'credit', accountId: '', taxCode: '', amount: 'total' }], invoiceStatus: 'auto' }, askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] } };
}

/** 保存済みルールを編集用（SaveJournalRuleDto）へ。 */
export function editableRule(rule: JournalRuleDto): SaveJournalRuleDto {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = rule;
  return rest;
}

export interface RuleIssue { readonly path: string; readonly message: readonly [en: string, ja: string] }

/** 保存前に分かるルールの不備。科目・税区分は「マスタに存在し有効」を要求する。 */
export function ruleValidation(rule: SaveJournalRuleDto, chart: Pick<JournalChartOfAccountsDto, 'accounts' | 'taxCategories'>): readonly RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (rule.name.trim() === '') issues.push({ path: 'name', message: ['Enter a rule name', 'ルール名を入力してください'] });
  if (!Number.isInteger(rule.priority)) issues.push({ path: 'priority', message: ['Priority must be an integer', '優先度は整数で入力してください'] });
  rule.conditions.forEach((condition, index) => {
    if (condition.field.trim() === '') issues.push({ path: `conditions.${index}.field`, message: ['Choose the field of the condition', '条件の項目を選んでください'] });
    if (!['exists', 'notExists', 'isTrue', 'isFalse'].includes(condition.op) && (condition.value === undefined || condition.value === '')) issues.push({ path: `conditions.${index}.value`, message: ['Enter the value of the condition', '条件の値を入力してください'] });
    if (condition.op === 'regex' && typeof condition.value === 'string') { try { new RegExp(condition.value); } catch { issues.push({ path: `conditions.${index}.value`, message: ['The regular expression is invalid', '正規表現が不正です'] }); } }
    // between は「下限, 上限」の 2 数。片側だけ入れると conditionValueFromInput が欠けた側を 0 にするため、ここで気付けるようにする。
    if (condition.op === 'between') {
      const range: readonly unknown[] = Array.isArray(condition.value) ? condition.value as readonly unknown[] : [];
      const [low, high] = range;
      if (range.length !== 2 || typeof low !== 'number' || typeof high !== 'number' || !Number.isFinite(low) || !Number.isFinite(high) || low > high) {
        issues.push({ path: `conditions.${index}.value`, message: ['Enter the range as "min, max" (both numbers, min first)', '範囲は「下限, 上限」の 2 つの数値で入力してください（下限 ≤ 上限）'] });
      }
    }
  });
  if (rule.outcome.lines.length === 0) issues.push({ path: 'outcome.lines', message: ['Add at least one debit and one credit line', '借方・貸方の行を少なくとも 1 行ずつ追加してください'] });
  const enabledAccounts = new Set(chart.accounts.filter((account) => account.enabled).map((account) => account.id));
  const enabledTax = new Set(chart.taxCategories.filter((tax) => tax.enabled).map((tax) => tax.code));
  rule.outcome.lines.forEach((line, index) => {
    if (line.accountId === '') issues.push({ path: `outcome.lines.${index}.accountId`, message: ['Choose an account from the chart', '科目マスタから科目を選んでください'] });
    else if (!enabledAccounts.has(line.accountId)) issues.push({ path: `outcome.lines.${index}.accountId`, message: [`Account '${line.accountId}' is not an enabled account in the chart`, `科目「${line.accountId}」はマスタに無いか無効です`] });
    if (line.taxCode === '') issues.push({ path: `outcome.lines.${index}.taxCode`, message: ['Choose a tax category', '税区分を選んでください'] });
    else if (!enabledTax.has(line.taxCode)) issues.push({ path: `outcome.lines.${index}.taxCode`, message: [`Tax category '${line.taxCode}' is not enabled in the chart`, `税区分「${line.taxCode}」はマスタに無いか無効です`] });
    if (typeof line.amount === 'object' && 'fixed' in line.amount && !(Number.isInteger(line.amount.fixed) && line.amount.fixed >= 0)) issues.push({ path: `outcome.lines.${index}.amount`, message: ['Fixed amount must be a non-negative integer', '固定額は 0 以上の整数で入力してください'] });
    if (typeof line.amount === 'object' && 'ratio' in line.amount && !(line.amount.ratio >= 0 && line.amount.ratio <= 1)) issues.push({ path: `outcome.lines.${index}.amount`, message: ['Ratio must be between 0 and 1', '按分率は 0〜1 で入力してください'] });
  });
  if (rule.outcome.lines.length > 0 && !rule.outcome.lines.some((line) => line.side === 'debit')) issues.push({ path: 'outcome.lines', message: ['Add a debit line', '借方の行を追加してください'] });
  if (rule.outcome.lines.length > 0 && !rule.outcome.lines.some((line) => line.side === 'credit')) issues.push({ path: 'outcome.lines', message: ['Add a credit line', '貸方の行を追加してください'] });
  rule.askIf.forEach((ask, index) => {
    if (ask.questionId.trim() === '') issues.push({ path: `askIf.${index}.questionId`, message: ['Enter the question id', '質問 ID を入力してください'] });
    if (ask.prompt.trim() === '') issues.push({ path: `askIf.${index}.prompt`, message: ['Enter the question text', '質問文を入力してください'] });
  });
  return issues;
}

/** 条件の値: 入力欄の文字列 → DTO の値。between は "a,b" の 2 数、in はカンマ区切り、gte/lte は数値（数値でなければ文字列のまま）。 */
export function conditionValueFromInput(op: JournalConditionOpDto, raw: string): JournalJsonValueDto | undefined {
  if (op === 'exists' || op === 'notExists' || op === 'isTrue' || op === 'isFalse') return undefined;
  const trimmed = raw.trim();
  if (op === 'between') {
    const [low, high] = trimmed.split(',').map((part) => Number(part.trim()));
    return [Number.isFinite(low) ? low ?? 0 : 0, Number.isFinite(high) ? high ?? 0 : 0];
  }
  if (op === 'in') return trimmed.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (op === 'gte' || op === 'lte') { const parsed = Number(trimmed); return trimmed !== '' && Number.isFinite(parsed) ? parsed : trimmed; }
  return trimmed;
}

/** 条件の値: DTO の値 → 入力欄の文字列。 */
export function conditionValueToInput(_op: JournalConditionOpDto, value: JournalJsonValueDto | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 金額指定 → 選択肢と数値欄。 */
export function amountSpecChoice(amount: JournalAmountSpecDto): { readonly choice: AmountSpecChoice; readonly value: string } {
  if (typeof amount === 'string') return { choice: amount, value: '' };
  return 'fixed' in amount ? { choice: 'fixed', value: String(amount.fixed) } : { choice: 'ratio', value: String(amount.ratio) };
}

/** 選択肢と数値欄 → 金額指定。数値が不正なら 0（ruleValidation が指摘する）。 */
export function amountSpecFromChoice(choice: AmountSpecChoice, value: string): JournalAmountSpecDto {
  if (choice === 'fixed') { const parsed = Number(value); return { fixed: Number.isFinite(parsed) ? parsed : 0 }; }
  if (choice === 'ratio') { const parsed = Number(value); return { ratio: Number.isFinite(parsed) ? parsed : 0 }; }
  return choice;
}

export function amountSpecLabel(amount: JournalAmountSpecDto, text: Translate): string {
  if (typeof amount === 'object') return 'fixed' in amount ? text(`Fixed ${formatYen(amount.fixed)}`, `固定 ${formatYen(amount.fixed)}`) : text(`Ratio ${amount.ratio}`, `按分 ${amount.ratio}`);
  switch (amount) {
    case 'total': return text('Grand total', '合計');
    case 'taxable:10': return text('Taxable (10%)', '10% 対象額');
    case 'taxable:8': return text('Taxable (8%)', '8% 対象額');
    case 'tax:10': return text('Tax (10%)', '10% 税額');
    case 'tax:8': return text('Tax (8%)', '8% 税額');
    default: return text('Remainder', '残額');
  }
}

/* ---------------------------------------------------------------------------
 * 判定結果 → 原因・次の一手・ボタン
 * ------------------------------------------------------------------------- */

/** 判定タブのボタンが要求する遷移。JournalPage が対象タブへ切り替えて項目を開く。 */
export type JournalAction =
  | { readonly kind: 'new-rule' }
  | { readonly kind: 'hearing' }
  | { readonly kind: 'open-rule'; readonly ruleId: string }
  | { readonly kind: 'edit-facts' }
  | { readonly kind: 'answer'; readonly questionId: string; readonly prompt: string }
  | { readonly kind: 'open-chart'; readonly accountIds: readonly string[] }
  | { readonly kind: 'open-entry'; readonly entryId?: string };

export interface ReasonCard {
  readonly code: string;
  readonly cause: string;
  readonly nextStep: string;
  readonly actions: readonly { readonly label: string; readonly target: JournalAction }[];
}
export interface JudgmentSummary { readonly stage: 'decided' | 'undecided' | 'skipped' | 'none'; readonly cards: readonly ReasonCard[] }

/**
 * 判定結果を「原因 → 次の一手 → 直す場所へのボタン」に組み替える。理由 code ごとに 1 カード。
 * `ruleNames` はルール id → 名前（無ければ id を出す）。
 */
export function summarizeJudgment(judgment: JournalJudgmentDto | undefined, text: Translate, ruleNames: ReadonlyMap<string, string> = new Map()): JudgmentSummary {
  const nameOf = (ruleId: string) => ruleNames.get(ruleId) ?? ruleId;
  if (judgment === undefined) return { stage: 'none', cards: [{ code: 'not-judged', cause: text('This document has not been judged yet.', 'この帳票はまだ判定されていません。'), nextStep: text('Run "Judge pending" or judge this row.', '「未判定を判定」か、この行の「判定」を押してください。'), actions: [] }] };
  if (judgment.stage === 'decided') {
    return { stage: 'decided', cards: [{ code: 'decided', cause: text(`Rule "${nameOf(judgment.ruleId)}" matched (specificity ${judgment.specificity}).`, `ルール「${nameOf(judgment.ruleId)}」が一致しました（特異度 ${judgment.specificity}）。`), nextStep: text('Review the draft entry, then confirm it in the Export tab.', '仕訳ドラフトを確認し、出力タブで確定してください。'), actions: [{ label: text('Open the entry', '仕訳を開く'), target: { kind: 'open-entry', ...(judgment.entryId === undefined ? {} : { entryId: judgment.entryId }) } }, { label: text('Open the rule', 'ルールを開く'), target: { kind: 'open-rule', ruleId: judgment.ruleId } }] }] };
  }
  if (judgment.stage === 'skipped') {
    return { stage: 'skipped', cards: [{ code: 'document-kind', cause: text('Quotations and delivery notes are not journalized.', '見積書・納品書は仕訳の対象外です。'), nextStep: text('Nothing to do. If the kind is wrong, edit the facts and change the kind.', '対応は不要です。種別が誤りなら項目を編集して種別を直してください。'), actions: [{ label: text('Edit facts', '項目を編集'), target: { kind: 'edit-facts' } }] }] };
  }
  const cards = judgment.reasons.map((reason): ReasonCard => {
    switch (reason.code) {
      case 'no-rule':
        return { code: reason.code, cause: text('No enabled rule matched this document.', 'この帳票に一致する有効なルールがありません。'), nextStep: text('Create a rule from this document (the condition is prefilled from the description), or start a hearing to have one proposed.', 'この帳票からルールを作る（摘要から条件を事前入力）か、ヒアリングで提案させてください。'), actions: [{ label: text('Create a rule', 'ルールを作る'), target: { kind: 'new-rule' } }, { label: text('Start a hearing', 'ヒアリングを開始'), target: { kind: 'hearing' } }] };
      case 'multiple-rules':
        return { code: reason.code, cause: text(`${reason.ruleIds.length} rules tie: ${reason.ruleIds.map(nameOf).join(', ')}.`, `${reason.ruleIds.length} 件のルールが同点です: ${reason.ruleIds.map(nameOf).join('、')}。`), nextStep: text('Raise the priority of the intended rule, or make its conditions more specific.', '採用したいルールの優先度を上げるか、条件をより具体的にしてください。'), actions: reason.ruleIds.map((ruleId) => ({ label: text(`Open rule "${nameOf(ruleId)}"`, `ルール「${nameOf(ruleId)}」を開く`), target: { kind: 'open-rule', ruleId } })) };
      case 'missing-fact':
        return { code: reason.code, cause: text(`Rule "${nameOf(reason.ruleId)}" needs: ${reason.facts.join(', ')}.`, `ルール「${nameOf(reason.ruleId)}」に必要な項目が不足しています: ${reason.facts.join('、')}。`), nextStep: text('Fill the missing facts on this document, then judge again.', 'この帳票の項目を補い、もう一度判定してください。'), actions: [{ label: text('Edit facts', '項目を編集'), target: { kind: 'edit-facts' } }, { label: text('Open the rule', 'ルールを開く'), target: { kind: 'open-rule', ruleId: reason.ruleId } }] };
      case 'ask-if':
        return { code: reason.code, cause: text(`Rule "${nameOf(reason.ruleId)}" asks: ${reason.prompt}`, `ルール「${nameOf(reason.ruleId)}」が確認を求めています: ${reason.prompt}`), nextStep: text('Answer the question; the answer is stored in the document and the row is judged again.', '質問に答えてください。回答は帳票に保存され、再判定されます。'), actions: [{ label: text('Answer and judge again', '回答を記入して再判定'), target: { kind: 'answer', questionId: reason.questionId, prompt: reason.prompt } }] };
      case 'rule-suggest-mode':
        return { code: reason.code, cause: text(`Only suggest-mode rules matched: ${reason.ruleIds.map(nameOf).join(', ')}.`, `推測モードのルールだけが一致しました: ${reason.ruleIds.map(nameOf).join('、')}。`), nextStep: text('Switch the rule to auto mode if it is reliable, or start a hearing.', 'ルールが信頼できるなら自動モードに切り替えるか、ヒアリングを開始してください。'), actions: [...reason.ruleIds.map((ruleId) => ({ label: text(`Open rule "${nameOf(ruleId)}"`, `ルール「${nameOf(ruleId)}」を開く`), target: { kind: 'open-rule', ruleId } as JournalAction })), { label: text('Start a hearing', 'ヒアリングを開始'), target: { kind: 'hearing' } }] };
      case 'unknown-account':
        return { code: reason.code, cause: text(`Rule "${nameOf(reason.ruleId)}" refers to accounts missing or disabled in the chart: ${reason.accountIds.join(', ')}.`, `ルール「${nameOf(reason.ruleId)}」が参照する科目がマスタに無いか無効です: ${reason.accountIds.join('、')}。`), nextStep: text('Re-enable or re-create the account in the chart, or point the rule at another account.', '科目マスタでその科目を有効化／再登録するか、ルールの科目を別のものに変えてください。'), actions: [{ label: text('Open the chart', '科目マスタを開く'), target: { kind: 'open-chart', accountIds: reason.accountIds } }, { label: text('Open the rule', 'ルールを開く'), target: { kind: 'open-rule', ruleId: reason.ruleId } }] };
      case 'unbalanced':
        return { code: reason.code, cause: text(`Rule "${nameOf(reason.ruleId)}" produced lines whose debit and credit totals differ.`, `ルール「${nameOf(reason.ruleId)}」の行の借方合計と貸方合計が一致しません。`), nextStep: text('Check the amount specs of the outcome lines (use "remainder" on one side).', '行の金額指定を見直してください（片側に「残額」を使うと揃います）。'), actions: [{ label: text('Open the rule', 'ルールを開く'), target: { kind: 'open-rule', ruleId: reason.ruleId } }] };
      default: {
        const unknown: { readonly code: string } = reason;
        return { code: unknown.code, cause: text(`Undecided (${unknown.code}).`, `未確定（${unknown.code}）。`), nextStep: text('Start a hearing or create a rule.', 'ヒアリングを開始するか、ルールを作ってください。'), actions: [{ label: text('Create a rule', 'ルールを作る'), target: { kind: 'new-rule' } }] };
      }
    }
  });
  return { stage: 'undecided', cards };
}

/* ---------------------------------------------------------------------------
 * 事実 JSON の検証
 * ------------------------------------------------------------------------- */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FACT_KEYS = new Set(['direction', 'issuerName', 'recipientName', 'registrationNumber', 'issueDate', 'transactionDate', 'dueDate', 'grandTotal', 'totalsByRate', 'lines', 'paymentMethod', 'accountHint', 'description', 'descriptionNorm', 'counterpartyHint', 'extra']);

/**
 * 貼り付けられた JSON を `JournalDocumentFactsDto` として検証する。未知のキー・型違い・日付形式・登録番号の形を指摘する。
 * 登録番号のハイフンは除いて正規化する。
 */
export function validateFactsJson(raw: string): { readonly facts: JournalDocumentFactsDto; readonly errors?: undefined } | { readonly facts?: undefined; readonly errors: readonly string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (cause: unknown) { return { errors: [`JSON: ${cause instanceof Error ? cause.message : String(cause)}`] }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { errors: ['JSON: expected an object'] };
  const errors: string[] = [];
  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!FACT_KEYS.has(key)) errors.push(`${key}: unknown field (use "extra" for document-specific values)`);
  const str = (key: string) => { const value = object[key]; if (value !== undefined && typeof value !== 'string') errors.push(`${key}: expected a string`); };
  const date = (key: string) => { const value = object[key]; if (value !== undefined && (typeof value !== 'string' || !DATE_PATTERN.test(value))) errors.push(`${key}: expected YYYY-MM-DD`); };
  const int = (key: string) => { const value = object[key]; if (value !== undefined && !Number.isInteger(value)) errors.push(`${key}: expected an integer (yen, tax included)`); };
  for (const key of ['issuerName', 'recipientName', 'accountHint', 'description', 'descriptionNorm', 'counterpartyHint']) str(key);
  for (const key of ['issueDate', 'transactionDate', 'dueDate']) date(key);
  int('grandTotal');
  if (object['direction'] !== undefined && object['direction'] !== 'in' && object['direction'] !== 'out') errors.push('direction: expected "in" or "out"');
  if (object['paymentMethod'] !== undefined && !PAYMENT_METHODS.includes(object['paymentMethod'] as JournalPaymentMethodDto)) errors.push(`paymentMethod: expected one of ${PAYMENT_METHODS.join(', ')}`);
  let registrationNumber: string | undefined;
  if (object['registrationNumber'] !== undefined) {
    if (typeof object['registrationNumber'] !== 'string') errors.push('registrationNumber: expected a string');
    else {
      registrationNumber = object['registrationNumber'].replace(/[-\s]/g, '').toUpperCase();
      if (!/^T\d{13}$/.test(registrationNumber)) errors.push('registrationNumber: expected T + 13 digits');
    }
  }
  if (object['lines'] !== undefined) {
    if (!Array.isArray(object['lines'])) errors.push('lines: expected an array');
    else (object['lines'] as unknown[]).forEach((line, index) => {
      const item = line as Record<string, unknown> | null;
      if (item === null || typeof item !== 'object') { errors.push(`lines[${index}]: expected an object`); return; }
      if (typeof item['description'] !== 'string') errors.push(`lines[${index}].description: expected a string`);
      if (!Number.isInteger(item['amount'])) errors.push(`lines[${index}].amount: expected an integer`);
      if (item['taxRate'] !== undefined && ![10, 8, 0].includes(item['taxRate'] as number)) errors.push(`lines[${index}].taxRate: expected 10, 8, or 0`);
    });
  }
  if (object['totalsByRate'] !== undefined) {
    if (!Array.isArray(object['totalsByRate'])) errors.push('totalsByRate: expected an array');
    else (object['totalsByRate'] as unknown[]).forEach((total, index) => {
      const item = total as Record<string, unknown> | null;
      if (item === null || typeof item !== 'object') { errors.push(`totalsByRate[${index}]: expected an object`); return; }
      if (![10, 8, 0].includes(item['rate'] as number)) errors.push(`totalsByRate[${index}].rate: expected 10, 8, or 0`);
      if (!Number.isInteger(item['taxableAmount'])) errors.push(`totalsByRate[${index}].taxableAmount: expected an integer`);
      if (typeof item['amountIncludesTax'] !== 'boolean') errors.push(`totalsByRate[${index}].amountIncludesTax: expected true or false`);
    });
  }
  if (object['extra'] !== undefined && (object['extra'] === null || typeof object['extra'] !== 'object' || Array.isArray(object['extra']))) errors.push('extra: expected an object');
  if (errors.length > 0) return { errors };
  const facts = { ...(object as unknown as JournalDocumentFactsDto), ...(registrationNumber === undefined ? {} : { registrationNumber }) };
  return { facts };
}

/* ---------------------------------------------------------------------------
 * 仕訳
 * ------------------------------------------------------------------------- */

/** 借方合計・貸方合計と一致判定。 */
export function entryBalance(lines: readonly { readonly side: 'debit' | 'credit'; readonly amount: number }[]): { readonly debit: number; readonly credit: number; readonly balanced: boolean } {
  let debit = 0;
  let credit = 0;
  for (const line of lines) { if (line.side === 'debit') debit += line.amount; else credit += line.amount; }
  return { debit, credit, balanced: debit === credit && lines.length > 0 };
}

/** 出力ファイル名。サーバーが返した名前を使い、無ければ形式と日付から作る。パス区切りは落とす。 */
export function csvDownloadName(result: { readonly fileName?: string; readonly format: string }, now: Date = new Date()): string {
  const safe = (result.fileName ?? '').replace(/[\\/:*?"<>|]/g, '').trim();
  if (safe !== '') return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`;
  return `journal-${result.format}-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * Blob でダウンロードを起こす。`URL.createObjectURL` が無い環境（古い WebView・テスト）や例外時は false を返し、
 * 画面はテキストエリアのフォールバックを案内する。UTF-8 BOM はサーバーの content が持つ前提（二重に付けない）。
 */
export function triggerDownload(fileName: string, content: string, mime = 'text/csv'): boolean {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return false;
    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * 科目マスタ
 * ------------------------------------------------------------------------- */

export interface ChartIssue { readonly path: string; readonly message: readonly [en: string, ja: string] }

/** 保存前に分かる科目マスタの不備: id / code / 税区分コード / 補助軸 id・値 id の重複、名前の空欄。 */
export function chartValidation(chart: SaveJournalChartOfAccountsDto): readonly ChartIssue[] {
  const issues: ChartIssue[] = [];
  const seenIds = new Map<string, number>();
  const seenCodes = new Map<string, number>();
  chart.accounts.forEach((account, index) => {
    const id = account.id.trim();
    if (id === '') issues.push({ path: `accounts.${index}.id`, message: ['Enter an account id', '科目 ID を入力してください'] });
    else if (seenIds.has(id)) issues.push({ path: `accounts.${index}.id`, message: [`Account id '${id}' is duplicated (row ${(seenIds.get(id) ?? 0) + 1})`, `科目 ID「${id}」が重複しています（${(seenIds.get(id) ?? 0) + 1} 行目）`] });
    else seenIds.set(id, index);
    if (account.name.trim() === '') issues.push({ path: `accounts.${index}.name`, message: ['Enter an account name', '科目名を入力してください'] });
    const code = account.code?.trim() ?? '';
    if (code !== '') {
      if (seenCodes.has(code)) issues.push({ path: `accounts.${index}.code`, message: [`Account code '${code}' is duplicated (row ${(seenCodes.get(code) ?? 0) + 1})`, `科目コード「${code}」が重複しています（${(seenCodes.get(code) ?? 0) + 1} 行目）`] });
      else seenCodes.set(code, index);
    }
    if (account.defaultTaxCode !== undefined && account.defaultTaxCode !== '' && !chart.taxCategories.some((tax) => tax.code === account.defaultTaxCode)) issues.push({ path: `accounts.${index}.defaultTaxCode`, message: [`Default tax code '${account.defaultTaxCode}' is not in the tax categories`, `既定税区分「${account.defaultTaxCode}」が税区分一覧にありません`] });
  });
  const seenTax = new Set<string>();
  chart.taxCategories.forEach((tax, index) => {
    const code = tax.code.trim();
    if (code === '') issues.push({ path: `taxCategories.${index}.code`, message: ['Enter a tax code', '税区分コードを入力してください'] });
    else if (seenTax.has(code)) issues.push({ path: `taxCategories.${index}.code`, message: [`Tax code '${code}' is duplicated`, `税区分コード「${code}」が重複しています`] });
    else seenTax.add(code);
    if (tax.name.trim() === '') issues.push({ path: `taxCategories.${index}.name`, message: ['Enter a tax category name', '税区分名を入力してください'] });
    if (tax.rate !== undefined && !(tax.rate >= 0 && tax.rate <= 100)) issues.push({ path: `taxCategories.${index}.rate`, message: ['Rate must be between 0 and 100', '税率は 0〜100 で入力してください'] });
    if (tax.deductionRate !== undefined && !(tax.deductionRate >= 0 && tax.deductionRate <= 1)) issues.push({ path: `taxCategories.${index}.deductionRate`, message: ['Deduction rate must be between 0 and 1', '控除割合は 0〜1 で入力してください'] });
  });
  const seenDimensions = new Set<string>();
  chart.dimensions.forEach((dimension, index) => {
    const id = dimension.id.trim();
    if (id === '') issues.push({ path: `dimensions.${index}.id`, message: ['Enter a dimension id', '補助軸 ID を入力してください'] });
    else if (seenDimensions.has(id)) issues.push({ path: `dimensions.${index}.id`, message: [`Dimension id '${id}' is duplicated`, `補助軸 ID「${id}」が重複しています`] });
    else seenDimensions.add(id);
    if (dimension.name.trim() === '') issues.push({ path: `dimensions.${index}.name`, message: ['Enter a dimension name', '補助軸名を入力してください'] });
    const seenValues = new Set<string>();
    dimension.values.forEach((value, valueIndex) => {
      if (value.id.trim() === '') issues.push({ path: `dimensions.${index}.values.${valueIndex}.id`, message: ['Enter a value id', '値の ID を入力してください'] });
      else if (seenValues.has(value.id)) issues.push({ path: `dimensions.${index}.values.${valueIndex}.id`, message: [`Value id '${value.id}' is duplicated in dimension '${id}'`, `補助軸「${id}」の値 ID「${value.id}」が重複しています`] });
      else seenValues.add(value.id);
      if (value.name.trim() === '') issues.push({ path: `dimensions.${index}.values.${valueIndex}.name`, message: ['Enter a value name', '値の名前を入力してください'] });
    });
  });
  return issues;
}

/** 有効な科目を category ごとにまとめる（ルール編集・手入力仕訳の科目セレクト用）。空の category は出さない。 */
export function accountsByCategory(chart: Pick<JournalChartOfAccountsDto, 'accounts'>): readonly { readonly category: JournalAccountCategoryDto; readonly accounts: readonly JournalAccountDto[] }[] {
  const sorted = [...chart.accounts].filter((account) => account.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
  return ACCOUNT_CATEGORIES.map((category) => ({ category, accounts: sorted.filter((account) => account.category === category) })).filter((group) => group.accounts.length > 0);
}

/** 新しい科目の雛形。id は既存と衝突しない `acct-N`、sortOrder は末尾。 */
export function newAccount(accounts: readonly JournalAccountDto[]): JournalAccountDto {
  const ids = new Set(accounts.map((account) => account.id));
  let index = accounts.length + 1;
  while (ids.has(`acct-${index}`)) index += 1;
  return { id: `acct-${index}`, name: '', category: 'expense', aliases: [], enabled: true, sortOrder: accounts.reduce((max, account) => Math.max(max, account.sortOrder), 0) + 1 };
}

export function newTaxCategory(taxCategories: readonly JournalTaxCategoryDto[]): JournalTaxCategoryDto {
  const codes = new Set(taxCategories.map((tax) => tax.code));
  let index = taxCategories.length + 1;
  while (codes.has(`TAX-${index}`)) index += 1;
  return { code: `TAX-${index}`, name: '', side: 'in', enabled: true };
}

/** sortOrder 順に並べ、対象を 1 つ前後へ動かして 1..n に振り直す。端では何もしない。 */
export function moveAccount(accounts: readonly JournalAccountDto[], id: string, direction: 'up' | 'down'): readonly JournalAccountDto[] {
  const sorted = [...accounts].sort((a, b) => a.sortOrder - b.sortOrder);
  const index = sorted.findIndex((account) => account.id === id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= sorted.length) return accounts;
  const swapped = [...sorted];
  const current = swapped[index];
  const other = swapped[target];
  if (current === undefined || other === undefined) return accounts;
  swapped[index] = other;
  swapped[target] = current;
  return swapped.map((account, position) => ({ ...account, sortOrder: position + 1 }));
}

/** カンマ区切りの入力 → 配列（空要素は捨てる）。別名・口座名・必要項目に使う。 */
export function splitList(raw: string): readonly string[] {
  return raw.split(/[,、]/).map((item) => item.trim()).filter((item) => item !== '');
}

/* ---------------------------------------------------------------------------
 * ディープリンク
 * ------------------------------------------------------------------------- */

export interface JournalFocus { readonly tab: JournalTab; readonly section: 'document' | 'rule' | 'account' | 'entry'; readonly id: string }

/**
 * 他画面からの「この項目を開く」依頼（OpenTarget）→ 開くタブと項目。section が未知（'hearing' など Phase 2 以降）なら undefined。
 */
export function openJournalTarget(target: OpenTarget): JournalFocus | undefined {
  switch (target.section) {
    case 'document': return { tab: 'judge', section: 'document', id: target.internalId };
    case 'rule': return { tab: 'rules', section: 'rule', id: target.internalId };
    case 'account': return { tab: 'chart', section: 'account', id: target.internalId };
    case 'entry': return { tab: 'export', section: 'entry', id: target.internalId };
    default: return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * 事実フォーム（取込タブの手入力）
 * ------------------------------------------------------------------------- */

export interface FactsLineDraft { readonly description: string; readonly quantity: string; readonly unitPrice: string; readonly amount: string; readonly taxRate: '' | '10' | '8' | '0' }
export interface FactsTotalDraft { readonly rate: '10' | '8' | '0'; readonly taxableAmount: string; readonly taxAmount: string; readonly amountIncludesTax: boolean }
/** 入力欄の文字列で持つ事実。数値・日付の変換と検証は factsFromDraft が担う。 */
export interface FactsDraft {
  readonly direction: '' | 'in' | 'out'; readonly issuerName: string; readonly recipientName: string; readonly registrationNumber: string;
  readonly issueDate: string; readonly transactionDate: string; readonly dueDate: string; readonly grandTotal: string; readonly paymentMethod: '' | JournalPaymentMethodDto;
  readonly accountHint: string; readonly description: string; readonly counterpartyHint: string; readonly lines: readonly FactsLineDraft[]; readonly totals: readonly FactsTotalDraft[];
  /** extra は JSON オブジェクトの文字列（空 = なし）。 */
  readonly extra: string;
}

export const EMPTY_FACTS_LINE: FactsLineDraft = { description: '', quantity: '', unitPrice: '', amount: '', taxRate: '' };
export const EMPTY_FACTS_TOTAL: FactsTotalDraft = { rate: '10', taxableAmount: '', taxAmount: '', amountIncludesTax: true };

export function emptyFactsDraft(): FactsDraft {
  return { direction: '', issuerName: '', recipientName: '', registrationNumber: '', issueDate: '', transactionDate: '', dueDate: '', grandTotal: '', paymentMethod: '', accountHint: '', description: '', counterpartyHint: '', lines: [], totals: [], extra: '' };
}

/** 保存済みの facts → 入力欄。 */
export function draftFromFacts(facts: JournalDocumentFactsDto): FactsDraft {
  const str = (value: string | number | undefined) => value === undefined ? '' : String(value);
  return {
    direction: facts.direction ?? '', issuerName: facts.issuerName ?? '', recipientName: facts.recipientName ?? '', registrationNumber: facts.registrationNumber ?? '',
    issueDate: facts.issueDate ?? '', transactionDate: facts.transactionDate ?? '', dueDate: facts.dueDate ?? '', grandTotal: str(facts.grandTotal), paymentMethod: facts.paymentMethod ?? '',
    accountHint: facts.accountHint ?? '', description: facts.description ?? '', counterpartyHint: facts.counterpartyHint ?? '',
    lines: (facts.lines ?? []).map((line) => ({ description: line.description, quantity: str(line.quantity), unitPrice: str(line.unitPrice), amount: str(line.amount), taxRate: line.taxRate === undefined ? '' : String(line.taxRate) as '10' | '8' | '0' })),
    totals: (facts.totalsByRate ?? []).map((total) => ({ rate: String(total.rate) as '10' | '8' | '0', taxableAmount: str(total.taxableAmount), taxAmount: str(total.taxAmount), amountIncludesTax: total.amountIncludesTax })),
    extra: facts.extra === undefined ? '' : JSON.stringify(facts.extra, null, 2),
  };
}

/** 入力欄 → facts。空欄はキーごと落とす。不備は欄のパス → 文言（日英）。 */
export function factsFromDraft(draft: FactsDraft): { readonly facts: JournalDocumentFactsDto; readonly errors: Readonly<Record<string, readonly [en: string, ja: string]>> } {
  const errors: Record<string, readonly [string, string]> = {};
  const facts: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => { if (value !== undefined && value !== '') facts[key] = value; };
  const integer = (key: string, raw: string, required = false): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') { if (required) errors[key] = ['Required', '必須です']; return undefined; }
    const parsed = Number(trimmed.replace(/[,¥]/g, ''));
    if (!Number.isInteger(parsed)) { errors[key] = ['Enter an integer amount in yen', '円単位の整数で入力してください']; return undefined; }
    return parsed;
  };
  const date = (key: string, raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    if (!DATE_PATTERN.test(trimmed)) { errors[key] = ['Use YYYY-MM-DD', 'YYYY-MM-DD 形式で入力してください']; return undefined; }
    return trimmed;
  };
  put('direction', draft.direction);
  put('issuerName', draft.issuerName.trim());
  put('recipientName', draft.recipientName.trim());
  const registration = draft.registrationNumber.replace(/[-\s]/g, '').toUpperCase();
  if (registration !== '') { if (/^T\d{13}$/.test(registration)) facts['registrationNumber'] = registration; else errors['registrationNumber'] = ['Use T + 13 digits', 'T + 13 桁で入力してください']; }
  put('issueDate', date('issueDate', draft.issueDate));
  put('transactionDate', date('transactionDate', draft.transactionDate));
  put('dueDate', date('dueDate', draft.dueDate));
  put('grandTotal', integer('grandTotal', draft.grandTotal));
  put('paymentMethod', draft.paymentMethod);
  put('accountHint', draft.accountHint.trim());
  put('description', draft.description.trim());
  put('counterpartyHint', draft.counterpartyHint.trim());
  if (draft.lines.length > 0) {
    facts['lines'] = draft.lines.map((line, index) => {
      if (line.description.trim() === '') errors[`lines.${index}.description`] = ['Required', '必須です'];
      const amount = integer(`lines.${index}.amount`, line.amount, true) ?? 0;
      const quantity = line.quantity.trim() === '' ? undefined : Number(line.quantity);
      const unitPrice = line.unitPrice.trim() === '' ? undefined : Number(line.unitPrice);
      if (quantity !== undefined && !Number.isFinite(quantity)) errors[`lines.${index}.quantity`] = ['Enter a number', '数値で入力してください'];
      if (unitPrice !== undefined && !Number.isFinite(unitPrice)) errors[`lines.${index}.unitPrice`] = ['Enter a number', '数値で入力してください'];
      return { description: line.description.trim(), amount, ...(quantity === undefined ? {} : { quantity }), ...(unitPrice === undefined ? {} : { unitPrice }), ...(line.taxRate === '' ? {} : { taxRate: Number(line.taxRate) as 10 | 8 | 0, reducedRateMark: line.taxRate === '8' }) };
    });
  }
  if (draft.totals.length > 0) {
    facts['totalsByRate'] = draft.totals.map((total, index) => {
      const taxableAmount = integer(`totals.${index}.taxableAmount`, total.taxableAmount, true) ?? 0;
      const taxAmount = integer(`totals.${index}.taxAmount`, total.taxAmount);
      return { rate: Number(total.rate) as 10 | 8 | 0, taxableAmount, ...(taxAmount === undefined ? {} : { taxAmount }), amountIncludesTax: total.amountIncludesTax };
    });
  }
  if (draft.extra.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(draft.extra);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) errors['extra'] = ['extra must be a JSON object', 'extra は JSON オブジェクトで入力してください'];
      else facts['extra'] = parsed;
    } catch { errors['extra'] = ['extra is not valid JSON', 'extra が JSON として読めません']; }
  }
  return { facts: facts as JournalDocumentFactsDto, errors };
}
