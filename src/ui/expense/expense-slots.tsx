/**
 * 経費精算画面の登録点（docs/21 §20.10.2。骨格。凍結）。
 *
 * 3 系統（A 人と承認 / B お金の流れ / C 入力と規程）の部品を、骨格がスタブとして作り**静的に import** して差し込む位置を固定する。
 * 系統の担当はスタブのファイルを書き換えるだけで画面に出る（`ExpensePage.tsx` やタブの骨格ファイルに触らない）。
 * props の型はここに置き、系統は名前と形を変えない（足りなければ骨格担当へ依頼する）。
 *
 * 動的な登録（配列に push する方式）にしないのは、どの位置に何が出るかを型と import で追えるようにし、
 * 系統ごとの登録順でタブの並びや表示が揺れないようにするため（ADR-0043 代替案と同じ理由）。
 */
import type { ComponentType } from 'react';
import type { ApiTransport } from '../api/business-api';
import type {
  ExpenseCapabilitiesDto, ExpenseCategoryDto, ExpenseClaimDto, ExpenseClaimSummaryDto, ExpenseItemDraftDto, ExpensePolicyDto, ExpensePolicyResultDto,
  ExpenseReceiptRouteDto, ExpenseTransportSettingsDto, SaveExpensePolicyDto,
} from '../api/expense-types';
import type { JournalChartOfAccountsDto, TenantScopeDto } from '../api/types';
import type { OpenTarget } from '../navigation';
import type { ClaimFormDraft, ExpenseTab } from './expense-model';
import type { ExpenseFocusRequest } from './expense-shared';
import { AdvanceLinkField } from './money/AdvanceLinkField';
import { AdvancesLedger } from './money/AdvancesLedger';
import { CardsLedger } from './money/CardsLedger';
import { MoneySettingsSection } from './money/MoneySettingsSection';
import { PayoutPanel } from './money/PayoutPanel';
import { ReportsLedger } from './money/ReportsLedger';
import { DetailReadToggle } from './input/DetailReadToggle';
import { FaresLedger } from './input/FaresLedger';
import { PolicyHearingPanel as InputPolicyHearingPanel } from './input/PolicyHearingPanel';
import { RouteFields } from './input/RouteFields';
import { TransportSettingsSection } from './input/TransportSettingsSection';
import { ApprovalFlowPanel as PeopleApprovalFlowPanel } from './people/ApprovalFlowPanel';
import { ApprovalRoutesSection } from './people/ApprovalRoutesSection';
import { ClaimantPicker } from './people/ClaimantPicker';
import { EmployeesLedger } from './people/EmployeesLedger';

/* ---------------------------------------------------------------------------
 * props の型
 * ------------------------------------------------------------------------- */

/** すべてのスロットが受け取るもの。API クライアントは `expense<People|Money|Input>Api(transport)` で作る。 */
export interface ExpenseSlotBaseProps {
  readonly transport: ApiTransport;
  readonly scope: TenantScopeDto;
  /** 経費画面の中の対象を開く（`parseExpenseTarget` の section。台帳の行・申請の欄・規程の節）。 */
  readonly onOpen: (target: OpenTarget) => void;
}

/** 台帳タブ（従業員・組織 / 仮払金 / カード明細 / 運賃マスタ / レポート）。 */
export interface ExpenseLedgerSlotProps extends ExpenseSlotBaseProps {
  readonly policy: ExpensePolicyResultDto | undefined;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly chart: JournalChartOfAccountsDto | undefined;
  readonly capabilities: ExpenseCapabilitiesDto | undefined;
  /** 申請一覧を読み直す（紐付け・照合・精算で申請が変わったとき）。 */
  readonly onClaimsChanged: () => Promise<void> | void;
  /** 規程を読み直す（台帳から規程の設定を変えたとき）。 */
  readonly onReloadPolicy: () => Promise<void>;
  readonly onTab: (tab: ExpenseTab) => void;
  /** 導線で開かれた対象（section: employee / employee-commuter / organization / advance / card / cards / fares、id は行の id か空）。 */
  readonly focus: ExpenseFocusRequest | undefined;
}

/**
 * 規程タブの節（承認経路 / 交通費 / カード・仮払）。規程の下書きを編集し、保存は規程タブの「規程を保存」でまとめて行う
 * （節ごとに保存ボタンを持つと、未保存の費目の変更と食い違うため）。
 */
export interface ExpensePolicySectionSlotProps extends ExpenseSlotBaseProps {
  readonly draft: SaveExpensePolicyDto;
  readonly saved: boolean;
  /** 下書きを差し替える（規程タブが「保存していない変更」にする）。 */
  readonly onChange: (next: SaveExpensePolicyDto) => void;
  readonly chart: JournalChartOfAccountsDto | undefined;
  /** 導線で開かれた対象（approval の id は経路 id か空）。 */
  readonly focus: ExpenseFocusRequest | undefined;
}

/** 規程タブの「社内規程から案を作る」。提案の採用はサーバーが規程を保存するので、結果を `onPolicySaved` で返す。 */
export interface ExpensePolicyHearingSlotProps extends ExpenseSlotBaseProps {
  /** 保存済みの規程（差分の基準。`updatedAt` を `basePolicyUpdatedAt` に使う）。 */
  readonly policy: ExpensePolicyDto;
  /** 規程タブに未保存の変更があるか（採用すると下書きが読み直しで消えるので、確認に使う）。 */
  readonly dirty: boolean;
  readonly capabilities: ExpenseCapabilitiesDto | undefined;
  readonly onPolicySaved: (next: ExpensePolicyResultDto) => void;
}

/** 申請の作成・編集フォームの申請者欄（氏名の入力欄の隣に出る）。 */
export interface ExpenseClaimantFieldSlotProps extends ExpenseSlotBaseProps {
  readonly mode: 'new' | 'edit';
  readonly claim: ExpenseClaimDto | undefined;
  readonly draft: ClaimFormDraft;
  /** 下書きを差し替える（`employeeId` を入れると保存本文に載る）。 */
  readonly onChange: (next: ClaimFormDraft) => void;
  /** 氏名の入力欄の id（導線 `claimant` はここへフォーカスする）。 */
  readonly inputId: string;
}

/** 申請の詳細の「仮払の紐付け」（id `expense-claim-advance-link` の中に出る）。 */
export interface ExpenseClaimAdvanceFieldSlotProps extends ExpenseSlotBaseProps {
  readonly claim: ExpenseClaimDto;
  /** 承認済み・精算済み・承認中は編集できない。 */
  readonly editable: boolean;
  readonly onClaimChanged: (next: ExpenseClaimDto) => void;
  /** 導線 `advance-link` で開かれた（印を付ける）。 */
  readonly focused: boolean;
}

/** 承認タブの詳細の承認の流れ（段・承認者・状態・代理の印）。 */
export interface ExpenseApprovalFlowSlotProps extends ExpenseSlotBaseProps {
  readonly claim: ExpenseClaimDto;
  readonly onClaimChanged: (next: ExpenseClaimDto) => void;
  readonly onClaimsChanged: () => Promise<void> | void;
}

/** 精算出力タブの振込データ（全銀協）。 */
export interface ExpenseSettlePayoutSlotProps extends ExpenseSlotBaseProps {
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly onClaimsChanged: () => Promise<void> | void;
}

/** 明細フォームの区間欄。フォームは `expense-form` のグリッドなので、行いっぱいに使うならクラス `expense-wide` を付ける。 */
export interface ExpenseItemRouteSlotProps extends ExpenseSlotBaseProps {
  readonly claim: ExpenseClaimDto;
  /** 選んでいる費目（`route` の設定があるときだけ区間欄を出す）。 */
  readonly category: ExpenseCategoryDto | undefined;
  readonly transportSettings: ExpenseTransportSettingsDto | undefined;
  /** 取引日（運賃の有効期間・定期の有効期限の照合に使う。空文字 = 未入力）。 */
  readonly transactionDate: string;
  readonly route: ExpenseReceiptRouteDto | undefined;
  /** undefined で区間を消す。 */
  readonly onChange: (next: ExpenseReceiptRouteDto | undefined) => void;
  /** 最初の入力欄の id（導線 `item-route:<itemId>` はここへフォーカスする）。 */
  readonly inputId: string;
}

/**
 * 画像読取の追加読取。`reader` は読み取りの前の切替（既定 off・端末に記憶は C が持つ）、`draft` は読取の結果の行ごとの「追加で読む」。
 * `detail` が true のとき、骨格は `/expense/receipts/extract` に `detail: true` を付けて送る。
 */
export type ExpenseDetailReadSlotProps = ExpenseSlotBaseProps & { readonly capabilities: ExpenseCapabilitiesDto | undefined } & (
  | { readonly placement: 'reader'; readonly detail: boolean; readonly onDetailChange: (next: boolean) => void }
  | { readonly placement: 'draft'; readonly draft: ExpenseItemDraftDto; readonly images: readonly string[]; readonly onDraftChange: (next: ExpenseItemDraftDto) => void }
);

/* ---------------------------------------------------------------------------
 * スロット（§20.10.2 の表）
 * ------------------------------------------------------------------------- */

// A: 人と承認
export const LedgerEmployees: ComponentType<ExpenseLedgerSlotProps> = EmployeesLedger;
export const PolicyApprovalRoutes: ComponentType<ExpensePolicySectionSlotProps> = ApprovalRoutesSection;
export const ClaimantField: ComponentType<ExpenseClaimantFieldSlotProps> = ClaimantPicker;
export const ApprovalFlowPanel: ComponentType<ExpenseApprovalFlowSlotProps> = PeopleApprovalFlowPanel;

// B: お金の流れ
export const LedgerAdvances: ComponentType<ExpenseLedgerSlotProps> = AdvancesLedger;
export const LedgerCards: ComponentType<ExpenseLedgerSlotProps> = CardsLedger;
export const LedgerReports: ComponentType<ExpenseLedgerSlotProps> = ReportsLedger;
export const PolicyMoneySettings: ComponentType<ExpensePolicySectionSlotProps> = MoneySettingsSection;
export const ClaimAdvanceField: ComponentType<ExpenseClaimAdvanceFieldSlotProps> = AdvanceLinkField;
export const SettlePayoutPanel: ComponentType<ExpenseSettlePayoutSlotProps> = PayoutPanel;

// C: 入力と規程
export const LedgerFares: ComponentType<ExpenseLedgerSlotProps> = FaresLedger;
export const PolicyTransportSettings: ComponentType<ExpensePolicySectionSlotProps> = TransportSettingsSection;
export const PolicyHearingPanel: ComponentType<ExpensePolicyHearingSlotProps> = InputPolicyHearingPanel;
export const ItemRouteFields: ComponentType<ExpenseItemRouteSlotProps> = RouteFields;
export const DetailReadControls: ComponentType<ExpenseDetailReadSlotProps> = DetailReadToggle;

/** 台帳タブ → スロット（`ExpensePage` の 2 段目のタブ列が使う）。 */
export const EXPENSE_LEDGER_SLOTS = {
  employees: LedgerEmployees, advances: LedgerAdvances, cards: LedgerCards, fares: LedgerFares, reports: LedgerReports,
} as const satisfies Record<Exclude<ExpenseTab, 'policy' | 'ingest' | 'check' | 'approve' | 'settle'>, ComponentType<ExpenseLedgerSlotProps>>;
