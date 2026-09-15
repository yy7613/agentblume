/**
 * application層: 汎用の経費明細 CSV の取込（docs/21 §6.3）。
 *
 * 申請者（氏名 + 社員番号）ごとに `draft` の申請を 1 件作る（`claimId` 指定時はその申請へ追記し、申請者列は無視）。
 * 読めない値は行を捨てずに項目を空にして警告を積み、行そのものが壊れているときだけ `skippedRows` にする。
 * 1 申請 100 明細を超える分は `skippedRows`（期間を分けてもらう）。保存は 1 トランザクションで行う。
 *
 * 従業員マスタを配線した構成では、新しく作る申請の申請者を**有効な従業員**に当てる（docs/21 §20.1.1）: 社員番号の一致 →
 * 氏名キーの一意な一致の順。当たらない・同名が複数なら紐付けずに文字列のまま残す（同姓同名を黙って結ぶと、他人の口座へ振り込む事故になる）。
 */
import { randomUUID } from 'node:crypto';
import { businessDateOf, DEFAULT_BUSINESS_TIME_ZONE } from '../../domain/expense/business-date';
import { appendItems, CLAIM_MAX_ITEMS, claimantKeyOf, createExpenseClaim, validatePeriod, type Claimant, type ClaimPeriod, type ExpenseClaim, type ExpenseItem } from '../../domain/expense/claim';
import { parseClaimCsv, type ClaimCsvColumnMatch, type ClaimCsvSkippedRow } from '../../domain/expense/claim-csv';
import { employeeCodeKey, employeeNameKey, type ExpenseEmployee } from '../../domain/expense/employee';
import { ExpenseDomainError } from '../../domain/expense/errors';
import { resolveCategory } from '../../domain/expense/policy';
import { sanitizeReceiptFacts } from '../../domain/expense/receipt-facts';
import type { ExpenseClaimRepository, ExpensePolicyRepository, ExpenseReceiptRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { requireClaim, type ClaimantResolver } from './manage-claims';
import { loadExpensePolicy } from './manage-policy';
import type { EmployeeDirectoryPort } from './ports';

/** CSV の申請者を従業員マスタに当てるための依存（省略 = 当てない。MVP と同じ）。 */
export interface CsvClaimantMatching {
  readonly directory: EmployeeDirectoryPort;
  readonly claimants: ClaimantResolver;
}

export interface ImportExpenseCsvInput {
  readonly scope: TenantScope;
  readonly content: string;
  readonly period: ClaimPeriod;
  readonly claimId?: string;
  readonly fileName?: string;
  readonly by: string;
}

export interface ImportedClaimRef {
  readonly id: string;
  readonly claimant: Claimant;
  readonly itemCount: number;
  /** この取込で足した明細の件数。 */
  readonly importedCount: number;
  readonly created: boolean;
}

export interface ImportExpenseCsvResult {
  readonly claims: readonly ImportedClaimRef[];
  readonly skippedRows: readonly ClaimCsvSkippedRow[];
  readonly warnings: readonly string[];
  readonly columnMatches: readonly ClaimCsvColumnMatch[];
}

export class ImportExpenseCsvUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly policies: ExpensePolicyRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
    private readonly employees?: CsvClaimantMatching,
  ) {}

  /** 申請者を有効な従業員に当てる関数（社員番号の一致 → 氏名の一意な一致）。マスタが空なら何もしない。 */
  private async claimantMatcher(scope: TenantScope): Promise<(claimant: Claimant) => Promise<Claimant>> {
    const employees = this.employees;
    if (employees === undefined) return async (claimant) => claimant;
    const enabled = await employees.directory.list(scope, { enabled: true });
    if (enabled.length === 0) return async (claimant) => claimant;
    const byKey = (keyOf: (employee: ExpenseEmployee) => string | undefined): Map<string, ExpenseEmployee[]> => {
      const map = new Map<string, ExpenseEmployee[]>();
      for (const employee of enabled) {
        const key = keyOf(employee);
        if (key !== undefined) map.set(key, [...(map.get(key) ?? []), employee]);
      }
      return map;
    };
    const byCode = byKey((employee) => (employee.code === undefined ? undefined : employeeCodeKey(employee.code)));
    const byName = byKey((employee) => employeeNameKey(employee.name));
    return async (claimant) => {
      const code = claimant.employeeCode === undefined ? undefined : byCode.get(employeeCodeKey(claimant.employeeCode));
      const matched = code?.length === 1 ? code[0] : byName.get(employeeNameKey(claimant.name))?.length === 1 ? byName.get(employeeNameKey(claimant.name))?.[0] : undefined;
      return matched === undefined ? claimant : employees.claimants.resolve(scope, { ...claimant, employeeId: matched.id });
    };
  }

  async execute(input: ImportExpenseCsvInput): Promise<ImportExpenseCsvResult> {
    const period = validatePeriod(input.period, 'import expense CSV: period');
    const target = input.claimId === undefined ? undefined : await requireClaim(this.claims, input.scope, input.claimId);
    const parsed = parseClaimCsv(input.content, { requireClaimant: target === undefined });
    const { policy } = await loadExpensePolicy(this.policies, input.scope);
    const now = this.now();
    const at = now.toISOString();
    const today = businessDateOf(now, this.timeZone);
    const skippedRows: ClaimCsvSkippedRow[] = [...parsed.skippedRows];
    const matchClaimant = target === undefined ? await this.claimantMatcher(input.scope) : async (claimant: Claimant) => claimant;

    // 申請者ごとに束ねる（claimId 指定時は 1 束）。並びは CSV に最初に現れた順。
    const groups = new Map<string, { claimant: Claimant; items: ExpenseItem[]; capacity: number }>();
    for (const row of parsed.rows) {
      const claimant = target?.claimant ?? (row.claimant as Claimant);
      const key = target === undefined ? claimantKeyOf(claimant) : target.id;
      let group = groups.get(key);
      if (group === undefined) {
        group = { claimant, items: [], capacity: CLAIM_MAX_ITEMS - (target?.items.length ?? 0) };
        groups.set(key, group);
      }
      if (group.items.length >= group.capacity) {
        skippedRows.push({ row: row.line, reason: `1 つの申請に入る明細は ${CLAIM_MAX_ITEMS} 件までです。期間を分けてください` });
        continue;
      }
      let facts;
      try {
        facts = sanitizeReceiptFacts(row.facts, `CSV row ${row.line}`).facts;
      } catch (error) {
        if (!(error instanceof ExpenseDomainError)) throw error;
        skippedRows.push({ row: row.line, reason: error.message });
        continue;
      }
      const categoryId = resolveCategory(policy, row.categoryText)?.id;
      group.items.push({
        id: this.makeId(),
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(row.categoryText === undefined ? {} : { categoryText: row.categoryText }),
        facts,
        source: { type: 'csv-row', ...(input.fileName === undefined ? {} : { fileName: input.fileName }), row: row.record },
        extraction: { method: 'csv', warnings: row.warnings, ...(row.rejectedRegistrationNumber === undefined ? {} : { rejectedRegistrationNumber: row.rejectedRegistrationNumber }) },
        addedOn: today,
      });
    }

    const note = `CSV 取込${input.fileName === undefined ? '' : `: ${input.fileName}`}`;
    const saved: { claim: ExpenseClaim; importedCount: number; created: boolean }[] = [];
    for (const group of groups.values()) {
      if (group.items.length === 0) continue;
      if (target !== undefined) {
        saved.push({ claim: appendItems(target, group.items, input.by, at, note), importedCount: group.items.length, created: false });
        continue;
      }
      const claim = createExpenseClaim({
        tenant: input.scope, claimant: await matchClaimant(group.claimant), period, items: group.items, acknowledgements: [],
        history: [{ type: 'created', by: input.by, at, note }], submittedBy: input.by, createdAt: at, updatedAt: at,
      }, this.makeId);
      saved.push({ claim, importedCount: group.items.length, created: true });
    }
    await this.unitOfWork.withTransaction(async () => {
      for (const entry of saved) {
        await this.claims.save(entry.claim, entry.created ? new Map() : await this.receipts.hashesByClaim(input.scope, entry.claim.id));
      }
    });
    return {
      claims: saved.map((entry) => ({ id: entry.claim.id, claimant: entry.claim.claimant, itemCount: entry.claim.items.length, importedCount: entry.importedCount, created: entry.created })),
      skippedRows: skippedRows.sort((left, right) => left.row - right.row),
      warnings: parsed.warnings,
      columnMatches: parsed.columnMatches,
    };
  }
}
