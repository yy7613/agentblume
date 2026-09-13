import { describe, expect, it } from 'vitest';
import { JOURNAL_CAPABILITIES_DISABLED, JournalCapabilitiesUseCase, type JournalCapabilities } from './capabilities';

describe('JournalCapabilitiesUseCase', () => {
  it('境界: 解決器を渡さなければ「どちらも使えない」（テスト・埋め込み利用の既定）', async () => {
    expect(await new JournalCapabilitiesUseCase().execute()).toEqual({
      extraction: { enabled: false, vision: false },
      hearing: { enabled: false },
    });
    expect(JOURNAL_CAPABILITIES_DISABLED).toEqual({ extraction: { enabled: false, vision: false }, hearing: { enabled: false } });
  });

  it('正常: 注入された解決器の答えをそのまま返す', async () => {
    const capabilities: JournalCapabilities = { extraction: { enabled: true, vision: true }, hearing: { enabled: false } };
    expect(await new JournalCapabilitiesUseCase(async () => capabilities).execute()).toEqual(capabilities);
  });

  it('正常: 呼ぶたびに解決器を評価する（モデル設定は実行中に変わる）', async () => {
    let vision = false;
    const usecase = new JournalCapabilitiesUseCase(async () => ({ extraction: { enabled: true, vision }, hearing: { enabled: false } }));
    expect((await usecase.execute()).extraction.vision).toBe(false);
    vision = true;
    expect((await usecase.execute()).extraction.vision).toBe(true);
  });

  it('境界: テキスト抽出だけ使える構成（vision 非対応モデル）も表現できる', async () => {
    const usecase = new JournalCapabilitiesUseCase(async () => ({ extraction: { enabled: true, vision: false }, hearing: { enabled: false } }));
    const capabilities = await usecase.execute();
    expect(capabilities.extraction.enabled).toBe(true);
    expect(capabilities.extraction.vision).toBe(false);
  });
});

describe('JournalCapabilitiesUseCase（解決器が壊れているとき）', () => {
  it('異常: 解決器が形の違う値を返しても、画面が使う 2 つの旗は必ず boolean で返る', async () => {
    const broken = { extraction: { enabled: 'yes' }, hearing: undefined } as unknown as JournalCapabilities;
    const capabilities = await new JournalCapabilitiesUseCase(async () => broken).execute();
    expect(typeof capabilities.extraction.enabled).toBe('boolean');
    expect(typeof capabilities.extraction.vision).toBe('boolean');
    expect(typeof capabilities.hearing.enabled).toBe('boolean');
  });

  it('例外: 解決器が失敗しても throw せず「どちらも使えない」を返す（機能フラグで画面を止めない）', async () => {
    const useCase = new JournalCapabilitiesUseCase(async () => { throw new Error('model settings are broken'); });
    await expect(useCase.execute()).resolves.toEqual(JOURNAL_CAPABILITIES_DISABLED);
  });
});
