/**
 * ドメイン: 規程の案と現在の規程の差分、選んだ変更の適用（docs/21 §20.7.2。UC9。純関数）。
 *
 * - 差分は項目ごと（費目は欄ごと）に並べ、利用者が選んだ変更だけを現在の規程へ当てる（既定では何も選ばない）。
 * - 削除は出さず無効化（`enabled: false`）にする（申請や判定から参照される費目・条件を消さない）。
 * - 並びは費目 → 申請ルール → 事前承認 → 承認経路 → 重さ。id は差分を作り直しても変わらない（`category:<id>:<欄>`）。
 * - 選んだ変更の組み合わせが規程として通るかは、保存時に `createExpensePolicy`（`SaveExpensePolicyUseCase`）が検証する。
 */
import type { ApprovalRoute, ApprovalSettings } from '../approval';
import { ExpenseDomainError } from '../errors';
import type { ClaimRules, CreateExpensePolicyProps, ExpenseCategory, ExpensePolicy, PreApprovalRule } from '../policy';
import type { PolicyProposal, ProposedPolicyPatch } from '../policy-hearing';
import type { SeverityOverride } from '../reason-codes';
import { relatedPaths, stableJson } from './policy-proposal';

export const POLICY_CHANGE_KINDS = ['add', 'update', 'disable'] as const;
export type PolicyChangeKind = (typeof POLICY_CHANGE_KINDS)[number];
export type PolicyChangeSection = 'category' | 'claim-rule' | 'pre-approval' | 'approval-route' | 'severity';

export interface PolicyChange {
  /** 例: `category:meal.entertainment:limits.perPerson` / `claim-rule:submissionDeadlineDays` / `severity:payee-missing`。 */
  readonly id: string;
  readonly kind: PolicyChangeKind;
  readonly section: PolicyChangeSection;
  /** 費目・条件・経路の id、申請ルールのキー、重さのコード。 */
  readonly key: string;
  /** 費目の欄（`limits.perPerson` など）。費目の追加・条件・経路・申請ルール・重さでは省略。 */
  readonly field?: string;
  /** 根拠と照らすパス（`categories.<id>.<欄>` など）。 */
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly rationale?: { readonly path: string; readonly quote?: string; readonly quoteFound: boolean; readonly note?: string };
}

/** 費目で差分を取る欄（欄ごとに選べるようにする）。 */
export const CATEGORY_DIFF_FIELDS = [
  'name', 'enabled', 'aliases', 'accountId', 'defaultTaxRate', 'taxCodeByRate', 'receipt', 'invoice', 'requires',
  'limits.perItem', 'limits.perClaim', 'limits.perPerson', 'limits.perPersonBasis', 'limits.perUnit', 'note', 'route',
] as const;

function getField(category: ExpenseCategory, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), category);
}

function setField(category: ExpenseCategory, field: string, value: unknown): ExpenseCategory {
  const [head, tail] = field.split('.') as [string, string | undefined];
  const next = { ...category } as Record<string, unknown>;
  if (tail === undefined) {
    if (value === null || value === undefined) delete next[head];
    else next[head] = value;
    return next as unknown as ExpenseCategory;
  }
  const inner = { ...(next[head] as Record<string, unknown> | undefined) };
  if (value === null || value === undefined) delete inner[tail];
  else inner[tail] = value;
  next[head] = inner;
  return next as unknown as ExpenseCategory;
}

const same = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);
const orNull = (value: unknown): unknown => (value === undefined ? null : value);

function rationaleFor(path: string, rationales: PolicyProposal['rationales']): PolicyChange['rationale'] {
  const related = rationales.filter((rationale) => relatedPaths(rationale.path, path));
  return related.find((rationale) => rationale.quoteFound) ?? related[0];
}

export function diffExpensePolicy(current: ExpensePolicy, candidate: ProposedPolicyPatch, rationales: PolicyProposal['rationales'] = []): readonly PolicyChange[] {
  const changes: PolicyChange[] = [];
  const push = (change: Omit<PolicyChange, 'rationale'>): void => {
    const rationale = rationaleFor(change.path, rationales);
    changes.push({ ...change, ...(rationale === undefined ? {} : { rationale }) });
  };

  for (const proposed of candidate.categories ?? []) {
    const existing = current.categories.find((category) => category.id === proposed.id);
    if (existing === undefined) {
      push({ id: `category:${proposed.id}`, kind: 'add', section: 'category', key: proposed.id, path: `categories.${proposed.id}`, before: null, after: proposed });
      continue;
    }
    for (const field of CATEGORY_DIFF_FIELDS) {
      const before = getField(existing, field);
      const after = getField(proposed, field);
      if (same(before, after)) continue;
      const kind: PolicyChangeKind = field === 'enabled' && after === false ? 'disable' : 'update';
      push({ id: `category:${proposed.id}:${field}`, kind, section: 'category', key: proposed.id, field, path: `categories.${proposed.id}.${field}`, before: orNull(before), after: orNull(after) });
    }
  }

  for (const [key, after] of Object.entries(candidate.claimRules ?? {})) {
    const before = current.claimRules[key as keyof ClaimRules];
    if (!same(before, after)) push({ id: `claim-rule:${key}`, kind: 'update', section: 'claim-rule', key, path: `claimRules.${key}`, before: orNull(before), after: orNull(after) });
  }

  const listChanges = <T extends { readonly id: string; readonly enabled: boolean }>(section: 'pre-approval' | 'approval-route', pathPrefix: string, currentList: readonly T[], proposedList: readonly T[]): void => {
    for (const proposed of proposedList) {
      const existing = currentList.find((entry) => entry.id === proposed.id);
      const path = `${pathPrefix}.${proposed.id}`;
      if (existing === undefined) push({ id: `${section}:${proposed.id}`, kind: 'add', section, key: proposed.id, path, before: null, after: proposed });
      else if (!same(existing, proposed)) {
        const disableOnly = existing.enabled && !proposed.enabled && same({ ...existing, enabled: false }, proposed);
        push({ id: `${section}:${proposed.id}`, kind: disableOnly ? 'disable' : 'update', section, key: proposed.id, path, before: existing, after: proposed });
      }
    }
  };
  listChanges<PreApprovalRule>('pre-approval', 'preApprovalRules', current.preApprovalRules, candidate.preApprovalRules ?? []);
  listChanges<ApprovalRoute>('approval-route', 'approval.routes', current.approval.routes, candidate.approvalRoutes ?? []);

  for (const [code, after] of Object.entries(candidate.severityOverrides ?? {})) {
    const before = current.severityOverrides[code as keyof ExpensePolicy['severityOverrides']];
    if (before === after) continue;
    push({ id: `severity:${code}`, kind: before === undefined ? 'add' : 'update', section: 'severity', key: code, path: `severityOverrides.${code}`, before: orNull(before), after });
  }
  return changes;
}

/** 保存の入力（`SaveExpensePolicyUseCase` へそのまま渡せる形。実用化の節は現在の値を明示して送る）。 */
export type AppliedPolicyInput = Pick<ExpensePolicy, 'categories' | 'claimRules' | 'preApprovalRules' | 'journal' | 'approval' | 'transport' | 'card' | 'advance'> & {
  readonly severityOverrides: Readonly<Record<string, SeverityOverride>>;
};

/** 選んだ変更だけを現在の規程へ当てる。未知の変更 id は 400（画面が古い差分を送った）。 */
export function applyPolicyChanges(current: ExpensePolicy, changes: readonly PolicyChange[], selectedIds: readonly string[]): AppliedPolicyInput {
  const selected = new Set(selectedIds);
  const unknown = [...selected].filter((id) => !changes.some((change) => change.id === id));
  if (unknown.length > 0) throw new ExpenseDomainError(`policy hearing: unknown change ids: ${unknown.join(', ')}; recreate the diff and choose the changes again`);
  let categories = [...current.categories];
  let claimRules: ClaimRules = current.claimRules;
  let preApprovalRules = [...current.preApprovalRules];
  let routes = [...current.approval.routes];
  const severityOverrides: Record<string, SeverityOverride> = { ...current.severityOverrides };
  const upsert = <T extends { readonly id: string }>(list: readonly T[], item: T): T[] => (list.some((entry) => entry.id === item.id) ? list.map((entry) => (entry.id === item.id ? item : entry)) : [...list, item]);

  for (const change of changes) {
    if (!selected.has(change.id)) continue;
    switch (change.section) {
      case 'category':
        if (change.field === undefined) {
          const added = change.after as ExpenseCategory;
          const sortOrder = categories.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 1;
          categories = upsert(categories, { ...added, sortOrder: categories.some((category) => category.sortOrder === added.sortOrder) ? sortOrder : added.sortOrder });
        } else {
          const field = change.field;
          categories = categories.map((category) => (category.id === change.key ? setField(category, field, change.after) : category));
        }
        break;
      case 'claim-rule':
        claimRules = { ...claimRules, [change.key]: change.after } as ClaimRules;
        break;
      case 'pre-approval':
        preApprovalRules = upsert(preApprovalRules, change.after as PreApprovalRule);
        break;
      case 'approval-route':
        routes = upsert(routes, change.after as ApprovalRoute);
        break;
      case 'severity':
        severityOverrides[change.key] = change.after as SeverityOverride;
        break;
    }
  }
  return {
    categories,
    claimRules,
    preApprovalRules,
    severityOverrides,
    journal: current.journal,
    approval: { ...current.approval, routes },
    transport: current.transport,
    card: current.card,
    advance: current.advance,
  };
}
