/**
 * application層: 経費精算の実用化の拡張点（ポート。docs/21 §20.3.1 / §20.13.2。骨格。凍結）。
 *
 * 系統の担当はこのポートを実装し、骨格のユースケース（判定・承認・読取・仕訳連携）は実装を知らずに呼ぶ。
 * スタブ（`people/` `money/` `input/` の同名ファイル）は MVP と同じ動き（事実なし・1 段承認・追加読取なし）を返す。
 */
import type { ApprovalFlow, ApprovalPlan } from '../../domain/expense/approval';
import type { CheckExtensionsInput } from '../../domain/expense/check-extensions';
import type { ExpenseClaim } from '../../domain/expense/claim';
import type { DetailDisagreementField } from '../../domain/expense/detail-read';
import type { ExpenseEmployee } from '../../domain/expense/employee';
import type { ExpenseBlockingReason } from '../../domain/expense/errors';
import type { ExpenseOrganization } from '../../domain/expense/organization';
import type { ExpensePolicy } from '../../domain/expense/policy';
import type { ExpenseEmployeeListOptions } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExpenseItemDraft } from './receipt-drafts';

/**
 * 経費の操作者（docs/21 §20.1.2）。作り方（従業員の解決・単一ユーザーの判定）は `actor.ts`。
 * 型をここに置くのは、`actor.ts` がこのファイルの `EmployeeDirectoryPort` を使うため（相互 import の循環を避ける）。
 */
export interface ExpenseActor {
  readonly subject: string;
  readonly displayName?: string;
  readonly roles: readonly string[];
  /** 単一ユーザーモード（全段を代理承認できる）。 */
  readonly singleUser: boolean;
  /** approve 権限を持つか（認可の表から api が決める）。 */
  readonly canApprove: boolean;
  /** ログイン ID で結んだ有効な従業員。 */
  readonly employeeId?: string;
}

/** 1 申請の判定に要る系統の事実を集める（索引で引く。画像本体は読まない）。 */
export interface ExpenseCheckFactsProvider {
  gather(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy, today: string): Promise<Partial<CheckExtensionsInput>>;
}

/** 事実を集めない provider（系統の配線が無い構成・テスト）。 */
export const NO_CHECK_FACTS: ExpenseCheckFactsProvider = { gather: async () => ({}) };

/** 従業員の読み取り（B の振込・仮払・カードの保有者、C の定期区間、骨格の申請者の写しが使う）。 */
export interface EmployeeDirectoryPort {
  findById(scope: TenantScope, id: string): Promise<ExpenseEmployee | null>;
  findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseEmployee[]>;
  findBySubject(scope: TenantScope, subject: string): Promise<ExpenseEmployee | null>;
  list(scope: TenantScope, options?: ExpenseEmployeeListOptions): Promise<readonly ExpenseEmployee[]>;
}

/** 組織の読み取り（未保存なら空の組織）。 */
export interface OrganizationReadPort {
  get(scope: TenantScope): Promise<ExpenseOrganization>;
}

/** 操作者が現在の段を承認できるか（A の `actorStepBlockers` の結果）。 */
export interface ApprovalActorDecision {
  /** §20.5.1 の擬似コード（空なら承認できる）。 */
  readonly blockers: readonly ExpenseBlockingReason[];
  /** 代理承認として記録するか（コメント必須）。 */
  readonly proxy: boolean;
}

/** 承認経路の解決（A）。スタブは MVP の 1 段（approve 権限を持つ誰でも）。 */
export interface ApprovalRoutePlanner {
  /** `checked` の申請の承認計画（承認時にも同じ関数で再計算する）。 */
  plan(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy): Promise<ApprovalPlan>;
  /** 操作者が `flow` の現在の段を承認できるか（`flow` は checked なら計画から作ったもの、in-approval なら保存済み）。 */
  actorBlockers(scope: TenantScope, input: { readonly claim: ExpenseClaim; readonly policy: ExpensePolicy; readonly flow: ApprovalFlow; readonly actor: ExpenseActor; readonly comment?: string }): Promise<ApprovalActorDecision>;
  /** 現在の段の承認者の従業員 id（`expense_claim_approvers` の入れ直しと「あなたの承認待ち」に使う）。 */
  currentApprovers(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy): Promise<readonly string[]>;
}

/** 経費専用の追加読取（C。§20.7.1）。仕訳の読取の結果（下書き）に対して、同じ画像で追加の構造化抽出を行う。 */
export interface ReceiptDetailReaderPort {
  /** 使えるか（モデル未設定・構造化出力や vision 非対応・test プロファイルでは false）。 */
  available(): Promise<boolean>;
  read(input: { readonly scope: TenantScope; readonly images: readonly string[]; readonly draft: ExpenseItemDraft }, signal?: AbortSignal): Promise<ReceiptDetailReadResult>;
}

export interface ReceiptDetailReadResult {
  /** 空欄だけを埋め、`extraction.flags` / `extraction.detail` を付けた下書き。 */
  readonly draft: ExpenseItemDraft;
  readonly disagreements: readonly { readonly field: DetailDisagreementField; readonly journalValue: string | null; readonly detailValue: string | null }[];
  readonly warnings: readonly string[];
}

/** 仕訳の科目マスタの読み取り（部門の補助軸の値の照合。§20.12）。composition が仕訳のユースケースを包む。 */
export interface JournalChartReadPort {
  read(scope: TenantScope): Promise<{
    readonly accounts: readonly { readonly id: string; readonly name: string; readonly enabled: boolean }[];
    readonly dimensions: readonly { readonly id: string; readonly name: string; readonly values: readonly { readonly id: string; readonly name: string; readonly enabled: boolean }[] }[];
  }>;
}
