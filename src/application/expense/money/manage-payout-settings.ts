/**
 * application層: 振込元の設定（口座・依頼人コード・依頼人名・書式の銀行差・支払仕訳。docs/21 §20.2.9 / §20.6.4。UC3）。
 *
 * - 振込元の口座番号も封緘して保存する（骨格の `sealAccountNumber`）。応答は末尾 4 桁だけ（`accountNumberLast4`）。
 * - 保存本文で口座番号を省略したら既存の封緘値を保つ（画面は「変更する」を押したときだけ口座番号を送る）。`source: null` で振込元を外す。
 * - 未保存なら既定値（振込元なし・最も広く通る書式）を返すが保存しない（`saved: false`）。
 * 開封はしない（開封は振込データの作成・再ダウンロードの `payouts.ts` だけ）。
 */
import type { BankAccountType } from '../../../domain/expense/bank-account';
import type { ExpensePayoutSettings, PayoutSourceAccount, PayoutSourceAccountType, ZenginFormatSettings } from '../../../domain/expense/payout';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { sealAccountNumber } from '../bank-account-secrets';
import type { ExpenseSystemDeps } from '../system-deps';

export type MaskedPayoutSourceAccount = Omit<PayoutSourceAccount, 'accountNumber'> & { readonly accountNumberLast4: string };
export type MaskedPayoutSettings = Omit<ExpensePayoutSettings, 'source'> & { readonly source?: MaskedPayoutSourceAccount };

export function maskPayoutSettings(settings: ExpensePayoutSettings): MaskedPayoutSettings {
  const { source, ...rest } = settings;
  if (source === undefined) return rest;
  const { accountNumber, ...account } = source;
  return { ...rest, source: { ...account, accountNumberLast4: accountNumber.hint } };
}

export interface PayoutSourceInput {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: PayoutSourceAccountType | Extract<BankAccountType, 'ordinary' | 'current' | 'other'>;
  /** 平文。省略 = 既存の口座番号を保つ。 */
  readonly accountNumber?: string;
}

export interface PayoutSettingsInput {
  /** undefined = 既存を保つ、null = 振込元を外す。 */
  readonly source?: PayoutSourceInput | null;
  readonly requesterCode?: string;
  readonly requesterNameKana?: string;
  readonly format?: Partial<ZenginFormatSettings>;
  readonly journal?: Partial<ExpensePayoutSettings['journal']>;
}

export class ManagePayoutSettingsUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async get(scope: TenantScope): Promise<{ readonly settings: MaskedPayoutSettings; readonly saved: boolean }> {
    const { value, saved } = await this.deps.settings.load(scope, 'payout');
    return { settings: maskPayoutSettings(value), saved };
  }

  async save(scope: TenantScope, input: PayoutSettingsInput): Promise<MaskedPayoutSettings> {
    const existing = (await this.deps.settings.load(scope, 'payout')).value;
    let source: PayoutSourceAccount | undefined = existing.source;
    if (input.source === null) source = undefined;
    else if (input.source !== undefined) {
      const { accountNumber: plain, ...account } = input.source;
      const accountNumber = plain === undefined || plain === ''
        ? existing.source?.accountNumber ?? await sealAccountNumber(this.deps.cipher, plain ?? '')
        : await sealAccountNumber(this.deps.cipher, plain);
      source = { ...account, accountNumber };
    }
    // 省略した項目は既存の値を保つ（画面の部分的な保存で依頼人コード・依頼人名が消えないように）。空文字で消す。
    const requesterCode = input.requesterCode ?? existing.requesterCode;
    const requesterNameKana = input.requesterNameKana ?? existing.requesterNameKana;
    const saved = await this.deps.settings.save(scope, 'payout', {
      ...(source === undefined ? {} : { source }),
      ...(requesterCode === undefined || requesterCode === '' ? {} : { requesterCode }),
      ...(requesterNameKana === undefined || requesterNameKana === '' ? {} : { requesterNameKana }),
      format: { ...existing.format, ...(input.format ?? {}) },
      journal: { ...existing.journal, ...(input.journal ?? {}) },
      updatedAt: this.deps.now().toISOString(),
    });
    return maskPayoutSettings(saved);
  }
}
