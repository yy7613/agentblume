/**
 * application層: 銀行明細 CSV のプロファイル（保存できる列マッピング。docs/22 §5.3）。
 *
 * 組込み（仕訳の銀行プリセットの写し）は一覧に並べるが保存・削除はできない（複製して編集する）。
 */
import { randomUUID } from 'node:crypto';
import { BUILTIN_BANK_CSV_PROFILES, createBankCsvProfile, isBuiltinProfileId, type BankCsvProfile, type ReceivablesColumnMapping } from '../../domain/receivables/bank-csv-profile';
import { BankCsvProfileNotFoundError, ReceivablesStateError } from '../../domain/receivables/errors';
import type { BankCsvProfileRepository } from '../../domain/receivables/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export class ListBankCsvProfilesUseCase {
  constructor(private readonly profiles: BankCsvProfileRepository) {}
  async execute(scope: TenantScope): Promise<readonly BankCsvProfile[]> {
    return [...await this.profiles.list(scope), ...BUILTIN_BANK_CSV_PROFILES];
  }
}

export interface SaveBankCsvProfileInput {
  readonly scope: TenantScope;
  readonly id?: string;
  readonly name: string;
  readonly mapping: ReceivablesColumnMapping;
  readonly headerSignature?: readonly string[];
  readonly headerRow?: number | 'auto';
  readonly accountKey?: string;
}

export class SaveBankCsvProfileUseCase {
  constructor(private readonly profiles: BankCsvProfileRepository, private readonly makeId: () => string = randomUUID, private readonly now: () => Date = () => new Date()) {}
  async execute(input: SaveBankCsvProfileInput): Promise<BankCsvProfile> {
    if (input.id !== undefined && isBuiltinProfileId(input.id)) throw new ReceivablesStateError('profile-builtin', 'a builtin bank CSV profile cannot be changed; save it under a new name');
    const at = this.now().toISOString();
    const existing = input.id === undefined ? null : await this.profiles.findById(input.scope, input.id);
    const profile = createBankCsvProfile({
      tenant: input.scope, ...(input.id === undefined ? {} : { id: input.id }), name: input.name, mapping: input.mapping,
      ...(input.headerSignature === undefined ? {} : { headerSignature: input.headerSignature }),
      ...(input.headerRow === undefined ? {} : { headerRow: input.headerRow }),
      ...(input.accountKey === undefined ? {} : { accountKey: input.accountKey }),
      createdAt: existing?.createdAt ?? at, updatedAt: at,
    }, this.makeId);
    await this.profiles.save(profile);
    return profile;
  }
}

export class DeleteBankCsvProfileUseCase {
  constructor(private readonly profiles: BankCsvProfileRepository) {}
  async execute(scope: TenantScope, id: string): Promise<void> {
    if (isBuiltinProfileId(id)) throw new ReceivablesStateError('profile-builtin', 'a builtin bank CSV profile cannot be deleted');
    if (!await this.profiles.delete(scope, id)) throw new BankCsvProfileNotFoundError(`bank CSV profile not found: ${id}`);
  }
}
