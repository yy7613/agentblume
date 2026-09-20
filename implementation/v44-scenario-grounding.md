# v44: 検証シナリオをデータに接地する（scenario grounding）

- 決定の記録: [ADR-0050](../docs/adr/0050-scenario-grounding.md)
- 実測の経緯: [ADR-0047](../docs/adr/0047-factory-lessons-from-estat.md) 第6ラウンドの残課題

## 1. 問題（実測）

Factory が作った Tool とエージェントは正しく動いているのに、`report.quality` が `below-targets` のままになる。トランスクリプトを読むと、原因は検証する側にあった。

| 実測（12B の擬似ユーザー） | 何が起きたか |
|---|---|
| 「10月の総支給額 320,000円、総就業時間 165時間。時間当たり給与を算出してください」 | 擬似ユーザーが**自分で数値を作って渡し**、エージェントを電卓として使おうとした。エージェントは統計データしか持たないので噛み合わず、`max-turns` |
| 「製造業における従業者数の推移を」 | データに無い指標を尋ねた（データは完全失業者数だけ） |
| 「450,000円 ÷ 168時間 = 約2,679円 と合わない」 | 正しい回答（4,205.1065 円/時）を、自作の試算と比べて誤りだと言い張った |

計画のシナリオ目標は妥当だった（「特定の月の時間当たり給与を調査する」）。ずれは会話の中で起きている。**擬似ユーザーは、相手のエージェントが何のデータを持っているかを一度も知らされていない**。知らされているのは人物設定と目標の 1 行だけである。

副次的な問題が 2 つある。

- Planner が `persona.extraInstructions` に**エージェント向けの指示**を書く（「必ずツールの出力をそのまま使い、単位を漏らさず伝えてください」）。擬似ユーザーがそれを自分の発話として繰り返し、監督者のように振る舞う。
- シナリオ目標がデータの期間外の年を名指しすることがある（検出は今回の実測では未発生だが、同じ原因から起きる）。

## 2. 方針

1. **前提は決定的に合成して渡す**。擬似ユーザーに渡す「状況」（`Scenario.context`）へ、Stage 0 のプロファイルから作った「検証の前提」ブロックを Factory が付ける。LLM に書かせない（書かせたものは揺れ、消える。ADR-0047 決定 7 と同じ判断）。
2. **ドメインは変えない**。`Scenario.context` は既にあり、擬似ユーザーの system prompt とアンケートの両方へ入る。Factory のシナリオは draft として保存され、利用者が Scenario 画面で読めて直せる。
3. **計画の食い違いは「柔らかい違反」として 1 回だけ出し直させる**。データの期間外の年を名指しするシナリオは、既存の Planner 修復ラウンドへ理由つきで戻す。2 回目も残っていたら**計画は受理する**（前提ブロックが実際の範囲を伝えるので、致命傷にならない。検証シナリオの言い回しで Run を落とさない）。
4. **ペルソナは「ユーザーがどんな人か」だけを書かせる**。プロンプト規則で直す（決定的には見分けられない）。

## 3. 前提ブロック（決定的合成）

### 3.1 置き場所と API

新規 `src/application/factory/scenario-grounding.ts`（純関数のみ。I/O なし）。

```ts
export const SCENARIO_GROUNDING_HEADING = '# Validation premises / 検証の前提 (factory-managed)';

export interface ScenarioGroundingInput {
  readonly plan: FactoryPlan;
  readonly scenario: FactoryPlan['scenarios'][number];
  readonly profiles: readonly DataProfile[];
  readonly language: 'ja' | 'en';
}

/** そのシナリオが対象にするデータソースのプロファイル（宣言順・重複なし）。 */
export function groundingProfilesOf(input: Omit<ScenarioGroundingInput, 'language'>): readonly DataProfile[];

/** 前提ブロック。対象のプロファイルが 1 件も無ければ undefined（ブロックを付けない）。 */
export function describeScenarioGrounding(input: ScenarioGroundingInput): string | undefined;

/** 計画の context（あれば）の後ろへ前提ブロックを連結する。どちらも無ければ undefined。 */
export function composeScenarioContext(planned: string | undefined, grounding: string | undefined): string | undefined;
```

### 3.2 対象のデータソース

`scenario.expectedToolKeys` が指す `plan.tools[]` の `dataSourceId` と `additionalDataSourceIds`（宣言順・重複なし）。再利用 Tool（`reuse` あり、`dataSourceId` が空）は数えない。1 件も解決できなければ **Run の全プロファイル**を対象にする。プロファイルに無い id は黙って飛ばす。

### 3.3 文面（日本語。英語は同じ構造の直訳）

```text
# Validation premises / 検証の前提 (factory-managed)
- あなたは自分のデータを持っていない。アシスタントが持つ下記のデータについて質問する。金額・件数などの数値を自分で作って渡したり、その数値での計算を頼んだりしない。
- アシスタントが持つデータ:
  - eStat 現金給与総額（168 行）: 値の列 = 現金給与総額【円】 / 期間の列「時点」= 2012-01-01 〜 2025-11-01（month 167・year 13・fiscal-year 13）/ 地域 = 全国
  - eStat 総実労働時間（168 行）: 値の列 = 総実労働時間【時間】 / 期間の列「時点」= 2012-01-01 〜 2025-11-01（month 167・year 13・fiscal-year 13）/ 地域 = 全国
- 質問は上の期間とカテゴリの範囲内にする。データに無い指標（別の業種・別の統計・個別の会社や従業員）は尋ねない。目標が範囲外の質問を明示的に求めている場合だけ例外とする。
- アシスタントがデータの値を時点と単位つきで答えたら、その数値は正しいものとして扱う。自分で作った試算と比べて誤りだと主張しない。
```

1 データソース 1 行。各要素の作り方:

| 要素 | 出どころ | 上限と省略 |
|---|---|---|
| 名前・行数 | `profile.name` / `profile.rowCount` | — |
| 値の列 | `profile.columns` のうち `type === 'number'` で、期間列・カテゴリ列でないもの | 先頭 6 列。超えたら「ほか N 列」/ `and N more` |
| 期間 | `profile.periodColumns[]`（列名・`minStart`〜`maxStart` の日付部分・粒度別件数を件数の多い順） | 先頭 1 列だけ。無ければ要素ごと省く |
| カテゴリ | `profile.categoricalColumns[]`（列名 = 値の例） | 先頭 2 列、各 8 値まで。超えたら「ほか N 種類」/ `and N more`。コードらしい列（`CODE_LIKE_COLUMN` に合う列名）は飛ばす。無ければ省く |

- データソースは先頭 3 件まで。超えたら末尾に「ほか N 件のデータ」/ `and N more data sources`。
- 値の列が 1 つも無いデータソースは「値の列 = （数値の列なし）」/ `(no numeric columns)` と書く（行は残す）。
- ブロック全体が 1,800 文字を超えたら、カテゴリの値の例 → 値の列 の順に上限を半分にして作り直す（決定的。最大 2 回）。それでも超える場合はそのまま返す（切り詰めて文を壊さない）。
- 値はプロファイル由来（利用者のデータ）である。擬似ユーザーの system prompt に入るのは既存の `context` と同じ扱いで、新しい信頼境界は作らない。ただし改行を含む列名・値は 1 行に畳む（`\s+` → 空白 1 つ）。見出し行そのもの（`# Validation premises`）を含む値は、その `#` を外す（ブロックの偽装を避ける）。

### 3.4 Stage 5 への組み込み

`RunFactoryUseCase` の Scenario 保存（`docs/16` §4 Stage 5）で、`context` を次に置き換える。

```ts
const context = composeScenarioContext(scenarioPlan.context, describeScenarioGrounding({ plan, scenario: scenarioPlan, profiles: context.profiles, language }));
```

- `language` は `run.goal.language`（`'ja' | 'en'`。それ以外・未指定は `'ja'`）。
- 計画の `context` が既に見出し（`SCENARIO_GROUNDING_HEADING`）を含む場合は二重に付けない（再開・再試行で同じ計画をもう一度通っても冪等）。
- シナリオ集合は Run 内で凍結する既存の規律は変えない。改善ループは前提ブロックに触れない（シナリオを書き換えないため）。

## 4. 計画の接地検査（柔らかい違反）

### 4.1 API

新規 `src/application/factory/roles/plan-grounding.ts`（純関数）。

```ts
/** データの期間外の年を名指しするシナリオを、直し方つきで列挙する。無ければ空配列。 */
export function describeScenarioGroundingViolations(plan: FactoryPlan, profiles: readonly DataProfile[]): readonly string[];
```

- 対象の文字列: `scenario.goal` と `scenario.context`。
- 年の抽出: `/(?<!\d)(19|20)\d{2}(?=年|年度|\/|-|\b)/u` 相当。和暦・「過去5年」のような相対表現は見ない。
- 対象のデータソースは §3.2 と同じ規則（実装は `groundingProfilesOf` を共有せず、この 1 ファイルで完結させてよい。**ファイルの所有を分けるため**。規則が同じであることはテストで固定する）。
- 対象のどのプロファイルにも期間列が無ければ検査しない（空配列）。
- 範囲は、対象プロファイルの全期間列の `minStart` の最小年 〜 `maxStart` の最大年。年度表記のずれを吸収するため、**下限 −1 年**までは許す。
- 違反文（英語。Planner へのフィードバックは英語で統一されている）:
  `scenarios.<index> ('<key>') mentions <year>, but the data covers <minYear>–<maxYear>; use a period inside the data or do not name a year`

### 4.2 Planner の修復ラウンドへの接続

`PlannerRole.propose` の `accept`:

- **1 回目**の応答: 既存の検証に通った後で接地検査を行い、違反があれば `FactoryValidationError`（メッセージは違反を `; ` で連結）を投げる → 既存の修復ラウンドが理由つきで 1 回だけ出し直させる。
- **2 回目**の応答: 接地検査は**行わない**（硬い検証だけ）。柔らかい違反で Run を落とさない。
- 1 回目が硬い検証で落ちた場合も、2 回目は硬い検証だけ（従来どおり）。

### 4.3 プロンプト規則（2 行を足す）

```text
- personas[].extraInstructions describes the USER only (who they are, what they care about, how they talk). Never put instructions for the assistant there (such as "always quote the tool output"): the pseudo user would repeat them as its own demands.
- scenarios[].goal must be answerable from the listed data: name only indicators, periods (inside periodColumns minStart–maxStart) and categories that exist in the profiles. The pseudo user has no data of their own, so never plan a scenario where the user supplies figures to calculate with.
```

`CALCULATE_…` のような版定数が Planner プロンプトにあれば上げる（無ければ不要）。

## 5. テスト（観点）

`scenario-grounding.test.ts`
- 正常: 2 ソースのシナリオで、名前・行数・値の列・期間の範囲と粒度（件数の多い順）・カテゴリの例が 1 ソース 1 行で出る（ja / en の両方を完全一致で固定）。
- 正常: 対象は `expectedToolKeys` の Tool のソースだけ（無関係なソースは載らない）。`additionalDataSourceIds` も載る。
- 異常: 再利用 Tool しか指さないシナリオ・未知の toolKey → Run の全プロファイルへフォールバック。
- 異常: プロファイルが空 → `undefined`。`composeScenarioContext(undefined, undefined)` → `undefined`。
- 境界: 値の列 7 つ → 6 つ + 「ほか 1 列」。カテゴリ値 9 つ → 8 つ + 「ほか 1 種類」。ソース 4 件 → 3 件 + 「ほか 1 件のデータ」。コードらしい列は飛ばす。期間列・カテゴリ列が無い表は要素ごと省く。
- 境界: 1,800 文字を超えると上限を半分にして作り直す。
- 境界: 改行を含む値は 1 行に畳む。見出しを含む値は `#` を外す。
- 正常: `composeScenarioContext` は計画の context を先・前提を後に空行区切りで連結し、既に見出しを含む context には二重に付けない。

`plan-grounding.test.ts`
- 正常: 範囲内の年・年を含まない目標 → 空配列。
- 異常: 範囲外の年 → 違反文（index・key・年・範囲を含む）。`context` の中の年も見る。
- 境界: 下限 −1 年は許す。上限 +1 年は違反。期間列の無いデータ → 検査しない。複数ソースは和集合の範囲。電話番号のような 4 桁を含む長い数字列は年とみなさない。

`planner-role.test.ts`
- 正常: 1 回目に範囲外の年 → 違反文つきで 2 回目を呼び、2 回目の計画を返す。
- 正常（従来どおり）: 違反が無ければモデル呼び出しは 1 回。
- 境界: 2 回目にも範囲外の年が残っていても計画を受理する（Run を落とさない）。
- 正常: system プロンプトに 2 つの規則が入っている。

`run-factory.test.ts`
- 正常: 保存された Scenario の `context` が見出しを含み、対象データソースの名前と期間の範囲を含む。計画が `context` を持てば、その後ろに付く。
- 正常（従来どおり）: プロファイルが無い Run（データソースなし）では `context` は計画どおり。

すべて日本語の it 名（正常 / 異常 / 境界 / 例外、回帰固定は「従来どおり」）。実装後に `node .claude/skills/test-completeness-check/driver.mjs red <files>` で、新規テストが修正前のコードで赤になることを確かめる。

## 5b. 追補（実機 r11 で分かった 3 点）

前提ブロックを入れて回し直すと、擬似ユーザーの質問はすべてデータの範囲内になった（架空の数値・対象外の指標は 0 件。P4 の目標達成率 0.5 → 1.0）。残った失敗から、原因を 3 つ特定した。

### 5b.1 評点の向きを明示する（全シナリオ共通。Factory に限らない）

実測: 自由記述は「正確で明瞭、調査報告として十分」なのに `q2`（総合満足度）= 2、`q3`〜`q5` = 1。`buildSurveySchema` が scale 設問に付ける説明は `総合満足度 / Overall satisfaction (integer 1..5)` だけで、**どちらが高評価かをどこにも書いていない**。12B は 1 を「1 位」と読む。

- `buildSurveySchema`: scale 設問の説明を `… (integer <min>..<max>; <min> = lowest / 最低, <max> = highest / 最高)` にする。
- `RunScenarioUseCase.surveyTurn` の指示文へ 1 文足す。ja: 「評点は数が大きいほど高評価である（最小値 = 最も悪い、最大値 = 最も良い）。自由記述の内容と評点を一致させること。」 en: 同じ意味の直訳。検証落ちの再依頼文にも同じ 1 文を含める。
- `DEFAULT_SURVEY` の `q4` は「手間の少なさ（少ないほど高評価）」で、向きの説明が設問ごとに逆に読める。`textJa: '手間の少なさ（手間が少なかったほど高い点）'` / `textEn: 'Low effort required (the less effort it took, the higher the score)'` に直す。UI や他の層に `DEFAULT_SURVEY` の写し（pinned copy）があれば同じ文面に揃える。保存済みシナリオは自分の `survey` を持つので影響しない。

### 5b.2 答えが得られたら終える（前提ブロックに 1 行足す）

実測: 目標（「特定の期間の時給推移を把握する」）への答えを 1 ターン目で得た後、擬似ユーザーが要因分析・経営的示唆・別の比較を求め続けて `max-turns` になり、`goalAchieved: false` で終わった（アンケートの `q1` は true）。ツールに無い計算（時給の前年比）を求め、エージェントが規律どおり暗算を断ると不満を述べた回もある。

前提ブロックの末尾へ 5 つ目の項目を足す。

```text
- 目標に書かれた内容に、アシスタントがデータの値で答えたら、その時点で目標は達成である（goalAchieved と endConversation を true にする）。目標に無い追加の分析（要因の考察・示唆・別の比較・追加の計算）を求めて会話を延ばさない。
```

en も同じ意味の直訳。

### 5b.3 自由記述の列をカテゴリの例に出さない

実測: e-Stat の `注記` 列（「標本設計改正（1952年末～1953年初）の影響があり…」のような長文）が distinct 60 以下なのでカテゴリ列として載り、前提ブロックを長くしていた。**値の最大長が 30 文字を超える列**はカテゴリの例に出さない（コードらしい列の除外と同じ段で飛ばす）。

## 6. 非スコープ

- 擬似ユーザーの採点（`goalAchieved`・満足度）を客観指標で裏取りすること（回答の数値がツール出力に含まれるかの決定的な照合）。効果は大きいが別の増分にする。
- 手で作ったシナリオ（Scenario 画面）への前提の自動付与。Factory の外では、対象エージェントのデータを決定的に知る手段が無い。
- シナリオ目標の内容（指標名・カテゴリ名）の決定的な検査。年以外は表記揺れが大きく、誤検知が Run を 1 回余計に回すコストに見合わない。
