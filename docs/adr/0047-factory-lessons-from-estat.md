# ADR-0047: 実データ（政府統計 CSV）で Agent Factory を回して分かった欠陥と、その決定的な塞ぎ方

- 状態: 承認
- 日付: 2026-09-20（第1ラウンド: 決定 1–8 / 第2ラウンド: 決定 9–12）
- 関連: ADR-0033（Agent Factory の生成・改善ループ）、`docs/16-agent-factory.md`、`docs/11-scenario-validation.md`、`docs/06-etl-tool-builder.md` §3.15（`parse-period`）

## 文脈

Agent Factory を、作り物ではない CSV（e-Stat の完全失業者数・就業者数など）とローカル 12B モデルで通しで回した。データの形は次のとおり。

| 列 | 中身 |
|---|---|
| `時点` | **1 つの列に粒度が混在する文字列**（`1975年10月` 月次 / `2024年1-3月期` 四半期 / `2024年` 暦年 / `2024年度` 年度） |
| `地域コード` / `地域` | `全国` + 47 都道府県（48 値） |
| 値の列 | `完全失業者（男女計）【万人】` など 1 列 |
| `注記` | 出典・断り書き |

1 ファイル 1,000〜14,000 行。目標は「期間を指定した質問（2008年から2010年の推移、最大だった時期）に答える」。

結果は「Run は `succeeded`・`bestIteration: 1`・自信のある総括」でありながら、中身は全シナリオ失敗・満足度 0・ツール命中率 0 だった。以下は、そのとき実際に記録されていた値と、そこから分かった欠陥である。

### 観測 1: `toolHitRate` が構造的に必ず 0 になる

```json
"expectedToolHit": { "expected": ["factory_tool_asset_fetch_unemployment_data_5cb3da85"], "called": ["fetch_unemployment_data"], "hitRate": 0 }
```

Stage 5 は `Scenario.expectedTools` を Tool の `publishName` で書いていた。一方 `RunScenarioUseCase.collectAgentRun` が `calledTools` に入れるのはトレースの `tool-call` 名、すなわち `toolToModelDefinition` がモデルへ公開する関数名（`agentTool.name ?? publishName`）である。Factory 生成 Tool は必ず `agentTool.name` を持つので、両者は**決して一致しない**。指標の欠陥であって、エージェントの欠陥ではなかった。

### 観測 2: Analyst が盲目で、誤診する

Analyst に渡していたのは status / goalAchieved / 感想 / hitRate だけだった。観測 1 で hitRate が常に 0、さらに当時のアンケート検証の不具合で全シナリオが `status:'error'`・`survey: []` になっていたため、Analyst は「エージェントがツールを呼んでいない。system prompt を簡素化すべき」と結論した。実際には毎ターン呼んでいた。

さらに、ある Run では総括に "I am revising the system prompt" と書きながら `proposals` が空で返り（applied 0 / rejected 0）、`maxIterations: 2`・`errorRate: 1` にもかかわらずループは 1 回で静かに終わった。理由は Run のどこにも残っていない。

### 観測 3: 生成された Tool では目標に答えられない

ToolSmith が作ったのは `csv-source → filter(時点 eq <period>, 地域 eq <region>) → agent-output(maxRows 100, overflow 'error')` だった。

- (a) `時点` は文字列なので**完全一致しか引けない**。範囲指定も、時系列順の並べ替えも、最大値の期間も出せない。
- (b) 引数はすべて省略可能（`makeArgumentsOptional`）なので、エージェントの最初の呼び出しは「引数なし」になる。それは 1,191 行を返し、`agent-output` を溢れさせて**ツール呼び出し自体が失敗**した。
- (c) エージェントは年次データに `"2015年12月31日"` を渡して 0 行を得た。そのうえで記憶から数字を作文して答えた。

### 観測 4: Run の状態とレポートが正直でない

`errorRate: 1` / `avgSatisfaction: 0` の Run が `succeeded` で終わり、レポートには Analyst の自信のある総括だけが載った。`avgSatisfaction: 0` は「満足度が低い」ではなく「1 件も回収できていない」だったが、メトリクスからはその区別がつかない（`avgSatisfaction` は `q2` を持つ Run だけの平均なので、欠測は平均に現れない）。

## 決定

### 1. 期待 Tool 名は「エージェントが呼ぶ関数名」で持つ

`GenerateAgentAssetsResult.toolKeyToPublishName` を `toolKeyToToolName` へ改め、値を `agentTool.name ?? publishName` にする（再利用した既存 Tool はカタログの `toolName` が同じ導出をしている）。Stage 5 はこれをそのまま `Scenario.expectedTools` へ入れる。

名前の導出を `toolToModelDefinition` と 1 本に揃えるのが要点で、「保存時の名前」と「呼び出し時の名前」を別々に組み立てる限り同じ事故が再発する。

### 2. Analyst には「なぜ失敗したか」を判断できる材料だけを増やす

Scenario 別サマリへ次を足す。いずれも決定的な事実で、解釈は Analyst に委ねる。

- `errorStage` / `errorMessage`（`ScenarioRun.error`）。`survey` 段の失敗は会話が成立していることを意味する。
- `expectedTools` / `calledTools`（名前の食い違いと「呼んでいない」を区別させる）。
- `surveyCollected`（欠測と低評価を区別させる）。
- `toolCalls`: 実際に渡した引数と返ってきた行数。`ScenarioRun.transcript[].runId` から Agent Run のトレースを引いて畳む。トレースは**防御的に**読む（`rowCount` も `noMatch` も古い Run には無い）。
- `answeredWithNumbersAfterZeroRows`: 0 行（または該当なし）の直後に数字入りで答えたターンがあるか。観測 3(c) の兆候そのもので、プロンプトではなく Tool の引数契約を疑うべき合図になる。

system プロンプトには「これらをどう読むか」も書く（欠測は不満ではない、名前違いは不使用ではない、0 行は引数の書式か値が違う、等）。

あわせて `IterationMetrics.surveyMissingCount`（`q2` を回収できなかった件数）を足し、レポート・UI に出す。`errorRate` は会話の失敗率だけを意味する（アンケート欠測は含まない）ことを明記する。

### 3. 「改訂すると言って提案 0 件」はロールの失敗として扱う

`proposals` が空なら、明示的な差し戻し文言（`EMPTY_PROPOSALS_FEEDBACK`）を untrusted payload 側へ添えて **1 回だけ**再依頼する（`budget.maxRoleCalls` に余裕があるときだけ）。それでも空ならループを打ち切るが、`no_proposals` を接頭辞に持つ `proposal_rejected` イベントで理由を残す。提案が全て却下された場合も `no_applied_proposals` で残す。

新しい `FactoryEventKind` は足さない（ADR-0033 の方針どおり、イベント語彙は増やさずメッセージで説明する）。

### 4. 期間は決定的なノードで開いてから絞る

`parse-period` ノード（`docs/06` §3.15）を ToolSmith の許可語彙へ入れ、`limit` も加える（`SAFE_TRANSFORM_TYPES` = select / filter / sort / distinct / limit / parse-period / summary-statistics）。プロンプトには各ノードの config 契約をノードカタログとして列挙し、期間の定石を教える。

```text
source → parse-period → filter(periodGranularity eq <粒度>) → filter(periodStart gte/lte <日付引数>) → sort(periodStart) → limit → agent-output
```

日付の範囲引数は `agent-input` に `type: "date"` で宣言し、`valueBinding` で gte / lte 条件へ束縛する（`validateToolArguments` が ISO 文字列を `Date` へ正規化する）。粒度が混在する列（`mixed: true`）では粒度フィルタを**必須**とする。粒度の語彙は `PERIOD_GRANULARITIES` から導出し、プロンプト側でリテラルを複製しない。

### 5. Stage 0 プロファイルに「期間列・値の列挙・総行数」を足す

`DataProfile` へ次を足し、Planner と ToolSmith の untrusted payload に載せる。

- `rowCount`: データソース全体の行数。
- `periodColumns[]`: `parsePeriodLabel` が非 null 値の **90% 以上**を解釈できた文字列列。粒度別件数・`minStart` / `maxStart`・`mixed` を持つ。
- `categoricalColumns[]`: distinct が **60 以下**の文字列列と、その全値（48 都道府県はここに載る）。

判定はサンプル 20 行ではなく**全行**に対して行う（年次と月次の混在は末尾に出るため、サンプルでは取りこぼす）。プレビューが既に計算済みの `fullOutput` を使うので追加の実行コストは掛からない。

Planner / ToolSmith には、これを使って「粒度は分けること」「出力は縛ること」「説明文に受け付ける書式と有効な値を書くこと」を指示する。

### 6. 生成直後に「引数なしの呼び出し」を決定的に試す

修復ループでは、設計時プレビュー（`agent-input` の `sample` を束縛した = 全引数を渡した呼び出し）に加えて、**実行時と同じ `graphWithArguments` で全引数を省略した 2 本目のプレビュー**を回す。終端 `agent-output` が `shape: 'rows'` かつ `overflow: 'error'` で `rows > maxRows` なら、直し方（末尾に `limit` を足す / 集計する / `shape: "summary"` にする）を添えて修復ループへ差し戻す。

Factory 生成 Tool の引数はすべて省略可能なので、「既定の呼び出し」は仕様の一部であって例外ではない。これを設計時に通しておかないと、最初の 1 回目の呼び出しで必ず落ちる。

あわせて、エンジン検証より手前に**構造検査**（`describeGraphShapeViolations`）を置く: 許可ノード語彙、計画どおりの source と `dataSourceId`、`agent-output` がちょうど 1 つ、`agent-input` が未接続、データ経路が単一チェーン。エンジンのスキーマエラーは「どう直すか」を伝えられないため、修復が空回りしていた。

### 7. 回答の規律は決定的合成側に置き、プロンプト改訂で消させない

生成 Agent の system prompt へ、言語非依存の見出し `# Answer discipline / 回答の規律 (factory-managed)` を持つブロックを**決定的に**付ける。内容は「数字はツールの行から引き写す」「0 行なら 0 行と言い、実在する値を挙げて次の条件を提案する」「時点と単位を併記する」「注記を引用する」「引数は説明どおりの書式・値で渡す」。

このブロックは Assembler の起草物ではないので、`system-prompt-revision`（役割文と実行規則をまるごと差し替える提案）を適用しても残る。`ApplyImprovementsUseCase` は、起点 Agent が持っていた文面があればそれを引き継ぐ（利用者が手を入れた規律を既定文へ戻さない）。

### 8. Run の状態と成果物の質を分けて書く

`FactoryRunStatus` の意味は変えない（`succeeded` = パイプラインが最後まで走った）。そのうえで `FactoryReport` へ決定的な品質判定を足す。

| `report.quality` | 条件 |
|---|---|
| `met-targets` | 最良イテレーションが `options.targets` を満たした |
| `below-targets` | 測れたが `goalAchievedRate` か `avgSatisfaction` が目標に届かない |
| `unverified` | そもそも測れていない（シナリオ0件 / 全シナリオがエラー / アンケート全欠測） |

`report.qualityReasons` に理由を残し、API / UI の DTO と Factory 画面にも出す。「満たしていない」と「測れていない」を分けるのが要点で、全滅した Run を「未達」と書くとエージェントの質の問題に見えてしまい、観測 2 と同じ誤診を人間の側で繰り返すことになる。

## 帰結

- Factory が作る Tool は、既定の呼び出しで落ちないこと・期間を範囲で引けることが**保存前に**保証される。`add-tool` 提案の適用も同じ `generateToolWithRepair` を通るので、改善ループで足す Tool にも同じ規律が掛かる。
- Analyst の入力は増えるが、すべて決定的な事実で、untrusted data として隔離する規律（ADR-0033）は変わらない。Agent Run のトレースを読むために `RunFactoryUseCase` は `RunRepository` を任意依存として受け取る（未注入なら `toolCalls` が欠けるだけで Run は従来どおり動く）。
- `IterationMetrics.surveyMissingCount` と `FactoryReport.quality` / `qualityReasons` は永続化スキーマの追加フィールドで、既存の保存済み Run は既定値（`0` / `'unverified'` / `[]`）で読める。判定不能な旧 Run を「目標達成」と偽らない側へ倒してある。
- ToolSmith のプロンプトは長くなる。12B 級のローカルモデルでは、短い原則より「ノードの config 契約」と「定石のチェーン」を具体的に見せる方が通る確率が高い、という実測に従った選択である。

## 第2ラウンド: 同じデータで回し直して残った 3 つの欠陥

上記を入れて再実行した。`toolHitRate` は 0 → 1 になり、生成 Tool は `parse-period → 粒度 filter → periodStart filter → limit` の形になり、レポートは正直に `below-targets` を出し、0 行のツール結果に対してエージェントは「該当するデータがありません」と答えた（作文しなくなった）。残った欠陥は**すべて Tool の設計**の問題だった。

生成された Tool（総人口・48 地域・都道府県は**年次の行しか無い**）:

```text
csv-source → parse-period(時点) → filter(periodGranularity eq 'year') → filter(地域 eq <prefectures>)
  → filter(periodStart gte <time_point>, periodStart lte <time_point>) → select(["地域","総人口（総数）【人】"])
  → limit(100) → agent-output
引数: prefectures: string nullable / time_point: string nullable（sample "2024-01-01"）
```

### 観測 A: `select` が証拠の列を落とした

`時点` も `periodStart` も `注記` も出力に残らなかった。エージェントは「いつの数字か」を行から読めず、**年次の行しか返さない Tool の結果に「2023年12月 14,212,596人」という月次の期間を付けて**答えた。回答の規律は「時点を併記せよ」と書いてあるが、行に時点が無ければ守れない。

### 観測 B: 範囲も「最新」も引けない

同じ引数 `time_point` が `gte` と `lte` の**両方**に束縛されていた。これは範囲指定の顔をした完全一致であり、しかも型は `string`（`date` ではない）。年次データ（`periodStart` は 2023-01-01）に 2023-10-01 を渡せば 0 行になる。`sort` も無いため「最新」も「2008年から2010年の推移」も原理的に出せない。

### 観測 C: 1 カテゴリ 1 呼び出しがツール予算を食い潰した

「東京都・大阪府・北海道を比較」のシナリオが `RunFailedError: tool call limit exceeded: maximum 4`（`MAX_TOOL_CALLS`）で落ちた。原因は Analyst 自身の改訂で、Tool の説明を「一度に一つの都道府県のみ」に絞っていた。3 県の比較が 3 回の呼び出しになり、他の呼び出しと合わせて上限を超えた。

加えて、goalAchievedRate が 0.5 → 0 へ落ち 1 件が `agent` 段で落ちたイテレーションで、**Analyst は findings を 1 件も返さなかった**。

## 第2ラウンドの決定

### 9. 行を返す Tool には「意味」の検査を掛ける（`describeToolSemanticViolations`）

構造検査（決定 6）とエンジンのスキーマ検証を通っても、答えに使えない Tool はできる。スキーマが確定した直後に、行を返す Tool（`shape` が `rows`/`first-row`、集計ノードなし）へ次を掛け、違反は直し方つきで修復ループへ返す。

| 検査 | 根拠 |
|---|---|
| 終端の表に**元の期間ラベル列**が残っている | 観測 A。`periodStart` は代替にならない（エージェントが引用するのはデータが使っているラベル） |
| 終端の表に数値列が最低 1 つ残っている | 観測 A。答えるものが無い Tool を作らせない |
| `date` 列を絞る引数は `type: "date"` | 観測 B。`string` だと日付比較が文字列比較になる |
| 同じ引数を下限と上限の両方へ束縛していない | 観測 B。`*_from` / `*_to` の 2 つの nullable 引数へ分けさせる |
| `parse-period` を使うなら開始日で `sort` している。目的が「最新・直近・latest」を求めるならその向きが `desc` | 観測 B。並べ替えが無いと `limit` が意味を持たない |

注記列（`注記` / remarks / 備考）の保全は**プロンプト規則**にとどめた。目的によっては落として良く、Run を止める検査にすると正当な Tool まで弾くため。「最新なら降順」も、目的の文言に最新系のキーワードがあるときだけ強制する。

**「引数なし呼び出しの 1 行目が最新の期間か」を実行して確かめる案は採らなかった。** 並べ替えの向きを直接見れば同じことが分かり、プレビューをもう 1 本増やさずに済む。何をもって「最新を求める目的か」を決めるのはどのみちキーワード判定であり、実行して確かめてもその恣意性は消えない。取りこぼした言い回しはプロンプト規則が拾う。

### 10. 1 回の呼び出しで複数カテゴリを返せる設計を既定にする

`filter` に `in` 演算子は**足さない**（ドメインの演算子を増やすのは影響範囲が大きく、今回の失敗は `in` が無いことではなく「1 カテゴリ 1 呼び出しの設計」が原因）。代わりに:

- カテゴリ引数は nullable のままにし、省略すればその期間の全カテゴリが返ること（48 行は `maxRows` に収まる）を ToolSmith へ教える。「一度に一つ」を説明へ書かせない。
- Analyst と Assembler のペイロードへ `toolCallBudget`（= `MAX_TOOL_CALLS`）を渡し、「対象ごとに 1 回ずつ呼ぶ」設計・規則を提案させない。
- 回答の規律へ「複数の対象を比べるときは絞り込み引数を省略して 1 回だけ呼び、返った行から選ぶ」を足す。ただし**この Run の Tool が実際に引数を省略できるときだけ**（`inputSchema` の nullable 宣言から決定的に導く）。守れない指示を書くと他の規律まで薄まる。

**将来の課題**: 複数値を 1 回で明示指定したい場合（「この 3 県だけ」）は `filter` に `in` 演算子が要る。ドメイン・保存検証・UI・Tool Calling スキーマ（配列引数）に跨るため、独立した増分として扱う。

### 11. 悪化は決定的に列挙して Analyst へ渡す

`regressions[]` を算出して渡す: 主指標・満足度・ツール命中率の低下、エラー率・アンケート欠測の増加、そして**前イテレーションに無かった失敗段の出現**。プロンプトでは「各項目を必ず findings に反映し、`regressions` が空でないのに空の findings を返さない」と明示する。悪化が無ければキーごと渡さない（空配列を見せない）。

### 12. 最良イテレーションは `errorRate` まで見て選ぶ

優先順に **`goalAchievedRate` 大 → `errorRate` 小 → `avgSatisfaction` 大 → index 小**。`errorRate` を満足度より先に置くのは、会話が落ちたイテレーションは「観測できていない」のであって「満足度が高い」わけではないため。全て同点なら早いイテレーションを残す（同じ成績なら改訂の少ない版が安全）。

## 却下した案

- **`ScenarioRun.metrics.expectedToolHit` の比較を名前の正規化で甘くする**: 命中率は「期待どおりの Tool を呼んだか」の指標であって、似た名前を当てる指標ではない。名前の導出を 1 本に揃える方が正しい。
- **Tool の出力を実行時に黙って `maxRows` で切る**: 既に `omissionNote` で件数は伝えているが、「設計上どうやっても溢れる Tool」を作らせない方が先である。実行時の救済は、設計時の欠陥を見えなくする。
- **回答の規律を Assembler のプロンプトに書かせる**: 実測で Analyst の書き直しに消された。LLM に書かせたものは LLM に消される。
- **全滅した Run を `failed` にする**: `succeeded` は「パイプラインが完走した」という既存の契約で、生成資産（draft）は失敗解析のために残す必要がある（`docs/16` §7）。状態の意味を変えるより、質の判定を別に載せる方が壊れない。
- **`filter` に `in` 演算子を足して複数カテゴリを一度に指定させる（第2ラウンド）**: 観測 C の原因は `in` が無いことではなく「1 カテゴリ 1 呼び出し」の設計であり、引数を省略すれば全カテゴリが 1 回で返る。ドメイン・保存検証・UI・Tool Calling の配列引数に跨る変更を、今この欠陥のために入れる理由がない。後続の独立した増分とする。
- **注記列の保全を必須検査にする（第2ラウンド）**: 目的によっては落として良い列なので、Run を止める検査にすると正当な Tool まで弾く。プロンプト規則にとどめた。
- **「引数なし呼び出しの 1 行目が最新か」を実行して確かめる（第2ラウンド）**: 並べ替えの向きを見れば同じことが分かり、プレビューを 1 本増やさずに済む。「最新を求める目的か」の判定がキーワード依存である点は、実行しても変わらない。
