/**
 * ドメイン: 「迷うケース」カタログ（docs/20 §4）。
 *
 * 帳票の外にある判定軸（誰との飲食か・何を買ったか・事業利用の割合 …）を聞くための質問テンプレート。
 * Stage 2 のプロンプトと、ルールの `askIf` の雛形に使う。回答は `factPath`（`extra.<key>`）へ書き戻し、
 * 提案ルールの条件（`extra.purpose equals 'internal-meeting'` 等）に使えるようにする。
 * `sets` は選択肢が示唆する科目（ヒント。マスタの id ではなく名前）と税区分コード。
 */

export interface AmbiguityOption {
  readonly value: string;
  readonly label: string;
  readonly sets?: { readonly accountHint?: string; readonly taxCode?: string };
  readonly hint?: string;
}

export interface AmbiguityCase {
  readonly id: string;
  readonly title: string;
  /** どんな文書で聞くべきか（人が読む説明。プロンプトにも渡す）。 */
  readonly trigger: string;
  readonly question: string;
  readonly options: readonly AmbiguityOption[];
  /** 回答の書き戻し先（facts のパス）。 */
  readonly factPath: string;
  /** 法令・実務上の根拠メモ。 */
  readonly note: string;
}

export const AMBIGUITY_CATALOG: readonly AmbiguityCase[] = [
  {
    id: 'meal_purpose',
    title: '飲食の目的',
    trigger: '飲食店・カフェ・居酒屋などへの支出',
    question: '誰と・何の目的の飲食でしたか？（参加人数も教えてください）',
    options: [
      { value: 'entertainment', label: '取引先との接待', sets: { accountHint: '接待交際費', taxCode: 'JP-IN-10-S' } },
      { value: 'internal-meeting', label: '社内・取引先との打合せ（軽食程度）', sets: { accountHint: '会議費', taxCode: 'JP-IN-10-S' } },
      { value: 'welfare', label: '従業員の慰労・懇親', sets: { accountHint: '福利厚生費', taxCode: 'JP-IN-10-S' } },
      { value: 'private', label: '私用', sets: { accountHint: '事業主貸', taxCode: 'JP-NA' } },
    ],
    factPath: 'extra.purpose',
    note: '1 人あたり 10,000 円以下（2024/4/1 以後。以前は 5,000 円）の飲食は交際費から除外できる（参加者・人数の記録が必要）。',
  },
  {
    id: 'ec_item_type',
    title: 'EC サイトで買ったもの',
    trigger: 'Amazon・楽天・ヨドバシなど EC サイトへの支出',
    question: '何を買いましたか？',
    options: [
      { value: 'books', label: '書籍・雑誌', sets: { accountHint: '新聞図書費', taxCode: 'JP-IN-10-S' } },
      { value: 'supplies', label: '文具・消耗品', sets: { accountHint: '消耗品費', taxCode: 'JP-IN-10-S' } },
      { value: 'equipment', label: '機材・備品（10 万円以上なら固定資産の確認へ）', sets: { accountHint: '工具器具備品', taxCode: 'JP-IN-10-S' } },
      { value: 'merchandise', label: '販売する商品の仕入', sets: { accountHint: '仕入高', taxCode: 'JP-IN-10-S' } },
      { value: 'private', label: '私用', sets: { accountHint: '事業主貸', taxCode: 'JP-NA' } },
    ],
    factPath: 'extra.itemType',
    note: 'EC の領収書は明細行から品目が分かることが多いので、明細があればそれを提示してから聞く。',
  },
  {
    id: 'fixed_asset_check',
    title: '固定資産の確認',
    trigger: '1 品（1 単位）の取得価額が 100,000 円以上',
    question: '1 単位の取得価額と取得日を教えてください。青色申告（または中小企業者）ですか？',
    options: [
      { value: 'expense', label: '10 万円未満 → 費用', sets: { accountHint: '消耗品費' } },
      { value: 'lump-sum', label: '10 万円以上 20 万円未満 → 一括償却資産（3 年均等）', sets: { accountHint: '一括償却資産' } },
      { value: 'small-asset', label: '30 万円未満（2026/4/1 以後は 40 万円未満）で青色・中小 → 少額減価償却資産の特例（全額費用）', sets: { accountHint: '消耗品費' } },
      { value: 'fixed-asset', label: '上記以外 → 固定資産として減価償却', sets: { accountHint: '工具器具備品' } },
    ],
    factPath: 'extra.assetTreatment',
    note: '少額減価償却資産の特例は年 300 万円まで。判定は税抜経理なら税抜、税込経理なら税込の取得価額で行う。',
  },
  {
    id: 'transport_kind',
    title: '交通費の種類',
    trigger: '鉄道・バス・タクシー・航空など交通機関への支出',
    question: '出張ですか、近距離の移動ですか、通勤ですか？',
    options: [
      { value: 'business-trip', label: '出張（宿泊を伴う・遠方）', sets: { accountHint: '旅費交通費', taxCode: 'JP-IN-10-S' } },
      { value: 'local', label: '近距離の移動', sets: { accountHint: '旅費交通費', taxCode: 'JP-IN-10-S' } },
      { value: 'commute', label: '通勤', sets: { accountHint: '旅費交通費', taxCode: 'JP-IN-10-S' } },
      { value: 'private', label: '私用', sets: { accountHint: '事業主貸', taxCode: 'JP-NA' } },
    ],
    factPath: 'extra.transportKind',
    note: '公共交通機関の運賃（3 万円未満）は帳簿のみで仕入税額控除できる（適格請求書の保存不要）。国際線・海外の交通費は不課税。',
  },
  {
    id: 'prepaid_period',
    title: 'サービス期間',
    trigger: '年払い・サブスクリプション・保険料など期間のある支出',
    question: 'サービス期間はいつからいつまでですか？（1 年以内ですか）',
    options: [
      { value: 'within-year', label: '1 年以内で毎年継続 → 短期前払費用として全額費用', sets: {} },
      { value: 'over-year', label: '1 年超、または期間が不明 → 前払費用として期間按分', sets: { accountHint: '前払費用', taxCode: 'JP-NA' } },
    ],
    factPath: 'extra.servicePeriod',
    note: '短期前払費用の特例は「支払日から 1 年以内に役務提供を受ける」「毎期継続して支払時に費用計上」が条件。',
  },
  {
    id: 'withholding_check',
    title: '源泉徴収の確認',
    trigger: '個人（士業・フリーランス・講師など）への報酬の支払',
    question: '相手は個人ですか？ 報酬の種類（原稿料・講演料・税理士報酬など）は？',
    options: [
      { value: 'individual-withheld', label: '個人で源泉徴収の対象 → 報酬 + 預り金（10.21%、100 万円超の部分は 20.42%）', sets: { accountHint: '支払報酬料', taxCode: 'JP-IN-10-S' } },
      { value: 'individual-not-withheld', label: '個人だが源泉徴収の対象外', sets: { accountHint: '外注工賃', taxCode: 'JP-IN-10-S' } },
      { value: 'corporation', label: '法人', sets: { accountHint: '外注工賃', taxCode: 'JP-IN-10-S' } },
    ],
    factPath: 'extra.payeeType',
    note: '源泉徴収額は請求書の記載があればそれを使う。登録番号が無い個人なら経過措置の控除割合も同時に決める。',
  },
  {
    id: 'invoice_registration',
    title: '適格請求書発行事業者の確認',
    trigger: '支出の証憑に登録番号（T + 13 桁）が無い',
    question: '相手は適格請求書発行事業者ですか？（登録番号を確認できますか）',
    options: [
      { value: 'registered', label: '登録番号を確認できた（番号を入力）', sets: { taxCode: 'JP-IN-10-S' } },
      { value: 'not-registered', label: '登録していない・分からない → 取引日の経過措置で控除割合を決める', sets: { taxCode: 'JP-IN-10-S-D80' } },
      { value: 'not-required', label: '少額特例（1 万円未満、基準期間の課税売上高 1 億円以下）または帳簿のみ保存の取引', sets: { taxCode: 'JP-IN-10-S' } },
    ],
    factPath: 'extra.invoiceRegistration',
    note: '経過措置: 80%（〜2026/9/30）→ 70%（〜2028/9/30）→ 50%（〜2030/9/30）→ 30%（〜2031/9/30）→ 0%。取引日で自動判定する。',
  },
  {
    id: 'tax_exempt_kind',
    title: '非課税・不課税の判定',
    trigger: '保険料・地代・切手・行政手数料・会費など',
    question: 'この取引の性質はどれですか？',
    options: [
      { value: 'exempt', label: '非課税（保険料・土地の賃借料・切手の購入・行政手数料など）', sets: { taxCode: 'JP-IN-EXEMPT' } },
      { value: 'out-of-scope', label: '不課税・対象外（会費・寄付金・給与・税金など）', sets: { taxCode: 'JP-IN-NA' } },
      { value: 'taxable', label: '課税（通常の物品・サービス）', sets: { taxCode: 'JP-IN-10-S' } },
    ],
    factPath: 'extra.taxNature',
    note: '住宅の家賃は非課税、事務所の家賃は課税。切手は購入時非課税だが使用時に課税仕入とする継続適用も認められる。',
  },
  {
    id: 'household_ratio',
    title: '家事按分',
    trigger: '個人事業主の家賃・光熱費・通信費など家事と共用する支出',
    question: '事業利用の按分率は何 % ですか？',
    options: [
      { value: 'ratio', label: '按分率を入力（費用 × 按分率、残りは事業主貸）', sets: {} },
      { value: 'full', label: '全額事業用', sets: {} },
      { value: 'none', label: '全額私用', sets: { accountHint: '事業主貸', taxCode: 'JP-NA' } },
    ],
    factPath: 'extra.businessRatio',
    note: '按分の根拠（面積・時間・使用日数など）を記録しておく。仕入税額控除も按分後の金額で行う。',
  },
  {
    id: 'bank_transfer_in',
    title: '入金の内容',
    trigger: '銀行明細の入金（摘要「振込 ｶ)…」など）',
    question: 'どの請求に対する入金ですか？',
    options: [
      { value: 'receivable', label: '売掛金の回収', sets: { accountHint: '売掛金', taxCode: 'JP-NA' } },
      { value: 'sales', label: '売上（請求書を起こしていない）', sets: { accountHint: '売上高', taxCode: 'JP-OUT-10-S' } },
      { value: 'advance', label: '前受金（納品前の入金）', sets: { accountHint: '前受金', taxCode: 'JP-NA' } },
      { value: 'loan', label: '借入金の入金', sets: { accountHint: '借入金', taxCode: 'JP-NA' } },
      { value: 'owner', label: '事業主からの資金移動', sets: { accountHint: '事業主借', taxCode: 'JP-NA' } },
    ],
    factPath: 'extra.depositKind',
    note: '振込手数料が差し引かれて入金される場合は差額を支払手数料（または売上値引）として起こす。',
  },
  {
    id: 'account_transfer',
    title: '口座間の資金移動',
    trigger: '口座間振替・カード引落・ATM 入出金',
    question: '相手の口座は自社（自分）が管理している口座ですか？',
    options: [
      { value: 'own-account', label: '自社の口座への資金移動', sets: { accountHint: '普通預金', taxCode: 'JP-NA' } },
      { value: 'card-settlement', label: 'クレジットカードの引落（未払金の消込）', sets: { accountHint: '未払金', taxCode: 'JP-NA' } },
      { value: 'cash', label: 'ATM での現金の引出・預入', sets: { accountHint: '現金', taxCode: 'JP-NA' } },
      { value: 'other', label: 'それ以外（支払・入金）', sets: {} },
    ],
    factPath: 'extra.transferKind',
    note: '資金移動は損益に影響しない。カード引落は各利用明細で計上済みの未払金を消し込む。',
  },
  {
    id: 'reduced_rate_check',
    title: '軽減税率の確認',
    trigger: '8% 対象の明細行がある（飲食料品）',
    question: '店内での飲食ですか、持ち帰り（テイクアウト・出前）ですか？',
    options: [
      { value: 'eat-in', label: '店内飲食 → 10%', sets: { taxCode: 'JP-IN-10-S' } },
      { value: 'take-out', label: '持ち帰り・出前・食材の購入 → 8%（軽減）', sets: { taxCode: 'JP-IN-8R-S' } },
    ],
    factPath: 'extra.reducedRate',
    note: 'レシートに税率別の内訳があればそれを優先し、この質問は内訳の無い手書き領収書などに限る。',
  },
];

/** id でカタログを引く。 */
export function findAmbiguityCase(id: string): AmbiguityCase | undefined {
  return AMBIGUITY_CATALOG.find((entry) => entry.id === id);
}
