/**
 * application層: 区間の入力中に運賃マスタの候補と通勤定期のヒントを引く（`POST /expense/fares/lookup`。docs/21 §20.9.4。UC8）。
 *
 * 判定と同じ純関数（`fareCandidates` / `findCommuterOverlap`）を使うので、画面のヒントとチェックの結果が食い違わない。
 * 通勤定期のヒントは `employeeId` を指定したときだけ（画面の明細フォームが申請者の従業員で引く。ツールには出さない）。
 */
import { businessDateOf } from '../../../domain/expense/business-date';
import type { FareRoute } from '../../../domain/expense/fare-table';
import { formatStations } from '../../../domain/expense/input/station';
import { fareCandidates, findCommuterOverlap } from '../../../domain/expense/input/transport';
import { ROUTE_MAX_TRIPS, validateStations, type FareType } from '../../../domain/expense/receipt-facts';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';

export interface LookupExpenseFareInput {
  readonly scope: TenantScope;
  readonly stations: readonly string[];
  readonly fareType?: FareType;
  /** 取引日（省略 = 今日。運賃と定期の有効期間の照合に使う）。 */
  readonly date?: string;
  /** 片道の回数（金額の候補の計算。省略 = 1）。 */
  readonly trips?: number;
  readonly employeeId?: string;
}

export type CommuterHint =
  | { readonly kind: 'full'; readonly passRoute: string; readonly validTo?: string }
  | { readonly kind: 'partial'; readonly passRoute: string; readonly validTo?: string; readonly overlapFrom: string; readonly overlapTo: string; readonly restRoute?: string; readonly suggestedAmount?: number };

export interface LookupExpenseFareResult {
  readonly fareType: FareType;
  readonly candidates: readonly FareRoute[];
  /** 候補の最大運賃（チェックが基準にする額）。候補が無ければ省略。 */
  readonly maxFare?: number;
  /** 運賃マスタの経路の数（0 なら「運賃マスタに登録すると照合できます」と案内する）。 */
  readonly routeCount: number;
  readonly commuterHint?: CommuterHint;
}

export class LookupExpenseFareUseCase {
  constructor(private readonly deps: Pick<ExpenseSystemDeps, 'settings' | 'employeeDirectory' | 'repositories' | 'now' | 'timeZone'>) {}

  async execute(input: LookupExpenseFareInput): Promise<LookupExpenseFareResult> {
    const stations = validateStations(input.stations, 'fare lookup: stations');
    const trips = input.trips ?? 1;
    if (!Number.isInteger(trips) || trips < 1 || trips > ROUTE_MAX_TRIPS) throw new ExpenseDomainError(`fare lookup: trips must be an integer between 1 and ${ROUTE_MAX_TRIPS}`);
    const [{ policy }, fares] = await Promise.all([loadExpensePolicy(this.deps.repositories.policies, input.scope), this.deps.settings.load(input.scope, 'fares')]);
    const fareType = input.fareType ?? policy.transport.defaultFareType;
    const date = input.date ?? businessDateOf(this.deps.now(), this.deps.timeZone);
    const table = fares.value;
    const candidates = fareCandidates({ stations, fareType, date }, table);
    const hint = input.employeeId === undefined ? undefined : await this.commuterHint(input.scope, input.employeeId, { stations, fareType, date, trips, table });
    return {
      fareType,
      candidates,
      ...(candidates.length === 0 ? {} : { maxFare: Math.max(...candidates.map((route) => route.fare)) }),
      routeCount: table.routes.length,
      ...(hint === undefined ? {} : { commuterHint: hint }),
    };
  }

  private async commuterHint(scope: TenantScope, employeeId: string, query: { readonly stations: readonly string[]; readonly fareType: FareType; readonly date: string; readonly trips: number; readonly table: Parameters<typeof fareCandidates>[1] }): Promise<CommuterHint | undefined> {
    const employee = await this.deps.employeeDirectory.findById(scope, employeeId);
    if (employee === null || !employee.enabled) return undefined;
    const overlap = findCommuterOverlap({ ...query, passes: employee.commuterPasses });
    if (overlap === undefined) return undefined;
    const base = { passRoute: formatStations(overlap.pass.stations), ...(overlap.pass.validTo === undefined ? {} : { validTo: overlap.pass.validTo }) };
    if (overlap.kind === 'full') return { kind: 'full', ...base };
    return {
      kind: 'partial', ...base, overlapFrom: overlap.overlapFrom, overlapTo: overlap.overlapTo,
      ...(overlap.restRoute === undefined ? {} : { restRoute: overlap.restRoute }),
      ...(overlap.suggestedAmount === undefined ? {} : { suggestedAmount: overlap.suggestedAmount }),
    };
  }
}
