# samples/expense — 経費精算のサンプル

経費精算（docs/21-expense.md）の動作確認と、規程チェックの期待結果を固定するための **すべて架空** のデータです。
会社名（株式会社サンプル商事 / テスト工業株式会社）、人名（テスト太郎 / テスト花子 / テスト次郎 / テスト三郎）、登録番号（`T1234567890123`）は架空で、実在の事業者とは関係ありません。

期待結果は `src/composition/expense-flow.e2e.test.ts` が実装と突き合わせています（ずれたらテストが落ちます）。

## ファイル

| ファイル | 内容 | 形式 |
|---|---|---|
| `policy-template.csv` | 初期テンプレートの費目 CSV（docs/21 §5.4 の列）。取り込むと規程が保存され `policy-unreviewed` が消える | UTF-8 **BOM あり** / CRLF |
| `claims-generic.csv` | 日本語列名。申請者 2 名（テスト太郎・テスト花子）。理由コードを 1 行ずつ踏む行と、何も出ない行 | UTF-8 BOM なし / CRLF |
| `claims-generic.sjis.csv` | 上の Shift-JIS（CP932）版（画面の文字コード判定の確認用） | Shift-JIS / CRLF |
| `claims-english-headers.csv` | 英語列名（claimant, date, payee, amount, category …）。費目は別名（「タクシー代」「接待」「電車」）と当たらない名前 | UTF-8 / CRLF |
| `claims-resubmit.csv` | `claims-generic.csv` の 2 行を別申請として再提出 | UTF-8 / CRLF |
| `expected-checks.json` | 上記 CSV の行（ヘッダ = 1 行目）ごとの期待 `verdict` と理由コード（順不同） | JSON |

画像は新しく作らず `samples/journal/rendered/` を使います（`receipt-simplified.png` / `receipt-handwritten.png` / `expense-report.png`）。

## 取り込み方（`#/expense`）

1. **規程** ステップ → 「CSV 取込」で `policy-template.csv` を選ぶ（規程が保存される）。
2. **申請取込** ステップ → CSV タブ → 申請期間 `2026-09-01`〜`2026-09-30` で `claims-generic.csv`（または `.sjis.csv`）を取り込む。申請者ごとに申請が 2 件できる。
3. **チェック** ステップ → 「未チェックをチェック」。
4. `claims-resubmit.csv` はチェックの後に取り込んで、その申請をチェックする（相手がチェック済みなので `duplicate-across-claims` が差し戻しの重さで出る）。

期待結果は **判定日 2026-09-30（日本時間）** の値です。別の日にチェックすると、`date-in-future`（10/05 の行）と `submission-late`（取込日から数える）が変わります。

## 読み方の注意

- **CSV の明細には領収書の画像が無い**ので、領収書が必要な費目（タクシー・宿泊・交際費・消耗品など）では `receipt-missing` も出ます。画像 / PDF タブで取り込んだ明細では出ません。`電車・バス`（領収書不要・3 万円未満は登録番号不要）と `日当` の行が「何も出ない行」になるのはそのためです。
- 日付が読めない行（`9月xx日`）は行を捨てず、取引日を空にして取込の警告を残します（`date-missing` と `receipt-extraction-warning`）。
- 金額が空の行は、金額に依存するチェック（上限・事前承認の金額条件・重複）を打ち切ります。

## claims-generic.csv の行ごとの期待結果（抜粋。全行は expected-checks.json）

| 行 | 申請者 | 内容 | 判定 | 理由コード |
|---|---|---|---|---|
| 2 | テスト太郎 | 電車 420 円 | pass | — |
| 3 | テスト太郎 | 交際費 4 名 38,000 円 | returned | receipt-missing |
| 4 | テスト太郎 | 交際費 4 名 44,000 円 | returned | receipt-missing, per-person-limit-exceeded |
| 5 | テスト太郎 | 交際費 人数空欄 | returned | receipt-missing, attendees-missing |
| 6 | テスト太郎 | 期間外 08/31 | returned | date-outside-period |
| 7 | テスト太郎 | 宿泊 2 泊 26,000 円 | returned | receipt-missing, per-unit-limit-exceeded |
| 8 | テスト太郎 | タクシー 12,000 円 | returned | receipt-missing, per-item-limit-exceeded |
| 9 | テスト太郎 | 支払先空欄 | needs-review | payee-missing |
| 10 | テスト太郎 | 会社払い | returned | receipt-missing, payment-not-reimbursable |
| 11, 12 | テスト太郎 | 同じ書籍の 2 行 | returned | receipt-missing, duplicate-in-claim |
| 13 | テスト太郎 | 交際費 55,000 円・稟議番号なし | returned | receipt-missing, pre-approval-missing |
| 14 | テスト太郎 | 06/15（期限 90 日超・期間外） | returned | date-outside-period, submission-late |
| 15 | テスト花子 | 日当 2 日 6,000 円 | pass | — |
| 16 | テスト花子 | 10/05（未来） | returned | date-in-future |
| 17 | テスト花子 | 登録番号なし | returned | receipt-missing, registration-number-missing |
| 18 | テスト花子 | タクシー 目的空欄 | returned | purpose-missing, receipt-missing |
| 19 | テスト花子 | 費目「おやつ」 | returned | category-missing |
| 20 | テスト花子 | 金額空欄 | returned | amount-missing, receipt-missing |
| 21 | テスト花子 | 日付が読めない | returned | date-missing, receipt-missing, receipt-extraction-warning |
| 22 | テスト花子 | 交際費 参加者・関係空欄 | returned | receipt-missing, attendee-details-missing |
| 23 | テスト花子 | 消耗品 110,000 円 | returned | receipt-missing, per-item-limit-exceeded, pre-approval-missing |

## 画像を読み取ったときに期待する下書き

読取結果はモデルによって揺れるので、ここは自動テストで固定していない目安です（読み取った値は自動で補正しません）。

| 画像 | 下書き | 主に出る理由コード（規程保存済み・申請に入れてチェック） |
|---|---|---|
| `receipt-simplified.png` | 1 件。支払先・金額・登録番号・税率別内訳 | 費目の別名に当たらなければ `category-missing`（費目を選べば消える）。内訳の読み違いがあれば `receipt-amount-mismatch` |
| `receipt-handwritten.png` | 1 件。12,000 円・宛名「上様」 | 飲食の費目を選ぶと `attendees-missing`（人数は領収書に無い）。登録番号が無ければ `registration-number-missing` |
| `expense-report.png` | 明細 5 行に分割。日付は空、申請者候補「テスト太郎」（支払先には入れない） | 各行に `date-missing`・`payee-missing`・`receipt-extraction-warning`（精算書の行には日付と支払先が無い） |

## 実用化のサンプル（docs/21 §20。系統 A / B / C）

§20 の実用化（従業員マスタ・承認経路・カード明細・交通費・追加読取・規程のヒアリング）の動作確認用です。値はすべて架空です（銀行コード `9999`・支店 `999` は未割当の架空値、運賃も架空。駅名だけは実在）。期待結果は各系統のテストが突き合わせています。

| ファイル | 内容 | 形式 | 突き合わせるテスト |
|---|---|---|---|
| `employees.csv` | 従業員 6 名（テスト太郎〜）。部門・上長（`manager_code`）・口座・通勤定期（` > ` 区切りの駅）。`#/expense` の「従業員・組織」台帳の CSV 取込で入れる | UTF-8 BOM / CRLF | `composition/expense-people.test.ts`、`application/expense/people/employee-transfer.test.ts` |
| `employees-invalid.csv` | 取り込めない行の見本: 名義カナが変換後 30 バイトを超える（切り詰めずに止める）、中点「・」（変換しない）、口座番号のハイフン（黙って外さない） | UTF-8 BOM / CRLF | `composition/expense-people.test.ts` |
| `people-organization.json` | 部門 3（管理本部・営業部・経理部。部門長と親子）と承認者グループ「経理」。`PUT /expense/organization` の本文の形 | JSON | `composition/expense-people.test.ts` |
| `people-approval-routes.json` | 承認経路の見本（5 万円以上の交際費は 上長 → 部門長 → …）。規程の `approval` の形 | JSON | `composition/expense-people.test.ts` |
| `card-statement-generic.csv` | 法人カード明細 5 件（2026-09-03〜09-25。日本語列名: 利用日・利用店名・利用金額・カード番号下 4 桁・備考）。カード `1111`（営業用・保有者テスト太郎）と `2222`（共用）。「カード明細」台帳で取り込むと列の対応は保存済みの形式から自動で決まり、09-03 の 3,200 円を立替で申請すると `card-charge-claimed`（二重計上の疑い）になる | UTF-8 BOM | `composition/expense-money.e2e.test.ts` |
| `card-statement-overlap.csv` | `card-statement-generic.csv` の後に取り込む明細 2 行: generic と同じ利用 1 行（重複として数え、取り込まない）と 10 月の新しい利用 1 行。なお generic と同じ内容のファイルを別名で取り込むと 409 `EXPENSE_CARD_DUPLICATE_IMPORT` | UTF-8 BOM | `composition/expense-money.e2e.test.ts` |
| `expected-zengin.hex` | 全銀協 総合振込ファイルの**期待バイト列**（16 進テキスト）。ヘッダー・データ 2 件・トレーラー・エンドの 5 レコード（各 120 バイト + CRLF）、半角カナは JIS X 0201 の 1 バイト。`src/domain/expense/money/zengin-file.test.ts` の入力（依頼人「サンプルシヨウジ」・振込日 2026-09-25・テスト タロウ 5,180 円 / テスト サブロウ 32,000 円。銀行コード 9999 などは架空）から**生成**したもので、テストがバイト単位で一致を確かめる（再ダウンロードで同じ SHA-256 になる前提）。銀行へ送るファイルではない | 16 進テキスト | `domain/expense/money/zengin-file.test.ts` |
| `fares.csv` | 運賃マスタ（中野・新宿・霞ケ関の経路。IC 運賃、双方向）。「運賃マスタ」台帳の CSV 取込で入れる | UTF-8 BOM | `composition/expense-input.test.ts` |
| `input-expected-transport-checks.json` | 通勤定期のある申請者の交通費 6 明細と、期待する理由コード（`commuter-pass-overlap` / `commuter-pass-partial-overlap` / `fare-exceeds-table` / `fare-route-unknown` / `route-missing` / 何も出ない）。駅名の別名（霞が関 → 霞ケ関）も含む | JSON | `composition/expense-input.test.ts` |
| `input-detail-read-cases.json` | 経費専用の追加読取の応答（印字どおりの文字列）と、下書きに付く印・事実・食い違いの 5 例（発行日の代用、登録番号の桁誤り、2 回の読取の食い違い、精算書の支払先、参加人数と区間の補完） | JSON | `composition/expense-input.test.ts` |
| `policy-hearing-document-sample.md` | 架空の旅費・経費規程（規程のヒアリングに「文書から」で渡す見本） | Markdown | `composition/expense-input.test.ts` |
| `policy-hearing-scripted-proposal.json` | 上の文書に対してモデルが返す提案の見本（テストはこれをスクリプトのモデルから返し、差分・保存を確かめる） | JSON | `composition/expense-input.test.ts` |

振込元の設定・仮払・集計の見本はサンプルファイルにせず、テストのフィクスチャ（`src/adapters/storage/expense-v9.fixtures.ts`）に持っています。振込データの一本通し（承認 → 作成 → 再ダウンロード → 確定）は `src/composition/expense-money-payout.e2e.test.ts` が確かめます。

### 実用化の読み方の注意

- 従業員を 1 人でも登録すると（マスタを使っている状態）、申請者を従業員に紐付けていない申請に `claimant-unlinked` が出ます。従業員を登録しなければ MVP と同じ判定です。
- 交通費の照合は、運賃マスタに経路があるか、申請者に通勤定期があるときだけ動きます。どちらも無ければ `route-missing` などは出ません。
- 追加読取で付いた印（`read-values-unconfirmed` の元）は、明細フォームでその欄を直して保存すると外れます。値を見ただけでは外れません。
