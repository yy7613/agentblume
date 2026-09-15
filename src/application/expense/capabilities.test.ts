import { describe, expect, it, vi } from 'vitest';
import type { LoggerPort } from '../operations/logger';
import { EXPENSE_CAPABILITIES_DISABLED, ExpenseCapabilitiesUseCase, type ExpenseCapabilities } from './capabilities';

const OFF = { detailExtraction: { enabled: false }, policyHearing: { enabled: false } } as const;

describe('ExpenseCapabilitiesUseCase', () => {
  it('境界: 解決器を渡さなければ読取・追加読取・ヒアリングは使えない側（テスト・埋め込み利用の既定）', async () => {
    expect(await new ExpenseCapabilitiesUseCase().execute()).toEqual({ extraction: { enabled: false, vision: false }, ...OFF });
    expect(EXPENSE_CAPABILITIES_DISABLED).toEqual({ extraction: { enabled: false, vision: false }, ...OFF });
  });

  it('正常: 読取も画像も使える構成はそのまま返す', async () => {
    const value: ExpenseCapabilities = { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: true } };
    expect(await new ExpenseCapabilitiesUseCase(async () => value).execute()).toEqual(value);
  });

  it('正常: 実用化のキーを省略した解決器は、その機能を使えない側に倒す', async () => {
    expect(await new ExpenseCapabilitiesUseCase(async () => ({ extraction: { enabled: true, vision: true } })).execute()).toEqual({ extraction: { enabled: true, vision: true }, ...OFF });
  });

  it('正常: 呼ぶたびに解決器を評価する（モデル設定は実行中に変わる）', async () => {
    let enabled = false;
    const usecase = new ExpenseCapabilitiesUseCase(async () => ({ extraction: { enabled, vision: true } }));
    expect((await usecase.execute()).extraction.enabled).toBe(false);
    enabled = true;
    expect((await usecase.execute()).extraction).toEqual({ enabled: true, vision: true });
  });

  it('境界: vision と追加読取は読取そのものが使えるときだけ true（ヒアリングは読取に依らない）', async () => {
    const usecase = new ExpenseCapabilitiesUseCase(async () => ({ extraction: { enabled: false, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: true } }));
    expect(await usecase.execute()).toEqual({ extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: true } });
  });

  it('境界: テキストだけ読める構成（vision 非対応モデル）も表現できる', async () => {
    const usecase = new ExpenseCapabilitiesUseCase(async () => ({ extraction: { enabled: true, vision: false } }));
    expect(await usecase.execute()).toEqual({ extraction: { enabled: true, vision: false }, ...OFF });
  });

  it('異常: 解決器が形の違う値を返しても、旗は必ず boolean の false に倒す', async () => {
    for (const broken of [undefined, {}, { extraction: { enabled: 'yes', vision: 'yes' }, detailExtraction: { enabled: 'yes' }, policyHearing: { enabled: 1 } }]) {
      const usecase = new ExpenseCapabilitiesUseCase(async () => broken as unknown as ExpenseCapabilities);
      expect(await usecase.execute()).toEqual(EXPENSE_CAPABILITIES_DISABLED);
    }
  });

  it('例外: 解決器が失敗しても throw せず disabled を返し、握り潰したことをロガーに残す', async () => {
    const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const usecase = new ExpenseCapabilitiesUseCase(async () => { throw new Error('model settings are broken'); }, logger);
    await expect(usecase.execute()).resolves.toEqual(EXPENSE_CAPABILITIES_DISABLED);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('例外: ロガーが無くても解決器の失敗で落ちない', async () => {
    const usecase = new ExpenseCapabilitiesUseCase(async () => { throw new Error('boom'); });
    await expect(usecase.execute()).resolves.toEqual(EXPENSE_CAPABILITIES_DISABLED);
  });
});
