/**
 * application層: 全銀協の振込データ（事前点検 → 作成 → 振込バッチ → 再ダウンロード・確定・取消。docs/21 §20.1.3 / §20.2.9 / §20.6.5。UC3）。
 *
 * - 口座番号の開封は骨格の `openAccountNumber` **だけ**で行い、作成と再ダウンロードの瞬間に限る。鍵が無く開封できなければ
 *   `SecretCipherError` を `ExpenseDomainError`（欄 `bankAccount.accountNumber` / `source.accountNumber`）に言い換え、口座の再入力へ導く（系統 A と同じ扱い）。
 *   平文は例外の文言・ログに入れない。
 * - 作成: 止める理由が 1 件でもあれば、または確認必須の警告が未確認なら `ExpensePayoutBlockedError`（ファイルを作らない）。
 *   通ればバッチの保存・申請の振込の印・追加支給の印を**同じトランザクション**で行う。
 * - 確定: 申請 → 精算済み（`exportFileName` = ファイル名）、仮払の支払 → 支払済み、追加支給 → 支払済みで仮払も精算済み。
 *   どちらも `payoutBatchId` を付ける。振込元の設定で支払仕訳が on なら下書きを作る（仕訳側の拒否は警告にして確定は止めない）。
 * - 取消: 作成済み（未確定）だけ。申請と追加支給の印を外す。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ExpenseAdvance } from '../../../domain/expense/advance';
import { maskBankAccount, type BankAccount, type MaskedBankAccount, type SealedAccountNumber } from '../../../domain/expense/bank-account';
import { businessDateOf } from '../../../domain/expense/business-date';
import { clearPayout, markPayoutExported, markSettled, reimbursableAmount, type ExpenseClaim } from '../../../domain/expense/claim';
import {
  ExpenseAdvanceNotFoundError, ExpenseClaimNotFoundError, ExpenseDomainError, ExpensePayoutBlockedError, ExpensePayoutNotFoundError, ExpenseTransitionError,
  type ExpensePayoutProblem,
} from '../../../domain/expense/errors';
import { clearAdditionalPaymentExport, markAdditionalPaymentExported, markAdvancePaid, payAdvanceAdditional } from '../../../domain/expense/money/advance-transitions';
import { planPayout, unacknowledgedWarnings, type PayoutAdvanceRef, type PayoutClaimRef, type PlannedPayoutLine } from '../../../domain/expense/money/payout-plan';
import { buildPayoutJournalDraft } from '../../../domain/expense/money/payout-journal';
import { buildZenginTransferFile, zenginFileName, type ZenginFileLine } from '../../../domain/expense/money/zengin-file';
import { createExpensePayoutBatch, type ExpensePayoutBatch, type ExpensePayoutSettings, type PayoutBatchStatus, type PayoutLine } from '../../../domain/expense/payout';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { SecretCipherError } from '../../model-settings/secret-cipher';
import { openAccountNumber } from '../bank-account-secrets';
import { JournalDraftRejectedError } from '../errors';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';
import { maskPayoutSettings, type MaskedPayoutSettings } from './manage-payout-settings';

export interface PayoutRequest {
  readonly claimIds?: readonly string[];
  readonly advanceIds?: readonly string[];
  readonly transferDate: string;
}

export interface PayoutCandidates {
  readonly claims: readonly { readonly id: string; readonly claimantName: string; readonly employeeId?: string; readonly amount: number; readonly journalLinked: 'none' | 'partial' | 'complete' }[];
  readonly advancePayments: readonly { readonly id: string; readonly employeeId: string; readonly employeeName: string; readonly amount: number }[];
  readonly advanceAdditionals: readonly { readonly id: string; readonly employeeId: string; readonly employeeName: string; readonly amount: number }[];
}

export type MaskedPayoutLine = Omit<PlannedPayoutLine, 'bank'> & { readonly bank: MaskedBankAccount };

export interface PayoutPreview {
  readonly candidates: PayoutCandidates;
  readonly lines: readonly MaskedPayoutLine[];
  readonly totalAmount: number;
  readonly recordCount: number;
  readonly problems: readonly ExpensePayoutProblem[];
  readonly warnings: readonly ExpensePayoutProblem[];
}

export type ExpensePayoutBatchView = Omit<ExpensePayoutBatch, 'tenant' | 'lines' | 'settingsSnapshot'> & {
  readonly lines: readonly (Omit<PayoutLine, 'bank'> & { readonly bank: MaskedBankAccount })[];
  readonly settingsSnapshot: MaskedPayoutSettings;
};

export interface PayoutFile {
  readonly fileName: string;
  readonly contentBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export function payoutBatchView(batch: ExpensePayoutBatch): ExpensePayoutBatchView {
  const { tenant: _tenant, lines, settingsSnapshot, ...rest } = batch;
  return { ...rest, lines: lines.map((line) => ({ ...line, bank: maskBankAccount(line.bank) })), settingsSnapshot: maskPayoutSettings(settingsSnapshot) };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export class ExpensePayoutsUseCase {
  constructor(
    private readonly deps: ExpenseSystemDeps,
    private readonly makeId: () => string = () => randomUUID().replaceAll('-', '').slice(0, 16),
  ) {}

  private now(): Date { return this.deps.now(); }

  /** 口座番号の開封（`openAccountNumber` だけを通す）。鍵が無ければ直す欄つきの入力エラーにする。 */
  private async open(sealed: SealedAccountNumber, field: string, owner: string): Promise<string> {
    try {
      return await openAccountNumber(this.deps.cipher, sealed);
    } catch (error) {
      if (!(error instanceof SecretCipherError)) throw error;
      throw new ExpenseDomainError(`the account number of ${owner} cannot be opened with the current key file; enter the account number again`, undefined, { field });
    }
  }

  private async claimRefs(scope: TenantScope, ids: readonly string[] | undefined): Promise<readonly PayoutClaimRef[]> {
    const { policy } = await loadExpensePolicy(this.deps.repositories.policies, scope);
    if (ids === undefined) {
      const summaries = await this.deps.repositories.claims.list(scope, { status: 'approved', limit: 5000 });
      return summaries
        .filter((summary) => summary.payoutBatchId === undefined && summary.advanceId === undefined)
        .map((summary): PayoutClaimRef => ({
          id: summary.id, status: summary.status, claimantName: summary.claimant.name, journalLinked: summary.journalLinked,
          amount: policy.card.acceptCorporatePaymentItems ? summary.totalAmount - summary.corporatePaymentAmount : summary.totalAmount,
          ...(summary.claimant.employeeId === undefined ? {} : { employeeId: summary.claimant.employeeId }),
        }))
        .filter((claim) => claim.amount > 0);
    }
    const claims = await this.deps.repositories.claims.findByIds(scope, unique(ids));
    const missing = unique(ids).find((id) => !claims.some((claim) => claim.id === id));
    if (missing !== undefined) throw new ExpenseClaimNotFoundError(`expense claim not found: ${missing}`);
    return claims.map((claim): PayoutClaimRef => ({
      id: claim.id, status: claim.status, claimantName: claim.claimant.name, amount: reimbursableAmount(claim, policy),
      journalLinked: claim.journalLink === undefined ? 'none' : claim.journalLink.complete ? 'complete' : 'partial',
      ...(claim.claimant.employeeId === undefined ? {} : { employeeId: claim.claimant.employeeId }),
      ...(claim.advanceId === undefined ? {} : { advanceId: claim.advanceId }),
      ...(claim.payout === undefined ? {} : { payoutBatchId: claim.payout.batchId }),
    }));
  }

  private static advanceRef(advance: ExpenseAdvance): PayoutAdvanceRef {
    const extra = advance.settlement?.additionalPayment;
    return {
      id: advance.id, employeeId: advance.employeeId, employeeName: advance.employeeSnapshot.name, status: advance.status, amount: advance.amount, paid: advance.payment !== undefined,
      ...(extra === undefined ? {} : { additionalPayment: { amount: extra.amount, status: extra.status, ...(extra.payoutBatchId === undefined ? {} : { payoutBatchId: extra.payoutBatchId }) } }),
    };
  }

  private async advanceRefs(scope: TenantScope, ids: readonly string[] | undefined): Promise<{ readonly payments: readonly PayoutAdvanceRef[]; readonly additionals: readonly PayoutAdvanceRef[] }> {
    const { advances } = this.deps.repositories;
    if (ids === undefined) {
      const [approved, settling] = await Promise.all([advances.list(scope, { status: 'approved', limit: 5000 }), advances.list(scope, { status: 'settling', limit: 5000 })]);
      return {
        payments: approved.filter((advance) => advance.payment === undefined).map(ExpensePayoutsUseCase.advanceRef),
        additionals: settling.filter((advance) => advance.settlement?.additionalPayment?.status === 'pending').map(ExpensePayoutsUseCase.advanceRef),
      };
    }
    const found = await advances.findByIds(scope, unique(ids));
    const missing = unique(ids).find((id) => !found.some((advance) => advance.id === id));
    if (missing !== undefined) throw new ExpenseAdvanceNotFoundError(`expense advance not found: ${missing}`);
    const refs = found.map(ExpensePayoutsUseCase.advanceRef);
    return { payments: refs.filter((ref) => ref.additionalPayment === undefined), additionals: refs.filter((ref) => ref.additionalPayment !== undefined) };
  }

  private async planFor(scope: TenantScope, request: PayoutRequest) {
    const all = request.claimIds === undefined && request.advanceIds === undefined;
    const [settings, claims, advances, candidateClaims, candidateAdvances, exported] = await Promise.all([
      this.deps.settings.load(scope, 'payout'),
      this.claimRefs(scope, all ? undefined : request.claimIds ?? []),
      this.advanceRefs(scope, all ? undefined : request.advanceIds ?? []),
      this.claimRefs(scope, undefined),
      this.advanceRefs(scope, undefined),
      this.deps.repositories.payouts.list(scope, { status: 'exported', limit: 1000 }),
    ]);
    const confirmed = await this.deps.repositories.payouts.findActiveByClaimIds(scope, claims.map((claim) => claim.id));
    const activeBatches = [...new Map([...exported, ...confirmed].map((batch) => [batch.id, batch])).values()];
    const employeeIds = unique([...claims.flatMap((claim) => (claim.employeeId === undefined ? [] : [claim.employeeId])), ...advances.payments.map((ref) => ref.employeeId), ...advances.additionals.map((ref) => ref.employeeId)]);
    const employees = employeeIds.length === 0 ? [] : await this.deps.employeeDirectory.findByIds(scope, employeeIds);
    const now = this.now();
    const plan = planPayout({
      settings: settings.value, transferDate: request.transferDate, today: businessDateOf(now, this.deps.timeZone), now,
      claims, advancePayments: advances.payments, advanceAdditionals: advances.additionals, employees, activeBatches,
    });
    const candidates: PayoutCandidates = {
      claims: candidateClaims.map(({ id, claimantName, employeeId, amount, journalLinked }) => ({ id, claimantName, amount, journalLinked, ...(employeeId === undefined ? {} : { employeeId }) })),
      advancePayments: candidateAdvances.payments.map(({ id, employeeId, employeeName, amount }) => ({ id, employeeId, employeeName, amount })),
      advanceAdditionals: candidateAdvances.additionals.map(({ id, employeeId, employeeName, additionalPayment }) => ({ id, employeeId, employeeName, amount: additionalPayment?.amount ?? 0 })),
    };
    return { settings: settings.value, plan, candidates };
  }

  /** 事前点検（状態を変えない）。 */
  async preview(scope: TenantScope, request: PayoutRequest): Promise<PayoutPreview> {
    const { plan, candidates } = await this.planFor(scope, request);
    return { candidates, lines: plan.lines.map((line) => ({ ...line, bank: maskBankAccount(line.bank) })), totalAmount: plan.totalAmount, recordCount: plan.recordCount, problems: plan.problems, warnings: plan.warnings };
  }

  private async buildFile(settings: ExpensePayoutSettings, lines: readonly { readonly name: string; readonly holderKanaConverted: string; readonly bank: BankAccount; readonly amount: number; readonly employeeCode?: string }[], transferDate: string) {
    const source = settings.source;
    if (source === undefined || settings.requesterCode === undefined || settings.requesterNameKana === undefined) {
      throw new ExpensePayoutBlockedError('payout: the payout source is not set', [{ code: 'payout-source-missing', message: '振込元の口座（または依頼人コード・依頼人名）が設定されていません。振込元の設定で入れてください', fixTarget: 'payout-settings' }]);
    }
    const { accountNumber: sealedSource, ...sourceAccount } = source;
    const requester = { ...sourceAccount, requesterCode: settings.requesterCode, requesterNameKana: settings.requesterNameKana, accountNumber: await this.open(sealedSource, 'source.accountNumber', 'the payout source') };
    const fileLines: ZenginFileLine[] = [];
    for (const line of lines) {
      const { accountNumber, holderKana: _holderKana, changedAt: _changedAt, changedBy: _changedBy, ...bank } = line.bank;
      fileLines.push({
        ...bank, holderKana: line.holderKanaConverted, amount: line.amount, accountNumber: await this.open(accountNumber, 'bankAccount.accountNumber', line.name),
        ...(line.employeeCode === undefined ? {} : { employeeCode: line.employeeCode }),
      });
    }
    return buildZenginTransferFile(requester, settings.format, fileLines, transferDate);
  }

  /** 振込データを作る（approve 権限・監査は api）。 */
  async create(scope: TenantScope, request: PayoutRequest & { readonly acknowledgedWarnings: readonly string[] }, by: string): Promise<{ readonly batch: ExpensePayoutBatchView; readonly file: PayoutFile }> {
    const { settings, plan } = await this.planFor(scope, request);
    if (plan.problems.length > 0) throw new ExpensePayoutBlockedError(`payout: ${plan.problems.length} problem(s) must be fixed before creating the file`, plan.problems, plan.warnings);
    const pending = unacknowledgedWarnings(plan.warnings, request.acknowledgedWarnings);
    if (pending.length > 0) throw new ExpensePayoutBlockedError(`payout: confirm the warnings first (${pending.join(', ')})`, [], plan.warnings);
    if (plan.lines.length === 0) {
      throw new ExpensePayoutBlockedError('payout: there is nothing to transfer', [{ code: 'payout-claim-not-approved', message: '振込の対象がありません。承認済みの申請か、支払待ちの仮払を選んでください', fixTarget: 'approve' }]);
    }
    const built = await this.buildFile(settings, plan.lines, request.transferDate);
    const id = this.makeId();
    const at = this.now().toISOString();
    const fileName = zenginFileName(request.transferDate, id);
    const batch = createExpensePayoutBatch({
      tenant: scope, id, status: 'exported', transferDate: request.transferDate,
      lines: plan.lines.map((line) => ({ employeeId: line.employeeId, name: line.name, holderKanaConverted: line.holderKanaConverted, bank: line.bank, amount: line.amount, sources: line.sources })),
      recordCount: plan.recordCount, totalAmount: plan.totalAmount, fileName, fileSha256: sha256(built.bytes), settingsSnapshot: settings,
      acknowledgedWarnings: unique(request.acknowledgedWarnings), by, createdAt: at,
    });
    const { claims, advances, payouts, receipts } = this.deps.repositories;
    await this.deps.unitOfWork.withTransaction(async () => {
      await payouts.save(batch);
      const sources = batch.lines.flatMap((line) => line.sources);
      for (const claim of await claims.findByIds(scope, sources.filter((source) => source.kind === 'claim').map((source) => source.id))) {
        await claims.save(markPayoutExported(claim, id, at), await receipts.hashesByClaim(scope, claim.id));
      }
      for (const advance of await advances.findByIds(scope, sources.filter((source) => source.kind === 'advance-additional').map((source) => source.id))) {
        await advances.save(markAdditionalPaymentExported(advance, id, at));
      }
    });
    return { batch: payoutBatchView(batch), file: { fileName, contentBase64: Buffer.from(built.bytes).toString('base64'), byteLength: built.bytes.length, sha256: batch.fileSha256 } };
  }

  async list(scope: TenantScope, options: { readonly status?: PayoutBatchStatus; readonly limit?: number } = {}): Promise<readonly ExpensePayoutBatchView[]> {
    return (await this.deps.repositories.payouts.list(scope, { limit: options.limit ?? 100, ...(options.status === undefined ? {} : { status: options.status }) })).map(payoutBatchView);
  }

  private async require(scope: TenantScope, id: string): Promise<ExpensePayoutBatch> {
    const batch = await this.deps.repositories.payouts.findById(scope, id);
    if (batch === null) throw new ExpensePayoutNotFoundError(`expense payout batch not found: ${id}`);
    return batch;
  }

  /** 再ダウンロード（写しの口座番号を開封して同じバイト列を作り直す。取消済みは作らない）。 */
  async file(scope: TenantScope, id: string): Promise<PayoutFile> {
    const batch = await this.require(scope, id);
    if (batch.status === 'cancelled') {
      throw new ExpenseTransitionError(`payout file: batch ${id} is cancelled`, { nextStep: '取り消した振込データはダウンロードできません。振込データを作り直してください' });
    }
    const employees = await this.deps.employeeDirectory.findByIds(scope, batch.lines.map((line) => line.employeeId));
    const codes = new Map(employees.flatMap((employee) => (employee.code === undefined ? [] : [[employee.id, employee.code] as const])));
    const built = await this.buildFile(batch.settingsSnapshot, batch.lines.map((line) => ({ ...line, ...(codes.has(line.employeeId) ? { employeeCode: codes.get(line.employeeId) as string } : {}) })), batch.transferDate);
    const digest = sha256(built.bytes);
    if (digest !== batch.fileSha256) {
      throw new ExpenseTransitionError(`payout file: the regenerated file of batch ${id} differs from the original`, { nextStep: '社員番号など振込データの元の値が変わっています。振込データを取り消して作り直してください' });
    }
    return { fileName: batch.fileName, contentBase64: Buffer.from(built.bytes).toString('base64'), byteLength: built.bytes.length, sha256: digest };
  }

  /** 銀行で振込を終えたら確定する（申請 → 精算済み、仮払の支払・追加支給 → 支払済み）。 */
  async confirm(scope: TenantScope, id: string, by: string): Promise<{ readonly batch: ExpensePayoutBatchView; readonly claims: readonly ExpenseClaim[]; readonly advances: readonly ExpenseAdvance[]; readonly warnings: readonly string[] }> {
    const batch = await this.require(scope, id);
    if (batch.status !== 'exported') {
      throw new ExpenseTransitionError(`payout confirm: batch ${id} is ${batch.status}`, { nextStep: batch.status === 'confirmed' ? 'この振込データは確定済みです' : '取り消した振込データは確定できません' });
    }
    const at = this.now().toISOString();
    const sources = batch.lines.flatMap((line) => line.sources);
    const { claims: claimRepo, advances: advanceRepo, payouts, receipts } = this.deps.repositories;
    const warnings: string[] = [];
    let confirmed = createExpensePayoutBatch({ ...batch, status: 'confirmed', confirmedAt: at, confirmedBy: by });
    const result = await this.deps.unitOfWork.withTransaction(async () => {
      const claims: ExpenseClaim[] = [];
      for (const claim of await claimRepo.findByIds(scope, sources.filter((source) => source.kind === 'claim').map((source) => source.id))) {
        const settled = markSettled(claim, by, at, batch.fileName);
        await claimRepo.save(settled, await receipts.hashesByClaim(scope, claim.id));
        claims.push(settled);
      }
      const advances: ExpenseAdvance[] = [];
      const kinds = new Map(sources.filter((source) => source.kind !== 'claim').map((source) => [source.id, source.kind]));
      for (const advance of await advanceRepo.findByIds(scope, [...kinds.keys()])) {
        const payment = { paidOn: batch.transferDate, method: 'transfer' as const, payoutBatchId: id };
        const next = kinds.get(advance.id) === 'advance-payment' ? markAdvancePaid(advance, payment, by, at) : payAdvanceAdditional(advance, payment, by, at);
        await advanceRepo.save(next);
        advances.push(next);
      }
      await payouts.save(confirmed);
      return { claims, advances };
    });
    if (batch.settingsSnapshot.journal.createPaymentEntry && this.deps.journalDrafts !== undefined) {
      const { policy } = await loadExpensePolicy(this.deps.repositories.policies, scope);
      try {
        const { entryId } = await this.deps.journalDrafts.createDraft(scope, buildPayoutJournalDraft(confirmed, policy));
        confirmed = createExpensePayoutBatch({ ...confirmed, journalEntryId: entryId });
        await payouts.save(confirmed);
      } catch (error) {
        if (!(error instanceof JournalDraftRejectedError)) throw error;
        warnings.push(`支払の仕訳下書きを作れませんでした（${error.detail}）。仕訳画面で手入力するか、科目マスタを直してください`);
      }
    }
    return { batch: payoutBatchView(confirmed), ...result, warnings };
  }

  /** 取消（未確定だけ）。申請と追加支給の印を外す。 */
  async cancel(scope: TenantScope, id: string, note: string, by: string): Promise<ExpensePayoutBatchView> {
    const batch = await this.require(scope, id);
    if (batch.status !== 'exported') {
      throw new ExpenseTransitionError(`payout cancel: batch ${id} is ${batch.status}`, { nextStep: batch.status === 'confirmed' ? '確定した振込データは取り消せません。銀行で組戻しの手続きをしてください' : 'この振込データは取消済みです' });
    }
    if (note.trim() === '') throw new ExpenseTransitionError('payout cancel: a note is required', { nextStep: '取り消す理由を書いてください' });
    const at = this.now().toISOString();
    const cancelled = createExpensePayoutBatch({ ...batch, status: 'cancelled', cancel: { by, at, note: note.trim() } });
    const sources = batch.lines.flatMap((line) => line.sources);
    const { claims, advances, payouts, receipts } = this.deps.repositories;
    await this.deps.unitOfWork.withTransaction(async () => {
      for (const claim of await claims.findByIds(scope, sources.filter((source) => source.kind === 'claim').map((source) => source.id))) {
        const next = clearPayout(claim, id, at);
        if (next !== claim) await claims.save(next, await receipts.hashesByClaim(scope, claim.id));
      }
      for (const advance of await advances.findByIds(scope, sources.filter((source) => source.kind === 'advance-additional').map((source) => source.id))) {
        const next = clearAdditionalPaymentExport(advance, id, at);
        if (next !== advance) await advances.save(next);
      }
      await payouts.save(cancelled);
    });
    return payoutBatchView(cancelled);
  }
}
