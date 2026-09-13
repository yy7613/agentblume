/**
 * application層: ヒアリングの提案（ルール草案 + 仕訳草案 + 新科目）の検証（純関数。docs/20 §7）。
 *
 * ## なぜ「壊れた提案は保存しない」か
 * 提案が保存できてしまうと、利用者は画面で「登録」を押せる。押した瞬間に存在しない科目 id を
 * 参照するルールが増え、以後の判定は毎回 `unknown-account` で止まる。**モデルの出力は
 * ここを通過するまでは提案ですらない**ので、通らなければ提案の無いセッションとして保存し、
 * 何が駄目だったかを利用者に見せる（1 回の修復依頼はユースケース側が行う）。
 *
 * ## 何を見るか
 * - 科目 id・税区分コード・補助軸の値 id が**マスタにあるか、または同じ提案の new* にあるか**。
 * - ルールがドメインの `createJournalRule` を通るか（条件の演算子・金額指定・置換子まで）。
 * - 仕訳草案がドメインの `validateJournalEntryDraft` を通るか（**貸借一致**・正の整数・日付）。
 * - 条件・requiredFacts の facts パスが facts の形として在り得るか（`extra.<key>` は自由）。
 *
 * モデルは科目名しか知らないことがあるので、`accountName` は**マスタ（または新科目）の名前で上書きする**。
 * 名前と id が食い違う仕訳行は CSV の中身を壊すため、クライアント申告を採らないのは
 * `SaveJournalEntryUseCase` と同じ規律である。
 */
import {
  findAccount, findTaxCategory, type Account, type ChartOfAccounts, type TaxCategory,
} from '../../domain/journal/chart-of-accounts';
import type { DocumentFacts } from '../../domain/journal/document';
import { validateJournalEntryDraft, type JournalEntryDraft, type JournalEntryLine } from '../../domain/journal/entry';
import type { HearingProposal } from '../../domain/journal/hearing';
import { createJournalRule, type JournalRuleDraft } from '../../domain/journal/rule';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 提案が新規に足せる科目・補助軸の値・税区分の上限（利用者が 1 画面で確認できる量）。 */
export const MAX_PROPOSED_ACCOUNTS = 10;
export const MAX_PROPOSED_DIMENSION_VALUES = 10;
export const MAX_PROPOSED_TAX_CATEGORIES = 5;

/** facts のパスとして在り得る最初のセグメント（`DocumentFacts` のキー）。 */
const FACT_ROOTS: ReadonlySet<string> = new Set([
  'direction', 'issuerName', 'recipientName', 'registrationNumber', 'issueDate', 'transactionDate', 'dueDate',
  'grandTotal', 'totalsByRate', 'lines', 'paymentMethod', 'accountHint', 'description', 'descriptionNorm',
  'counterpartyHint', 'extra',
] satisfies readonly (keyof DocumentFacts)[]);

const SEGMENT_PATTERN = /^[A-Za-z0-9_]+(?:\[\])?$/u;

/**
 * facts のパスとして形が正しいか（`descriptionNorm` / `lines[].description` / `extra.purpose`）。
 * 値の有無は見ない（判定時に無ければ `missing-fact` になるだけで、パスとしては正しい）。
 */
export function isWellFormedFactPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const segments = path.trim().split('.');
  if (segments.length === 0 || segments.some((segment) => !SEGMENT_PATTERN.test(segment))) return false;
  const root = segments[0]!.replace(/\[\]$/u, '');
  if (!FACT_ROOTS.has(root)) return false;
  // `extra` は「extra.<key>」の形でだけ意味を持つ（extra 単体を条件にしても評価できない）。
  if (root === 'extra' && segments.length < 2) return false;
  return true;
}

/** 提案が参照してよい id の集合（マスタ + 同じ提案の新規分）。 */
export interface KnownChartIds {
  readonly accountNames: ReadonlyMap<string, string>;
  readonly taxCodes: ReadonlySet<string>;
  readonly dimensionValues: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ProposedAdditions {
  readonly newAccounts: readonly Omit<Account, 'sortOrder' | 'enabled'>[];
  readonly newDimensionValues: readonly { readonly dimensionId: string; readonly id: string; readonly name: string }[];
  readonly newTaxCategories: readonly Omit<TaxCategory, 'enabled'>[];
}

/** マスタと新規分を合わせた「今この提案の中で有効な id」。 */
export function knownChartIds(chart: ChartOfAccounts, additions?: ProposedAdditions): KnownChartIds {
  const accountNames = new Map<string, string>(chart.accounts.map((account) => [account.id, account.name]));
  for (const account of additions?.newAccounts ?? []) accountNames.set(account.id, account.name);
  const taxCodes = new Set<string>(chart.taxCategories.map((entry) => entry.code));
  for (const entry of additions?.newTaxCategories ?? []) taxCodes.add(entry.code);
  const dimensionValues = new Map<string, Set<string>>(chart.dimensions.map((dimension) => [dimension.id, new Set(dimension.values.map((value) => value.id))]));
  for (const value of additions?.newDimensionValues ?? []) {
    const existing = dimensionValues.get(value.dimensionId) ?? new Set<string>();
    existing.add(value.id);
    dimensionValues.set(value.dimensionId, existing);
  }
  return { accountNames, taxCodes, dimensionValues };
}

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value === null || typeof value !== 'object' || Array.isArray(value) ? undefined : value as Record<string, unknown>;
}

function checkReferences(lines: readonly { accountId?: unknown; taxCode?: unknown; dimensionValues?: unknown }[], known: KnownChartIds, label: string, issues: string[]): void {
  for (const [index, line] of lines.entries()) {
    const accountId = typeof line.accountId === 'string' ? line.accountId.trim() : '';
    if (accountId === '') issues.push(`${label}[${index}].accountId が空`);
    else if (!known.accountNames.has(accountId)) issues.push(`${label}[${index}].accountId "${accountId}" は科目マスタにも newAccounts にも無い`);
    const taxCode = typeof line.taxCode === 'string' ? line.taxCode.trim() : '';
    if (taxCode === '') issues.push(`${label}[${index}].taxCode が空`);
    else if (!known.taxCodes.has(taxCode)) issues.push(`${label}[${index}].taxCode "${taxCode}" は税区分マスタにも newTaxCategories にも無い`);
    const dimensionValues = asObject(line.dimensionValues);
    for (const [dimensionId, valueId] of Object.entries(dimensionValues ?? {})) {
      const values = known.dimensionValues.get(dimensionId);
      if (values === undefined) issues.push(`${label}[${index}].dimensionValues の補助軸 "${dimensionId}" がマスタに無い`);
      else if (typeof valueId !== 'string' || !values.has(valueId)) issues.push(`${label}[${index}].dimensionValues["${dimensionId}"] の値 "${String(valueId)}" がマスタにも newDimensionValues にも無い`);
    }
  }
}

/**
 * ルール草案の検証。ドメインの `createJournalRule` を「保存せずに」通し、
 * 参照 id と facts パスを追加で見る。id は検証専用の `draft` を使う（保存時に採番し直す）。
 */
export function validateProposedRule(raw: unknown, known: KnownChartIds, scope: TenantScope, defaultName?: string): ValidationOutcome<JournalRuleDraft> {
  const value = asObject(raw);
  if (value === undefined) return { ok: false, issues: ['rule がオブジェクトではない'] };
  const issues: string[] = [];
  const outcome = asObject(value['outcome']);
  const lines = Array.isArray(outcome?.['lines']) ? outcome['lines'] as readonly Record<string, unknown>[] : [];
  if (lines.length === 0) issues.push('rule.outcome.lines が空');
  checkReferences(lines, known, 'rule.outcome.lines', issues);

  const conditions = Array.isArray(value['conditions']) ? value['conditions'] as readonly Record<string, unknown>[] : [];
  for (const [index, condition] of conditions.entries()) {
    if (!isWellFormedFactPath(condition['field'])) issues.push(`rule.conditions[${index}].field "${String(condition['field'])}" は facts のパスとして解釈できない`);
  }
  const askIf = Array.isArray(value['askIf']) ? value['askIf'] as readonly Record<string, unknown>[] : [];
  for (const [index, entry] of askIf.entries()) {
    const entryConditions = Array.isArray(entry['conditions']) ? entry['conditions'] as readonly Record<string, unknown>[] : [];
    for (const [conditionIndex, condition] of entryConditions.entries()) {
      if (!isWellFormedFactPath(condition['field'])) issues.push(`rule.askIf[${index}].conditions[${conditionIndex}].field "${String(condition['field'])}" は facts のパスとして解釈できない`);
    }
  }
  const requiredFacts = Array.isArray(value['requiredFacts']) ? value['requiredFacts'] : [];
  for (const [index, path] of requiredFacts.entries()) {
    if (!isWellFormedFactPath(path)) issues.push(`rule.requiredFacts[${index}] "${String(path)}" は facts のパスとして解釈できない`);
  }

  const at = '2026-01-01T00:00:00.000Z'; // 検証専用（保存時に実時刻で作り直す）。
  let draft: JournalRuleDraft | undefined;
  try {
    const created = createJournalRule({
      tenant: scope,
      id: 'draft',
      name: typeof value['name'] === 'string' && value['name'].trim() !== '' ? value['name'] : (defaultName ?? ''),
      enabled: value['enabled'] !== false,
      mode: value['mode'] === 'suggest' ? 'suggest' : 'auto',
      priority: typeof value['priority'] === 'number' ? Math.trunc(value['priority']) : 100,
      scope: (asObject(value['scope']) ?? {}) as JournalRuleDraft['scope'],
      conditions: conditions as unknown as JournalRuleDraft['conditions'],
      outcome: (outcome ?? { lines: [] }) as unknown as JournalRuleDraft['outcome'],
      askIf: askIf as unknown as JournalRuleDraft['askIf'],
      requiredFacts: requiredFacts as readonly string[],
      createdAt: at,
      updatedAt: at,
    });
    draft = {
      name: created.name, enabled: created.enabled, mode: created.mode, priority: created.priority,
      scope: created.scope, conditions: created.conditions, outcome: created.outcome,
      askIf: created.askIf, requiredFacts: created.requiredFacts,
    };
  } catch (error) {
    issues.push(`rule がドメインの検証を通らない: ${messageOf(error)}`);
  }
  if (issues.length > 0 || draft === undefined) return { ok: false, issues: issues.length > 0 ? issues : ['rule を組み立てられなかった'] };
  return { ok: true, value: draft };
}

/**
 * 仕訳草案の検証。`accountName` は**必ずマスタ（または新科目）の名前で埋め直す**
 * （モデルの申告を採らない）。貸借一致・金額・日付はドメインの検証に任せる。
 */
export function validateProposedEntry(raw: unknown, known: KnownChartIds, defaultDate?: string): ValidationOutcome<JournalEntryDraft> {
  const value = asObject(raw);
  if (value === undefined) return { ok: false, issues: ['entry がオブジェクトではない'] };
  const issues: string[] = [];
  const rawLines = Array.isArray(value['lines']) ? value['lines'] as readonly Record<string, unknown>[] : [];
  if (rawLines.length === 0) issues.push('entry.lines が空');
  checkReferences(rawLines, known, 'entry.lines', issues);
  if (issues.length > 0) return { ok: false, issues };

  const lines: JournalEntryLine[] = rawLines.map((line) => {
    const accountId = String(line['accountId']).trim();
    const dimensionValues = asObject(line['dimensionValues']);
    const partner = typeof line['partner'] === 'string' && line['partner'].trim() !== '' ? line['partner'].trim() : undefined;
    const taxAmount = typeof line['taxAmount'] === 'number' ? Math.trunc(line['taxAmount']) : undefined;
    return {
      side: line['side'] === 'credit' ? 'credit' : 'debit',
      accountId,
      accountName: known.accountNames.get(accountId) ?? accountId,
      ...(dimensionValues === undefined ? {} : { dimensionValues: dimensionValues as Record<string, string> }),
      taxCode: String(line['taxCode']).trim(),
      amount: typeof line['amount'] === 'number' ? Math.trunc(line['amount']) : Number.NaN,
      ...(taxAmount === undefined ? {} : { taxAmount }),
      ...(partner === undefined ? {} : { partner }),
    };
  });

  try {
    return {
      ok: true,
      value: validateJournalEntryDraft({
        date: typeof value['date'] === 'string' && value['date'].trim() !== '' ? value['date'] : (defaultDate ?? ''),
        lines,
        description: typeof value['description'] === 'string' ? value['description'] : '',
        invoiceStatus: (value['invoiceStatus'] ?? 'not_required') as JournalEntryDraft['invoiceStatus'],
        ...(typeof value['registrationNumber'] === 'string' ? { registrationNumber: value['registrationNumber'] } : {}),
        ...(typeof value['item'] === 'string' ? { item: value['item'] } : {}),
        ...(Array.isArray(value['tags']) ? { tags: (value['tags'] as readonly unknown[]).filter((tag): tag is string => typeof tag === 'string') } : {}),
      }, 'proposal entry'),
    };
  } catch (error) {
    return { ok: false, issues: [`entry がドメインの検証を通らない: ${messageOf(error)}`] };
  }
}

/** 新規に足す科目・補助軸の値・税区分（形と件数だけを見る。登録するかは利用者が選ぶ）。 */
function readAdditions(value: Record<string, unknown>, chart: ChartOfAccounts, issues: string[]): ProposedAdditions {
  const newAccounts: Omit<Account, 'sortOrder' | 'enabled'>[] = [];
  for (const [index, raw] of (Array.isArray(value['newAccounts']) ? value['newAccounts'] : []).entries()) {
    const item = asObject(raw);
    const id = typeof item?.['id'] === 'string' ? item['id'].trim() : '';
    const name = typeof item?.['name'] === 'string' ? item['name'].trim() : '';
    const category = item?.['category'];
    if (id === '' || name === '') { issues.push(`newAccounts[${index}] は id と name が要る`); continue; }
    if (findAccount(chart, id) !== undefined) { issues.push(`newAccounts[${index}].id "${id}" は既にマスタにある（新規として提案しない）`); continue; }
    if (typeof category !== 'string') { issues.push(`newAccounts[${index}].category が無い`); continue; }
    const aliases = Array.isArray(item?.['aliases']) ? (item['aliases'] as readonly unknown[]).filter((alias): alias is string => typeof alias === 'string') : [];
    const defaultTaxCode = typeof item?.['defaultTaxCode'] === 'string' ? item['defaultTaxCode'] : undefined;
    const note = typeof item?.['note'] === 'string' ? item['note'] : undefined;
    newAccounts.push({ id, name, category: category as Account['category'], aliases, ...(defaultTaxCode === undefined ? {} : { defaultTaxCode }), ...(note === undefined ? {} : { note }) });
  }
  if (newAccounts.length > MAX_PROPOSED_ACCOUNTS) issues.push(`newAccounts は ${MAX_PROPOSED_ACCOUNTS} 件までにする（${newAccounts.length} 件）`);

  const newDimensionValues: { dimensionId: string; id: string; name: string }[] = [];
  for (const [index, raw] of (Array.isArray(value['newDimensionValues']) ? value['newDimensionValues'] : []).entries()) {
    const item = asObject(raw);
    const dimensionId = typeof item?.['dimensionId'] === 'string' ? item['dimensionId'].trim() : '';
    const id = typeof item?.['id'] === 'string' ? item['id'].trim() : '';
    const name = typeof item?.['name'] === 'string' ? item['name'].trim() : '';
    if (dimensionId === '' || id === '' || name === '') { issues.push(`newDimensionValues[${index}] は dimensionId / id / name が要る`); continue; }
    if (!chart.dimensions.some((dimension) => dimension.id === dimensionId)) { issues.push(`newDimensionValues[${index}].dimensionId "${dimensionId}" という補助軸はマスタに無い`); continue; }
    newDimensionValues.push({ dimensionId, id, name });
  }
  if (newDimensionValues.length > MAX_PROPOSED_DIMENSION_VALUES) issues.push(`newDimensionValues は ${MAX_PROPOSED_DIMENSION_VALUES} 件までにする（${newDimensionValues.length} 件）`);

  const newTaxCategories: Omit<TaxCategory, 'enabled'>[] = [];
  for (const [index, raw] of (Array.isArray(value['newTaxCategories']) ? value['newTaxCategories'] : []).entries()) {
    const item = asObject(raw);
    const code = typeof item?.['code'] === 'string' ? item['code'].trim() : '';
    const name = typeof item?.['name'] === 'string' ? item['name'].trim() : '';
    const side = item?.['side'];
    if (code === '' || name === '') { issues.push(`newTaxCategories[${index}] は code と name が要る`); continue; }
    if (findTaxCategory(chart, code) !== undefined) { issues.push(`newTaxCategories[${index}].code "${code}" は既にマスタにある（新規として提案しない）`); continue; }
    if (side !== 'in' && side !== 'out' && side !== 'none') { issues.push(`newTaxCategories[${index}].side は in / out / none のいずれか`); continue; }
    const rate = typeof item?.['rate'] === 'number' ? item['rate'] : undefined;
    const deductionRate = typeof item?.['deductionRate'] === 'number' ? item['deductionRate'] : undefined;
    newTaxCategories.push({ code, name, side, ...(rate === undefined ? {} : { rate }), ...(deductionRate === undefined ? {} : { deductionRate }) });
  }
  if (newTaxCategories.length > MAX_PROPOSED_TAX_CATEGORIES) issues.push(`newTaxCategories は ${MAX_PROPOSED_TAX_CATEGORIES} 件までにする（${newTaxCategories.length} 件）`);

  return { newAccounts, newDimensionValues, newTaxCategories };
}

export interface HearingProposalContext {
  readonly scope: TenantScope;
  readonly chart: ChartOfAccounts;
  /**
   * モデルが埋め忘れたときに使う既定値（帳票から作る）。
   * 小さいモデルは name や date を落としがちで、そこだけで提案全体を捨てるのは惜しい。
   * 補ったことは warnings に残し、利用者が登録前に直せるようにする。
   */
  readonly defaults?: { readonly ruleName?: string; readonly entryDate?: string };
}

/**
 * モデルの提案を検証して `HearingProposal` にする。**壊れていれば理由をすべて返す**
 * （1 つ直して次が出る、を繰り返させない。1 回の修復依頼にすべて載せる）。
 */
export function validateHearingProposal(raw: unknown, context: HearingProposalContext): ValidationOutcome<HearingProposal> {
  const value = asObject(raw);
  if (value === undefined) return { ok: false, issues: ['proposal がオブジェクトではない'] };
  const issues: string[] = [];
  const additions = readAdditions(value, context.chart, issues);
  const known = knownChartIds(context.chart, additions);

  const rawRule = asObject(value['rule']);
  const rawEntry = asObject(value['entry']);
  const filledName = typeof rawRule?.['name'] !== 'string' || rawRule['name'].trim() === '';
  const filledDate = typeof rawEntry?.['date'] !== 'string' || rawEntry['date'].trim() === '';
  const rule = validateProposedRule(value['rule'], known, context.scope, context.defaults?.ruleName);
  if (!rule.ok) issues.push(...rule.issues);
  const entry = validateProposedEntry(value['entry'], known, context.defaults?.entryDate);
  if (!entry.ok) issues.push(...entry.issues);
  if (issues.length > 0 || !rule.ok || !entry.ok) return { ok: false, issues };

  const rationale = typeof value['rationale'] === 'string' ? value['rationale'].trim() : '';
  const warnings = Array.isArray(value['warnings']) ? (value['warnings'] as readonly unknown[]).filter((warning): warning is string => typeof warning === 'string') : [];
  if (filledName && context.defaults?.ruleName !== undefined) warnings.push(`ルール名が提案に無かったので「${context.defaults.ruleName}」で補った。分かりやすい名前に直せる。`);
  if (filledDate && context.defaults?.entryDate !== undefined) warnings.push(`仕訳日が提案に無かったので帳票の ${context.defaults.entryDate} で補った。取引日が違えば直すこと。`);
  return {
    ok: true,
    value: {
      rule: rule.value,
      entry: entry.value,
      newAccounts: additions.newAccounts,
      newDimensionValues: additions.newDimensionValues,
      newTaxCategories: additions.newTaxCategories,
      rationale,
      warnings,
    },
  };
}
