/**
 * ドメイン: 規程の案（ヒアリングのモデル出力）の検証（docs/21 §20.7.2 / ADR-0043 §12。UC9。純関数）。
 *
 * - 案は**現在の規程に 1 件ずつ重ねて `createExpensePolicy` を通る部分だけ**を残し、通らない部分は `dropped` に理由を残す。
 *   1 件ずつ重ねるので、残った案をすべて当てた規程も必ず検証を通る。
 * - 承認経路の案は段の種類（上長・部門長・承認グループ・承認権限を持つ誰でも）までに限り、特定の従業員は採らない
 *   （モデルに従業員の氏名を渡さない。ADR-0043 帰結）。承認グループは組織にある id だけ。部門の条件は画面で設定する。
 * - 根拠の引用は規程文（NFKC・空白除去・小文字化）の部分文字列として探し、`quoteFound` を付ける。
 *   数値の変更で根拠が見つからないものは警告にする（幻覚の数値を利用者が見分けられるように）。
 * - 文書モードで節ごとに違う値が出た項目は、どちらも案に入れずに警告に残す（`mergeProposalDrafts`）。
 *
 * モデルの出力は緩い形で受け（`RawPolicyProposal`）、ここで厳密に検証する（仕訳のヒアリングと同じ方針）。
 */
import type { ApprovalRoute, ApprovalSettings } from '../approval';
import { createExpensePolicy, type ClaimRules, type CreateExpensePolicyProps, type ExpenseCategory, type ExpensePolicy, type PreApprovalRule } from '../policy';
import type { PolicyProposal, ProposedPolicyPatch } from '../policy-hearing';
import type { SeverityOverride } from '../reason-codes';

/** モデルの応答（形を信用しない）。 */
export interface RawPolicyProposal {
  readonly categories?: unknown;
  readonly claimRules?: unknown;
  readonly preApprovalRules?: unknown;
  readonly approvalRoutes?: unknown;
  readonly severityOverrides?: unknown;
  readonly rationales?: unknown;
}

export interface ProposalValidationContext {
  readonly current: ExpensePolicy;
  /** 引用を探す原文（文書モードは規程文、質問モードは回答の文）。 */
  readonly sourceText: string;
  /** 仕訳の科目マスタの有効な科目 id（読めなかったら undefined = 検査しない）。 */
  readonly accountIds?: ReadonlySet<string>;
  /** 組織の有効な承認グループ id。 */
  readonly groupIds: ReadonlySet<string>;
}

export interface ProposalValidation {
  readonly proposal: PolicyProposal;
  /** 修復の依頼に使う「落とした理由」の一覧。 */
  readonly issues: readonly string[];
}

export const PROPOSAL_MAX_RATIONALES = 200;
const CLAIM_RULE_KEYS = ['submissionDeadlineDays', 'nonReimbursablePaymentMethods', 'attendeesIncludeClaimant', 'forbidSelfApproval'] as const;
const CATEGORY_OBJECT_FIELDS = ['taxCodeByRate', 'receipt', 'invoice', 'requires', 'route'] as const;
const CATEGORY_VALUE_FIELDS = ['code', 'name', 'aliases', 'accountId', 'defaultTaxRate', 'note'] as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Props = Omit<CreateExpensePolicyProps, 'approval'> & { readonly approval: ApprovalSettings };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** null は「指定なし」（既存の値を保つ）。モデルが知らない項目を null で埋めても、上限を黙って消さない。 */
function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeQuoteText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

export function quoteFoundIn(source: string, quote: string | undefined): boolean {
  if (quote === undefined) return false;
  const needle = normalizeQuoteText(quote);
  return needle !== '' && normalizeQuoteText(source).includes(needle);
}

/** パスが同じ項目を指すか（一方が他方の親でもよい）。id に `.` を含む（`meal.entertainment`）ので境界付きで比べる。 */
export function relatedPaths(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

/** キーを並べた JSON（節ごとの案の同一性と差分の比較に使う）。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function propsOf(policy: ExpensePolicy): Props {
  return { ...policy };
}

function mergeCategory(existing: ExpenseCategory | undefined, entry: Record<string, unknown>, props: Props): ExpenseCategory {
  const base: ExpenseCategory = existing ?? {
    id: entry['id'] as string,
    name: '',
    enabled: true,
    sortOrder: props.categories.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 1,
    aliases: [],
    defaultTaxRate: 10,
    taxCodeByRate: props.categories[0]?.taxCodeByRate ?? {},
    receipt: { required: true },
    invoice: { required: true },
    requires: { purpose: false, attendees: false, attendeeDetails: false },
    limits: { perPersonBasis: 'tax-included' },
  };
  const merged: Record<string, unknown> = { ...base };
  for (const key of CATEGORY_VALUE_FIELDS) if (entry[key] !== null && entry[key] !== undefined) merged[key] = entry[key];
  for (const key of CATEGORY_OBJECT_FIELDS) {
    if (!isObject(entry[key])) continue;
    const current = base[key];
    merged[key] = { ...(isObject(current) ? current : {}), ...withoutNulls(entry[key]) };
  }
  if (isObject(entry['limits'])) merged['limits'] = { ...base.limits, ...withoutNulls(entry['limits']) };
  if (typeof entry['enabled'] === 'boolean') merged['enabled'] = entry['enabled'];
  return merged as unknown as ExpenseCategory;
}

function replaceOrAppend<T extends { readonly id: string }>(list: readonly T[], item: T): readonly T[] {
  return list.some((entry) => entry.id === item.id) ? list.map((entry) => (entry.id === item.id ? item : entry)) : [...list, item];
}

function arrayOf(value: unknown, path: string, dropped: { path: string; reason: string }[]): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  dropped.push({ path, reason: '配列ではないので読めませんでした' });
  return [];
}

function numericPaths(prefix: string, before: unknown, after: unknown): string[] {
  if (typeof after === 'number') return before === after ? [] : [prefix];
  if (!isObject(after)) return [];
  const previous = isObject(before) ? before : {};
  return Object.keys(after).flatMap((key) => numericPaths(`${prefix}.${key}`, previous[key], after[key]));
}

export function validatePolicyProposal(raw: RawPolicyProposal, context: ProposalValidationContext): ProposalValidation {
  const dropped: { path: string; reason: string }[] = [];
  let props = propsOf(context.current);
  const accepted: { categories: string[]; claimRules: string[]; preApprovalRules: string[]; routes: string[]; severities: string[] } = { categories: [], claimRules: [], preApprovalRules: [], routes: [], severities: [] };
  const numericChanges: string[] = [];

  const apply = (path: string, next: Props): boolean => {
    try {
      createExpensePolicy(next);
      props = next;
      return true;
    } catch (error) {
      dropped.push({ path, reason: messageOf(error) });
      return false;
    }
  };

  arrayOf(raw.categories, 'categories', dropped).forEach((entry, index) => {
    if (!isObject(entry) || typeof entry['id'] !== 'string' || entry['id'].trim() === '') {
      dropped.push({ path: `categories[${index}]`, reason: '費目の id がありません' });
      return;
    }
    const id = entry['id'].trim();
    const path = `categories.${id}`;
    const existing = props.categories.find((category) => category.id === id);
    const merged = mergeCategory(existing, { ...entry, id }, props);
    if (context.accountIds !== undefined && merged.accountId !== undefined && merged.accountId !== existing?.accountId && !context.accountIds.has(merged.accountId)) {
      dropped.push({ path: `${path}.accountId`, reason: `科目 ${merged.accountId} は仕訳の科目マスタに無いか無効です` });
      return;
    }
    if (apply(path, { ...props, categories: replaceOrAppend(props.categories, merged) })) {
      accepted.categories.push(id);
      numericChanges.push(...['limits', 'receipt', 'invoice'].flatMap((key) => numericPaths(`${path}.${key}`, existing?.[key as 'limits'], merged[key as 'limits'])));
    }
  });

  if (raw.claimRules !== undefined && raw.claimRules !== null) {
    if (!isObject(raw.claimRules)) dropped.push({ path: 'claimRules', reason: 'オブジェクトではないので読めませんでした' });
    else {
      for (const [key, value] of Object.entries(withoutNulls(raw.claimRules))) {
        const path = `claimRules.${key}`;
        if (!(CLAIM_RULE_KEYS as readonly string[]).includes(key)) {
          dropped.push({ path, reason: 'この項目は規程の申請ルールにありません' });
          continue;
        }
        const before = props.claimRules[key as keyof ClaimRules];
        if (apply(path, { ...props, claimRules: { ...props.claimRules, [key]: value } as ClaimRules })) {
          accepted.claimRules.push(key);
          numericChanges.push(...numericPaths(path, before, value));
        }
      }
    }
  }

  arrayOf(raw.preApprovalRules, 'preApprovalRules', dropped).forEach((entry, index) => {
    if (!isObject(entry) || typeof entry['id'] !== 'string' || entry['id'].trim() === '') {
      dropped.push({ path: `preApprovalRules[${index}]`, reason: '事前承認の条件の id がありません' });
      return;
    }
    const id = entry['id'].trim();
    const path = `preApprovalRules.${id}`;
    const existing = props.preApprovalRules.find((rule) => rule.id === id);
    const merged = { enabled: true, categoryIds: [], ...(existing ?? {}), ...withoutNulls(entry), id } as unknown as PreApprovalRule;
    if (apply(path, { ...props, preApprovalRules: replaceOrAppend(props.preApprovalRules, merged) })) {
      accepted.preApprovalRules.push(id);
      numericChanges.push(...numericPaths(path, existing, merged));
    }
  });

  arrayOf(raw.approvalRoutes, 'approval.routes', dropped).forEach((entry, index) => {
    if (!isObject(entry) || typeof entry['id'] !== 'string' || entry['id'].trim() === '') {
      dropped.push({ path: `approval.routes[${index}]`, reason: '承認経路の id がありません' });
      return;
    }
    const id = entry['id'].trim();
    const path = `approval.routes.${id}`;
    const steps = Array.isArray(entry['steps']) ? entry['steps'] : [];
    const approvers = steps.map((step) => (isObject(step) && isObject(step['approver']) ? step['approver'] : {}));
    if (approvers.some((approver) => approver['kind'] === 'employee')) {
      dropped.push({ path, reason: '特定の従業員を承認者にする案は採りません（段の種類までに限ります。承認者は画面で選んでください）' });
      return;
    }
    const unknownGroup = approvers.find((approver) => approver['kind'] === 'group' && !context.groupIds.has(String(approver['groupId'])));
    if (unknownGroup !== undefined) {
      dropped.push({ path, reason: `承認グループ ${String(unknownGroup['groupId'])} は組織にありません` });
      return;
    }
    const when = isObject(entry['when']) ? withoutNulls(entry['when']) : {};
    if (Array.isArray(when['departmentIds']) && when['departmentIds'].length > 0) {
      dropped.push({ path, reason: '部門の条件は案に含めません（部門は画面の承認経路で選んでください）' });
      return;
    }
    const existing = props.approval.routes.find((route) => route.id === id);
    const merged = { enabled: true, ...(existing ?? {}), ...withoutNulls(entry), id, when: { categoryIds: [], ...when, departmentIds: [] } } as unknown as ApprovalRoute;
    if (apply(path, { ...props, approval: { ...props.approval, routes: replaceOrAppend(props.approval.routes, merged) } })) {
      accepted.routes.push(id);
      numericChanges.push(...numericPaths(`${path}.when`, existing?.when, merged.when));
    }
  });

  if (raw.severityOverrides !== undefined && raw.severityOverrides !== null) {
    if (!isObject(raw.severityOverrides)) dropped.push({ path: 'severityOverrides', reason: 'オブジェクトではないので読めませんでした' });
    else {
      for (const [code, value] of Object.entries(withoutNulls(raw.severityOverrides))) {
        if (apply(`severityOverrides.${code}`, { ...props, severityOverrides: { ...props.severityOverrides, [code]: value as SeverityOverride } })) accepted.severities.push(code);
      }
    }
  }

  const rationales = arrayOf(raw.rationales, 'rationales', dropped).slice(0, PROPOSAL_MAX_RATIONALES).flatMap((entry) => {
    if (!isObject(entry) || typeof entry['path'] !== 'string' || entry['path'].trim() === '') return [];
    const quote = typeof entry['quote'] === 'string' && entry['quote'].trim() !== '' ? entry['quote'].trim() : undefined;
    const note = typeof entry['note'] === 'string' && entry['note'].trim() !== '' ? entry['note'].trim() : undefined;
    return [{ path: entry['path'].trim(), ...(quote === undefined ? {} : { quote }), quoteFound: quoteFoundIn(context.sourceText, quote), ...(note === undefined ? {} : { note }) }];
  });

  const final = createExpensePolicy(props);
  const candidate: Mutable<ProposedPolicyPatch> = {};
  if (accepted.categories.length > 0) candidate.categories = final.categories.filter((category) => accepted.categories.includes(category.id));
  if (accepted.claimRules.length > 0) candidate.claimRules = Object.fromEntries(accepted.claimRules.map((key) => [key, final.claimRules[key as keyof ClaimRules]])) as Partial<ClaimRules>;
  if (accepted.preApprovalRules.length > 0) candidate.preApprovalRules = final.preApprovalRules.filter((rule) => accepted.preApprovalRules.includes(rule.id));
  if (accepted.routes.length > 0) candidate.approvalRoutes = final.approval.routes.filter((route) => accepted.routes.includes(route.id));
  if (accepted.severities.length > 0) candidate.severityOverrides = Object.fromEntries(accepted.severities.map((code) => [code, final.severityOverrides[code as keyof typeof final.severityOverrides] as SeverityOverride]));

  const warnings = [...new Set(numericChanges)]
    .filter((path) => !rationales.some((rationale) => rationale.quoteFound && relatedPaths(rationale.path, path)))
    .map((path) => `規程文に根拠が見つからない数値です: ${path}`);
  return { proposal: { candidate, rationales, dropped, warnings }, issues: dropped.map((entry) => `${entry.path}: ${entry.reason}`) };
}

/**
 * 節ごとの案を 1 つにまとめる（決定的）。同じ項目（費目 id・条件 id・経路 id・申請ルールのキー・重さのコード）に違う値が出たら、
 * 両方を警告に残してどちらも案に入れない（どちらが正しいかはモデルでなく人が決める）。
 */
export function mergeProposalDrafts(drafts: readonly RawPolicyProposal[]): { readonly merged: RawPolicyProposal; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const byId = (key: 'categories' | 'preApprovalRules' | 'approvalRoutes', label: string): unknown[] => {
    const seen = new Map<string, { value: unknown; json: string; conflict: boolean }>();
    const order: string[] = [];
    const loose: unknown[] = [];
    for (const draft of drafts) {
      const list = Array.isArray(draft[key]) ? draft[key] as unknown[] : [];
      for (const entry of list) {
        const id = isObject(entry) && typeof entry['id'] === 'string' ? entry['id'] : undefined;
        if (id === undefined) { loose.push(entry); continue; }
        const json = stableJson(entry);
        const previous = seen.get(id);
        if (previous === undefined) { seen.set(id, { value: entry, json, conflict: false }); order.push(id); }
        else if (previous.json !== json && !previous.conflict) {
          previous.conflict = true;
          warnings.push(`${label} ${id} に節ごとに違う案が出たので、どちらも案に入れていません: ${previous.json} / ${json}`);
        }
      }
    }
    return [...order.filter((id) => seen.get(id)?.conflict !== true).map((id) => seen.get(id)?.value), ...loose];
  };
  const byKey = (key: 'claimRules' | 'severityOverrides', label: string): Record<string, unknown> => {
    const seen = new Map<string, { value: unknown; json: string; conflict: boolean }>();
    for (const draft of drafts) {
      const record = isObject(draft[key]) ? withoutNulls(draft[key] as Record<string, unknown>) : {};
      for (const [name, value] of Object.entries(record)) {
        const json = stableJson(value);
        const previous = seen.get(name);
        if (previous === undefined) seen.set(name, { value, json, conflict: false });
        else if (previous.json !== json && !previous.conflict) {
          previous.conflict = true;
          warnings.push(`${label} ${name} に節ごとに違う値が出たので、どちらも案に入れていません: ${previous.json} / ${json}`);
        }
      }
    }
    return Object.fromEntries([...seen.entries()].filter(([, entry]) => !entry.conflict).map(([name, entry]) => [name, entry.value]));
  };
  const merged: RawPolicyProposal = {
    categories: byId('categories', '費目'),
    claimRules: byKey('claimRules', '申請ルール'),
    preApprovalRules: byId('preApprovalRules', '事前承認の条件'),
    approvalRoutes: byId('approvalRoutes', '承認経路'),
    severityOverrides: byKey('severityOverrides', '重さ'),
    rationales: drafts.flatMap((draft) => (Array.isArray(draft.rationales) ? draft.rationales : [])),
  };
  return { merged, warnings };
}
