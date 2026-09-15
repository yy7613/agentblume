import { describe, expect, it } from 'vitest';
import { moneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { scope } from '../../../adapters/storage/expense-repository.fixtures';
import { cardImportFixture, cardTransactionFixture, fixtureCardSettings, fixturePayoutSettings } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { ExpenseCardSettingsUseCase } from './card-settings';
import { GetExpenseMoneyReadinessUseCase } from './money-readiness';

describe('ExpenseCardSettingsUseCase', () => {
  it('正常: 未保存なら空の設定を saved=false で返し（保存しない）、保存すると更新日時を付けて saved=true', async () => {
    const ctx = moneyTestContext();
    const settings = new ExpenseCardSettingsUseCase(ctx.deps);
    expect(await settings.get(scope)).toEqual({ settings: { cards: [], profiles: [], updatedAt: '2026-09-15T00:00:00.000Z' }, saved: false });
    expect(await ctx.settings.get(scope, 'cards')).toBeNull();
    const { cards, profiles } = fixtureCardSettings();
    const saved = await settings.save(scope, { cards, profiles });
    expect(saved.updatedAt).toBe('2026-09-20T03:00:00.000Z');
    expect(await settings.get(scope)).toEqual({ settings: saved, saved: true });
  });

  it('異常: カード id の重複・下 4 桁の形の違いは保存しない', async () => {
    const settings = new ExpenseCardSettingsUseCase(moneyTestContext().deps);
    const card = { id: 'card-a', label: 'A', last4: '1111', enabled: true };
    await expect(settings.save(scope, { cards: [card, card], profiles: [] })).rejects.toThrow(ExpenseDomainError);
    await expect(settings.save(scope, { cards: [{ ...card, last4: '12345' }], profiles: [] })).rejects.toThrow(ExpenseDomainError);
  });
});

describe('GetExpenseMoneyReadinessUseCase', () => {
  it('正常: 何も設定していなければすべて未設定（失敗ではない）', async () => {
    expect(await new GetExpenseMoneyReadinessUseCase(moneyTestContext().deps).execute(scope)).toEqual({ cards: false, cardCount: 0, cardImportCount: 0, cardCoverage: [], payout: false });
  });

  it('正常: 有効なカード・取込の件数と最後の取込・取込範囲・振込元の設定を返す', async () => {
    const ctx = moneyTestContext();
    const { cards, profiles } = fixtureCardSettings();
    await ctx.settings.save(scope, 'cards', { cards: [...cards, { id: 'card-off', label: '旧', last4: '9999', enabled: false }], profiles, updatedAt: '2026-09-15T00:00:00.000Z' });
    await ctx.settings.save(scope, 'payout', fixturePayoutSettings());
    await ctx.cards.saveImport(cardImportFixture('import-1'), [cardTransactionFixture('tx-1')]);
    expect(await new GetExpenseMoneyReadinessUseCase(ctx.deps).execute(scope)).toEqual({
      cards: true, cardCount: 2, cardImportCount: 1, lastCardImportAt: '2026-09-15T00:00:00.000Z', cardCoverage: [{ cardId: 'card-sales', from: '2026-09-01', to: '2026-09-30' }], payout: true,
    });
  });
});
