/**
 * application層: 規程の費目 CSV の取込 / 出力（docs/21 §5.4）。
 *
 * **取込は費目の一覧だけを置き換え**、申請ルール・事前承認条件・重さ・仕訳設定は残す（科目 CSV と同じ規律）。
 * 事前承認条件が参照する費目が CSV から消える場合は、行番号ではなく**条件名と費目 id を並べて拒否**する。
 * 行の不正は行番号（ヘッダ = 1）付きの `ExpenseDomainError`（表計算ソフトの行番号と一致する）。
 */
import { ExpenseDomainError } from '../../domain/expense/errors';
import { createExpensePolicy, EXPENSE_TAX_RATES, PER_PERSON_BASES, type ExpenseCategory, type ExpensePolicy, type ExpenseTaxRate, type PerPersonBasis } from '../../domain/expense/policy';
import type { ExpensePolicyRepository } from '../../domain/expense/repositories';
import { parseCsv, rowToRecord, toCsv } from '../../domain/journal/csv';
import { JournalCsvImportError } from '../../domain/journal/errors';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { loadExpensePolicy } from './manage-policy';

export const EXPENSE_CATEGORY_CSV_COLUMNS = [
  'id', 'code', 'name', 'enabled', 'accountId', 'defaultTaxRate', 'taxCode10', 'taxCode8', 'taxCode0',
  'receiptRequired', 'receiptExemptBelow', 'invoiceRequired', 'invoiceExemptBelow',
  'requiresPurpose', 'requiresAttendees', 'requiresAttendeeDetails',
  'perItemLimit', 'perClaimLimit', 'perPersonLimit', 'perPersonBasis', 'perUnitLabel', 'perUnitLimit', 'aliases', 'note',
] as const;

/** 別名の区切り（`,` は CSV の区切りと衝突するので `;`）。 */
export const EXPENSE_CATEGORY_ALIAS_SEPARATOR = ';';
export const EXPENSE_CATEGORY_CSV_FILE_NAME = 'expense-categories.csv';
const UTF8_BOM = '﻿';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

export function categoriesToCsv(policy: Pick<ExpensePolicy, 'categories'>): string {
  const rows = policy.categories.map((category) => [
    category.id, category.code, category.name, bool(category.enabled), category.accountId, category.defaultTaxRate,
    category.taxCodeByRate['10'], category.taxCodeByRate['8'], category.taxCodeByRate['0'],
    bool(category.receipt.required), category.receipt.exemptBelow, bool(category.invoice.required), category.invoice.exemptBelow,
    bool(category.requires.purpose), bool(category.requires.attendees), bool(category.requires.attendeeDetails),
    category.limits.perItem, category.limits.perClaim, category.limits.perPerson, category.limits.perPersonBasis,
    category.limits.perUnit?.label, category.limits.perUnit?.amount, category.aliases.join(EXPENSE_CATEGORY_ALIAS_SEPARATOR), category.note,
  ]);
  return UTF8_BOM + toCsv([[...EXPENSE_CATEGORY_CSV_COLUMNS], ...rows]);
}

export class ExportExpensePolicyCsvUseCase {
  constructor(private readonly policies: ExpensePolicyRepository) {}

  async execute(scope: TenantScope): Promise<{ readonly content: string; readonly fileName: string }> {
    const { policy } = await loadExpensePolicy(this.policies, scope);
    return { content: categoriesToCsv(policy), fileName: EXPENSE_CATEGORY_CSV_FILE_NAME };
  }
}

function rowError(line: number, message: string): ExpenseDomainError {
  return new ExpenseDomainError(`expense categories CSV row ${line}: ${message}`, line);
}

function parseBoolean(raw: string, line: number, column: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw rowError(line, `${column} must be true or false (found: ${raw})`);
}

function parseLimit(raw: string, line: number, column: string): number | undefined {
  const value = raw.trim().replace(/,/gu, '');
  if (value === '') return undefined;
  if (!/^\d+$/u.test(value)) throw rowError(line, `${column} must be a whole number of yen or empty for no limit (found: ${raw})`);
  return Number(value);
}

/** CSV の 1 行 → 費目（値の範囲は `createExpensePolicy` が検証する）。 */
export function categoryFromCsvRecord(record: Readonly<Record<string, string>>, line: number, index: number): ExpenseCategory {
  const cell = (column: string): string => (record[column] ?? '').trim();
  const id = cell('id');
  if (id === '') throw rowError(line, 'id must not be empty');
  const rateText = cell('defaultTaxRate');
  const rate = rateText === '' ? 10 : Number(rateText);
  if (!(EXPENSE_TAX_RATES as readonly number[]).includes(rate)) throw rowError(line, `defaultTaxRate must be one of ${EXPENSE_TAX_RATES.join(', ')} (found: ${rateText})`);
  const basisText = cell('perPersonBasis');
  const basis = basisText === '' ? 'tax-included' : basisText;
  if (!(PER_PERSON_BASES as readonly string[]).includes(basis)) throw rowError(line, `perPersonBasis must be one of ${PER_PERSON_BASES.join(', ')} (found: ${basisText})`);
  const unitLabel = cell('perUnitLabel');
  const unitLimit = parseLimit(cell('perUnitLimit'), line, 'perUnitLimit');
  if ((unitLabel === '') !== (unitLimit === undefined)) throw rowError(line, 'perUnitLabel and perUnitLimit must be filled together (or both left empty)');
  const code = cell('code');
  const accountId = cell('accountId');
  const note = cell('note');
  const exempt = (column: string): number | undefined => parseLimit(cell(column), line, column);
  const taxCode = (column: string): string | undefined => (cell(column) === '' ? undefined : cell(column));
  return {
    id,
    ...(code === '' ? {} : { code }),
    name: cell('name'),
    enabled: parseBoolean(cell('enabled'), line, 'enabled', true),
    // 並びは CSV の行順（利用者が表計算ソフトで並べ替えた結果をそのまま採る）。
    sortOrder: (index + 1) * 10,
    aliases: cell('aliases').split(EXPENSE_CATEGORY_ALIAS_SEPARATOR).map((alias) => alias.trim()).filter((alias) => alias !== ''),
    ...(accountId === '' ? {} : { accountId }),
    defaultTaxRate: rate as ExpenseTaxRate,
    taxCodeByRate: {
      ...(taxCode('taxCode10') === undefined ? {} : { '10': taxCode('taxCode10') }),
      ...(taxCode('taxCode8') === undefined ? {} : { '8': taxCode('taxCode8') }),
      ...(taxCode('taxCode0') === undefined ? {} : { '0': taxCode('taxCode0') }),
    },
    receipt: { required: parseBoolean(cell('receiptRequired'), line, 'receiptRequired', true), ...(exempt('receiptExemptBelow') === undefined ? {} : { exemptBelow: exempt('receiptExemptBelow') }) },
    invoice: { required: parseBoolean(cell('invoiceRequired'), line, 'invoiceRequired', true), ...(exempt('invoiceExemptBelow') === undefined ? {} : { exemptBelow: exempt('invoiceExemptBelow') }) },
    requires: {
      purpose: parseBoolean(cell('requiresPurpose'), line, 'requiresPurpose', false),
      attendees: parseBoolean(cell('requiresAttendees'), line, 'requiresAttendees', false),
      attendeeDetails: parseBoolean(cell('requiresAttendeeDetails'), line, 'requiresAttendeeDetails', false),
    },
    limits: {
      ...(parseLimit(cell('perItemLimit'), line, 'perItemLimit') === undefined ? {} : { perItem: parseLimit(cell('perItemLimit'), line, 'perItemLimit') }),
      ...(parseLimit(cell('perClaimLimit'), line, 'perClaimLimit') === undefined ? {} : { perClaim: parseLimit(cell('perClaimLimit'), line, 'perClaimLimit') }),
      ...(parseLimit(cell('perPersonLimit'), line, 'perPersonLimit') === undefined ? {} : { perPerson: parseLimit(cell('perPersonLimit'), line, 'perPersonLimit') }),
      perPersonBasis: basis as PerPersonBasis,
      ...(unitLimit === undefined ? {} : { perUnit: { label: unitLabel, amount: unitLimit } }),
    },
    ...(note === '' ? {} : { note }),
  };
}

export class ImportExpensePolicyCsvUseCase {
  constructor(
    private readonly policies: ExpensePolicyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly content: string }): Promise<ExpensePolicy> {
    let table: string[][];
    try {
      table = parseCsv(input.content);
    } catch (error) {
      if (error instanceof JournalCsvImportError) throw new ExpenseDomainError(`expense categories CSV: ${error.message}`, error.row);
      throw error;
    }
    if (table.length === 0) throw new ExpenseDomainError('expense categories CSV: the file has no rows');
    const headers = table[0]!.map((header) => header.replace(/^﻿/u, '').trim());
    for (const required of ['id', 'name'] as const) {
      if (!headers.includes(required)) throw new ExpenseDomainError(`expense categories CSV: the header row must include the '${required}' column (found: ${headers.join(', ')})`);
    }
    const categories = table.slice(1).map((row, index) => categoryFromCsvRecord(rowToRecord(headers, row), index + 2, index));

    const { policy: base } = await loadExpensePolicy(this.policies, input.scope);
    const ids = new Set(categories.map((category) => category.id));
    const dangling = base.preApprovalRules.flatMap((rule) => rule.categoryIds.filter((id) => !ids.has(id)).map((id) => `「${rule.name}」→ ${id}`));
    if (dangling.length > 0) {
      throw new ExpenseDomainError(`expense categories CSV: pre-approval rules refer to categories that are not in the CSV: ${dangling.join(', ')}. 無効（enabled=false）にして残すか、事前承認条件から外してから取り込んでください`);
    }
    // CSV には交通費の区間の設定（`route`）の列が無いので、同じ id の費目の現在の設定を引き継ぐ（取込で黙って消さない）。
    const routes = new Map(base.categories.map((category) => [category.id, category.route]));
    const withRoutes = categories.map((category) => {
      const route = routes.get(category.id);
      return route === undefined ? category : { ...category, route };
    });
    try {
      const policy = createExpensePolicy({ ...base, categories: withRoutes, updatedAt: this.now().toISOString() });
      await this.policies.save(input.scope, policy);
      return policy;
    } catch (error) {
      // 規程の検証は配列の位置で言うので、表計算ソフトの行番号へ言い換える。
      const match = error instanceof ExpenseDomainError ? /categories\[(\d+)\]/u.exec(error.message) : null;
      if (match !== null) throw new ExpenseDomainError(`expense categories CSV row ${Number(match[1]) + 2}: ${(error as Error).message}`, Number(match[1]) + 2);
      throw error;
    }
  }
}
