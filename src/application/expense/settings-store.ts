/**
 * application層: ワークスペースに 1 つの設定（組織・振込元・カード・運賃）の読み書き（docs/21 §20.2.1 / §20.8）。
 *
 * 規程と同じく**未保存なら既定値を返すが保存しない**（参照が書き込みを起こすと読み取り権限しか無い利用者が落ち、
 * 既定値を後から改善しても一度でも開いたワークスペースに古い値が焼き付くため）。応答の `saved` で区別する。
 * 系統の担当はここを通して設定を読む（リポジトリを直接読まない。既定値の補い方を 1 か所にするため）。
 */
import type { ExpenseOrganization } from '../../domain/expense/organization';
import type { ExpenseSettingsRepository } from '../../domain/expense/repositories';
import { createExpenseSettings, defaultExpenseSettings, type ExpenseSettingsKind, type ExpenseSettingsOf } from '../../domain/expense/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { OrganizationReadPort } from './ports';

export interface ExpenseSettingsResult<K extends ExpenseSettingsKind> {
  readonly value: ExpenseSettingsOf<K>;
  readonly saved: boolean;
}

export class ExpenseSettingsStore {
  constructor(private readonly repository: ExpenseSettingsRepository) {}

  async load<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K): Promise<ExpenseSettingsResult<K>> {
    const stored = await this.repository.get(scope, kind);
    return stored === null ? { value: defaultExpenseSettings(kind), saved: false } : { value: stored, saved: true };
  }

  /** 検証してから保存し、保存した値を返す（`updatedAt` は呼び出し側が決める）。 */
  async save<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K, value: unknown): Promise<ExpenseSettingsOf<K>> {
    const validated = createExpenseSettings(kind, value);
    await this.repository.save(scope, kind, validated);
    return validated;
  }
}

/** 組織の読み取りポート（承認経路の解決・集計・仕訳の補助軸が使う）。 */
export function organizationReader(store: ExpenseSettingsStore): OrganizationReadPort {
  return {
    async get(scope: TenantScope): Promise<ExpenseOrganization> {
      return (await store.load(scope, 'organization')).value;
    },
  };
}
