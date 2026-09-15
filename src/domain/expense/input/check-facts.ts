/**
 * ドメイン: 判定に渡す「入力と規程」の事実の型（docs/21 §20.3.1 / §20.3.4。系統 C）。
 *
 * 循環依存を避けるための葉。`check-extensions.ts` がこの型だけを import する（`check-input.ts` は import しない）。
 * 集めるのは application の `InputCheckFactsProvider`（運賃マスタは設定から、申請者の通勤定期は `EmployeeDirectoryPort` で読む）。
 *
 * 交通費の照合は「運賃マスタに経路がある」か「申請者に通勤定期がある」ときだけ動く（`transportInUse`）。
 * 初期テンプレートの「電車・バス」は区間が必須の設定なので、運賃も定期も設定していない会社で `route-missing` を出すと
 * MVP と判定が変わってしまう（§20.2.13「設定しない限り MVP と同じ動き」）。
 */
import type { CommuterPass } from '../employee';
import type { FareRoute, StationAlias } from '../fare-table';

export interface InputCheckFacts {
  /** 運賃マスタが保存済みか。 */
  readonly fareTableSaved?: boolean;
  /** 運賃マスタの経路（未保存なら空）。 */
  readonly fareRoutes?: readonly FareRoute[];
  readonly stationAliases?: readonly StationAlias[];
  /** 申請者の通勤定期（従業員マスタに紐付いた有効な従業員のもの。紐付いていなければ空）。 */
  readonly commuterPasses?: readonly CommuterPass[];
}

/** 交通費の照合を使っている構成か（運賃マスタに経路がある、または申請者に通勤定期がある）。 */
export function transportInUse(facts: InputCheckFacts | undefined): boolean {
  if (facts === undefined) return false;
  return (facts.fareRoutes?.length ?? 0) > 0 || (facts.commuterPasses?.length ?? 0) > 0;
}
