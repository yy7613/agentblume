/**
 * 設定・取引先・明細 CSV プロファイル・機能フラグのユースケース。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryBankCsvProfileRepository, InMemoryCustomerRepository, InMemoryInvoiceRepository, InMemoryReceivablesSettingsRepository,
} from '../../adapters/storage/in-memory-receivables-repositories';
import { BankCsvProfileNotFoundError, CustomerNotFoundError, ReceivablesDomainError } from '../../domain/receivables/errors';
import { createInvoice } from '../../domain/receivables/invoice';
import { RECEIVABLES_CAPABILITIES_DISABLED, ReceivablesCapabilitiesUseCase } from './capabilities';
import { DeleteBankCsvProfileUseCase, ListBankCsvProfilesUseCase, SaveBankCsvProfileUseCase } from './manage-bank-csv-profiles';
import { DeleteCustomerUseCase, GetCustomerUseCase, ListCustomersUseCase, SaveCustomerUseCase } from './manage-customers';
import { GetReceivablesSettingsUseCase, SaveReceivablesSettingsUseCase } from './manage-settings';
import { localIsoDate } from './ports';
import { AT, invoiceContent, issuerSettings, NOW, scope, sequentialIds } from './receivables-usecases.fixtures';

describe('設定', () => {
  it('正常: 未保存なら初期値を saved=false で返し（保存しない）、保存後は saved=true', async () => {
    const repo = new InMemoryReceivablesSettingsRepository();
    const get = new GetReceivablesSettingsUseCase(repo);
    expect(await get.execute(scope)).toMatchObject({ saved: false, settings: { matching: { maxCombinationSize: 3 } } });
    expect(await repo.get(scope)).toBeNull();
    const { updatedAt: _updatedAt, ...settings } = issuerSettings();
    const saved = await new SaveReceivablesSettingsUseCase(repo, () => NOW).execute({ scope, settings });
    expect(saved.updatedAt).toBe(AT);
    expect(await get.execute(scope)).toMatchObject({ saved: true, settings: { issuer: { name: '株式会社サンプルソフト' } } });
    await expect(new SaveReceivablesSettingsUseCase(repo).execute({ scope, settings: { ...settings, matching: { ...settings.matching, maxCombinationSize: 9 } } })).rejects.toThrow(ReceivablesDomainError);
  });
});

describe('取引先', () => {
  it('正常: 作成・更新で別名の出所を引き継ぎ、別の取引先と重なる正規化名は warnings に出す', async () => {
    const customers = new InMemoryCustomerRepository();
    const save = new SaveCustomerUseCase(customers, sequentialIds('c'), () => NOW);
    const first = await save.execute({ scope, name: 'サンプル商事', kana: 'サンプルシヨウジ' });
    expect(first).toMatchObject({ customer: { id: 'c-1', createdAt: AT }, warnings: [] });
    const second = await save.execute({ scope, name: '別会社', payerAliases: [{ text: 'ｻﾝﾌﾟﾙｼﾖｳｼﾞ' }] });
    expect(second.warnings).toEqual([{ normalized: 'サンプルシヨウジ', otherCustomerId: 'c-1', otherCustomerName: 'サンプル商事' }]);
    // 学習済みの別名は id を送れば出所を保ったまま文字列だけ変わる。
    const learned = { ...second.customer, payerAliases: [{ ...second.customer.payerAliases[0]!, origin: 'learned' as const, matchingId: 'm1' }] };
    await customers.save(learned);
    const updated = await save.execute({ scope, id: learned.id, name: '別会社', payerAliases: [{ id: learned.payerAliases[0]!.id, text: 'ﾍﾞﾂｶﾞｲｼﾔ' }, { text: '新しい名義' }] });
    expect(updated.customer.payerAliases.map((alias) => [alias.origin, alias.matchingId, alias.normalized])).toEqual([['learned', 'm1', 'ベツガイシヤ'], ['manual', undefined, '新シイ名義']]);
    expect(updated.customer.createdAt).toBe(AT);
    await expect(save.execute({ scope, id: 'missing', name: 'x' })).rejects.toBeInstanceOf(CustomerNotFoundError);
    expect(await new GetCustomerUseCase(customers).execute(scope, 'c-1')).toMatchObject({ name: 'サンプル商事' });
    await expect(new GetCustomerUseCase(customers).execute(scope, 'missing')).rejects.toBeInstanceOf(CustomerNotFoundError);
  });

  it('正常 / 異常: 一覧は未入金額を付ける。請求書から参照されている取引先は削除できず無効化を案内する', async () => {
    const customers = new InMemoryCustomerRepository();
    const invoices = new InMemoryInvoiceRepository();
    const save = new SaveCustomerUseCase(customers, sequentialIds('c'), () => NOW);
    const { customer: used } = await save.execute({ scope, name: 'A 商事' });
    const { customer: unused } = await save.execute({ scope, name: 'B 商事', enabled: false });
    await invoices.save(createInvoice({ tenant: scope, id: 'i', ...invoiceContent({ customerId: used.id }), status: 'issued', number: 'N-1', roundingMode: 'floor', snapshot: { issuer: issuerSettings().issuer, customer: { name: 'A', honorific: '御中' }, roundingMode: 'floor', issuedAt: AT }, createdAt: AT, updatedAt: AT }));
    await invoices.save(createInvoice({ tenant: scope, id: 'd', ...invoiceContent({ customerId: undefined }), roundingMode: 'floor', createdAt: AT, updatedAt: AT }));
    const list = new ListCustomersUseCase(customers, invoices);
    expect((await list.execute(scope)).map((item) => [item.customer.name, item.outstanding])).toEqual([['A 商事', 110_000], ['B 商事', 0]]);
    expect((await list.execute(scope, { enabled: false })).map((item) => item.customer.name)).toEqual(['B 商事']);
    const remove = new DeleteCustomerUseCase(customers, invoices);
    await expect(remove.execute(scope, used.id)).rejects.toMatchObject({ reason: 'customer-in-use', params: { invoices: 1 } });
    await remove.execute(scope, unused.id);
    await expect(remove.execute(scope, unused.id)).rejects.toBeInstanceOf(CustomerNotFoundError);
  });
});

describe('明細 CSV プロファイル', () => {
  it('正常: 利用者のプロファイルを組込みより先に並べる。更新は作成日時を保つ', async () => {
    const profiles = new InMemoryBankCsvProfileRepository();
    const save = new SaveBankCsvProfileUseCase(profiles, sequentialIds('p'), () => NOW);
    const profile = await save.execute({ scope, name: '地銀', mapping: { date: '取引日', deposit: '入金' }, headerRow: 4, accountKey: 'main' });
    expect(profile).toMatchObject({ id: 'p-1', origin: 'user', headerRow: 4, accountKey: 'main' });
    const later = await new SaveBankCsvProfileUseCase(profiles, sequentialIds('x'), () => new Date('2026-10-01T00:00:00.000Z')).execute({ scope, id: 'p-1', name: '地銀 改', mapping: { date: '取引日', amount: '金額' }, headerSignature: ['取引日', '金額', '摘要'] });
    expect(later).toMatchObject({ name: '地銀 改', createdAt: AT, headerSignature: ['取引日', '金額', '摘要'] });
    const list = await new ListBankCsvProfilesUseCase(profiles).execute(scope);
    expect(list[0]!.id).toBe('p-1');
    expect(list.slice(1).every((entry) => entry.origin === 'builtin')).toBe(true);
  });

  it('異常: 組込みは保存も削除もできない。無いプロファイルの削除は 404', async () => {
    const profiles = new InMemoryBankCsvProfileRepository();
    await expect(new SaveBankCsvProfileUseCase(profiles).execute({ scope, id: 'builtin:generic', name: 'x', mapping: { date: 'd', deposit: 'x' } })).rejects.toMatchObject({ reason: 'profile-builtin' });
    await expect(new DeleteBankCsvProfileUseCase(profiles).execute(scope, 'builtin:mufg')).rejects.toMatchObject({ reason: 'profile-builtin' });
    await expect(new DeleteBankCsvProfileUseCase(profiles).execute(scope, 'missing')).rejects.toBeInstanceOf(BankCsvProfileNotFoundError);
    await new SaveBankCsvProfileUseCase(profiles, () => 'p', () => NOW).execute({ scope, name: 'x', mapping: { date: 'd', deposit: 'x' } });
    await new DeleteBankCsvProfileUseCase(profiles).execute(scope, 'p');
    expect(await profiles.list(scope)).toEqual([]);
  });
});

describe('機能フラグと時計', () => {
  it('正常: 解決器の値を boolean に正規化する。失敗は「使えない」に倒してログに残す', async () => {
    expect(await new ReceivablesCapabilitiesUseCase().execute()).toEqual(RECEIVABLES_CAPABILITIES_DISABLED);
    expect(await new ReceivablesCapabilitiesUseCase(async () => ({ invoiceDraft: { enabled: true, vision: 'yes' as never } })).execute()).toEqual({ invoiceDraft: { enabled: true, vision: false } });
    const logger = { log: vi.fn() };
    expect(await new ReceivablesCapabilitiesUseCase(async () => { throw new Error('broken'); }, logger as never).execute()).toEqual(RECEIVABLES_CAPABILITIES_DISABLED);
  });

  it('正常: ローカル日付は YYYY-MM-DD で 0 埋めする', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});
