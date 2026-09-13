/**
 * application層: 自動仕訳ルールの保存・一覧・削除・テスト（docs/20 §2.3 / §9）。
 *
 * 保存時に **outcome が参照する科目 id と税区分コードが現在のマスタにあるか**を確かめる。
 * ここで弾かないと、保存は通るのに判定のたびに `unknown-account` で止まるルールが増え、
 * 利用者は「ルールを作ったのに効かない」理由を判定画面まで行かないと知れない。
 *
 * 「文書でテスト」（`TestJournalRuleUseCase`）は**保存しない**。草案をそのまま `createJournalRule` に
 * 通してから判定と同じ関数（`ruleMatches` → requiredFacts → askIf → `buildEntryFromRule`）を使うので、
 * 保存後の挙動と食い違わない。
 *
 * 入力はテナントスコープとルール本体を**入れ子**で受ける（`{ scope, rule }`）。`JournalRule` 自身が
 * `scope`（ルールの適用範囲 = 帳票種別・収支・口座）という別物のフィールドを持つため、平らにすると衝突する。
 */
import { randomUUID } from 'node:crypto';
import { findAccount, findTaxCategory, type ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { evaluateConditions, hasFact } from '../../domain/journal/conditions';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import type { UndecidedReason } from '../../domain/journal/document';
import type { JournalEntryDraft } from '../../domain/journal/entry';
import { buildEntryFromRule } from '../../domain/journal/entry-builder';
import { JournalDomainError, JournalRuleNotFoundError } from '../../domain/journal/errors';
import { ruleMatches } from '../../domain/journal/judgment';
import type { ChartOfAccountsRepository, JournalDocumentRepository, JournalRuleRepository } from '../../domain/journal/repositories';
import { createJournalRule, ruleSpecificity, type JournalRule, type JournalRuleDraft } from '../../domain/journal/rule';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 保存するルール（草案に id を足した形。id 省略で新規）。 */
export type SaveJournalRuleDraft = JournalRuleDraft & { readonly id?: string };

export interface SaveJournalRuleInput {
  readonly scope: TenantScope;
  readonly rule: SaveJournalRuleDraft;
}

/** ルールの outcome が参照する科目 / 税区分がマスタにあり、かつ有効か。 */
function assertOutcomeReferences(rule: JournalRule, chart: ChartOfAccounts): void {
  for (const [index, line] of rule.outcome.lines.entries()) {
    const label = `journal rule: outcome.lines[${index}]`;
    const account = findAccount(chart, line.accountId);
    if (account === undefined) throw new JournalDomainError(`${label}.accountId refers to an account that is not in the chart of accounts: ${line.accountId}`);
    if (!account.enabled) throw new JournalDomainError(`${label}.accountId refers to a disabled account: ${line.accountId} (${account.name})`);
    const taxCategory = findTaxCategory(chart, line.taxCode);
    if (taxCategory === undefined) throw new JournalDomainError(`${label}.taxCode refers to a tax category that is not in the chart of accounts: ${line.taxCode}`);
    if (!taxCategory.enabled) throw new JournalDomainError(`${label}.taxCode refers to a disabled tax category: ${line.taxCode} (${taxCategory.name})`);
  }
}

/** 草案 → 検証済みルール（`createJournalRule` の引数組み立てを保存とテストで共有する）。 */
function buildRule(scope: TenantScope, draft: SaveJournalRuleDraft, createdAt: string, updatedAt: string, makeId?: () => string): JournalRule {
  return createJournalRule({
    tenant: scope,
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name,
    enabled: draft.enabled,
    mode: draft.mode,
    priority: draft.priority,
    scope: draft.scope,
    conditions: draft.conditions,
    outcome: draft.outcome,
    askIf: draft.askIf,
    requiredFacts: draft.requiredFacts,
    ...(draft.provenance === undefined ? {} : { provenance: draft.provenance }),
    createdAt,
    updatedAt,
  }, makeId);
}

export class SaveJournalRuleUseCase {
  constructor(
    private readonly rules: JournalRuleRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveJournalRuleInput): Promise<JournalRule> {
    const at = this.now().toISOString();
    const existing = input.rule.id === undefined ? null : await this.rules.findById(input.scope, input.rule.id);
    // 更新は作成時刻を保つ（競合解決が createdAt 昇順なので、編集で優先順が入れ替わってはならない）。
    const rule = buildRule(input.scope, input.rule, existing?.createdAt ?? at, at, this.makeId);
    const chart = (await this.charts.get(input.scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    assertOutcomeReferences(rule, chart);
    await this.rules.save(rule);
    return rule;
  }
}

export class ListJournalRulesUseCase {
  constructor(private readonly rules: JournalRuleRepository) {}

  /** priority 降順 → createdAt 昇順 → id 昇順（判定の優先順と同じ並び）。 */
  async execute(scope: TenantScope): Promise<readonly JournalRule[]> {
    return this.rules.list(scope);
  }
}

export class DeleteJournalRuleUseCase {
  constructor(private readonly rules: JournalRuleRepository) {}

  async execute(scope: TenantScope, id: string): Promise<void> {
    const deleted = await this.rules.delete(scope, id);
    if (!deleted) throw new JournalRuleNotFoundError(`journal rule not found: ${id}`);
  }
}

export interface JournalRuleTestResult {
  readonly documentId: string;
  readonly matched: boolean;
  readonly specificity?: number;
  readonly entry?: JournalEntryDraft;
  readonly reasons?: readonly UndecidedReason[];
}

export interface TestJournalRuleInput {
  readonly scope: TenantScope;
  readonly rule: SaveJournalRuleDraft;
  readonly documentIds: readonly string[];
}

/**
 * 草案ルールを保存せずに文書群へ照合する。
 * 見つからない文書は結果に現れない（`findByIds` は見つかったものだけを ids の順で返す）。
 */
export class TestJournalRuleUseCase {
  constructor(
    private readonly documents: JournalDocumentRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: TestJournalRuleInput): Promise<readonly JournalRuleTestResult[]> {
    const at = this.now().toISOString();
    // 未保存の草案には id が無い。判定理由に載る id なので、分かる印として 'draft' を使う。
    const rule = buildRule(input.scope, { ...input.rule, id: input.rule.id ?? 'draft' }, at, at);
    const chart = (await this.charts.get(input.scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const documents = await this.documents.findByIds(input.scope, input.documentIds);
    const specificity = ruleSpecificity(rule);
    const today = at.slice(0, 10);

    return documents.map((document) => {
      if (!ruleMatches(rule, document)) return { documentId: document.id, matched: false };
      const missing = rule.requiredFacts.filter((path) => !hasFact(document.facts, path));
      if (missing.length > 0) return { documentId: document.id, matched: true, specificity, reasons: [{ code: 'missing-fact' as const, ruleId: rule.id, facts: missing }] };
      const ask = rule.askIf.find((entry) => evaluateConditions(document.facts, entry.conditions));
      if (ask !== undefined) return { documentId: document.id, matched: true, specificity, reasons: [{ code: 'ask-if' as const, ruleId: rule.id, questionId: ask.questionId, prompt: ask.prompt }] };
      const built = buildEntryFromRule({ rule, facts: document.facts, chart, today });
      return built.ok
        ? { documentId: document.id, matched: true, specificity, entry: built.entry }
        : { documentId: document.id, matched: true, specificity, reasons: [built.reason] };
    });
  }
}