/**
 * ドメイン: 規程の初期テンプレート（docs/21 §5.3）。
 *
 * **ここに書いた数値・費目はすべて初期値**で、利用者が自社の規程と見比べて保存するまで判定は `policy-unreviewed` を出す。
 * 上限額・費目名がコードに現れてよいのはこのファイルだけ（判定コードは規程のデータしか見ない。テストで固定する）。
 * 科目 id は仕訳の標準セット（`journal/default-chart.ts`）の id、税区分コードも標準セットのもの。
 */
import { createExpensePolicy, type ExpenseCategory, type ExpensePolicy } from './policy';

/** 初期テンプレートの版（`updatedAt`）。保存したことが無いワークスペースはこの時刻を返す。 */
export const DEFAULT_EXPENSE_POLICY_UPDATED_AT = '2026-09-14T00:00:00.000Z';

const TAX_CODES = { '10': 'JP-IN-10-S', '8': 'JP-IN-8R-S', '0': 'JP-IN-NA' } as const;

type Seed = Omit<ExpenseCategory, 'enabled' | 'sortOrder' | 'taxCodeByRate' | 'defaultTaxRate'> & Partial<Pick<ExpenseCategory, 'defaultTaxRate'>>;

const REQUIRED = { required: true } as const;
const NOT_REQUIRED = { required: false } as const;
const PURPOSE_ONLY = { purpose: true, attendees: false, attendeeDetails: false } as const;
const NOTHING = { purpose: false, attendees: false, attendeeDetails: false } as const;

const CATEGORY_SEEDS: readonly Seed[] = [
  // 区間の検査（UC8）は電車・バスだけ既定で有効にする。運賃マスタ・通勤定期が空なら何も出ない（§20.2.2）。
  { id: 'transport.public', name: '電車・バス', aliases: ['電車', 'バス', '電車代', 'バス代', '地下鉄', '交通費'], accountId: 'expense.travel', receipt: NOT_REQUIRED, invoice: { required: true, exemptBelow: 30_000 }, requires: PURPOSE_ONLY, limits: { perPersonBasis: 'tax-included' }, note: '3 万円未満の公共交通機関は帳簿のみ保存で仕入税額控除ができます', route: { required: true, commuterPass: true, fareTable: true } },
  { id: 'transport.taxi', name: 'タクシー', aliases: ['タクシー代', 'ハイヤー'], accountId: 'expense.travel', receipt: REQUIRED, invoice: REQUIRED, requires: PURPOSE_ONLY, limits: { perItem: 10_000, perPersonBasis: 'tax-included' } },
  { id: 'travel.long', name: '新幹線・航空券', aliases: ['新幹線', '航空券', '飛行機'], accountId: 'expense.travel', receipt: REQUIRED, invoice: REQUIRED, requires: PURPOSE_ONLY, limits: { perPersonBasis: 'tax-included' } },
  { id: 'travel.lodging', name: '宿泊費', aliases: ['宿泊', 'ホテル'], accountId: 'expense.travel', receipt: REQUIRED, invoice: REQUIRED, requires: PURPOSE_ONLY, limits: { perPersonBasis: 'tax-included', perUnit: { label: '泊', amount: 12_000 } } },
  { id: 'travel.per_diem', name: '日当', aliases: ['出張日当'], accountId: 'expense.travel', receipt: NOT_REQUIRED, invoice: NOT_REQUIRED, requires: PURPOSE_ONLY, limits: { perPersonBasis: 'tax-included', perUnit: { label: '日', amount: 3_000 } }, note: '出張旅費規程に基づく支給は帳簿のみ保存で仕入税額控除ができます' },
  { id: 'meal.meeting', name: '会議費（打合せの飲食）', aliases: ['会議費', '打合せ', '会議用弁当'], accountId: 'expense.meetings', receipt: REQUIRED, invoice: REQUIRED, requires: { purpose: true, attendees: true, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' }, note: '1 人あたりの基準を決めている会社は上限を入れてください' },
  { id: 'meal.entertainment', name: '交際費（接待の飲食）', aliases: ['交際費', '接待', '接待交際費'], accountId: 'expense.entertainment', receipt: REQUIRED, invoice: REQUIRED, requires: { purpose: true, attendees: true, attendeeDetails: true }, limits: { perPerson: 10_000, perPersonBasis: 'tax-included' }, note: '1 人 10,000 円以下の飲食費は交際費から除外できます（2024-04-01 以後。税抜経理なら基準を税抜に変えてください）' },
  { id: 'supplies', name: '消耗品・事務用品', aliases: ['消耗品', '事務用品', '文具', '文房具'], accountId: 'expense.supplies', receipt: REQUIRED, invoice: REQUIRED, requires: NOTHING, limits: { perItem: 100_000, perPersonBasis: 'tax-included' }, note: '10 万円以上は固定資産の確認が要ります' },
  { id: 'books', name: '書籍・資料', aliases: ['書籍', '図書', '新聞図書費'], accountId: 'expense.books', receipt: REQUIRED, invoice: REQUIRED, requires: NOTHING, limits: { perPersonBasis: 'tax-included' } },
  { id: 'communication', name: '通信費・切手', aliases: ['通信費', '切手', '郵便'], accountId: 'expense.communication', receipt: REQUIRED, invoice: REQUIRED, requires: NOTHING, limits: { perPersonBasis: 'tax-included' } },
  { id: 'shipping', name: '送料・宅配', aliases: ['送料', '宅配', '宅配便', '運賃'], accountId: 'expense.shipping', receipt: REQUIRED, invoice: REQUIRED, requires: NOTHING, limits: { perPersonBasis: 'tax-included' } },
  { id: 'misc', name: 'その他', aliases: ['雑費'], accountId: 'expense.misc', receipt: REQUIRED, invoice: REQUIRED, requires: PURPOSE_ONLY, limits: { perItem: 30_000, perPersonBasis: 'tax-included' } },
];

/** 初期テンプレートを指定時刻で組み立てる（「初期テンプレートに戻す」で保存する用にも使う）。 */
export function defaultExpensePolicy(updatedAt: string = DEFAULT_EXPENSE_POLICY_UPDATED_AT): ExpensePolicy {
  return createExpensePolicy({
    categories: CATEGORY_SEEDS.map((seed, index) => ({ ...seed, enabled: true, sortOrder: (index + 1) * 10, defaultTaxRate: seed.defaultTaxRate ?? 10, taxCodeByRate: { ...TAX_CODES } })),
    claimRules: {
      submissionDeadlineDays: 90,
      nonReimbursablePaymentMethods: [],
      attendeesIncludeClaimant: true,
      // ローカルで 1 人で使うと承認できなくなるので既定は off。規程タブに「複数人で運用するなら on」を出す。
      forbidSelfApproval: false,
    },
    preApprovalRules: [
      { id: 'entertainment-50000', name: '交際費で 1 件 50,000 円以上', enabled: true, categoryIds: ['meal.entertainment'], minAmount: 50_000 },
      { id: 'any-100000', name: '1 件 100,000 円以上', enabled: true, categoryIds: [], minAmount: 100_000 },
    ],
    severityOverrides: {},
    journal: { creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '立替精算 {claimant} {payee} {category}' },
    updatedAt,
  });
}
