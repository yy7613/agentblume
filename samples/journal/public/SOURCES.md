# samples/journal/public — 出典・利用条件

このフォルダに **同梱** しているのは国税庁の公開 PDF 4 件だけです。それ以外の参考資料は URL のみ記載し、ファイルは再配布していません。取得日: 2026-09-13。

## 同梱ファイル（国税庁）

- 発行元: 国税庁（<https://www.nta.go.jp/>）
- 利用条件: 国税庁ホームページ利用規約（<https://www.nta.go.jp/chuijiko/copy.htm>）。公共データ利用規約（PDL1.0）に準拠しており、**出典（国税庁ホームページ）を明記** すれば複製・改変・再配布ができます（CC BY 4.0 互換）。本フォルダでは改変せずそのまま同梱しています。
- 出典表記: 「国税庁 インボイス制度に関する Q&A（<https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/qa_invoice_mokuji.htm>）」

| ファイル | URL | 内容 / サンプルとしての用途 |
|---|---|---|
| `nta_invoice_qa_54_tekikaku_kisai.pdf` | <https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/54.pdf> | 問54 適格請求書の記載事項 6 項目と記載例（小麦粉 / 牛肉 / キッチンペーパー、10% 対象 88,000 円・8% 対象 43,200 円）。`invoice-qualified` の様式根拠。PDF 取込 → 記載例の抽出テスト |
| `nta_invoice_qa_57_hasuu.pdf` | <https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/57.pdf> | 問57 消費税額等の端数処理（1 インボイスにつき税率ごとに 1 回。商品ごとの端数処理は不可）。抽出後の整合チェック（税率別合計 = 合計 ± 税率行数）の根拠 |
| `nta_invoice_qa_58_kani_kisai.pdf` | <https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/58.pdf> | 問58 適格簡易請求書の記載事項とレシート記載例（コーラ※ / ギュウニク※ / ハミガキコ、10% 対象・8% 対象・お預り・お釣）。`receipt-simplified` の様式根拠 |
| `nta_invoice_qa_94_tatekaekin.pdf` | <https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/94.pdf> | 問94 立替金（立替金精算書 + 適格請求書の写しで控除可、記載イメージ）。`expense-report` の様式根拠 |

## URL のみ（同梱していない参考資料）

| 資料 | URL | 発行元 | 利用条件（調査時の記録） | 用途 |
|---|---|---|---|---|
| JP PINT（Peppol 日本標準インボイス）仕様・UBL サンプル XML（`Japan_PINT_Invoice_UBL_Example*.xml`、`Aligned-TaxCategoryCodes.gc`） | <https://docs.peppol.eu/poac/jp/pint-jp/>（`resources.zip` 内 `trn-invoice/example/`）。デジタル庁の案内: <https://www.digital.go.jp/policies/electronic_invoice> | OpenPeppol AISBL | 仕様書本文は OpenPeppol の事前同意なく改変・再配布・販売不可。サンプル XML は実装検証用に公開されているが再配布条件が明確でないため、**社内検証・テストデータ用途に限定し同梱しない**。本リポジトリでは意味を写した `../pint-invoice-minimal.json` のみ同梱 | 税区分 S / AA / E / O / G、`CustomizationID urn:peppol:pint:billing-1@jp-1`、登録番号 schemeID 0221 |
| Peppol BIS Billing 3.0 サンプル（`base-example.xml`, `Allowance-example.xml`） | <https://github.com/OpenPEPPOL/peppol-bis-invoice-3/tree/master/rules/examples> | OpenPEPPOL | リポジトリにライセンス表記なし。テスト用途に限定 | 欧州形式との比較 |
| 鹿児島市 請求書 様式第18（その3）と記入例（適格 税抜 / 適格 税込 / 免税事業者用） | <https://www.city.kagoshima.lg.jp/kaikei/kaikeikanri/shise/nyusatsu/yoshikinado/shiki-02.html>（`reiwaeikyuusyo.xls`, `zeinuki.pdf`, `zeikomi.pdf`, `mennzei.pdf`） | 鹿児島市 | 市の著作権ページを調査時に確認できず。出典明記のうえ社内テストデータとして利用、再配布前に市サイトの「著作権・リンクについて」を要確認 | 8% / 10% / 課税対象外の 3 列表示、免税事業者用（登録番号なし）の記載例 |
| 全銀協規定形式「入出金取引明細」レコードレイアウト（SMBC 法人 EB マニュアル） | <https://www.smbc.co.jp/hojin/eb/firm/manual/resources/pdf/nyuusyukkintorihikimeisai.pdf> | 三井住友銀行 | 銀行サイトの著作物。**参照専用**（再配布不可と考える） | 全銀協固定長は取込対象外（docs/20 §6）とする根拠。入払区分 1=入金 2=出金、取引区分コード |
| 所得税青色申告決算書（一般用）様式・書き方（令和 7 年分） | <https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r03/10.pdf> / <https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf> | 国税庁 | 上と同じ（PDL1.0、出典明記で利用可） | 科目マスタ標準セット（docs/20 §5）の科目枠 |
| 令和 6 年度改正 交際費等（飲食費 1 人あたり 10,000 円） | <https://www.nta.go.jp/publication/pamph/hojin/kaisei_gaiyo2024/pdf/J.pdf> | 国税庁 | 同上 | 迷うケース `meal_purpose` の閾値 |
| 適格請求書 Q&A 問 18 / 104 / 110 / 113-3 / 113-4、概要パンフレット、手引き | <https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/qa_invoice_mokuji.htm> | 国税庁 | 同上 | 登録番号の構成、帳簿のみ保存の特例、経過措置の割合（80% → 70% → 50% → 30%） |

## 取得を見送ったもの

- Microsoft「楽しもう Office」インボイス対応請求書テンプレート: 個人利用限定のため未取得。
- freee / マネーフォワード / 弥生 の請求書テンプレート: 各社利用規約（再配布不可）のため未取得。
- Japanese-Mobile-Receipt-OCR データセット: 画像の公開先・ライセンスを確認できず未取得。
