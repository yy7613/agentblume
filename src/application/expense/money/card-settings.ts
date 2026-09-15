/**
 * application層: 法人カードと明細 CSV の列マッピングの設定（docs/21 §20.2.8。`expense_settings` の kind `cards`）。
 *
 * 未保存なら空の設定を返すが保存しない（`saved: false`）。カードの下 4 桁より多い番号は持たない。
 */
import type { CardStatementProfile, ExpenseCard, ExpenseCardSettings } from '../../../domain/expense/card';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';

export class ExpenseCardSettingsUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async get(scope: TenantScope): Promise<{ readonly settings: ExpenseCardSettings; readonly saved: boolean }> {
    const { value, saved } = await this.deps.settings.load(scope, 'cards');
    return { settings: value, saved };
  }

  async save(scope: TenantScope, input: { readonly cards: readonly ExpenseCard[]; readonly profiles: readonly CardStatementProfile[] }): Promise<ExpenseCardSettings> {
    return this.deps.settings.save(scope, 'cards', { cards: input.cards, profiles: input.profiles, updatedAt: this.deps.now().toISOString() });
  }
}
