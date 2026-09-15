/**
 * ドメイン: 振込データの組み立てと点検（`planPayout`。docs/21 §20.5.2 / §20.6.5。UC3。純関数）。
 *
 * 1. 対象: 指定の申請（承認済み・振込バッチに入っていない・仮払に紐付かない）、仮払の支払（承認済み・未払い）、
 *    仮払の追加支給（精算中・追加支給が支払待ち）。
 * 2. 行: 従業員ごとに合算（同じ従業員は 1 行。口座は現在の従業員マスタ）。返金（差額が負）は**相殺しない**
 *    （返金の仮払はそもそも対象にならず、他の支払から差し引かない）。
 * 3. 点検: §20.5.2 の順（振込元 → 申請・紐付け → 口座 → 名義 → 金額・件数 → 二重 → 日付 → 警告）で**全件**を集める。
 *    従業員の口座・名義（未登録・桁不正・禁止文字・**30 バイト超は切り詰めずに止める**・銀行名・書式の変換・直近 30 日の口座変更）は
 *    系統 A の `employeePayoutReadiness` をそのまま使い、同じ点検を二重に持たない。
 * 点検の 1 件は骨格の `payoutProblem`（原因・次の一手・導線）、止める / 警告は `isBlockingPayoutProblem` で分ける。
 */
import type { BankAccount } from '../bank-account';
import type { ExpenseEmployee } from '../employee';
import { EXPENSE_PAYOUT_BLOCKING_CODES, EXPENSE_PAYOUT_WARNING_CODES, type ExpensePayoutProblem } from '../errors';
import { isBlockingPayoutProblem, payoutProblem, ZENGIN_MAX_AMOUNT, type ExpensePayoutBatch, type ExpensePayoutSettings, type PayoutSourceKind } from '../payout';
import { employeePayoutReadiness } from '../people/payout-readiness';

/** 振込の対象になりうる申請の要約。`amount` は従業員へ支払う額（`reimbursableAmount`）。 */
export interface PayoutClaimRef {
  readonly id: string;
  readonly status: string;
  readonly employeeId?: string;
  readonly claimantName: string;
  readonly advanceId?: string;
  readonly payoutBatchId?: string;
  readonly amount: number;
  readonly journalLinked: 'none' | 'partial' | 'complete';
}

/** 振込の対象になりうる仮払の要約（支払 / 追加支給）。 */
export interface PayoutAdvanceRef {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly status: string;
  readonly amount: number;
  readonly paid: boolean;
  readonly additionalPayment?: { readonly amount: number; readonly status: string; readonly payoutBatchId?: string };
}

export interface PayoutPlanInput {
  readonly settings: ExpensePayoutSettings;
  readonly transferDate: string;
  /** 業務のタイムゾーンの今日（振込日が過去かの判定）。 */
  readonly today: string;
  /** 直近の口座変更の判定に使う時刻。 */
  readonly now: Date;
  readonly claims: readonly PayoutClaimRef[];
  readonly advancePayments: readonly PayoutAdvanceRef[];
  readonly advanceAdditionals: readonly PayoutAdvanceRef[];
  readonly employees: readonly ExpenseEmployee[];
  /** 取消されていない振込バッチ（二重の振込を防ぐ）。 */
  readonly activeBatches: readonly ExpensePayoutBatch[];
}

export interface PlannedPayoutLine {
  readonly employeeId: string;
  readonly name: string;
  readonly employeeCode?: string;
  readonly holderKanaConverted: string;
  readonly bank: BankAccount;
  readonly amount: number;
  readonly sources: readonly { readonly kind: PayoutSourceKind; readonly id: string; readonly amount: number }[];
}

export interface PayoutPlan {
  readonly lines: readonly PlannedPayoutLine[];
  readonly recordCount: number;
  readonly totalAmount: number;
  /** 止める理由（1 件でもあればファイルを作らない）。 */
  readonly problems: readonly ExpensePayoutProblem[];
  /** 確認必須の警告（全コードを確認済みにして送ったときだけ作る）。 */
  readonly warnings: readonly ExpensePayoutProblem[];
}

interface Group {
  readonly employeeId: string;
  readonly sources: { kind: PayoutSourceKind; id: string; amount: number }[];
}

const order = (codes: readonly string[]) => (left: ExpensePayoutProblem, right: ExpensePayoutProblem): number => codes.indexOf(left.code) - codes.indexOf(right.code);

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

function findActive(batches: readonly ExpensePayoutBatch[], kind: PayoutSourceKind, id: string): ExpensePayoutBatch | undefined {
  return batches.find((batch) => batch.status !== 'cancelled' && batch.lines.some((line) => line.sources.some((source) => source.kind === kind && source.id === id)));
}

/** 振込の対象を点検して従業員ごとの行にする。 */
export function planPayout(input: PayoutPlanInput): PayoutPlan {
  const { settings } = input;
  const found: ExpensePayoutProblem[] = [];
  if (settings.source === undefined || settings.requesterCode === undefined || settings.requesterNameKana === undefined) {
    found.push(payoutProblem('payout-source-missing', {}, { field: settings.source === undefined ? 'source' : settings.requesterCode === undefined ? 'requesterCode' : 'requesterNameKana' }));
  }

  const employees = new Map(input.employees.map((employee) => [employee.id, employee]));
  const groups = new Map<string, Group>();
  const add = (employeeId: string, kind: PayoutSourceKind, id: string, amount: number): void => {
    if (amount <= 0) return;
    const group = groups.get(employeeId) ?? { employeeId, sources: [] };
    group.sources.push({ kind, id, amount });
    groups.set(employeeId, group);
  };
  const exported = (batch: ExpensePayoutBatch, label: string, refs: { readonly claimId?: string; readonly advanceId?: string }): void => {
    found.push(payoutProblem('payout-already-exported', { claimId: label, batchId: batch.id, createdAt: batch.createdAt }, refs));
  };

  let unjournaled = 0;
  for (const claim of input.claims) {
    const refs = { claimId: claim.id };
    const batch = findActive(input.activeBatches, 'claim', claim.id);
    if (batch !== undefined || claim.payoutBatchId !== undefined) {
      const active = batch ?? input.activeBatches.find((entry) => entry.id === claim.payoutBatchId);
      if (active !== undefined) exported(active, claim.id, refs);
      else found.push(payoutProblem('payout-already-exported', { claimId: claim.id, batchId: claim.payoutBatchId ?? '', createdAt: '' }, refs));
      continue;
    }
    if (claim.status !== 'approved') { found.push(payoutProblem('payout-claim-not-approved', { claimId: claim.id, status: claim.status }, refs)); continue; }
    if (claim.advanceId !== undefined) { found.push(payoutProblem('payout-claim-not-approved', { claimId: claim.id, status: `仮払 ${claim.advanceId} で精算する申請` }, refs)); continue; }
    if (claim.employeeId === undefined || !employees.has(claim.employeeId)) { found.push(payoutProblem('payout-employee-unlinked', { claimId: claim.id }, refs)); continue; }
    if (claim.amount <= 0) continue;
    if (claim.journalLinked !== 'complete') unjournaled += 1;
    add(claim.employeeId, 'claim', claim.id, claim.amount);
  }
  for (const advance of input.advancePayments) {
    const refs = { advanceId: advance.id };
    const label = `仮払 ${advance.id}`;
    const batch = findActive(input.activeBatches, 'advance-payment', advance.id);
    if (batch !== undefined) { exported(batch, label, refs); continue; }
    if (advance.status !== 'approved' || advance.paid) { found.push(payoutProblem('payout-claim-not-approved', { claimId: label, status: advance.status }, refs)); continue; }
    if (!employees.has(advance.employeeId)) { found.push(payoutProblem('payout-employee-unlinked', { claimId: label }, refs)); continue; }
    add(advance.employeeId, 'advance-payment', advance.id, advance.amount);
  }
  for (const advance of input.advanceAdditionals) {
    const refs = { advanceId: advance.id };
    const label = `仮払 ${advance.id} の追加支給`;
    const batch = findActive(input.activeBatches, 'advance-additional', advance.id);
    if (batch !== undefined) { exported(batch, label, refs); continue; }
    const extra = advance.additionalPayment;
    if (advance.status !== 'settling' || extra === undefined || extra.status !== 'pending') { found.push(payoutProblem('payout-claim-not-approved', { claimId: label, status: advance.status }, refs)); continue; }
    if (!employees.has(advance.employeeId)) { found.push(payoutProblem('payout-employee-unlinked', { claimId: label }, refs)); continue; }
    add(advance.employeeId, 'advance-additional', advance.id, extra.amount);
  }

  const lines: PlannedPayoutLine[] = [];
  const sortedGroups = [...groups.values()].sort((left, right) => (left.employeeId < right.employeeId ? -1 : left.employeeId > right.employeeId ? 1 : 0));
  for (const group of sortedGroups) {
    const employee = employees.get(group.employeeId) as ExpenseEmployee;
    const readiness = employeePayoutReadiness(employee, settings.format, input.now);
    found.push(...readiness.problems, ...readiness.warnings);
    const amount = group.sources.reduce((sum, source) => sum + source.amount, 0);
    if (amount > ZENGIN_MAX_AMOUNT) found.push(payoutProblem('payout-amount-too-large', { employee: employee.name, amount }, { employeeId: employee.id }));
    if (readiness.problems.length > 0 || employee.bankAccount === undefined || amount > ZENGIN_MAX_AMOUNT) continue;
    lines.push({
      employeeId: employee.id, name: employee.name, holderKanaConverted: readiness.holderKanaConverted ?? '', bank: employee.bankAccount, amount, sources: group.sources,
      ...(employee.code === undefined ? {} : { employeeCode: employee.code }),
    });
  }
  if (groups.size > settings.format.maxRecords) found.push(payoutProblem('payout-too-many-records', { count: groups.size, max: settings.format.maxRecords }));
  if (input.transferDate < input.today) found.push(payoutProblem('payout-transfer-date-invalid', { transferDate: input.transferDate }, { field: 'transferDate' }));
  else if (isWeekend(input.transferDate)) found.push(payoutProblem('payout-transfer-date-weekend', { transferDate: input.transferDate }, { field: 'transferDate' }));
  if (unjournaled > 0) found.push(payoutProblem('payout-no-journal', { count: unjournaled }));

  return {
    lines,
    recordCount: lines.length,
    totalAmount: lines.reduce((sum, line) => sum + line.amount, 0),
    problems: found.filter((problem) => isBlockingPayoutProblem(problem.code)).sort(order(EXPENSE_PAYOUT_BLOCKING_CODES)),
    warnings: found.filter((problem) => !isBlockingPayoutProblem(problem.code)).sort(order(EXPENSE_PAYOUT_WARNING_CODES)),
  };
}

/** 確認されていない警告のコード（すべて確認済みなら空）。 */
export function unacknowledgedWarnings(warnings: readonly ExpensePayoutProblem[], acknowledged: readonly string[]): readonly string[] {
  const done = new Set(acknowledged);
  return [...new Set(warnings.map((warning) => warning.code))].filter((code) => !done.has(code));
}
