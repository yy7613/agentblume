/**
 * ドメイン: 判定に渡す「お金の流れ」の事実の型（docs/21 §20.3.1 / §20.3.3 / §20.3.5。系統 B）。
 *
 * 循環依存を避けるための葉。`check-extensions.ts` がこの型だけを import する（`check-money.ts` は import しない）。
 * 事実は application の `MoneyCheckFactsProvider` が索引から集める（判定に I/O を入れない）。
 */

/** 紐付く仮払の要約（`claim.advanceId` の仮払）。 */
export interface MoneyAdvanceFact {
  readonly id: string;
  readonly employeeId: string;
  /** 申請時点の従業員名の写し（文言 `{advanceEmployee}`）。 */
  readonly employeeName: string;
  /** `AdvanceStatus` の値（文言 `{advanceStatus}` は状態のコードのまま渡す）。 */
  readonly status: string;
  /** 精算した日（`settled` / `settling` の日付）。 */
  readonly settledOn?: string;
  /** 精算に含めた申請 id（この申請が含まれていれば「精算済み」とは言わない）。 */
  readonly settledClaimIds: readonly string[];
}

/** 照合に使うカード（設定の写し。無効なカードも保有者の判定には使う）。 */
export interface MoneyCardFact {
  readonly id: string;
  readonly label: string;
  readonly last4: string;
  readonly holderEmployeeId?: string;
}

/** 照合の候補のカード利用（未照合、またはこの申請に照合済み。対象外は入れない）。 */
export interface MoneyCardTransactionFact {
  readonly id: string;
  readonly cardId: string;
  readonly usedOn: string;
  readonly merchantRaw: string;
  readonly merchantKey: string;
  readonly amount: number;
  /** この申請への手動の紐付け（照合の割り当てより先に確定させる）。 */
  readonly manualItemId?: string;
}

export interface MoneyCardFacts {
  readonly cards: readonly MoneyCardFact[];
  readonly transactions: readonly MoneyCardTransactionFact[];
  /** カードごとの取込範囲（`periodFrom`〜`periodTo` の和集合）。 */
  readonly coverage: readonly { readonly cardId: string; readonly from: string; readonly to: string }[];
}

export interface MoneyCheckFacts {
  readonly advance?: MoneyAdvanceFact;
  /** カードが 1 枚も登録されていなければ undefined（MVP と同じく照合しない）。 */
  readonly card?: MoneyCardFacts;
}
