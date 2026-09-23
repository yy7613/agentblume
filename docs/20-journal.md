# 20. 仕訳（入力系・仕訳系）

伝票・帳票を取り込み、**2 段階判定**（① 既存ルールで迷わず仕訳できるか / ② できなければヒアリングでルール化）で仕訳を起こし、汎用 CSV に出力する機能。

入口はサイドバー「作る」の **業務テンプレート**（`#/templates`）で、その一覧から選んで入る。業務テンプレートは実験的な機能として初期状態では非表示で、設定の「実験的な機能を表示する」をオンにすると現れる（非表示のまま直リンクを開くと、設定への案内が出る）。仕訳は他の汎用機能（データソース・ツール・エージェント）と違って特定業務に寄せた機能なので、同じ並びに置かず業務テンプレートの下にまとめてある。画面そのものは独立した `#/journal` のままなので、直リンクと画面内からの遷移は従来どおり動く。

- 関連: [04-api-spec.md](./04-api-spec.md)（REST）/ [ADR-0038](./adr/0038-journal-two-stage-judgment.md) / [18-quickstart.md §7](./18-quickstart.md)
- 調査メモ（設計根拠）: 国税庁 適格請求書 Q&A（問18/54/57/58/94/104/113-3）、freee / マネーフォワード / 弥生 の自動仕訳ルール仕様、各社の仕訳インポート列。URL は本書末尾。

## 1. 目的とスコープ

| 目的 | 内容 |
|---|---|
| 入力 | 取込タブの入口は 5 系統: **CSV**（銀行・カード明細、銀行別プリセットで正規化）、**事実フォーム**（手入力）、**JSON 貼り付け**、**テキスト**（メール本文・メモから LLM 抽出）、**画像 / PDF**（vision モデルで読取） |
| 判定 | **Stage 1**: 決定的なルール照合。一意に確定できれば仕訳ドラフトを作る。**Stage 2**: 確定できない理由（該当ルール無し / 複数ルール競合 / 必要項目不足 / 「迷うケース」該当）を出し、LLM ヒアリングで質問→回答→**新ルールと必要項目の提案**→利用者が確認して登録→再判定 |
| 出力 | 汎用仕訳 CSV（UTF-8 BOM, CRLF）。列は弥生 25 項目を最大公約数に取引先・品目・インボイス区分・税額を加えた 25 列（§8）。弥生 / freee / MF 形式への写像はプリセットとして追加可能な構造 |
| 保持 | SQLite（`journal_*` テーブル、migration v5）。証憑本体（画像 data URL / PDF 由来の画像 / テキスト）は `journal_documents.record_json` に同梱（1 件 8 MiB 上限） |
| ツール化 | **参照のみ**組込みツール（`builtin-journal-entries`）としてエージェントから呼べる（フェーズ 3、§14）。判定・出力は状態を変えるためツール化しない |

**科目体系は固定しない**（利用者指示）。勘定科目・税区分・補助軸（補助科目 / 部門 / プロジェクト / タグ…）はワークスペース単位のマスタで、標準セットは初期値に過ぎない。追加・改名・無効化・並び替え・CSV 取込 / 出力ができ、ヒアリングが既存マスタに無い科目を提案したときは「新しい科目として登録するか」を確認してから登録する。ルールは科目を **id** で参照し、名称変更に追従する。

## 2. 概念モデル

```mermaid
classDiagram
  class ChartOfAccounts { accounts[] ; dimensions[] ; taxCategories[] ; updatedAt }
  class Account { id ; code? ; name ; category ; defaultTaxCode? ; aliases[] ; enabled ; sortOrder ; note? }
  class Dimension { id ; name ; values[] }
  class TaxCategory { code ; name ; side ; rate? ; deductionRate? ; enabled ; mapping{yayoi,freee,mf}? }
  class JournalDocument { id ; kind ; source ; facts ; extraction ; status ; entryId? ; hearingId? }
  class JournalRule { id ; name ; enabled ; mode ; priority ; scope ; conditions[] ; outcome ; askIf[] ; requiredFacts[] ; provenance }
  class JournalEntry { id ; documentId? ; ruleId? ; date ; lines[] ; description ; invoiceStatus ; status ; decidedBy ; confidence }
  class HearingSession { id ; documentId ; status ; turns[] ; proposal? }
  ChartOfAccounts "1" o-- "*" Account
  ChartOfAccounts "1" o-- "*" Dimension
  ChartOfAccounts "1" o-- "*" TaxCategory
  JournalDocument "1" --> "0..1" JournalEntry
  JournalDocument "1" --> "0..1" HearingSession
  JournalRule "1" --> "*" JournalEntry : decided
  HearingSession --> JournalRule : proposes
```

### 2.1 JournalDocument（取込んだ 1 証憑）

| 項目 | 内容 |
|---|---|
| `kind` | `invoice` / `simplified_invoice`（レシート）/ `receipt`（手書き領収書）/ `delivery_note` / `quotation` / `bank_statement` / `card_statement` / `expense_report` / `payslip` / `slip_transfer` / `slip_cash_in` / `slip_cash_out` / `other` / `unknown`。`quotation` と `delivery_note` は判定キューに乗せない（`skipped`） |
| `source` | `{ type: 'image' | 'pdf' | 'text' | 'structured' | 'csv-row', fileName?, mime?, dataUrl?（画像）, text?（原文）, row?（CSV 1 行の生値）, preset?（CSV プリセット id） }` |
| `facts` | **正規化済み事実**（§2.2）。判定はここだけを見る |
| `extraction` | `{ method: 'manual' | 'llm' | 'csv-preset' | 'structured', model?, confidence?（0..1）, warnings[], fieldEvidence?{ field → { sourceText, confidence } } }` |
| `status` | `extracted` → `decided`（Stage 1 で確定、entryId あり）/ `undecided`（理由付き）→ `hearing`（Stage 2 進行中）→ `decided` / `skipped` / `exported` |
| `judgment` | 直近の判定結果（§3）。`undecided` の理由はここに残す |

### 2.2 DocumentFacts（正規化済み事実）

帳票種別を問わず同じ形。無いものは `undefined`。金額は **税込整数（円）**、日付は `YYYY-MM-DD`（和暦は取込時に変換）。

| フィールド | 型 | 由来 |
|---|---|---|
| `direction` | `'in' \| 'out'` | 収入 / 支出（銀行明細の入出金列、請求書の宛名/発行者から） |
| `issuerName` / `recipientName` | string | 発行者（登録番号・住所がある側）/ 宛名（御中・様がある側） |
| `registrationNumber` | `T` + 13 桁 or undefined | ハイフン除去して正規化 |
| `issueDate` / `transactionDate` / `dueDate` | date | 取引日は経過措置の判定に使う |
| `grandTotal` | integer | 税込合計 |
| `totalsByRate[]` | `{ rate: 10 \| 8 \| 0, taxableAmount, taxAmount?, amountIncludesTax }` | 税率ごとの集計欄 |
| `lines[]` | `{ description, quantity?, unitPrice?, amount, taxRate?, reducedRateMark }` | 明細 |
| `paymentMethod` | `cash \| credit_card \| bank_transfer \| qr \| e_money \| direct_debit \| unknown` | |
| `accountHint` | string | 銀行口座 / カード名（CSV プリセット由来） |
| `description` / `descriptionNorm` | string | 摘要原文 / 正規化（NFKC、半角カナ→全角、`ｶ)`・`(株)` 等の法人略号除去、連続空白圧縮、数字列除去はしない） |
| `counterpartyHint` | string | 摘要から切り出した相手先 |
| `extra` | `Record<string, JsonValue>` | 帳票固有の追加項目（参加人数、目的など、ヒアリングで埋まる） |

### 2.3 JournalRule

freee / MF / 弥生 の自動仕訳ルールの共通形。

| 項目 | 内容 |
|---|---|
| `mode` | `auto`（Stage 1 で確定してよい）/ `suggest`（一致しても Stage 2 に回す＝freee の「推測」） |
| `priority` | 整数。大きいほど優先（同点は特異度 → 作成順） |
| `scope` | `{ documentKinds?[], direction?: 'in' \| 'out', accountHints?[] }`（空は共通） |
| `conditions[]` | AND。`{ field, op, value }`。`field` は facts のパス（`descriptionNorm`, `issuerName`, `grandTotal`, `registrationNumber`, `paymentMethod`, `transactionDate`, `lines[].description`, `extra.<key>` …）。`op` は `equals \| contains \| startsWith \| endsWith \| regex \| between \| gte \| lte \| in \| exists \| notExists \| isTrue \| isFalse` |
| `outcome` | `lines[]`: `{ side: 'debit' \| 'credit', accountId, dimensionValues?{ dimId: valueId }, taxCode, amount: 'total' \| 'taxable:10' \| 'taxable:8' \| 'tax:10' \| 'tax:8' \| 'remainder' \| { fixed } \| { ratio }, partnerFrom?: 'issuerName' \| 'counterpartyHint' \| { fixed } }`、`descriptionTemplate`（`{issuerName}` 等の置換）、`invoiceStatus?`（`qualified \| transitional \| none \| not_required \| auto`。`auto` は登録番号の有無と取引日から決める。ただし銀行・カード明細・給与・伝票のように**そもそも登録番号を載せない帳票**は `not_required` とし、「番号が無い＝免税事業者」と誤って経過措置にしない。経過措置になるのは請求書・レシート・領収書・経費精算書で番号が無いときだけ） |
| `askIf[]` | 条件を満たしても確定させない追加質問のトリガ: `{ conditions[], questionId, prompt }`（例: 金額 ≥ 100,000 → 固定資産確認） |
| `requiredFacts[]` | 確定に必要な facts パス。欠けていれば `undecided(missing-fact)` |
| `provenance` | `{ origin: 'manual' \| 'hearing' \| 'seed', hearingId?, exampleDocumentIds[] }` |

**特異度**: 条件数 + `equals` 2 点 / `startsWith` `endsWith` 1.5 点 / `contains` `regex` 1 点 + scope 指定ごとに 1 点。競合解決は priority → 特異度 → createdAt。

### 2.4 JournalEntry

| 項目 | 内容 |
|---|---|
| `lines[]` | `{ side, accountId, accountName（確定時の名称を写す）, dimensionValues?, taxCode, amount, taxAmount?, partner? }`。借方合計 = 貸方合計 を不変条件にする |
| `status` | `draft` → `confirmed` → `exported` |
| `decidedBy` | `rule` / `hearing` / `manual` |
| `invoiceStatus` / `registrationNumber` | インボイス区分と登録番号（CSV に出す） |

### 2.5 HearingSession（Stage 2）

| 項目 | 内容 |
|---|---|
| `turns[]` | `{ role: 'assistant', question: { id, text, kind: 'single' \| 'multi' \| 'text' \| 'number' \| 'confirm', options?[{ value, label, hint? }], factPath? } }` と `{ role: 'user', answer: { questionId, value } }` の列 |
| `proposal` | `{ rule: JournalRule 草案, entry: JournalEntry 草案, newAccounts?[], newDimensionValues?[], newTaxCategories?[], rationale }` |
| `status` | `open` → `proposed` → `accepted` / `cancelled` |

質問は「帳票外の判定軸」を聞く（§4 迷うケースカタログ）。回答は `facts.extra` にも書き戻し、提案ルールの条件（`extra.purpose equals 'internal-meeting'` 等）に使えるようにする。

## 3. 2 段階判定

```mermaid
flowchart TD
  D[JournalDocument facts] --> K{kind が仕訳対象?}
  K -- 見積/納品 --> S[skipped]
  K -- yes --> M[有効ルールを scope/conditions で照合]
  M --> N{一致 auto ルール}
  N -- 0 件 --> U1[undecided: no-rule]
  N -- 2 件以上 同点 --> U2[undecided: multiple-rules]
  N -- 1 件 --> R{requiredFacts 充足?}
  R -- 不足 --> U3[undecided: missing-fact]
  R -- ok --> A{askIf に該当?}
  A -- 該当 --> U4[undecided: ask-if questionId]
  A -- なし --> E[decided: JournalEntry draft]
  M -- suggest のみ一致 --> U5[undecided: rule-suggest-mode + 候補]
  U1 & U2 & U3 & U4 & U5 --> H[Stage 2 ヒアリング]
  H --> P[提案: ルール + 仕訳 + 新科目]
  P -->|利用者が確認| SV[ルール登録 → 再判定 → decided]
```

`judgeDocument(facts, rules, chart, now)` は **純粋関数**（`src/domain/journal/judgment.ts`）。結果:

```ts
type Judgment =
  | { stage: 'decided'; ruleId: string; entry: JournalEntryDraft; specificity: number; candidates: RuleMatch[] }
  | { stage: 'undecided'; reasons: UndecidedReason[]; candidates: RuleMatch[] }   // candidates は一致した suggest ルールや同点ルール
  | { stage: 'skipped'; reason: 'document-kind' };
type UndecidedReason =
  | { code: 'no-rule' }
  | { code: 'multiple-rules'; ruleIds: string[] }
  | { code: 'missing-fact'; ruleId: string; facts: string[] }
  | { code: 'ask-if'; ruleId: string; questionId: string; prompt: string }
  | { code: 'rule-suggest-mode'; ruleIds: string[] }
  | { code: 'unknown-account'; ruleId: string; accountIds: string[] }   // マスタから消えた/無効化された科目
  | { code: 'unbalanced'; ruleId: string };
```

UI は理由ごとに「原因 → 次の一手 → 修正場所へのボタン」を出す（`no-rule` → ヒアリング開始 / `multiple-rules` → ルール一覧で優先度調整 / `missing-fact` → 帳票の項目編集 / `unknown-account` → 科目マスタ）。

## 4. 「迷うケース」カタログ（ヒアリングの質問テンプレート）

`src/domain/journal/ambiguity-catalog.ts` に定数として持ち、Stage 2 のプロンプトと `askIf` の雛形に使う。抜粋:

| id | トリガ | 質問 | 分岐 |
|---|---|---|---|
| `meal_purpose` | 飲食店・カフェ・居酒屋 / 支出 | 誰と・何の目的の飲食でしたか？（参加人数） | 接待交際費 / 会議費 / 福利厚生費 / 事業主貸。1 人あたり 10,000 円以下（2024/4/1 以後）は交際費から除外可 |
| `ec_item_type` | Amazon・楽天・ヨドバシ等 | 何を買いましたか？（書籍 / 文具・消耗品 / 機材 / 商品仕入 / 私用） | 新聞図書費 / 消耗品費 / 工具器具備品 / 仕入高 / 事業主貸 |
| `fixed_asset_check` | 1 品 100,000 円以上 | 1 単位の取得価額と取得日、青色・中小か | 消耗品費 / 一括償却資産 / 少額減価償却資産（<30 万、2026/4/1 以後は <40 万）/ 固定資産 |
| `transport_kind` | 交通機関・タクシー | 出張ですか、近距離移動ですか、通勤ですか | 旅費交通費 / 交通費 / 通勤費 |
| `prepaid_period` | 年払い・サブスク・保険 | サービス期間はいつからいつまでですか（1 年以内か） | 前払費用 / 短期前払費用特例で全額費用 |
| `withholding_check` | 個人への報酬・士業 | 相手は個人ですか、報酬の種類は | 外注費 + 預り金（10.21% / 100 万円超 20.42%） |
| `invoice_registration` | 登録番号なし | 相手は適格請求書発行事業者ですか（番号を確認できますか） | 経過措置 80% / 70% / 50% / 30% / 控除なし（取引日で自動） |
| `tax_exempt_kind` | 保険料・地代・切手・行政手数料 | 取引の性質は | 非課税仕入 / 不課税・対象外 / 課税 |
| `household_ratio` | 家賃・光熱費・通信費（個人） | 事業利用の按分率は | 費用 × 按分率 + 事業主貸 |
| `bank_transfer_in` | 銀行摘要「振込 ｶ)…」入金 | どの請求の入金ですか | 売掛金回収 / 売上 / 前受金 / 借入金 |
| `account_transfer` | 口座間振替・カード引落 | 相手口座は自社管理ですか | 資金移動 / 未払金消込 |
| `reduced_rate_check` | 8% 対象行あり | 店内飲食ですか持ち帰りですか | 8%（軽減）/ 10% |

経過措置の控除割合は取引日で決める定数表（80%: 〜2026/9/30、70%: 〜2028/9/30、50%: 〜2030/9/30、30%: 〜2031/9/30、以後 0%）。

## 5. 科目マスタ（ChartOfAccounts）

- **標準セット**（seed）: 青色申告決算書（一般用）の科目 + 会計ソフト慣用科目（会議費・新聞図書費・支払手数料・車両費・研修費・諸会費・寄付金・支払報酬料）+ 資産・負債・純資産の仕訳相手科目（現金・普通預金・売掛金・未払金・預り金・事業主貸/借・資本金 など）。`category` は `asset | liability | equity | revenue | expense | other`。
- **税区分**（seed）: 内部コード `JP-{IN|OUT|NA}-{RATE}-{KIND}[-D{割合}]`（例 `JP-IN-10-S`, `JP-IN-8R-S`, `JP-IN-10-S-D80`, `JP-IN-EXEMPT`, `JP-IN-NA`, `JP-OUT-10-S`, `JP-OUT-8R-S`, `JP-OUT-EXEMPT`, `JP-OUT-EXPORT`, `JP-NA`）。`mapping` に弥生 / freee / MF の表示名を持てる（空でもよい）。
- **補助軸**（dimensions）: seed は `sub_account`（補助科目）と `department`（部門）を空の値リストで用意。利用者が軸自体を追加できる。
- **柔軟性の担保**: すべて string id。削除は論理（`enabled: false`）で、ルール・仕訳からの参照は残る（判定時に `unknown-account` として検出し導線を出す）。CSV 取込 / 出力（`id,code,name,category,defaultTaxCode,aliases,enabled`）。
- ヒアリング提案の `newAccounts[]` は利用者が「登録」を押したときだけマスタに入る。

## 6. 取込（5 系統）

画面の取込タブは 5 つの入口を横並びのボタンで切り替える（`src/ui/journal/IngestTab.tsx` の `Source` 型・`sources`）。

| 系統 | 経路 | 備考 |
|---|---|---|
| CSV（銀行 / カード） | **CSV プリセット**（楽天銀行 4 列、MUFG 9 列、SMBC 7 列、ゆうちょ 12 列、楽天カード、汎用「日付,摘要,出金,入金,残高」、全銀協固定長は対象外）→ 1 行 1 document | 列名署名でプリセット自動判定、失敗時は列マッピング UI |
| 事実フォーム | 手入力フォームで facts を直接編集 → 1 document | 判定タブの「項目を編集」もこの入口を再利用する |
| JSON 貼り付け | DocumentFacts の JSON を貼り付け → 1 document | `SaveJournalDocumentDto` の形 |
| テキスト | `POST /journal/documents/extract` に `text` を渡して LLM 抽出 | メール本文・メモ |
| 画像 / PDF | UI で縮小（長辺 2000px、JPEG）→ data URL → `POST /journal/documents/extract`（vision + 構造化出力、スキーマ = DocumentFacts + kind + fieldEvidence）→ 利用者が確認・修正して保存。PDF は**ブラウザ側**で `pdfjs-dist` によりページを画像化（テキスト層があればテキストも添付）してから同じ経路を通る | vision 非対応モデルなら機能フラグで案内。サーバーに PDF ライブラリを持ち込まない（ADR-0038） |

`POST /journal/documents/extract`（`ExtractJournalDocumentUseCase`）は構造化出力で `kind` + `DocumentFacts` + `fieldEvidence` を受け取り、**保存はしない**（利用者が確認・修正してから保存する）。プロンプト版は `journal-extract/v1`、温度 0、スキーマ違反は 1 回だけ修復を求める。入力の上限は画像 4 枚 × 4,200,000 文字（data URL。SVG と外部 URL は不可）とテキスト 100,000 文字。

抽出プロンプトの要点: 帳票にある情報だけ・無いものは null（**推測しない**）、金額は整数・日付は ISO（和暦は換算）、登録番号は `T` + 数字ちょうど 13 桁、`amountIncludesTax` を必ず出す、`issueDate`（発行日）と `transactionDate`（取引年月日。無い場合だけ null）を**別項目として区別する**、「御中/様＝宛名」「登録番号・印・住所がある側＝発行者（店舗名・支店名まで）」「経費精算書は申請者・伝票は作成者が発行者」、お預り/お釣は `extra.receivedAmount` / `extra.changeAmount` へ入れて合計と混同しない、記載の無い税率行（8%: 0 円 など）を作らない。

受け取った値は**そのまま信じず**ドメインの正規化関数（`normalizeRegistrationNumber` / `parseJapaneseDate` / `parseAmount` / `normalizeDescription` / `counterpartyFromDescription`）へ通し、通らない項目は落として理由を `extraction.warnings` に残す。さらに次の整合チェックを行い、**値は補正せず**警告だけを積む（差額を文言に入れる）:

| チェック | 許容 | 根拠 / 実測 |
|---|---|---|
| 税率別合計（税抜なら税額を加算）vs `grandTotal` | ±（税率行数）円 | 国税庁 Q&A 問57。**実測の誤読 3 件はすべてこれで捕まった**（1130 / 1430 / 14650 対 1230 / 1230 / 14770） |
| 税率行の `amountIncludesTax` が行ごとに食い違う | 不可 | 通常は帳票内で一貫する（10% 行と 8% 行で割れる応答が出た） |
| 対象額 0 円の税率行 | 落として警告 | 記載の無い行の捏造（手書き領収書で発生） |
| 登録番号が `T` + 13 桁でない | 落として**生の文字列と桁数**を警告 | 最頻の失敗（14 桁・12 桁の誤読。同じ数字が並ぶと数え違える） |
| 明細合計 vs `grandTotal` / 単価 × 数量 vs 金額 | ±（明細行数）円 / ±1 円 | 税抜明細なら差額は消費税である旨も文言に入れる |
| お預り − お釣 vs `grandTotal` | ±1 円 | レシートの読み違え検出 |
| 取引年月日が無く発行日で代用した | 警告 | 経過措置の控除割合は取引日で決まる（発行日を入れると税区分が狂う） |
| 8% 行に軽減税率の記号が無い / 請求書なのに登録番号が無い | 警告 | 適格請求書の記載要件・免税事業者の確認 |

モデル未設定・structured output 非対応・画像なのに vision 非対応は `JournalExtractionUnavailableError`（409。何が足りず設定画面のどこで直すかを message に書く）。1 枚あたりの所要時間は実測で 17〜229 秒（ローカル 12b / 26b）なので、`clientAbortSignal` を通して中断が確実に効くようにしてある。

## 7. ヒアリング（Stage 2）

1. `POST /journal/hearings`（documentId）: 文書は `undecided` か `hearing` であること。判定理由 + facts + **当てはまる**迷うケース（`selectAmbiguityCases`。純関数でトリガ語と `ask-if` から最大 5 件に絞る）+ 有効な科目 / 税区分 / 補助軸を LLM に渡し、最初の質問（最大 3 問）を構造化出力で得る。文書は `hearing` になる。既に開いているセッションがあれば**作り直さずそれを返す**。
2. `POST /journal/hearings/:id/answers`: 聞いた質問の id だけを受け付け、回答を `facts.extra.<key>`（質問の `factPath`。`extra.` 以外は拒否）へ書き戻し、LLM に次の質問か **提案** を出させる（`proposal`: rule + entry + newAccounts + newDimensionValues + newTaxCategories + rationale）。発話が 60 件に達したら打ち切ってセッションを閉じ、文書を未判定へ戻す。
3. 提案の検証（`hearing-proposal.ts`。純関数）: 科目 id・税区分コード・補助軸の値がマスタか同じ提案の new* にあるか、仕訳の**貸借が一致**するか、ルールが `createJournalRule` を通るか、条件の `field` が facts のパスか。`accountName` はモデルの申告ではなくマスタの名前で埋め直す。壊れていれば 1 回だけ修復を求め、それでも駄目なら**提案の無いセッション**として保存し、理由を `warnings` と assistant の発話で返す（壊れた提案を保存すると「登録」が押せてしまう）。
4. `POST /journal/hearings/:id/accept`: `registerAccountIds` / `registerDimensionValueIds` / `registerTaxCodes` に**利用者が明示した id だけ**をマスタへ登録（提案に無い id は 400）→ ルールを `provenance: { origin: hearing, hearingId, exampleDocumentIds }` で保存 → 対象 document を再判定 → 当たれば `decided` + 仕訳の下書き。`rule` / `entry` を渡せば利用者が編集した版で上書きでき、同じ検証を通る。**モデルがマスタを書き換える経路はこの 1 本だけで、しかも利用者の明示選択が要る。**
5. `POST /journal/hearings/:id/cancel`: 中止すると文書は `undecided` へ戻る（判定キューから消えない）。
6. LLM 非対応 / 無効時は「手動でルールを作る」導線（ルール編集フォームに facts から条件を事前入力）。可否は `GET /runtime/capabilities` の `journal.hearing.enabled`（structured output の有無に連動）。

## 8. 汎用 CSV

1 行 = 1 仕訳行。複合仕訳は同一 `entry_id`。UTF-8 BOM、CRLF、`YYYY/MM/DD`、金額は税込整数。

`entry_id, line_no, date, debit_account, debit_sub_account, debit_department, debit_partner, debit_tax_code, debit_amount, debit_tax_amount, credit_account, credit_sub_account, credit_department, credit_partner, credit_tax_code, credit_amount, credit_tax_amount, description, invoice_status, registration_number, item, tags, closing_flag, source_document_id, rule_id`

`GET /journal/export?format=generic|yayoi|freee|mf&status=confirmed&from&to&markExported=true` は
`{ format, fileName, content, entryCount, encoding, contentBase64?, warnings[] }` を返し、UI は Blob でダウンロードする
（従来の textarea 表示も残す）。会計ソフト別の列写像と値の組み立ては `src/application/journal/export-presets.ts` にあり、
**汎用 25 列の純粋な写像**（平坦化は domain の `genericCsvRows` が済ませてある）。税区分の表示名は科目マスタの
`taxCategories[].mapping.{yayoi,freee,mf}` から引くので、コード側に各社の税区分名を持たない。

| 形式 | 列 | ヘッダ行 | 文字コード | 1 仕訳の束ね方 |
|---|---|---|---|---|
| `generic` | 25 列（上記） | あり | UTF-8 BOM | `entry_id` |
| `yayoi` | 弥生 25 項目 | **なし** | **Shift-JIS** | 識別フラグ（単一行 `2000` / 複合 先頭 `2110`・中間 `2100`・末尾 `2101`） |
| `freee` | 32 列 + 行頭マーカー | 1 行目 `[表題行]`、データ行 `[明細行]` | UTF-8 BOM | 伝票番号（`entry_id` の数字部 6 桁） |
| `mf` | 27 列 | あり | UTF-8 BOM | 取引No（同上） |

- **弥生**: 決算整理仕訳は `本決`、取引日付は `YYYY/MM/DD`、タイプ `0`、調整 `no`。科目の無い側（複合仕訳の片側行）は
  税区分 `対象外`・金額 `0` にする（弥生は空欄を受け付けない）。摘要 64 字、仕訳メモ 180 字で切り詰め、仕訳メモには
  `rule=<ruleId> doc=<documentId>` を入れる。
- **freee**: 仕訳インポートの列。摘要は 1,024 字。科目コード・取引先コード・セグメント 1〜3 の列は用意するが今は空欄。
  取引インポートの 20 列は借方・貸方を表現できないので使わない。
- **MF**: 借方 / 貸方インボイス列を `invoice_status` から出す。`適格`（qualified）/ `80％控除`・`70％控除`・`50％控除`・
  `30％控除`（transitional。割合は税区分の `deductionRate`）/ `控除なし`（none）/ 空欄（not_required）。

**文字コードの運び方**: 弥生は Shift-JIS でないと取込画面で文字化けする。JSON は任意のバイト列を運べないので、
`encoding: 'shift_jis'` のときだけ `contentBase64` に Shift-JIS のバイト列を入れ、`content` は読める UTF-8 のまま返す
（テキストエリアのフォールバックが空にならないようにするため）。UI は `contentBase64` を復号し、`charset` を付けない
`text/csv` の Blob にする。

**warnings（黙って値を作らない）**: 次の場合に理由と直し方を `warnings[]` へ積み、画面は出力結果の直下に一覧で出す。
推測で値を埋めることはしない。

| 警告 | 直し方 |
|---|---|
| 税区分に会計ソフトの対応名が無い（内部コードのまま出力） | 「科目」タブの税区分でマッピングを設定する |
| 摘要 / 仕訳メモを上限で切り詰めた | 摘要を短くする |
| `entry_id` に伝票番号にできる数字が無い（空欄で出力） | 会計ソフト側で採番する |
| 1 仕訳の行数が 1 伝票の上限（100 行）を超える | 仕訳を分けてから出力する |
| Shift-JIS にできない文字がある（絵文字など。`?` になる） | 摘要・科目名からその文字を取り除く |

## 9. REST API（抜粋。詳細は 04-api-spec §3.4）

| Method | Path | 内容 |
|---|---|---|
| GET/PUT | `/journal/chart` | 科目マスタの取得 / 全体保存 |
| POST | `/journal/chart/reset` | 標準セットに戻す |
| GET/POST | `/journal/chart/export` `/journal/chart/import` | 科目 CSV |
| GET/POST/DELETE | `/journal/rules`, `/journal/rules/:id` | ルール CRUD |
| POST | `/journal/rules/test` | ルール草案を保存せずに文書群へ照合 |
| GET/POST/PUT/DELETE | `/journal/documents`, `/journal/documents/:id` | 文書 CRUD（POST は facts 直接 / JSON） |
| POST | `/journal/documents/import-csv` | CSV + preset → 文書群 |
| POST | `/journal/documents/extract` | 画像 / テキストから facts を LLM 抽出（保存しない） |
| POST | `/journal/documents/judge` | 指定文書（省略時は未判定全件）を Stage 1 判定 |
| GET/PUT/POST/DELETE | `/journal/entries`, `/journal/entries/:id`, `/journal/entries/:id/confirm` | 仕訳 CRUD・確定 |
| POST/GET | `/journal/hearings`, `/journal/hearings/:id`, `/journal/hearings/:id/answers`, `/journal/hearings/:id/accept`, `/journal/hearings/:id/cancel` | Stage 2 |
| GET | `/journal/export` | 仕訳 CSV |
| GET | `/runtime/capabilities` | `journal: { extraction: { enabled, vision }, hearing: { enabled } }` |

## 10. 画面

入口は「業務テンプレート」の一覧（`#/templates`）。そこから入ると仕訳画面（`#/journal`）が開き、左上の「← 業務テンプレート」で一覧へ戻る。
画面内は横並びのステップ（科目 → 取込 → 判定 → ルール → 出力）で切り替える。

| ステップ | 内容 |
|---|---|
| 取込 | 画像 / PDF / テキスト / CSV / 手入力。抽出結果の確認・修正フォーム（fieldEvidence の信頼度が低い項目を強調） |
| 判定 | 文書一覧（状態フィルタ）。「未判定を判定」ボタン。行ごとに Stage 1 の結果と理由、`ヒアリングを開始` / `ルールを開く` / `科目を開く` の導線。ヒアリングパネル（質問カード → 提案カード → 登録） |
| ルール | 一覧（優先度・特異度・最終適用）、編集フォーム、「文書でテスト」 |
| 科目 | 科目 / 税区分 / 補助軸の編集、CSV 取込 / 出力、標準に戻す |
| 出力 | 仕訳一覧（draft / confirmed）、確定、CSV ダウンロード |

ディープリンク: `OpenTarget { internalId: <id>, section: 'document' | 'rule' | 'account' | 'hearing' }`。

## 11. 保存（SQLite v5）

`journal_chart(tenant_id, workspace_id, record_json)`、`journal_documents(tenant_id, workspace_id, id, kind, status, transaction_date, created_at, record_json)`、`journal_rules(tenant_id, workspace_id, id, enabled, priority, record_json)`、`journal_entries(tenant_id, workspace_id, id, document_id, status, entry_date, record_json)`、`journal_hearings(tenant_id, workspace_id, id, document_id, status, record_json)`。

## 12. サンプル帳票

`samples/journal/` に同梱:

- 合成: 銀行明細 CSV（楽天型 / MUFG 型 / SMBC 型 / ゆうちょ型 / 汎用）、カード明細 CSV、適格請求書・簡易適格請求書・手書き領収書・立替金精算書の JSON（DocumentFacts）と HTML → PNG/PDF（`scripts/render-journal-samples.mts`、Playwright で描画）、メール本文テキスト。
- 公開物: 国税庁 Q&A 記載例（問54 / 57 / 58 / 94、公共データ利用規約 PDL1.0、出典明記）。JP PINT の UBL 例や自治体様式は再配布条件が確認できないため URL のみ `samples/journal/SOURCES.md` に記載。

### 12.1 サンプルの使い方

- 一覧と各ファイルの期待結果（Stage 1 の判定・該当する「迷うケース」・提案ルール例）は `samples/journal/README.md` にまとめてある。
- CSV は取込タブ → CSV で読み込む。列名は §6 のプリセット署名と一致させてあり、`*.sjis.csv`（Shift-JIS）・BOM 付き・LF 改行（`bank-smbc.csv`）で文字コード / 改行の自動判定を試せる。
- JSON は `SaveJournalDocumentDto`（`src/ui/api/types.ts`）の形。取込タブ → JSON 貼り付けにそのまま貼る。`quotation.json` / `delivery-note.json` は `skipped` になることの確認用。
- `rendered/*.png|pdf` は `templates/*.html` を `npx tsx scripts/render-journal-samples.mts` で描画したもので、同名の JSON が vision 抽出テストの正解データ。テンプレートの金額を変えたら JSON も直して再描画する（スクリプトが不一致を検出して失敗する）。
- `*.txt` はテキスト取込（LLM 抽出）用。期待する facts は README §3 に書いてある。
- `public/` の国税庁 PDF は出典明記のうえ同梱（`public/SOURCES.md`）。JP PINT の UBL 例は再配布せず、意味を写した `pint-invoice-minimal.json` だけ置いている。

## 13. フェーズ

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | ドメイン・保存・API・画面（取込は構造化 / CSV / テキスト保存のみ）、Stage 1 判定、科目マスタ、汎用 CSV、サンプル CSV/JSON | 完了 |
| 2 | LLM 抽出（画像 / PDF / テキスト）、ヒアリング（Stage 2）、抽出整合チェック | 完了 |
| 3 | 組込みツール（**参照のみ**。§14）、弥生・freee・MF プリセット、画像サンプル描画、e2e、docs/CHANGELOG | 進行中 |

## 14. エージェントから呼べる仕訳参照ツール（フェーズ 3）

組込みツール **`builtin-journal-entries`**（公開名 `journal_entries` / `sideEffect: read-only`）で、エージェントが**確定済みの仕訳を読める**。サーバー起動時に `seedBuiltinTools` が冪等にシードする（`src/builtin-tools.ts`）。

| 項目 | 内容 |
|---|---|
| 返すもの | 確定済み（`confirmed`）の仕訳。1 行 = 1 仕訳行（借方 × 貸方の対）。列は `entry_id, line_no, date, debit_account, debit_tax_code, debit_amount, credit_account, credit_tax_code, credit_amount, description, invoice_status, status, document_id, rule_id`。金額は税込整数、日付は `YYYY-MM-DD`、複合仕訳は反対側が `null`（汎用 CSV §8 と同じ畳み方で、表現だけ機械可読にしたもの） |
| 絞り込み | `period`（日付の前方一致。`2026` / `2026-09`）と `account`（科目名の部分一致。借方・貸方のどちらかに当たれば残す）。どちらも省略でき、省略した条件は実行時にスキップされる |
| 科目名 | **現在のマスタ**から引き直す（改名に追従する）。マスタから消えた科目だけ、仕訳が持つ確定時の名称へ落とす |
| 上限 | 1 回に読む仕訳は 500 件まで |

実装は ETL ノード **`journal-entries`**（source / arity 0、`src/domain/etl/nodes/journal-entries-source.ts`）。domain はリポジトリへ到達できないため、`web-search-source` と同じく **実行直前に `ResolveDataSourceGraphUseCase` が `json-source` へ書き換える**（行は `application/journal/entry-rows.ts` の `JournalEntryRowsProvider` が供給し、0 件でも列が消えないよう固定スキーマを添える）。port が配線されていなければ空表ではなく `journal entries are not available` で**落とす** — 「仕訳 0 件」と読み違えさせないため。

### 14.1 判定・出力は**わざと**ツール化しない

エージェントから呼べるのは**参照だけ**。判定（`POST /journal/documents/judge`）と出力（`GET /journal/export`）はツールにしない。

- **判定は状態を変える**（文書が `decided` になり仕訳の下書きが増える）。**出力はファイルを作り、`markExported` は仕訳を `exported` にする**。どちらも `read-only` では済まず `write` / `external-action` の副作用になり、承認ゲート（`run-agent-preview.ts` の `waiting-approval`）を通さなければならない。
- 帳簿は「誰がいつ確定したか」が要る。モデルの判断で仕訳が増えたり出力済みの印が付いたりすると、利用者が画面で見ている状態と帳簿の実体がずれる。**判定・確定・出力は画面から人が押す**（§10 の判定タブ・出力タブ）。
- 科目マスタを書き換える経路もヒアリングの `accept` 1 本のままで、そこは利用者の明示選択が要る（§7-4）。

### 14.2 仕訳画面から用途別のツールを作る

出力タブの **「この条件をツールにする」** で、いまの絞り込み（状態・期間）をそのまま読み取り専用ツールとして保存できる。用途ごとに 1 本ずつ作って使い分ける前提で、**何本でも持てる**。

| 項目 | 内容 |
|---|---|
| 作られるもの | `journal-entries` → `agent-output` の 2 ノードだけのグラフ。絞り込みは `journal-entries` の config に**焼き込む** |
| 引数 | **なし**。組込みの `journal_entries` は期間・科目を引数で受けるが、こちらは条件が確定しているので `agent-input` を置かない（モデルが条件を取り違えない） |
| 名前 | 利用者が付ける。function 名の規則（`/^[A-Za-z0-9_-]{1,64}$/`）へ整形し、使える文字が残らなければ保存を止める。整形された場合は「エージェントからは ○○ という名前で呼ばれます」と事前に見せる |
| owner | `journal`（組込みの `builtin` と区別できるようにしておく） |
| 副作用 | `read-only`。判定・出力は §14.1 のとおりツール化しない |

組み立ては UI の純粋関数（`src/ui/journal/journal-model.ts` の `buildJournalToolPayload`）にあり、保存は既存の `POST /tools` をそのまま使う。作ったツールは他のツールと同じく**エージェント画面で組み込む**。

### 14.3 チャットに添付した帳票を読む（`journal_read_attachment`）

組込みツール **`builtin-journal-attachment`**（公開名 `journal_read_attachment` / `sideEffect: read-only`）で、**いまのメッセージに添付されたレシート・請求書の画像**をエージェントが読める。取込タブと同じ `ExtractJournalDocumentUseCase` を使い、**保存はしない**（帳票も仕訳も作らない）。

| 項目 | 内容 |
|---|---|
| 返すもの | 1 行 = 1 添付。列は `file_name, kind, issuer_name, registration_number, invoice_status, issue_date, transaction_date, grand_total, tax_10_taxable, tax_10_tax, tax_8_taxable, tax_8_tax, description, confidence, warnings, facts_json` |
| 引数 | **なし**。添付は実行文脈から供給する |
| 読めなかった項目 | `null`（帳票に書いていない項目があるのは普通のこと）。`warnings` には読み取りの申告が入る。平坦な列に収まらない明細や他の税率は `facts_json` に JSON 文字列で添える |
| インボイス区分 | 事実に含まれないので、登録番号・取引日・帳票種別から `resolveInvoiceStatus`（§4）で決める |
| 添付が無いとき | 空表ではなく「添付がありません」で**落とす**。利用者が直せる状態なので、理由を返して直し方を伝える |

**なぜ引数で渡さないか**: ツールの引数は LLM が書く JSON なので、数 MB の base64 を運べない。添付は `NodeContext.attachments` → `ResolveDataSourceGraphUseCase.execute(scope, graph, context)` → `journal-attachment` ソースの順に流す。子エージェントと再開実行には渡さない（添付はその turn の入力であって、委譲先や再開後が引き継ぐものではない）。

**実行中は添付が無くても文脈を渡す**（空の一覧として渡す）。文脈の有無は「実行中か / 保存・スキーマ点検か」の区別に使っているので、添付が無いときに文脈ごと省くと、ノードが未解決のまま空表を返し、エージェントが「帳票に何も書いていない」と読み違える（「添付してください」と言えなくなる）。E2E で実際に踏んだ。

**実行文脈が無い呼び出し**（ツールの保存・スキーマ点検・プレビュー）**だけ**はノードを書き換えない。ここで落とすと組込みツールの登録そのものが起動時に失敗する。未解決のノードは自前の固定スキーマを返すので、スキーマ伝播はそのまま通る。

**対象は画像だけ**（JPEG / PNG / GIF / WebP）。API の添付検証（`imageAttachmentSchema`）が画像のデータ URL に限っており、PDF は取込タブと同じくブラウザ側で画像へ変換する前提。

### 14.4 取込 → 判定を 1 本で通す（`journal_draft_entry`）

組込みツール **`builtin-journal-draft-entry`**（公開名 `journal_draft_entry` / `sideEffect: read-only`）で、**添付した帳票を読み取り、保存済みのルールで判定し、仕訳案まで**返す。仕訳画面の 取込 → 判定 の流れを、そのまま 1 本のツールとして通すもの。

| 項目 | 内容 |
|---|---|
| 返すもの | 確定した帳票は **1 行 = 1 仕訳行**（借方・貸方それぞれ）。列は `file_name, decided, reason, rule_id, rule_name, line_no, side, account, tax_code, amount, partner, date, description, invoice_status, facts_json` |
| 確定しなかったとき | 行の代わりに `decided = false` と `reason`（`no-rule` / `multiple-rules` / `missing-fact` / `unknown-account` / `ask-if` / `rule-suggest-mode` / `document-kind`）を持つ 1 行。**空表にしない** — 「仕訳が無い」と「判定できなかった」を区別できなくなるため |
| 引数 | **なし**。添付は実行文脈から供給する（§14.3 と同じ） |
| 科目名 | **現在のマスタ**から引き直す。マスタから消えた科目だけ、判定時の名称へ落とす |
| 保存 | **しない**。帳票も仕訳も作らない（§14.1 のとおり、帳簿へ残すのは画面から人が押す） |

判定は domain の純粋関数 `judgeDocument` をそのまま呼ぶ。確定時は仕訳案（`JournalEntryDraft`）が判定結果に入っているので、仕訳を組み直す処理は持たない（`JudgeJournalDocumentsUseCase` と違い、保存も文書の更新もしない）。実装は `src/application/journal/draft-entry-rows.ts`。

**§14.3 との使い分け**: `journal_read_attachment` は読み取った事実だけを返す（ルールに関係なく、帳票に何が書いてあるかを知りたいとき）。`journal_draft_entry` はそこからさらに判定まで進める（どう仕訳するかを知りたいとき）。

## 参考 URL

国税庁 No.6625 <https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6625.htm> / Q&A 問18・54・57・58・94・104・113-3 <https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/qa_invoice_mokuji.htm> / 青色申告決算書 <https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r03/10.pdf> / freee 自動登録ルール <https://support.freee.co.jp/hc/ja/articles/202848350> / MF 自動仕訳ルール <https://biz.moneyforward.com/support/account/guide/journal02/jo24.html> / 弥生 仕訳データ項目 <https://support.yayoi-kk.co.jp/subcontents.html?page_id=18545> / freee 仕訳インポート <https://support.freee.co.jp/hc/ja/articles/50792412666137> / MF 仕訳帳インポート <https://biz.moneyforward.com/support/account/guide/import-books/ib01.html> / 楽天銀行 CSV <https://help-business.rakuten-bank.net/> / 交際費改正 <https://www.nta.go.jp/publication/pamph/hojin/kaisei_gaiyo2024/pdf/J.pdf>
