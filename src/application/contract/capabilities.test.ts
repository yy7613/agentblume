import { describe, expect, it, vi } from 'vitest';
import { CONTRACT_CAPABILITIES_DISABLED, ContractCapabilitiesUseCase, type ContractCapabilities } from './capabilities';

describe('ContractCapabilitiesUseCase', () => {
  it('正常: 解決器が未配線なら全部使えない', async () => {
    await expect(new ContractCapabilitiesUseCase().execute()).resolves.toEqual(CONTRACT_CAPABILITIES_DISABLED);
  });

  it('正常: 解決器の値を写す', async () => {
    const all: ContractCapabilities = { extraction: { enabled: true, vision: true }, review: { llm: true } };
    await expect(new ContractCapabilitiesUseCase(async () => all).execute()).resolves.toEqual(all);
  });

  it('境界: 抽出が使えないのに vision だけ true は false に倒す（文字起こしの後に抽出できないため）', async () => {
    const value = { extraction: { enabled: false, vision: true }, review: { llm: true } };
    await expect(new ContractCapabilitiesUseCase(async () => value).execute()).resolves.toEqual({ extraction: { enabled: false, vision: false }, review: { llm: true } });
  });

  it('境界: 欠けた値・true 以外の値は使えない側に倒す', async () => {
    await expect(new ContractCapabilitiesUseCase(async () => ({}) as never).execute()).resolves.toEqual(CONTRACT_CAPABILITIES_DISABLED);
    await expect(new ContractCapabilitiesUseCase(async () => null as never).execute()).resolves.toEqual(CONTRACT_CAPABILITIES_DISABLED);
    await expect(new ContractCapabilitiesUseCase(async () => ({ extraction: { enabled: 'yes', vision: 1 }, review: { llm: 'true' } }) as never).execute()).resolves.toEqual(CONTRACT_CAPABILITIES_DISABLED);
  });

  it('例外: 解決器が壊れていても画面を止めず、使えない側で返して握り潰したことをログに残す', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(new ContractCapabilitiesUseCase(async () => { throw new Error('settings unreadable'); }, logger).execute()).resolves.toEqual(CONTRACT_CAPABILITIES_DISABLED);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('contract capabilities could not be resolved'), expect.objectContaining({ reason: expect.stringContaining('settings unreadable') }));
    // ロガーが無くても落ちない。
    await expect(new ContractCapabilitiesUseCase(async () => { throw new Error('x'); }).execute()).resolves.toEqual(CONTRACT_CAPABILITIES_DISABLED);
  });
});
