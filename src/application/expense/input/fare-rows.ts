/**
 * application層: 運賃マスタを「Agent が読む表」へ畳む（`expense_fares`。docs/21 §20.11.4）。1 行 = 1 経路。
 *
 * 未保存なら 0 行（`saved` 列は行が無いと出ないが、ツールの説明で「0 件は未登録」と伝える）。通勤定期は出さない。
 */
import type { Row } from '../../../domain/data/types';
import type { ExpenseFareTable } from '../../../domain/expense/fare-table';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSettingsStore } from '../settings-store';

export function expenseFareRows(table: ExpenseFareTable, saved: boolean): readonly Row[] {
  if (!saved) return [];
  return table.routes.map((route) => ({
    route_id: route.id,
    stations: route.stations.join(' > '),
    from: route.stations[0] ?? '',
    to: route.stations[route.stations.length - 1] ?? '',
    fare_type: route.fareType,
    fare: route.fare,
    bidirectional: route.bidirectional,
    valid_from: route.validFrom ?? null,
    valid_to: route.validTo ?? null,
    note: route.note ?? null,
    saved,
    updated_at: table.updatedAt,
  }));
}

export class ExpenseFareRowsProvider {
  constructor(private readonly settings: Pick<ExpenseSettingsStore, 'load'>) {}

  async rows(scope: TenantScope): Promise<readonly Row[]> {
    const { value, saved } = await this.settings.load(scope, 'fares');
    return expenseFareRows(value, saved);
  }
}
