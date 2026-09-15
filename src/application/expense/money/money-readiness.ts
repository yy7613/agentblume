/**
 * application層: 「実用機能の準備」カード（docs/21 §20.10.1）のうち、お金の流れの状況（カード・カード明細の取込・振込元）。
 *
 * 未設定は失敗ではない（「使うときに設定」）ので、真偽と件数だけを返し、赤くするかどうかは画面が決めない。
 * 画面の `readinessRows(policy, known)` の `known.cards` / `known.payout` に渡す値。
 */
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';

export interface ExpenseMoneyReadiness {
  /** 有効な法人カードが 1 枚以上ある（照合が動く）。 */
  readonly cards: boolean;
  readonly cardCount: number;
  /** カード明細の取込の件数と最後の取込。 */
  readonly cardImportCount: number;
  readonly lastCardImportAt?: string;
  /** カードごとの取込範囲（「どの月まで取り込んだか」）。 */
  readonly cardCoverage: readonly { readonly cardId: string; readonly from: string; readonly to: string }[];
  /** 振込元の口座が設定されている（UC3 の振込データを作れる前提）。 */
  readonly payout: boolean;
}

export class GetExpenseMoneyReadinessUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope): Promise<ExpenseMoneyReadiness> {
    const [cards, payout, imports, coverage] = await Promise.all([
      this.deps.settings.load(scope, 'cards'),
      this.deps.settings.load(scope, 'payout'),
      this.deps.repositories.cards.listImports(scope, { limit: 1000 }),
      this.deps.repositories.cards.coverage(scope),
    ]);
    const enabled = cards.value.cards.filter((card) => card.enabled).length;
    return {
      cards: enabled > 0,
      cardCount: enabled,
      cardImportCount: imports.length,
      ...(imports[0] === undefined ? {} : { lastCardImportAt: imports[0].createdAt }),
      cardCoverage: coverage,
      // 振込データを作るには口座・依頼人コード・依頼人名の 3 つが要る（`payout-source-missing` と同じ条件）。
      payout: payout.saved && payout.value.source !== undefined && payout.value.requesterCode !== undefined && payout.value.requesterNameKana !== undefined,
    };
  }
}
