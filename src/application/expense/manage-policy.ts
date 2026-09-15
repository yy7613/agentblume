/**
 * application層: 経費の規程の取得・保存・初期化（docs/21 §5.4）。
 *
 * ## 保存したことが無いワークスペースは「初期テンプレートを返すが保存はしない」
 *
 * 仕訳の科目マスタ（ADR-0038 §2）と同じ理由: 参照が書き込みを起こすと、読み取り権限しか無い利用者が落ち、
 * 初期テンプレートを後から改善しても一度でも画面を開いたワークスペースに古い値が焼き付く。
 * 代わりに判定が `policy-unreviewed`（要確認）を出し、最初に規程を見直す導線にする。
 */
import { DEFAULT_EXPENSE_POLICY_UPDATED_AT, defaultExpensePolicy } from '../../domain/expense/default-policy';
import { createExpensePolicy, type ClaimRules, type ExpenseCategory, type ExpensePolicy, type JournalLinkSettings, type PreApprovalRule } from '../../domain/expense/policy';
import type { SeverityOverride } from '../../domain/expense/reason-codes';
import type { ExpensePolicyRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export interface ExpensePolicyResult {
  readonly policy: ExpensePolicy;
  /** 利用者が保存したものか（未保存 = 初期テンプレートのまま）。 */
  readonly saved: boolean;
}

/** 保存済みの規程、無ければ初期テンプレート（保存はしない）。判定・ツール・出力が共通で使う。 */
export async function loadExpensePolicy(policies: ExpensePolicyRepository, scope: TenantScope): Promise<ExpensePolicyResult> {
  const stored = await policies.get(scope);
  return stored === null ? { policy: defaultExpensePolicy(DEFAULT_EXPENSE_POLICY_UPDATED_AT), saved: false } : { policy: stored, saved: true };
}

export class GetExpensePolicyUseCase {
  constructor(private readonly policies: ExpensePolicyRepository) {}

  async execute(scope: TenantScope): Promise<ExpensePolicyResult> {
    return loadExpensePolicy(this.policies, scope);
  }
}

export interface SaveExpensePolicyInput {
  readonly scope: TenantScope;
  readonly categories: readonly ExpenseCategory[];
  readonly claimRules: ClaimRules;
  readonly preApprovalRules: readonly PreApprovalRule[];
  readonly severityOverrides: Readonly<Partial<Record<string, SeverityOverride>>>;
  readonly journal: JournalLinkSettings;
  /** 実用化の節（docs/21 §20.2.2）。省略した節は現在の規程の値を保つ。 */
  readonly approval?: unknown;
  readonly transport?: ExpensePolicy['transport'];
  readonly card?: ExpensePolicy['card'];
  readonly advance?: ExpensePolicy['advance'];
}

/**
 * 規程全体を置き換える（画面は編集後の全体を送る）。
 *
 * ただし実用化の節（承認経路・交通費・カード・仮払・費目の `route`・部門の補助軸）は、本文に**キーが無ければ現在の規程の値を保つ**。
 * それぞれの節は系統ごとの画面の部品が持ち、MVP の画面や古いクライアントが節を知らずに保存すると、他の担当が入れた設定を黙って消すため。
 * 消したいときは空の値（`route: null`・`departmentDimensionId: ''`・`approval: { routes: [] }`）を明示して送る。
 */
export class SaveExpensePolicyUseCase {
  constructor(
    private readonly policies: ExpensePolicyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveExpensePolicyInput): Promise<ExpensePolicy> {
    const { policy: current } = await loadExpensePolicy(this.policies, input.scope);
    const currentRoutes = new Map(current.categories.map((category) => [category.id, category.route]));
    const policy = createExpensePolicy({
      categories: input.categories.map((category) => (Object.prototype.hasOwnProperty.call(category, 'route') || currentRoutes.get(category.id) === undefined
        ? category
        : { ...category, route: currentRoutes.get(category.id) })),
      claimRules: input.claimRules,
      preApprovalRules: input.preApprovalRules,
      severityOverrides: input.severityOverrides,
      journal: Object.prototype.hasOwnProperty.call(input.journal, 'departmentDimensionId') || current.journal.departmentDimensionId === undefined
        ? input.journal
        : { ...input.journal, departmentDimensionId: current.journal.departmentDimensionId },
      approval: input.approval ?? current.approval,
      transport: input.transport ?? current.transport,
      card: input.card ?? current.card,
      advance: input.advance ?? current.advance,
      updatedAt: this.now().toISOString(),
    });
    await this.policies.save(input.scope, policy);
    return policy;
  }
}

/** 初期テンプレートへ戻す（保存する。保存したことになるので `policy-unreviewed` は消える）。 */
export class ResetExpensePolicyUseCase {
  constructor(
    private readonly policies: ExpensePolicyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope): Promise<ExpensePolicy> {
    const policy = defaultExpensePolicy(this.now().toISOString());
    await this.policies.save(scope, policy);
    return policy;
  }
}
