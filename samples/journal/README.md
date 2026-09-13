# samples/journal — 仕訳機能のサンプル帳票

仕訳タブ（docs/20-journal.md）の動作確認・LLM 抽出テスト・CSV プリセット判定テストに使う **すべて架空** の帳票セットです。
会社名（株式会社サンプル商事 / テスト工業株式会社）、人名（テスト太郎 / テスト花子）、登録番号（`T1234567890123` など末尾が明らかに規則的なもの）、住所（東京都千代田区霞が関1-1-1）はすべて架空で、実在の事業者とは関係ありません。

`public/` だけは国税庁の公開資料（出典・利用条件は `public/SOURCES.md`）です。

## 取り込み方（取込タブ）

| 系統 | 手順 | 対象ファイル |
|---|---|---|
| CSV | 取込タブ → **CSV** → ファイルを選ぶ（列名署名でプリセット自動判定。判定できないときは列マッピング UI） | `bank-*.csv`, `card-rakuten.csv` |
| JSON 貼り付け | 取込タブ → **JSON 貼り付け** → ファイル内容を貼る（`SaveJournalDocumentDto` 形。`facts` だけ貼ってもよい） | `*.json` |
| テキスト | 取込タブ → **テキスト** → 本文を貼る → LLM 抽出（フェーズ 2、`runtime/capabilities.journal.extraction.enabled` が必要） | `*.txt` |
| 画像 / PDF | 取込タブ → **画像 / PDF** → `rendered/*.png` または `rendered/*.pdf` を選ぶ（vision 抽出。同名の `*.json` が正解データ） | `rendered/*` |

## 1. 銀行 / カード明細 CSV

列名は docs/20-journal.md §6 のプリセット署名にそのまま一致させています。すべて 2026 年 9 月の同じ取引を各行フォーマットで表したもので、口座振替 / ATM / 手数料 / 振込（半角カナ `ｶ)ｻﾝﾌﾟﾙｼｮｳｼﾞ`）/ カード引落 / 給与 / 売掛入金が入っています。金額は `"67,960"` のように桁区切り付きで引用符囲み、**1 行は摘要に引用符付きカンマ**（`"ﾌﾘｺﾐ ﾔﾏﾀﾞﾃﾞｻﾞｲﾝｼﾞﾑｼｮ,ｶﾞﾂﾌﾞﾝ"`）を含みます。

| ファイル | 列（ヘッダ行そのまま） | 文字コード / 改行 | 日付形式 | 備考 |
|---|---|---|---|---|
| `bank-generic.csv` | `日付,摘要,出金,入金,残高` | UTF-8 **BOM あり** / CRLF | `2026/09/01` | 汎用プリセット。9 行 |
| `bank-rakuten.csv` | `取引日,入出金(円),残高(円),入出金先内容` | UTF-8 BOM なし / CRLF | **`20260901`**（8 桁） | 楽天銀行型。入出金は 1 列の符号付き（出金は `"-18,420"`） |
| `bank-rakuten.sjis.csv` | 同上 | **Shift-JIS (CP932)** / CRLF | 同上 | 上の Shift-JIS 版。文字コード自動判定のテスト用 |
| `bank-mufg.csv` | `日付,摘要,摘要内容,支払い金額,預かり金額,差引残高,メモ,未資金化区分,入払区分` | UTF-8 **BOM あり** / CRLF | `2026/9/1`（ゼロ埋めなし） | MUFG 型。摘要と摘要内容の 2 列、入払区分 `入金`/`出金` |
| `bank-mufg.sjis.csv` | 同上 | **Shift-JIS (CP932)** / CRLF | 同上 | 上の Shift-JIS 版 |
| `bank-smbc.csv` | `お取引日,お引出し,お預入れ,お取り扱い内容,残高,メモ,ラベル` | UTF-8 BOM なし / **LF**（意図的。LF 改行の CSV も読めることを確認する） | `2026/09/01` | SMBC 型。最終行にラベル `売掛` |
| `bank-yucho.csv` | `日付,入出金明細ID,詳細1,詳細2,払出し金額,預入れ金額,貸付金額,返済金額,残高,取扱店,取扱店名,メモ` | UTF-8 **BOM あり** / CRLF | `2026/09/01` | ゆうちょ型。詳細1 が種別、詳細2 が相手先 |
| `card-rakuten.csv` | `利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額,9月支払金額,10月繰越残高,11月以降繰越残高,新規サイン` | UTF-8 BOM なし / CRLF | `2026/08/02` | 楽天カード型。9 月支払金額の合計 169,780 円が各銀行 CSV の `ｶｰﾄﾞ ﾗｸﾃﾝｶｰﾄﾞ` 引落と一致。ノート PC は 3 回払い（`9月支払金額` 50,000 / 繰越 50,000 / 50,000）、海外利用 `"SAMPLE CLOUD INC, SAN FRANCISCO"` は引用符付きカンマ |

CSV 1 行 = 1 document（`kind: bank_statement` / `card_statement`、`source.type: csv-row`、`extraction.method: csv-preset`）になり、`facts.accountHint` にプリセット名（口座 / カード名）が入ります。

### 各行の期待結果（seed ルールのみ = ほぼ `no-rule`）

| 摘要（正規化後） | direction | 想定される迷うケース | 提案ルールの例 |
|---|---|---|---|
| 振込 サンプルショウジ 67,960 | in | `bank_transfer_in`（どの請求の入金か） | `descriptionNorm contains 'サンプルショウジ'` + in → 売掛金回収 |
| 口座振替 トウキョウデンリョク 18,420 | out | `household_ratio`（個人事業主なら按分） | `contains 'トウキョウデンリョク'` → 水道光熱費 `JP-IN-10-S` |
| ATM 引出 50,000 | out | `account_transfer`（現金への資金移動） | `startsWith 'ATM'` → 現金 / 普通預金（不課税） |
| 手数料 220 | out | なし（確定できる） | `contains '手数料'` → 支払手数料 `JP-IN-10-S` |
| 振込 テストタロウ 14,770 | out | 立替精算（`expense-report.json` と対応） | `contains 'テストタロウ'` + メモ `立替精算` → 未払金消込 |
| 振込 ヤマダデザインジムショ 88,000 | out | `invoice_registration` / `withholding_check`（`invoice-unregistered.json` と対応） | ヒアリングで確定 |
| カード ラクテンカード 169,780 | out | `account_transfer`（カード明細側で仕訳済みなら未払金消込） | `contains 'ラクテンカード'` → 未払金 |
| 給与 テストタロウ 247,690 | out | なし（`payslip.json` と対応） | `startsWith '給与'` → 給料手当 / 預り金（不課税） |
| 振込 テストコウギョウ 330,000 | in | `bank_transfer_in` | → 売掛金回収 |
| （カード）AMAZON.CO.JP 9,780 | out | `ec_item_type`（`amazon-order.json`） | ヒアリングで品目確認 |
| （カード）テッパンヤキサンプル 38,000 | out | `meal_purpose`（`meal-receipt-ambiguous.json`） | ヒアリングで目的・人数確認 |
| （カード）サンプルクラウド 39,600 | out | `prepaid_period`（`annual-subscription.json`） | ヒアリングで期間確認 |
| （カード）SAMPLE CLOUD INC 7,350 | out | `tax_exempt_kind`（海外 SaaS、`foreign-saas-usd.json`） | ヒアリングで課税区分確認 |
| （カード）ETC 首都高速 2,400 | out | `transport_kind` | `startsWith 'ETC'` → 旅費交通費 |
| （カード）サンプルデンキ 150,000（3 回払い） | out | `fixed_asset_check`（`pc-purchase-150000.json`） | askIf `grandTotal gte 100000` |

## 2. 構造化 JSON（`SaveJournalDocumentDto`）

`src/ui/api/types.ts` の `SaveJournalDocumentDto`（`kind` / `source` / `facts` / `extraction`）に一致します。`facts.grandTotal` は税込合計、`totalsByRate[].amountIncludesTax` が `false` の帳票は税抜表示の請求書、`true` はレシート類（内税）です。すべて CRLF、UTF-8（BOM なし）。

| ファイル | kind | 内容 | 期待する Stage-1 結果（seed ルールのみ） | 迷うケース / 期待する提案ルール |
|---|---|---|---|---|
| `invoice-qualified.json` | invoice | 適格請求書。発行者 株式会社サンプル商事（T1234567890123）→ 宛名 テスト工業株式会社。10% 50,000 + 8% 12,000（※印）、税込 67,960、振込、期限 2026-09-30 | `undecided: no-rule` | `reduced_rate_check`（8% 行あり）。提案: `issuerName equals '株式会社サンプル商事'` → 消耗品費 `taxable:10` + 会議費 `taxable:8` / 未払金、`invoiceStatus: qualified` |
| `invoice-unregistered.json` | invoice | 登録番号なしの請求書（山田デザイン事務所 = 個人）。88,000 円、取引日 2026-09-08 | `undecided: no-rule` | `invoice_registration`（経過措置 **80%**、取引日で自動）+ `withholding_check`（個人へのデザイン報酬）。提案: 外注費 `JP-IN-10-S-D80` / 未払金 + 預り金、`invoiceStatus: transitional` |
| `receipt-simplified.json` | simplified_invoice | 簡易適格請求書（レシート）。宛名なし、8% 680 / 10% 550（内税、税額の記載なし = 税率のみ）、現金、`extra.receivedAmount` 2,000 / `extra.changeAmount` 770 | `undecided: no-rule` | お預り / お釣を合計と混同しないことの確認。提案: `issuerName startsWith 'サンプルマート'` → 消耗品費 `taxable:10` + 会議費 `taxable:8` / 現金 |
| `receipt-handwritten.json` | receipt | 手書き領収書。宛名「上様」、但し書き「お品代として」、居酒屋、12,000 円、現金 | `undecided: no-rule` | `meal_purpose`（居酒屋だが内容不明）。宛名・但し書きの警告が `extraction.warnings` にある |
| `expense-report.json` | expense_report | 立替金精算書（テスト太郎、営業部）。5 行（タクシー / JR / 会議弁当 8% / 書籍 / 宅配便）、合計 14,770、`extra.employee` | `undecided: no-rule` | 行ごとに科目が違う複合仕訳。`transport_kind`（タクシー）。JR 3,400 円は帳簿のみ保存特例（3 万円未満 公共交通） |
| `slip-transfer.json` | slip_transfer | 振替伝票。減価償却費 / 減価償却累計額 50,000（`extra.debit` / `extra.credit`） | `undecided: no-rule` | 不課税。提案: `extra.debit.account equals '減価償却費'` → 減価償却費 / 減価償却累計額 `JP-NA` |
| `slip-cash-out.json` | slip_cash_out | 出金伝票。切手 84 円 × 50 = 4,200、現金 | `undecided: no-rule` | `tax_exempt_kind`（切手の購入は非課税、使用時に課税とみなす実務あり） |
| `payslip.json` | payslip | 給与明細。`grandTotal` は差引支給額 247,690、総支給 310,000 と控除内訳は `extra` | `undecided: no-rule` | 給料手当 310,000 / 預り金 62,310 + 普通預金 247,690 の複合仕訳。不課税（通勤手当のみ課税仕入） |
| `quotation.json` | quotation | 見積書 165,000 | **`skipped: document-kind`** | 判定キューに乗らないことの確認 |
| `delivery-note.json` | delivery_note | 納品書（`invoice-qualified` の 1 行目に対応） | **`skipped: document-kind`** | 同上 |
| `meal-receipt-ambiguous.json` | simplified_invoice | 鉄板焼き 4 名 38,000 円（1 人 9,500 円）、カード。`extra.headcount` 4 | `undecided: no-rule` | `meal_purpose`。1 人 10,000 円以下なので交際費から除外可 → 会議費 か 接待交際費 か（`chat-expense-request.txt` に経緯） |
| `amazon-order.json` | invoice | EC 注文 3 品 9,780 円（ハブ / ケーブル / 書籍） | `undecided: no-rule` | `ec_item_type`（消耗品費 と 新聞図書費 の混在） |
| `pc-purchase-150000.json` | invoice | ノート PC 1 台 150,000 円（税抜 136,364）、カード 3 回払い | `undecided: no-rule`（ルール登録後は `ask-if fixed_asset_check`） | `fixed_asset_check`（10 万円以上 30 万円未満 → 少額減価償却資産 か 一括償却資産 か） |
| `annual-subscription.json` | invoice | クラウド会計 年額 39,600 円、`extra.servicePeriod` 2026-10-01〜2027-09-30 | `undecided: no-rule` | `prepaid_period`（1 年以内 → 短期前払費用特例で全額費用 か 前払費用） |
| `freelancer-invoice-individual.json` | invoice | 個人ライター（T7777777777777 登録あり）原稿料 110,000、`extra.withholdingTax` 10,210、振込額 99,790 | `undecided: no-rule` | `withholding_check`（外注費 110,000 / 未払金 99,790 + 預り金 10,210） |
| `foreign-saas-usd.json` | invoice | 海外 SaaS USD 49.00 → `grandTotal` 7,350（`extra.currency` USD、`extra.exchangeRate` 150）、登録番号なし、税率 0 | `undecided: no-rule` | `tax_exempt_kind`（リバースチャージ / 不課税）。`invoiceStatus: not_required` の候補 |
| `pint-invoice-minimal.json` | invoice | JP PINT（Peppol）最小例を `SaveJournalDocumentDto` に手で写したもの（§4） | `undecided: no-rule` | S / AA / O の 3 区分（10% / 8% / 対象外）が `totalsByRate` に写っていること |

## 3. フリーテキスト（LLM 抽出用）

| ファイル | 内容 | 抽出で期待する facts |
|---|---|---|
| `mail-invoice-notice.txt` | 請求書送付メール本文（`invoice-qualified.json` と同じ請求） | `kind: invoice`, `issuerName: 株式会社サンプル商事`, `registrationNumber: T1234567890123`, `grandTotal: 67960`, `totalsByRate` 10%: 50,000 / 5,000, 8%: 12,000 / 960, `dueDate: 2026-09-30`, `paymentMethod: bank_transfer`, `extra.invoiceNumber: INV-2026-0901` |
| `memo-taxi.txt` | 交通費メモ | `kind: receipt`, `transactionDate: 2026-09-02`, `grandTotal: 3200`, `paymentMethod: cash`, `registrationNumber: T8888888888888`, `counterpartyHint: さんぷるタクシー`。迷うケース `transport_kind`。地下鉄 180 円は別 document として抽出されてもよい（帳簿のみ保存特例） |
| `chat-expense-request.txt` | チャットの経費申請スレッド（`meal-receipt-ambiguous.json` の経緯） | `kind: simplified_invoice`, `transactionDate: 2026-08-11`, `grandTotal: 38000`, `paymentMethod: credit_card`, `registrationNumber: T2222222222222`, `extra.headcount: 4`, `extra.purpose: 商談（新規案件）`, `extra.participants: 先方 2 名 / 自社 2 名`。ヒアリングなしで接待交際費に落ちる材料が揃っている |

## 4. Peppol / JP PINT

`pint-invoice-minimal.json` は JP PINT（`CustomizationID: urn:peppol:pint:billing-1@jp-1`）の最小例の意味を、公式 UBL XML ではなく **手書きの `SaveJournalDocumentDto`** で表したものです。`extra.taxCategories` に UBL の TaxCategory（`S` = 標準 10%、`AA` = 軽減 8%、`O` = 対象外）を残し、`totalsByRate` に 10 / 8 / 0 として写しています。
公式の UBL サンプル（XML）は <https://docs.peppol.eu/poac/jp/pint-jp/> にあり、再配布条件が明確でないためこのリポジトリには含めていません（`public/SOURCES.md` 参照）。

## 5. 描画済み画像 / PDF（`rendered/`）

`templates/*.html` を Playwright（Chromium）で描画したものです。同名の `*.json` と **1:1 で対応** し、LLM（vision）抽出テストの正解データとして使います。

| rendered | template | 正解 JSON | 様式 |
|---|---|---|---|
| `invoice-qualified.png` / `.pdf` (A4) | `templates/invoice-qualified.html` | `invoice-qualified.json` | 適格請求書（登録番号・税率別合計・※印） |
| `receipt-simplified.png` / `.pdf` (80mm 幅) | `templates/receipt-simplified.html` | `receipt-simplified.json` | 簡易適格請求書（感熱紙レシート風、58mm 相当の細幅） |
| `receipt-handwritten.png` / `.pdf` (A4) | `templates/receipt-handwritten.html` | `receipt-handwritten.json` | 手書き風領収書（手書き部分は cursive 系フォントで青インク風） |
| `expense-report.png` / `.pdf` (A4) | `templates/expense-report.html` | `expense-report.json` | 立替金精算書 |

再描画: リポジトリ直下で

```
npx tsx scripts/render-journal-samples.mts
```

（`@playwright/test` の Chromium が必要。未導入なら `npm run test:e2e:install`）。スクリプトは描画前に JSON の `grandTotal` / `registrationNumber` / 各行金額がテンプレート本文に含まれているか検査し、食い違いがあれば失敗します。PNG は幅 900px（レシートは 340px）、`deviceScaleFactor: 1.5`、各 600 KB 未満です。手書き風フォントは OS 依存（Windows: Segoe Print / Segoe Script、無ければ cursive フォールバック）なので、環境により見た目が変わります。

## 6. 公開資料（`public/`）

国税庁「インボイス制度に関する Q&A」の問 54 / 57 / 58 / 94 の PDF。出典・利用条件・各ファイルの内容は `public/SOURCES.md` を参照してください。

## 7. ファイルの文字コード・改行の規約

- 既定は UTF-8（BOM なし）+ CRLF。
- 例外: `bank-generic.csv` / `bank-mufg.csv` / `bank-yucho.csv` は UTF-8 **BOM あり**、`*.sjis.csv` は Shift-JIS（CP932）、`bank-smbc.csv` は **LF**。いずれも取込側の自動判定を試すための意図的なものです。
- `.gitattributes` で `*.sjis.csv` と `rendered/*` をバイナリ扱いにしています（改行変換や diff を抑止）。
