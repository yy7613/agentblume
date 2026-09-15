/**
 * api層: 経費精算「人と承認（従業員・組織・紐付け候補・承認の流れ。docs/21 §20.9.2）」のリクエスト Zod スキーマ。
 *
 * 列挙は domain から import し、共通のスコープ検証は `./schemas` の `tenantScopeSchema` / `scopeQuerySchema` を使う（`expense-schemas.ts` と同じ方針）。
 * 値の不変条件（口座の桁・名義カナの 30 バイト・社員番号の一意・上長の循環）は domain / application が正本で、ここは形と入口の上限だけ。
 */
import { z } from 'zod';
import { BANK_ACCOUNT_TYPES } from '../domain/expense/bank-account';
import { CLAIM_STATUSES } from '../domain/expense/claim';
import { COMMUTER_PASSES_MAX, LOGIN_SUBJECTS_MAX } from '../domain/expense/employee';
import { EMPLOYEE_LINKS_MAX } from '../application/expense/people/link-employees';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

/** CSV 本文は 5 MiB（§20.9.2）。 */
const CSV_MAX_CHARS = 5 * 1024 * 1024;
const id = z.string().min(1).max(64);
const optionalText = (max: number) => z.string().max(max).optional();

export const expenseEmployeeListQuerySchema = scopeQuerySchema.extend({
  query: z.string().max(100).optional(),
  departmentId: z.string().max(64).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const expenseBankAccountInputSchema = z.object({
  bankCode: z.string().max(10),
  bankNameKana: optionalText(60),
  branchCode: z.string().max(10),
  branchNameKana: optionalText(60),
  accountType: z.enum(BANK_ACCOUNT_TYPES),
  /** 平文（省略・空 = 既存の口座番号を保つ）。 */
  accountNumber: z.string().max(20).optional(),
  holderKana: z.string().max(100),
});

export const expenseCommuterPassSchema = z.object({
  id,
  stations: z.array(z.string().max(40)).max(30),
  validFrom: z.string().max(10).optional(),
  validTo: z.string().max(10).optional(),
  note: optionalText(200),
});

export const saveExpenseEmployeeBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().max(64).optional(),
  code: optionalText(20),
  name: z.string().max(100),
  nameKana: optionalText(100),
  departmentId: z.string().max(64).optional(),
  managerEmployeeId: z.string().max(64).optional(),
  loginSubjects: z.array(z.string().max(200)).max(LOGIN_SUBJECTS_MAX).optional(),
  /** null で口座を外す。省略は既存を保つ。 */
  bankAccount: expenseBankAccountInputSchema.nullable().optional(),
  commuterPasses: z.array(expenseCommuterPassSchema).max(COMMUTER_PASSES_MAX).optional(),
  enabled: z.boolean().optional(),
  note: optionalText(500),
});

export const importExpenseEmployeesBodySchema = z.object({ scope: tenantScopeSchema, content: z.string().max(CSV_MAX_CHARS) });

const departmentSchema = z.object({
  id,
  code: optionalText(20),
  name: z.string().max(100),
  parentId: z.string().max(64).optional(),
  headEmployeeId: z.string().max(64).optional(),
  journalDimensionValueId: z.string().max(128).optional(),
  enabled: z.boolean(),
});

const approverGroupSchema = z.object({ id, name: z.string().max(100), memberEmployeeIds: z.array(z.string().max(64)).max(100), enabled: z.boolean() });

export const saveExpenseOrganizationBodySchema = z.object({
  scope: tenantScopeSchema,
  departments: z.array(departmentSchema).max(500),
  approverGroups: z.array(approverGroupSchema).max(50),
});

export const expenseEmployeeLinksQuerySchema = scopeQuerySchema.extend({ status: z.enum(CLAIM_STATUSES).optional() });

export const confirmExpenseEmployeeLinksBodySchema = z.object({
  scope: tenantScopeSchema,
  links: z.array(z.object({ claimId: id, employeeId: id })).min(1).max(EMPLOYEE_LINKS_MAX),
});

export const previewApprovalRouteBodySchema = z.object({
  scope: tenantScopeSchema,
  /** 規程の承認設定の下書き（形と参照は domain の `validateApprovalSettings` が検査する）。 */
  approval: z.unknown(),
  policyCategoryIds: z.array(z.string().max(64)).max(500),
  subject: z.object({
    categoryIds: z.array(z.string().max(64)).max(100),
    totalAmount: z.number().int().min(0).max(100_000_000_000),
    departmentId: z.string().max(64).optional(),
    claimantEmployeeId: z.string().max(64).optional(),
  }),
});
