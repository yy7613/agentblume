# samples/receivables — 請求書発行と入金消込のサンプル

入金消込タブ（docs/22-receivables.md §11）の動作確認・判定の回帰確認・注文書の vision 読取テストに使う **すべて架空** のデータです。
会社名（株式会社サンプルソフト / 株式会社サンプル商事 / テスト工業株式会社 / 山田商事株式会社 / 山田デザイン事務所 / テスト物産株式会社 / 株式会社サンプル販売）、人名（ヤマダ タロウ / テスト花子）、登録番号（`T9876543210987` `T1234567890123` `T1357913579135`）、住所・電話・口座番号はすべて架空で、実在の事業者とは関係ありません。

## ファイル

| ファイル | 内容 |
|---|---|
| `settings.json` | `PUT /receivables/settings` の body（`{ "settings": ReceivablesSettings から updatedAt を除いた形 }`）。発行者「株式会社サンプルソフト」`T9876543210987`、端数は切り捨て、手数料の許容 1〜880 円、合算は 3 件まで、仕訳連携は初期値の科目 id・税区分（`nonTaxableTaxCode: JP-NA` を含む） |
| `customers.json` | 取引先 6 社の配列。各要素は `POST /receivables/customers` の body（scope 抜き）に **`ref` を足したもの**。山田商事（kana なし）/ サンプル商事（kana `サンプルシヨウジ`）/ テスト工業（kana `テストコウギヨウ`）/ 山田デザイン事務所（個人・別名なし）/ 同額請求の確認用 2 社 |
| `invoices/01〜09-*.json` | 発行する請求 9 件の下書き（`SaveInvoiceDto` 形 + `customerRef` + `customerNameHint`）。ファイル名の番号順に発行すると `INV-2026-0001`〜`0009` になる |
| `invoices/invoice-per-line-rounding.json` | 明細 1,234 / 2,345 / 3,456 円（税抜 10%）で、`declared.lineTaxAmounts` = [123, 234, 345]（明細ごとに切り捨てた値）。検査専用（発行しない） |
| `invoices/invoice-inclusive-8-10.json` | 税込、10% 6,180 円 + 8% 1,250 円。`declared.taxByRate` は四捨五入の値（562 / 93 円）。検査専用 |
| `bank-deposits-generic.csv` | 汎用プリセット（`日付,摘要,出金,入金,残高`）。UTF-8 **BOM あり** / CRLF。2026-09-01〜10-30 の 11 行（入金 8 + 出金 2 + 利息 1）。摘要は半角カナ `ﾌﾘｺﾐ ...` |
| `bank-deposits-mufg.sjis.csv` | 同じ 11 行を三菱UFJ銀行型の列（`摘要`=種別 / `摘要内容`=名義、日付はゼロ埋めなし）で。**Shift_JIS（CP932）** / CRLF |
| `bank-deposits-custom-preamble.csv` | 同じ 11 行を未知の列構成で。先頭 3 行が口座情報、4 行目がヘッダ `取引日,お取引内容,お引出金額,お預入金額,振込依頼人名,残高`（名義は独立列、金額は桁区切りなし）。UTF-8 BOM なし / CRLF |
| `bank-deposits-overlap.csv` | generic の続きの明細（2026-10-28〜11-10、汎用プリセット、BOM あり / CRLF）。先頭 3 行が generic の最後の 3 日と同じ入金、11-10 に同日・同額・同名義の入金が 2 行（残高は別） |
| `purchase-order.json` | テスト工業からの注文書（10% 3 行 + 8% 1 行、税抜、合計 201,140 円）の正解データ（仕訳の `SaveJournalDocumentDto` 形。仕訳の種別に「注文書」が無いので `kind: other` + `extra.documentTitle: 注文書`） |
| `templates/purchase-order.html` / `rendered/purchase-order.png` | 上の注文書の HTML と描画結果（幅 900px、`deviceScaleFactor: 1.5`） |

### API に送らないキー

- `customers.json` の **`ref`**、請求 JSON の **`customerRef`** はサンプル内の参照キーです（API は受け取りません。zod は未知のキーを捨てますが、スクリプトでは外して送ってください）。
- 請求 JSON の **`customerNameHint`** は画面の「JSON を貼り付け」が取引先欄の手掛かりとして読むキーです（ツール `receivables_invoice_draft` の `draft_json` と同じ）。API の `customerId` にはなりません。
- 請求 JSON の `note` は請求書の備考として保存されます（期待結果のメモ。消してもかまいません）。

## 取り込み順

1. **設定**: 設定ダイアログに `settings.json` の値を入れる（API: `PUT /receivables/settings` に `settings.json` をそのまま送る）。
2. **取引先**: `customers.json` の 6 社を登録する（API: 各要素から `ref` を外して `POST /receivables/customers`。返った `customer.id` を `ref` ごとに控える）。
3. **請求**: `invoices/01`〜`09` を **番号順に** 「JSON を貼り付け」→ 取引先を選ぶ → 保存 → 発行（API: `customerRef` / `customerNameHint` を外し、`customerId` に手順 2 の id を入れて `POST /receivables/invoices` → `POST /receivables/invoices/:id/issue`）。
4. **明細取込**: `bank-deposits-generic.csv` を取り込む（プロファイルは組込み「汎用」が自動で当たる。入金 9 件・出金スキップ 2 件）。
5. **判定**: 「消込を判定」。以降は下の表の手順で確定・再判定する。

## 期待結果（実際に流して確かめた結果）

`createApp({ profile: 'test' })` に上の順で流して確かめた値です（請求番号は発行順）。「再判定」は `unmatched` の入金をすべて判定し直すことです。

| 入金日 | 摘要 | 金額 | 対応する請求 | 1 回目の判定 | その後の手順 → 判定 |
|---|---|---|---|---|---|
| 09-10 | `ﾌﾘｺﾐ ｻﾝﾌﾟﾙｼﾖｳｼﾞ` | 110,000 | サンプル商事 INV-2026-0001 110,000 | **`decided / exact-amount-and-name`**（kana 一致） | 一括確定 → INV-0001 は入金済み |
| 09-15 | `ﾌﾘｺﾐ ｶ)ﾔﾏﾀﾞｼﾖｳｼﾞ` | 54,560 | 山田商事 INV-2026-0002 55,000 | **`unmatched / no-candidate`**（kana 未設定で名義不一致、同額の請求なし） | 山田商事に kana `ヤマダシヨウジ` を入れて再判定 → **`candidate / fee-difference`**（手数料 440 円）→ 確定 |
| 09-30 | `ﾌﾘｺﾐ ﾃｽﾄｺｳｷﾞﾖｳ` | 55,000 | テスト工業 INV-2026-0003 33,000 + INV-2026-0004 22,000 | **`candidate / combined-payment`**（山田商事の 55,000 円の請求は名義で候補から外れる） | 合算で確定 |
| 09-25 | `ﾌﾘｺﾐ ﾔﾏﾀﾞ ﾀﾛｳ` | 88,000 | 山田デザイン事務所 INV-2026-0005 88,000 | **`candidate / amount-only`**（INV-0009 は 10-01 発行なので候補外） | 「確定して名義を覚える」（別名 `ヤマダタロウ` を学習） |
| 10-30 | `ﾌﾘｺﾐ ﾔﾏﾀﾞ ﾀﾛｳ`（翌月分） | 88,000 | 山田デザイン事務所 INV-2026-0009 88,000 | `unmatched / multiple-candidates`（学習前は同額の INV-0005 / INV-0009 の 2 件） | 上の確定（名義の学習）後に再判定 → **`decided / exact-amount-and-name`**（別名一致、INV-0009）→ 一括確定 |
| 10-29 | `ﾌﾘｺﾐ ﾃｽﾄｺｳｷﾞﾖｳ` | 30,000 | テスト工業 INV-2026-0006 50,000 | `unmatched / no-candidate`（合算確定前は未入金が 3 件あり、どれとも決まらない） | 09-30 の合算を確定した後に再判定 → **`candidate / partial-payment`**（配分 30,000、手数料 0）→ 確定で INV-0006 は一部入金（残 20,000） |
| 10-28 | `ﾌﾘｺﾐ ｶ)ﾌﾒｲ` | 12,345 | なし | **`unmatched / no-candidate`** | 対象外にする |
| 10-15 | `ﾌﾘｺﾐ ｼﾖｳﾋﾝ ﾀﾞｲｷﾝ` | 44,000 | テスト物産 INV-2026-0007 44,000 / サンプル販売 INV-2026-0008 44,000 | **`unmatched / multiple-candidates`** | 候補から選ぶ（再判定しても同じ） |
| 09-01 | `ﾘｿｸ` | 3 | なし | **`unmatched / no-open-invoice`**（入金日より前に発行された請求が無い） | 対象外にする |

上の手順を終えた時点の請求: INV-0001〜0005 と 0009 が入金済み、INV-0006 が一部入金（残 20,000）、INV-0007 / 0008 が未入金。

## 追加の確認

| 確認 | 手順 | 実際の結果 |
|---|---|---|
| 重複取込（期間の重なり） | 上の手順の後に `bank-deposits-overlap.csv` を取り込む | 入金 2 件取込・出金スキップ 1 件・**重複 3 件**（2 行目 10-28 12,345 / 3 行目 10-29 30,000 / 4 行目 10-30 88,000） |
| 同日・同額・同名義の 2 件 | 同上（11-10 `ﾌﾘｺﾐ ﾃｽﾄｺｳｷﾞﾖｳ` 10,000 × 2、残高 1,415,908 / 1,425,908） | 指紋が別になり **2 件とも取り込まれる**。判定は 2 件とも `candidate / partial-payment`（INV-0006 残 20,000）で、互いに `contendedBy` が付く。1 件目を確定して再判定すると 2 件目は `decided / exact-amount-and-name`（残 10,000 と同額） |
| Shift_JIS / MUFG 型 | 手順 1〜3 の後に `bank-deposits-mufg.sjis.csv` を取り込む（文字コードは自動） | 文字コード `shift_jis`、プロファイル組込み「三菱UFJ銀行」、入金 9 件・出金スキップ 2 件。名義の正規化は generic と同じ（利息だけ `利息`）。1 回目の判定は上の表の「1 回目の判定」と全行同じ |
| 未知の列構成 + 前置き行 | 手順 1〜3 の後に `bank-deposits-custom-preamble.csv` をプレビュー | 組込みプロファイルに当たらず **`mappingRequired: true`**（不足 `date` / `deposit-or-amount`）、ヘッダ行 4（前置き 3 行）。マッピング無しの取込は `ReceivablesCsvImportError` で断られる |
| 同上（列マッピングで取込） | マッピング `日付=取引日` / `摘要=お取引内容` / `出金=お引出金額` / `入金=お預入金額` / `振込依頼人名=振込依頼人名` / `残高=残高` で取込 | 入金 9 件（ファイル上の行番号 5, 6, 7, 9, 10, 12, 13, 14, 15）・出金スキップ 2 件。名義は独立列から読む（利息は名義が空）。1 回目の判定は上の表と全行同じ |
| 明細ごとの丸め | `invoice-per-line-rounding.json` を貼り付けて検査（`POST /receivables/invoices/check`） | 違反 **`per-line-rounding`**（rate 10、申告 702 = 明細ごと 702、税率ごとに 1 回なら 703、差 -1）、警告 `declared-total-mismatch`（申告 7,737 / 計算 7,738） |
| 丸めモードの違い | `invoice-inclusive-8-10.json` を貼り付けて検査 | 違反なし。警告 **`rounding-mode-differs`** × 2（10%: 申告 562 / 計算 561、8%: 申告 93 / 計算 92。どちらも `round-half-up` なら一致）。計算値は 10% 税抜 5,619 / 税 561、8% 税抜 1,158 / 税 92、合計 7,430 |
| 注文書から請求書案 | エージェントに `rendered/purchase-order.png` を添付して `receivables_invoice_draft` を呼ばせる | 正解は `purchase-order.json`（取引先はテスト工業に当たる。合計 201,140 = 10% 175,000 + 17,500 / 8% 8,000 + 640）。vision の読取結果は模型に依存するので、ここでは正解データだけを置く |

## 描画（`rendered/`）

`templates/purchase-order.html` を `scripts/render-journal-samples.mts` と同じ手順（Playwright Chromium、viewport 幅 900px、`deviceScaleFactor: 1.5`、`locale: ja-JP`、fullPage）で描画した PNG です（約 120 KB）。描画前に `purchase-order.json` の合計・登録番号・各行金額・税率別の対象額と税額がテンプレート本文に含まれていることを検査しています。仕訳の描画スクリプトは `samples/journal` 専用なので、再描画するときは同じ手順を `samples/receivables` に向けて実行してください。

## ファイルの文字コード・改行

- JSON / HTML / README は UTF-8（BOM なし）。
- `bank-deposits-generic.csv` / `bank-deposits-overlap.csv` は UTF-8 **BOM あり** / CRLF、`bank-deposits-custom-preamble.csv` は UTF-8 BOM なし / CRLF、`*.sjis.csv` は CP932 / CRLF。
- `.gitattributes` で `*.sjis.csv` と `rendered/*` をバイナリ、CSV を改行変換なしにしています。
