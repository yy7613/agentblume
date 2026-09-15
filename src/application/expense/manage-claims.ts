/**
 * application層: 申請と明細の作成・編集・削除、証憑本体の取得（docs/21 §6 / §10）。
 *
 * - 明細の保存で登録番号の形が合わなければ 400 にせず、落として警告に残す（`sanitizeReceiptFacts`）。
 * - 費目を指定せず費目文字列だけが来たら、規程の別名で当てる（当たらなければ `category-missing` のまま文字列を残す）。
 * - 証憑本体は申請と別に保存し、申請の保存（重複検出の索引の入れ直しを含む）と同じトランザクションで括る。
 * - 申請を削除したら証憑本体も削除する。
 */
import { randomUUID } from 'node:crypto';
import { businessDateOf, DEFAULT_BUSINESS_TIME_ZONE } from '../../domain/expense/business-date';
import type { ExpenseDetailRecord, ExtractionFlag } from '../../domain/expense/detail-read';
import {
  claimTotalAmount, createExpenseClaim, editClaim, putItem, removeItem, withPolicyStaleness,
  type Claimant, type ClaimPeriod, type ExpenseClaim, type ExpenseClaimSummary, type ItemExtractionMethod, type ItemSource,
} from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseDomainError, ExpenseItemNotFoundError, ExpenseReceiptNotFoundError, ExpenseTransitionError } from '../../domain/expense/errors';
import { findDepartment } from '../../domain/expense/organization';
import { resolveCategory } from '../../domain/expense/policy';
import { createExpenseReceipt, type ExpenseReceipt } from '../../domain/expense/receipt';
import { sanitizeReceiptFacts } from '../../domain/expense/receipt-facts';
import type { ExpenseCardRepository, ExpenseClaimListOptions, ExpenseClaimRepository, ExpensePolicyRepository, ExpenseReceiptRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { loadExpensePolicy } from './manage-policy';
import type { EmployeeDirectoryPort, OrganizationReadPort } from './ports';
import { receiptSha256 } from './receipt-hash';

/** 申請を読み、無ければ 404。 */
export async function requireClaim(claims: ExpenseClaimRepository, scope: TenantScope, id: string): Promise<ExpenseClaim> {
  const claim = await claims.findById(scope, id);
  if (claim === null) throw new ExpenseClaimNotFoundError(`expense claim not found: ${id}`);
  return claim;
}

/**
 * 申請を保存する（索引に要る画像ハッシュは証憑の保管庫から読む）。`approvers` は現在の段の承認者の従業員 id
 * （「あなたの承認待ち」の索引。承認・チェックのユースケースだけが渡す。省略 = 空にする）。
 */
export async function saveClaim(claims: ExpenseClaimRepository, receipts: ExpenseReceiptRepository, claim: ExpenseClaim, approvers?: readonly string[]): Promise<void> {
  await claims.save(claim, await receipts.hashesByClaim(claim.tenant, claim.id), approvers);
}

/**
 * 申請者の写しを作る（§20.9.1）。`employeeId` を指定したら、本文の氏名・社員番号・部門は使わずに従業員マスタと組織から埋める
 * （申請の表示用の写しが従業員マスタと食い違うと、振込先と承認者が誰かを画面から追えなくなるため）。
 * `employeeId` が無ければ参照の id は受け取らない（クライアントが部門 id だけを申告しても写さない）。
 */
export class ClaimantResolver {
  constructor(
    private readonly directory: EmployeeDirectoryPort,
    private readonly organization: OrganizationReadPort,
  ) {}

  async resolve(scope: TenantScope, claimant: Claimant): Promise<Claimant> {
    if (claimant.employeeId === undefined || claimant.employeeId.trim() === '') {
      const { employeeId: _employeeId, departmentId: _departmentId, ...rest } = claimant;
      return rest;
    }
    const employee = await this.directory.findById(scope, claimant.employeeId);
    if (employee === null) throw new ExpenseDomainError(`expense claim: claimant.employeeId ${claimant.employeeId} is not in the employee master`, undefined, { field: 'claimant.employeeId' });
    if (!employee.enabled) throw new ExpenseDomainError(`expense claim: claimant.employeeId ${claimant.employeeId} is disabled; choose an enabled employee`, undefined, { field: 'claimant.employeeId' });
    const department = findDepartment(await this.organization.get(scope), employee.departmentId);
    return {
      name: employee.name,
      ...(employee.code === undefined ? {} : { employeeCode: employee.code }),
      ...(department === undefined ? {} : { department: department.name }),
      employeeId: employee.id,
      ...(employee.departmentId === undefined ? {} : { departmentId: employee.departmentId }),
    };
  }
}

/** 解決器を配線しない構成（テスト・既存の呼び出し）。参照の id は写さない。 */
async function withoutReferences(claimant: Claimant): Promise<Claimant> {
  const { employeeId: _employeeId, departmentId: _departmentId, ...rest } = claimant;
  return rest;
}

export interface CreateExpenseClaimInput {
  readonly scope: TenantScope;
  readonly claimant: Claimant;
  readonly period: ClaimPeriod;
  readonly title?: string;
  readonly by: string;
}

export class CreateExpenseClaimUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly claimants?: ClaimantResolver,
  ) {}

  async execute(input: CreateExpenseClaimInput): Promise<ExpenseClaim> {
    const at = this.now().toISOString();
    const claimant = this.claimants === undefined ? await withoutReferences(input.claimant) : await this.claimants.resolve(input.scope, input.claimant);
    const claim = createExpenseClaim({
      tenant: input.scope, claimant, period: input.period,
      ...(input.title === undefined ? {} : { title: input.title }),
      items: [], acknowledgements: [], history: [{ type: 'created', by: input.by, at }],
      submittedBy: input.by, createdAt: at, updatedAt: at,
    }, this.makeId);
    await this.claims.save(claim, new Map());
    return claim;
  }
}

export interface UpdateExpenseClaimInput extends CreateExpenseClaimInput {
  readonly id: string;
}

export class UpdateExpenseClaimUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly claimants?: ClaimantResolver,
  ) {}

  async execute(input: UpdateExpenseClaimInput): Promise<ExpenseClaim> {
    const claim = await requireClaim(this.claims, input.scope, input.id);
    const claimant = this.claimants === undefined ? await withoutReferences(input.claimant) : await this.claimants.resolve(input.scope, input.claimant);
    const updated = editClaim(claim, { claimant, period: input.period, title: input.title ?? '' }, input.by, this.now().toISOString());
    await saveClaim(this.claims, this.receipts, updated);
    return updated;
  }
}

export class GetExpenseClaimUseCase {
  constructor(private readonly claims: ExpenseClaimRepository) {}

  async execute(scope: TenantScope, id: string): Promise<ExpenseClaim> {
    return requireClaim(this.claims, scope, id);
  }
}

export class ListExpenseClaimsUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly policies: ExpensePolicyRepository,
  ) {}

  /** 作成日時の降順。`stale` は規程の版との比較まで含める。 */
  async execute(scope: TenantScope, options?: ExpenseClaimListOptions): Promise<readonly ExpenseClaimSummary[]> {
    const [{ policy }, summaries] = await Promise.all([loadExpensePolicy(this.policies, scope), this.claims.list(scope, options)]);
    return summaries.map((summary) => withPolicyStaleness(summary, policy));
  }
}

export class DeleteExpenseClaimUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    /** 申請の削除でカード利用の照合を外す（§20.8.3。省略 = カードを見ない）。 */
    private readonly cards?: ExpenseCardRepository,
  ) {}

  async execute(scope: TenantScope, id: string): Promise<void> {
    const claim = await requireClaim(this.claims, scope, id);
    if (claim.status === 'approved' || claim.status === 'settled' || claim.status === 'in-approval') {
      const nextStep = claim.status === 'settled' ? '精算済みの申請は削除できません（帳簿の記録として残します）' : '承認を取り消してから削除してください';
      throw new ExpenseTransitionError(`delete expense claim: a ${claim.status} claim cannot be deleted`, { nextStep });
    }
    // 証憑・申請（重複と派生の索引を含む）・カードの照合を 1 トランザクションで消す（照合だけが残ると、消えた明細にカード利用が結ばれ続ける）。
    await this.unitOfWork.withTransaction(async () => {
      await this.receipts.deleteByClaim(scope, id);
      await this.cards?.unlinkClaim(scope, id);
      await this.claims.delete(scope, id);
    });
  }
}

export interface SaveExpenseItemInput {
  readonly scope: TenantScope;
  readonly claimId: string;
  /** 省略で新規、指定で更新（無ければその id で新規）。 */
  readonly itemId?: string;
  readonly categoryId?: string;
  readonly categoryText?: string;
  readonly facts: unknown;
  readonly source: ItemSource;
  readonly extraction?: {
    readonly method?: ItemExtractionMethod;
    readonly model?: { readonly provider: string; readonly model: string };
    readonly confidence?: number;
    readonly warnings?: readonly string[];
    readonly documentKind?: string;
    readonly rejectedRegistrationNumber?: string;
    /** 構造化した読取の印（UC7）。人が欄を編集したら画面が対応する印を外して送る。 */
    readonly flags?: readonly ExtractionFlag[];
    /** 追加読取の記録（形は domain が検証する）。 */
    readonly detail?: unknown;
  };
  /** 添付する証憑本体（省略時、更新なら既存の証憑を残す）。 */
  readonly receipt?: { readonly dataUrl: string; readonly fileName?: string; readonly mime?: string; readonly text?: string };
  readonly by: string;
}

function defaultMethod(source: ItemSource, hasExtraction: boolean): ItemExtractionMethod {
  if (source.type === 'csv-row') return 'csv';
  if ((source.type === 'image' || source.type === 'pdf') && hasExtraction) return 'llm';
  return 'manual';
}

export class SaveExpenseItemUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly policies: ExpensePolicyRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
  ) {}

  async execute(input: SaveExpenseItemInput): Promise<ExpenseClaim> {
    const now = this.now();
    const at = now.toISOString();
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    const { policy } = await loadExpensePolicy(this.policies, input.scope);
    const sanitized = sanitizeReceiptFacts(input.facts, 'expense item: facts');
    const existing = input.itemId === undefined ? undefined : claim.items.find((item) => item.id === input.itemId);
    const itemId = existing?.id ?? input.itemId ?? this.makeId();

    const categoryText = input.categoryText?.trim() === '' ? undefined : input.categoryText?.trim();
    const categoryId = input.categoryId?.trim() === '' || input.categoryId === undefined ? resolveCategory(policy, categoryText)?.id : input.categoryId.trim();
    const warnings = [...new Set([...(input.extraction?.warnings ?? []), ...sanitized.warnings])];
    // 形の合わない番号を保存時に落としたらその生値、そうでなければ読取側から来た生値（番号が入力されたら消す）。
    const rejected = sanitized.rejectedRegistrationNumber ?? (sanitized.facts.registrationNumber === undefined ? input.extraction?.rejectedRegistrationNumber : undefined);

    let receipt: ExpenseReceipt | undefined;
    if (input.receipt !== undefined) {
      receipt = createExpenseReceipt({
        tenant: input.scope, id: this.makeId(), claimId: claim.id, itemId,
        source: {
          type: input.source.type === 'pdf' ? 'pdf' : 'image', dataUrl: input.receipt.dataUrl,
          ...(input.receipt.fileName === undefined ? {} : { fileName: input.receipt.fileName }),
          ...(input.receipt.mime === undefined ? {} : { mime: input.receipt.mime }),
          ...(input.receipt.text === undefined ? {} : { text: input.receipt.text }),
        },
        sha256: receiptSha256(input.receipt.dataUrl),
        createdAt: at,
      });
    }
    const receiptId = receipt?.id ?? existing?.receiptId;
    const updated = putItem(claim, {
      id: itemId,
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(categoryText === undefined ? {} : { categoryText }),
      facts: sanitized.facts,
      ...(receiptId === undefined ? {} : { receiptId }),
      source: input.source,
      extraction: {
        method: input.extraction?.method ?? defaultMethod(input.source, input.extraction !== undefined),
        ...(input.extraction?.model === undefined ? {} : { model: input.extraction.model }),
        ...(input.extraction?.confidence === undefined ? {} : { confidence: input.extraction.confidence }),
        warnings,
        ...(input.extraction?.documentKind === undefined ? {} : { documentKind: input.extraction.documentKind }),
        ...(rejected === undefined ? {} : { rejectedRegistrationNumber: rejected }),
        ...(input.extraction?.flags === undefined ? {} : { flags: input.extraction.flags }),
        ...(input.extraction?.detail === undefined ? {} : { detail: input.extraction.detail as ExpenseDetailRecord }),
      },
      addedOn: existing?.addedOn ?? businessDateOf(now, this.timeZone),
    }, input.by, at);

    const hashes = new Map(await this.receipts.hashesByClaim(input.scope, claim.id));
    if (receipt !== undefined) hashes.set(itemId, receipt.sha256);
    await this.unitOfWork.withTransaction(async () => {
      if (receipt !== undefined) {
        // 差し替えたら古い証憑本体は消す（残すと同じ明細に 2 枚ぶら下がり、重複検出が古い画像を見続ける）。
        if (existing?.receiptId !== undefined) await this.receipts.delete(input.scope, existing.receiptId);
        await this.receipts.save(receipt);
      }
      await this.claims.save(updated, hashes);
    });
    return updated;
  }
}

export class DeleteExpenseItemUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly claimId: string; readonly itemId: string; readonly by: string }): Promise<ExpenseClaim> {
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    const item = claim.items.find((entry) => entry.id === input.itemId);
    const updated = removeItem(claim, input.itemId, input.by, this.now().toISOString());
    const hashes = new Map(await this.receipts.hashesByClaim(input.scope, claim.id));
    hashes.delete(input.itemId);
    await this.unitOfWork.withTransaction(async () => {
      if (item?.receiptId !== undefined) await this.receipts.delete(input.scope, item.receiptId);
      await this.claims.save(updated, hashes);
    });
    return updated;
  }
}

export class GetExpenseReceiptUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
  ) {}

  async execute(scope: TenantScope, claimId: string, itemId: string): Promise<ExpenseReceipt> {
    const claim = await requireClaim(this.claims, scope, claimId);
    const item = claim.items.find((entry) => entry.id === itemId);
    if (item === undefined) throw new ExpenseItemNotFoundError(`expense item not found: ${itemId} (claim ${claimId})`);
    const receipt = item.receiptId === undefined ? null : await this.receipts.findById(scope, item.receiptId);
    if (receipt === null) throw new ExpenseReceiptNotFoundError(`expense item ${itemId} has no receipt image`);
    return receipt;
  }
}

/** 一覧の合計（画面の件数バッジ用に export）。 */
export { claimTotalAmount };
