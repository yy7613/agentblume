import { describe, expect, it } from 'vitest';
import { ContractExtractionUnavailableError } from './errors';
import { FakeModel } from './contract.fixtures';
import { ContractModelGate, isAbort, localDate, randomId, systemClock } from './support';

describe('localDate / systemClock / randomId', () => {
  it('正常: ローカル日付を 0 埋めの YYYY-MM-DD にする（TZ 変換をしない）', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
    const early = new Date(2026, 0, 1);
    early.setFullYear(999);
    expect(localDate(early)).toBe('0999-01-01');
  });

  it('正常: 既定の時計は今を返し、id は UUID', () => {
    const before = Date.now();
    expect(systemClock().getTime()).toBeGreaterThanOrEqual(before);
    expect(randomId()).toMatch(/^[0-9a-f-]{36}$/u);
    expect(randomId()).not.toBe(randomId());
  });
});

describe('ContractModelGate', () => {
  it('structuredAvailable: 設定済みかつ structured-output があるときだけ true（設定は非同期でもよい）', async () => {
    expect(await new ContractModelGate(new FakeModel(), () => true).structuredAvailable()).toBe(true);
    expect(await new ContractModelGate(new FakeModel(), async () => true).structuredAvailable()).toBe(true);
    expect(await new ContractModelGate(new FakeModel(), () => false).structuredAvailable()).toBe(false);
    expect(await new ContractModelGate(new FakeModel(['chat', 'vision']), () => true).structuredAvailable()).toBe(false);
  });

  it('assertStructured: 未設定と能力不足で、何が足りず設定のどこで直すかを書いた 409', async () => {
    await expect(new ContractModelGate(new FakeModel(), () => true).assertStructured('x')).resolves.toBeUndefined();
    const unset = new ContractModelGate(new FakeModel(), () => false).assertStructured('contract clause extraction');
    await expect(unset).rejects.toThrow(ContractExtractionUnavailableError);
    await expect(new ContractModelGate(new FakeModel(), () => false).assertStructured('contract clause extraction')).rejects.toThrow('contract clause extraction needs a model: set the main model slot in Settings > Models');
    await expect(new ContractModelGate(new FakeModel(['chat']), () => true).assertStructured('contract review')).rejects.toThrow('contract review needs a model with structured output');
    const error = await new ContractModelGate(new FakeModel(['chat']), () => true).assertStructured('x').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CONTRACT_EXTRACTION_UNAVAILABLE', name: 'ContractExtractionUnavailableError' });
  });

  it('assertVision: 未設定と vision なしを分けて断る（structured-output は要らない）', async () => {
    await expect(new ContractModelGate(new FakeModel(['vision']), () => true).assertVision()).resolves.toBeUndefined();
    await expect(new ContractModelGate(new FakeModel(), () => false).assertVision()).rejects.toThrow('transcribing contract pages needs a model');
    await expect(new ContractModelGate(new FakeModel(['chat', 'structured-output']), () => true).assertVision()).rejects.toThrow('Paste the text of the contract instead');
  });

  it('snapshot: 読み手が無い・undefined・失敗は undefined、取れたら provider と model だけを返す', async () => {
    expect(await new ContractModelGate(new FakeModel(), () => true).snapshot()).toBeUndefined();
    expect(await new ContractModelGate(new FakeModel(), () => true, async () => undefined).snapshot()).toBeUndefined();
    expect(await new ContractModelGate(new FakeModel(), () => true, async () => { throw new Error('settings broken'); }).snapshot()).toBeUndefined();
    const extra = { provider: 'local', model: 'gemma-12b', apiKey: 'secret' };
    expect(await new ContractModelGate(new FakeModel(), () => true, async () => extra).snapshot()).toEqual({ provider: 'local', model: 'gemma-12b' });
  });
});

describe('isAbort', () => {
  it('中断の合図（signal / AbortError / abort を含むメッセージ）だけを中断と見なす', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error('whatever'), controller.signal)).toBe(true);
    expect(isAbort(new DOMException('stop', 'AbortError'), undefined)).toBe(true);
    expect(isAbort(new Error('The operation was aborted'), new AbortController().signal)).toBe(true);
    expect(isAbort(new Error('model returned 500'), undefined)).toBe(false);
    expect(isAbort('aborted', undefined)).toBe(false);
  });
});
