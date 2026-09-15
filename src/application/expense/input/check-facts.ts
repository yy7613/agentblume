/**
 * application層: 判定に要る「入力と規程」の事実を集める（docs/21 §20.3.4。系統 C）。
 *
 * 集めるもの: 運賃マスタ（`deps.settings.load(scope, 'fares')`）と、申請者の通勤定期（`deps.employeeDirectory` で読む。A の型に依存しない）。
 * 区間の設定がある費目の明細が 1 件も無い申請では何も読まない（判定のたびに設定と従業員を読まない）。
 * 読取の印（UC7）は明細そのものにあるので、ここでは集めない。
 */
import type { CheckExtensionsInput } from '../../../domain/expense/check-extensions';
import type { ExpenseClaim } from '../../../domain/expense/claim';
import type { ExpensePolicy } from '../../../domain/expense/policy';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseCheckFactsProvider } from '../ports';
import type { ExpenseSystemDeps } from '../system-deps';

export class InputCheckFactsProvider implements ExpenseCheckFactsProvider {
  constructor(private readonly deps: Pick<ExpenseSystemDeps, 'settings' | 'employeeDirectory'>) {}

  async gather(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy, _today: string): Promise<Partial<CheckExtensionsInput>> {
    const routed = new Set(policy.categories.filter((category) => category.route !== undefined).map((category) => category.id));
    if (!claim.items.some((item) => item.categoryId !== undefined && routed.has(item.categoryId))) return {};
    const employeeId = claim.claimant.employeeId;
    const [fares, employee] = await Promise.all([
      this.deps.settings.load(scope, 'fares'),
      employeeId === undefined ? Promise.resolve(null) : this.deps.employeeDirectory.findById(scope, employeeId),
    ]);
    // 無効な従業員の定期は使わない（退職・異動の後の定期で差し戻さない。無効そのものは A の claimant-employee-disabled が見せる）。
    const commuterPasses = employee !== null && employee.enabled ? employee.commuterPasses : [];
    return {
      input: { fareTableSaved: fares.saved, fareRoutes: fares.value.routes, stationAliases: fares.value.stationAliases, commuterPasses },
    };
  }
}
