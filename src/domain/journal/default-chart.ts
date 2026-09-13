/**
 * ドメイン: 科目マスタの標準セット（seed。docs/20 §5）。
 *
 * 青色申告決算書（一般用）の科目 + 会計ソフト慣用科目 + 仕訳相手科目（資産・負債・純資産）。
 * id は ascii スラッグ（`expense.supplies` 等）で、利用者が改名しても id は変わらない。
 * 税区分は内部コード `JP-{IN|OUT|NA}-{RATE}-{KIND}[-D{割合}]` で、弥生 / freee / MF の表示名を `mapping` に持つ。
 * ここに無いものは利用者がマスタで追加する（コードにハードコードされる科目はここ以外に無い）。
 */
import { createChartOfAccounts, type Account, type AccountCategory, type ChartOfAccounts, type Dimension, type TaxCategory } from './chart-of-accounts';

/** 標準セットの版（`updatedAt`）。マスタを保存したことが無いワークスペースはこの時刻を返す。 */
export const DEFAULT_CHART_UPDATED_AT = '2026-09-13T00:00:00.000Z';

export const DEFAULT_TAX_CATEGORIES: readonly TaxCategory[] = [
  { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true, mapping: { yayoi: '課対仕入込10%', freee: '課対仕入10%', mf: '課税仕入 10%' } },
  { code: 'JP-IN-8R-S', name: '課税仕入 8%（軽減）', side: 'in', rate: 8, enabled: true, mapping: { yayoi: '課対仕入込軽減8%', freee: '課対仕入8%（軽）', mf: '課税仕入 (軽)8%' } },
  { code: 'JP-IN-10-S-D80', name: '課税仕入 10%（経過措置 80%）', side: 'in', rate: 10, deductionRate: 0.8, enabled: true, mapping: { yayoi: '課対仕入込10% 80%控除', freee: '課対仕入（控80）10%', mf: '課税仕入 10% 控除80%' } },
  { code: 'JP-IN-10-S-D70', name: '課税仕入 10%（経過措置 70%）', side: 'in', rate: 10, deductionRate: 0.7, enabled: true, mapping: { yayoi: '課対仕入込10% 70%控除', freee: '課対仕入（控70）10%', mf: '課税仕入 10% 控除70%' } },
  { code: 'JP-IN-10-S-D50', name: '課税仕入 10%（経過措置 50%）', side: 'in', rate: 10, deductionRate: 0.5, enabled: true, mapping: { yayoi: '課対仕入込10% 50%控除', freee: '課対仕入（控50）10%', mf: '課税仕入 10% 控除50%' } },
  { code: 'JP-IN-10-S-D30', name: '課税仕入 10%（経過措置 30%）', side: 'in', rate: 10, deductionRate: 0.3, enabled: true, mapping: { yayoi: '課対仕入込10% 30%控除', freee: '課対仕入（控30）10%', mf: '課税仕入 10% 控除30%' } },
  { code: 'JP-IN-10-S-D0', name: '課税仕入 10%（控除なし）', side: 'in', rate: 10, deductionRate: 0, enabled: true, mapping: { yayoi: '課対仕入込10% 控除不可', freee: '課対仕入（控0）10%', mf: '課税仕入 10% 控除不可' } },
  { code: 'JP-IN-EXEMPT', name: '非課税仕入', side: 'in', rate: 0, enabled: true, mapping: { yayoi: '非課仕入', freee: '非課仕入', mf: '非課税仕入' } },
  { code: 'JP-IN-NA', name: '対象外仕入（不課税）', side: 'in', enabled: true, mapping: { yayoi: '対象外', freee: '対象外', mf: '対象外仕入' } },
  { code: 'JP-OUT-10-S', name: '課税売上 10%', side: 'out', rate: 10, enabled: true, mapping: { yayoi: '課税売上込10%', freee: '課税売上10%', mf: '課税売上 10%' } },
  { code: 'JP-OUT-8R-S', name: '課税売上 8%（軽減）', side: 'out', rate: 8, enabled: true, mapping: { yayoi: '課税売上込軽減8%', freee: '課税売上8%（軽）', mf: '課税売上 (軽)8%' } },
  { code: 'JP-OUT-EXEMPT', name: '非課税売上', side: 'out', rate: 0, enabled: true, mapping: { yayoi: '非課売上', freee: '非課売上', mf: '非課税売上' } },
  { code: 'JP-OUT-EXPORT', name: '輸出売上（免税）', side: 'out', rate: 0, enabled: true, mapping: { yayoi: '輸出売上', freee: '輸出売上', mf: '輸出売上 0%' } },
  { code: 'JP-OUT-NA', name: '対象外売上（不課税）', side: 'out', enabled: true, mapping: { yayoi: '対象外', freee: '対象外', mf: '対象外' } },
  { code: 'JP-NA', name: '対象外', side: 'none', enabled: true, mapping: { yayoi: '対象外', freee: '対象外', mf: '対象外' } },
];

export const DEFAULT_DIMENSIONS: readonly Dimension[] = [
  { id: 'sub_account', name: '補助科目', values: [] },
  { id: 'department', name: '部門', values: [] },
];

type Seed = readonly [id: string, name: string, category: AccountCategory, defaultTaxCode: string | undefined, aliases: readonly string[]];

/** 順序がそのまま `sortOrder` になる（決算書の並びに近い順）。 */
const ACCOUNT_SEEDS: readonly Seed[] = [
  // 収入
  ['revenue.sales', '売上高', 'revenue', 'JP-OUT-10-S', ['売上', '売上金額', '売上高（収入金額）']],
  ['revenue.misc', '雑収入', 'revenue', 'JP-OUT-10-S', ['その他の収入', '雑収益']],
  // 費用（青色申告決算書 一般用）
  ['expense.purchases', '仕入高', 'expense', 'JP-IN-10-S', ['仕入', '仕入金額', '商品仕入']],
  ['expense.taxes_dues', '租税公課', 'expense', 'JP-NA', ['税金', '印紙', '収入印紙', '固定資産税']],
  ['expense.shipping', '荷造運賃', 'expense', 'JP-IN-10-S', ['送料', '運賃', '荷造発送費', '配送料']],
  ['expense.utilities', '水道光熱費', 'expense', 'JP-IN-10-S', ['電気代', 'ガス代', '水道代', '光熱費']],
  ['expense.travel', '旅費交通費', 'expense', 'JP-IN-10-S', ['交通費', '旅費', '出張費', '電車代', 'タクシー代']],
  ['expense.communication', '通信費', 'expense', 'JP-IN-10-S', ['電話代', '携帯電話', 'インターネット', '切手', '郵便料金']],
  ['expense.advertising', '広告宣伝費', 'expense', 'JP-IN-10-S', ['広告費', '宣伝費', 'Web広告']],
  ['expense.entertainment', '接待交際費', 'expense', 'JP-IN-10-S', ['交際費', '接待費', '贈答品']],
  ['expense.meetings', '会議費', 'expense', 'JP-IN-10-S', ['打合せ', '会議', 'ミーティング']],
  ['expense.insurance', '損害保険料', 'expense', 'JP-IN-EXEMPT', ['保険料', '火災保険', '自動車保険']],
  ['expense.repairs', '修繕費', 'expense', 'JP-IN-10-S', ['修理代', '修理費', 'メンテナンス']],
  ['expense.supplies', '消耗品費', 'expense', 'JP-IN-10-S', ['消耗品', '事務用品', '文具', '文房具', '備品費']],
  ['expense.depreciation', '減価償却費', 'expense', 'JP-NA', ['償却費']],
  ['expense.welfare', '福利厚生費', 'expense', 'JP-IN-10-S', ['福利厚生', '慶弔費', '健康診断']],
  ['expense.salaries', '給料賃金', 'expense', 'JP-NA', ['給料', '給与', '賃金', '給与手当']],
  ['expense.outsourcing', '外注工賃', 'expense', 'JP-IN-10-S', ['外注費', '業務委託費', '外注']],
  ['expense.fees', '支払手数料', 'expense', 'JP-IN-10-S', ['手数料', '振込手数料', '決済手数料', 'システム利用料']],
  ['expense.professional_fees', '支払報酬料', 'expense', 'JP-IN-10-S', ['報酬', '税理士報酬', '士業報酬', '顧問料']],
  ['expense.interest', '利子割引料', 'expense', 'JP-IN-EXEMPT', ['支払利息', '利息', '割引料']],
  ['expense.rent', '地代家賃', 'expense', 'JP-IN-10-S', ['家賃', '地代', '事務所家賃', '賃料', '駐車場代']],
  ['expense.books', '新聞図書費', 'expense', 'JP-IN-10-S', ['書籍', '図書', '新聞', '雑誌', '書籍代']],
  ['expense.vehicle', '車両費', 'expense', 'JP-IN-10-S', ['ガソリン代', '燃料費', '車検', '高速代', 'ETC']],
  ['expense.training', '研修費', 'expense', 'JP-IN-10-S', ['セミナー', '講習', '受講料', '教育訓練費']],
  ['expense.dues', '諸会費', 'expense', 'JP-IN-NA', ['会費', '年会費', '組合費']],
  ['expense.donations', '寄付金', 'expense', 'JP-IN-NA', ['寄附金', '寄付', '寄附']],
  ['expense.misc', '雑費', 'expense', 'JP-IN-10-S', ['その他経費', '諸経費']],
  ['expense.family_salary', '専従者給与', 'expense', 'JP-NA', ['専従者', '青色事業専従者給与']],
  // 資産
  ['asset.cash', '現金', 'asset', 'JP-NA', ['小口現金', 'キャッシュ']],
  ['asset.ordinary_deposit', '普通預金', 'asset', 'JP-NA', ['普通', '銀行口座', '預金']],
  ['asset.checking_deposit', '当座預金', 'asset', 'JP-NA', ['当座']],
  ['asset.receivables', '売掛金', 'asset', 'JP-NA', ['売掛', '未回収']],
  ['asset.other_receivables', '未収入金', 'asset', 'JP-NA', ['未収金', '未収']],
  ['asset.advances_paid', '前払金', 'asset', 'JP-NA', ['前渡金', '手付金']],
  ['asset.prepaid_expenses', '前払費用', 'asset', 'JP-NA', ['前払', '年払い']],
  ['asset.suspense_paid', '仮払金', 'asset', 'JP-NA', ['仮払']],
  ['asset.advances_on_behalf', '立替金', 'asset', 'JP-NA', ['立替', '立替払い']],
  ['asset.inventory_supplies', '貯蔵品', 'asset', 'JP-NA', ['未使用切手', '未使用印紙']],
  ['asset.equipment', '工具器具備品', 'asset', 'JP-IN-10-S', ['備品', '器具備品', 'パソコン', 'PC', '機材']],
  ['asset.vehicles', '車両運搬具', 'asset', 'JP-IN-10-S', ['車両', '自動車', '社用車']],
  ['asset.software', 'ソフトウェア', 'asset', 'JP-IN-10-S', ['ソフト', 'システム', 'アプリ開発']],
  ['asset.deposits_paid', '差入保証金', 'asset', 'JP-IN-NA', ['敷金', '保証金', '入居保証金']],
  ['asset.lump_sum_depreciable', '一括償却資産', 'asset', 'JP-IN-10-S', ['一括償却']],
  // 負債
  ['liability.payables', '買掛金', 'liability', 'JP-NA', ['買掛', '未払仕入']],
  ['liability.other_payables', '未払金', 'liability', 'JP-NA', ['未払', 'カード未払', 'クレジット未払']],
  ['liability.accrued_expenses', '未払費用', 'liability', 'JP-NA', ['未払経費']],
  ['liability.advances_received', '前受金', 'liability', 'JP-NA', ['前受', '前受収益']],
  ['liability.deposits_received', '預り金', 'liability', 'JP-NA', ['預り', '源泉所得税', '源泉徴収', '社会保険料預り金']],
  ['liability.suspense_received', '仮受金', 'liability', 'JP-NA', ['仮受', '内容不明入金']],
  ['liability.loans', '借入金', 'liability', 'JP-NA', ['借入', '融資', '長期借入金', '短期借入金']],
  ['liability.director_loans', '役員借入金', 'liability', 'JP-NA', ['役員借入', '社長借入']],
  // 純資産
  ['equity.owner_drawings', '事業主貸', 'equity', 'JP-NA', ['事業主', '私用', 'プライベート']],
  ['equity.owner_contributions', '事業主借', 'equity', 'JP-NA', ['事業主借入', '個人資金']],
  ['equity.opening_capital', '元入金', 'equity', 'JP-NA', ['元入']],
  ['equity.capital', '資本金', 'equity', 'JP-NA', ['出資金']],
];

export const DEFAULT_ACCOUNTS: readonly Account[] = ACCOUNT_SEEDS.map(([id, name, category, defaultTaxCode, aliases], index) => ({
  id, name, category, ...(defaultTaxCode === undefined ? {} : { defaultTaxCode }), aliases: [...aliases], enabled: true, sortOrder: (index + 1) * 10,
}));

/** 標準セット。`updatedAt` は seed の版。利用者が保存すると以後はそちらが使われる。 */
export const DEFAULT_CHART_OF_ACCOUNTS: ChartOfAccounts = createChartOfAccounts({
  accounts: DEFAULT_ACCOUNTS,
  dimensions: DEFAULT_DIMENSIONS,
  taxCategories: DEFAULT_TAX_CATEGORIES,
  updatedAt: DEFAULT_CHART_UPDATED_AT,
});

/** 標準セットの複製を指定時刻で返す（「標準に戻す」で保存する用）。 */
export function defaultChartOfAccounts(updatedAt: string): ChartOfAccounts {
  return createChartOfAccounts({ ...DEFAULT_CHART_OF_ACCOUNTS, updatedAt });
}
