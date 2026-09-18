/**
 * アプリ内ヘルプの文言（画面ごと）。
 *
 * **リポジトリ内の Markdown はブラウザから開けない**（本番の静的配信は `dist/ui` だけで、
 * `docs/` は配信対象に入らない。dev の Vite でだけ偶然開けても、同じUIが本番でリンク切れになる）。
 * そのため「短い説明をダイアログで見せる」＋「もっと詳しく知りたい人向けにファイルパスを示す」構成にする。
 */
import { businessOf } from './business/registry';
import type { BusinessScreenName } from './business/screen-ids';
import type { ScreenHelp } from './business/types';
import type { ScreenName } from './screens';

export type { HelpText, ScreenHelp } from './business/types';

/** 業務ではない画面。業務の画面のヘルプは業務の記述子（`<業務>/<業務>-business.ts`）が持つ（ADR-0039）。 */
type CoreScreenName = Exclude<ScreenName, BusinessScreenName>;

const HELP: Readonly<Record<CoreScreenName, ScreenHelp>> = {
  Chat: {
    title: { en: 'Chat', ja: 'チャット' },
    summary: { en: 'Talk to a saved Agent (or Multi-Agent) with its version pinned, and see which tools it called.', ja: '保存済みのエージェント（またはマルチエージェント）をバージョン固定で実行し、どのツールを呼んだかを確認します。' },
    steps: [
      { en: 'Pick an Agent in the selector at the bottom.', ja: '下の選択欄でエージェントを選びます。' },
      { en: 'Send a message. Runs are preview mode, so write tools are blocked.', ja: 'メッセージを送ります。プレビュー実行なので書き込み系ツールは遮断されます。' },
      { en: 'No Agent yet? Load the sample data, or build one in the Agent screen.', ja: 'エージェントが無い場合は、サンプルを読み込むかエージェント画面で作成してください。' },
    ],
    doc: 'docs/13-demo-operation-manual.md',
  },
  Data: {
    title: { en: 'Data sources', ja: 'データソース' },
    summary: { en: 'Register the CSV/JSON files and database connections that Tools read from.', ja: 'ツールが読み取るCSV／JSONファイルとデータベース接続を登録します。' },
    steps: [
      { en: 'Upload a CSV or JSON file (up to 5 MB each).', ja: 'CSVまたはJSONファイルをアップロードします（1ファイル最大5 MB）。' },
      { en: 'Database credentials stay on the server; only the connection ID is selectable here.', ja: 'DBの資格情報はサーバーだけが持ちます。この画面では接続IDだけを選べます。' },
      { en: 'Next: build a Tool that reads it, or let Factory generate one for you.', ja: '次は、これを読むツールを作るか、Factoryに自動生成させます。' },
    ],
    doc: 'docs/06-etl-tool-builder.md',
  },
  Tool: {
    title: { en: 'Tool Builder', ja: 'ツールビルダー' },
    summary: { en: 'Compose a data pipeline (source → transform → output) that an Agent can call as a function.', ja: 'エージェントが関数として呼べるデータ処理（ソース → 変換 → 出力）を組み立てます。' },
    steps: [
      { en: 'Start from a source node and connect transforms toward one output node.', ja: 'ソースノードから始め、変換をつないで1つの出力ノードへ流します。' },
      { en: 'The preview panel shows sample rows as soon as the graph is valid.', ja: 'グラフが有効になると、プレビューにサンプル行が出ます。' },
      { en: 'Fill the metadata and save a version so Agents can reference it.', ja: 'メタデータを入力してバージョンを保存すると、エージェントから参照できます。' },
      { en: '"Check readiness" runs the same preflight an Agent run would, without saving, and points at the node or setting to fix.', ja: '「呼び出し診断」は保存せずにエージェント実行と同じ事前検査を行い、直すべきノードや設定を示します。' },
    ],
    doc: 'docs/06-etl-tool-builder.md',
  },
  Skill: {
    title: { en: 'Skill Builder', ja: 'スキルビルダー' },
    summary: { en: 'Write reusable instructions (when to act, what to output) that Agents load as context.', ja: 'エージェントが文脈として読み込む、再利用可能な指示（いつ・何を出力するか）を書きます。' },
    steps: [
      { en: 'Describe the responsibility, activation condition, and expected output.', ja: '責務・発動条件・期待する出力を記述します。' },
      { en: 'Save a version, then attach it to an Agent in the Agent screen.', ja: 'バージョンを保存し、エージェント画面でエージェントへ割り当てます。' },
    ],
  },
  Agent: {
    title: { en: 'Agent Builder', ja: 'エージェントビルダー' },
    summary: { en: 'Assemble Skills, Tools, Wikis, and MCP servers into an Agent, then save it as a version.', ja: 'スキル・ツール・Wiki・MCPサーバーを束ねてエージェントを組み立て、バージョンとして保存します。' },
    steps: [
      { en: 'Fill the required fields, then select the Skills and Tools it may use.', ja: '必須項目を入力し、使用するスキルとツールを選びます。' },
      { en: '"Generate draft" writes a system prompt from that selection — review it before saving.', ja: '「草案を生成」は選択内容からシステムプロンプトを書きます。保存前に必ず確認してください。' },
      { en: '"Check integration" verifies, without saving, that every attached Tool can actually be called; saving also runs it and summarizes the result.', ja: '「組み込みチェック」は保存せずに、割り当てたツールを実際に呼び出せるかを検査します。保存時にも自動で実行され、結果を要約します。' },
      { en: 'After saving, try it in the Chat screen.', ja: '保存したらチャット画面で試します。' },
    ],
    doc: 'docs/03-domain-model.md',
  },
  Harness: {
    title: { en: 'Multi-Agent Builder', ja: 'マルチエージェントビルダー' },
    summary: { en: 'Wire several saved Agents into one orchestration pattern (sequential, handoff, concurrent, and so on).', ja: '保存済みのエージェント複数を、1つのオーケストレーションパターン（逐次・handoff・並行など）へ組み立てます。' },
    steps: [
      { en: 'Pick a pattern on the left, then assign a saved Agent version to every slot.', ja: '左でパターンを選び、全slotへ保存済みエージェントのバージョンを割り当てます。' },
      { en: 'Validate, save a version, and run a preview from this screen or the Chat screen.', ja: '検証してバージョンを保存し、この画面かチャット画面でプレビュー実行します。' },
    ],
    doc: 'docs/12-multi-agent.md',
  },
  Factory: {
    title: { en: 'Agent Factory', ja: 'Agent Factory' },
    summary: { en: 'Describe a goal and pick data sources; Factory generates Tools, Skills, an Agent, and validation assets as drafts, then improves them in a loop.', ja: 'やりたいことを書いてデータソースを選ぶと、ツール・スキル・エージェントと検証資産をdraftとして自動生成し、改善ループを回します。' },
    steps: [
      { en: 'Register at least one data source first (Create mode requires it).', ja: '先にデータソースを1件以上登録します（新規作成モードでは必須）。' },
      { en: 'Everything it produces is a draft — review it in the Agent / Tool / Skill screens.', ja: '生成されるものはすべてdraftです。エージェント・ツール・スキルの各画面で確認してください。' },
    ],
    doc: 'docs/16-agent-factory.md',
  },
  Inspect: {
    title: { en: 'Inspect', ja: '動作確認' },
    summary: { en: 'Run one request against a saved Agent and read the full trace: which tools ran, what came back, what it cost.', ja: '保存済みエージェントへ1回だけ指示を送り、どのツールが動いて何が返ったか、費用はいくらかを詳細に確認します。' },
    steps: [
      { en: 'Use this when a Chat answer looks wrong and you need to see why.', ja: 'チャットの回答がおかしいとき、原因を見るために使います。' },
    ],
    doc: 'docs/07-execution-model.md',
  },
  ToolCheck: {
    title: { en: 'Tool Check', ja: 'ツール検証' },
    summary: { en: 'Run a saved Tool by itself with the arguments an Agent would pass, compare the output with what you expect (row count, columns, values, duration), and keep the case to re-run after changes.', ja: '保存済みツールを、エージェントが渡すのと同じ引数で単体実行し、期待する結果（行数・列・値・所要時間）と比べて合否を出します。ケースとして保存すれば、ツールやデータを変えた後に再実行して退行を見つけられます。' },
    steps: [
      { en: 'Pick a Tool, fill the arguments, run. The output is computed on the full data exactly as in an Agent run, without side effects.', ja: 'ツールを選び、引数を入れて実行します。エージェント実行と同じく全行で計算し、副作用は起こしません。' },
      { en: 'Add expectations and save the case. "Run all" re-checks every saved case.', ja: '期待を追加してケースを保存します。「すべて実行」で保存済みケースをまとめて再確認できます。' },
      { en: 'A row expectation finds one row by "column == value" and checks that it is there, that it is gone, or what its cells hold. For a tool with an AI judgment node you can also expect the verdict for one of its input rows — tick every verdict you would accept, since AI verdicts vary.', ja: '「行の期待」は「列 == 値」で行を1つ特定し、残るか・消えるか・値がどうかを確かめます。AI判定ノードを含むツールでは、その入力行の判定値も期待にできます（AIの判定は揺れるので、許容できる判定値を複数選べます）。' },
      { en: '"Suggest cases with the model" drafts normal / boundary / abnormal cases from the tool definition. Run each to confirm, then save the ones you keep. Needs a model with structured output (see Settings).', ja: '「LLMでケースを提案」は、ツール定義から 正常 / 境界 / 異常 のケース案を作ります。実行して確認し、残すものを保存します。構造化出力に対応したモデルが必要です（設定画面）。' },
    ],
    doc: 'docs/06-etl-tool-builder.md',
  },
  Templates: {
    title: { en: 'Business templates', ja: '業務テンプレート' },
    summary: { en: 'The entry point for features built for a specific line of work. Pick one from the list to open it.', ja: '特定の業務向けにあらかじめ組んである機能の入口です。一覧から選ぶとその業務の画面に入ります。' },
    steps: [
      { en: 'Pick a template to open it. Each one is a full screen with its own steps; use the back link at the top to return here.', ja: '使う業務を選ぶと、その画面に入ります。各業務は独自の手順を持つ画面で、上部の戻るリンクでここへ戻れます。' },
      { en: 'Only templates that are ready to use are listed. The studio-wide features (data sources, tools, agents) stay in the groups above.', ja: '一覧に出るのは今すぐ使えるものだけです。データソース・ツール・エージェントのような全体で使う機能は、上のグループのままです。' },
    ],
  },
  Validation: {
    title: { en: 'Validation', ja: '検証' },
    summary: { en: 'Define personas and scenarios, run them against an Agent, and score the results before promoting a version.', ja: 'ペルソナとシナリオを定義してエージェントに実行させ、結果を採点してからバージョンを昇格します。' },
    steps: [
      { en: 'Personas → Scenarios → Runs is the usual order.', ja: 'ペルソナ → シナリオ → 実行 の順で進めます。' },
      { en: 'Datasets, Experiments, and Quality gates are for repeatable comparison.', ja: 'データセット・実験・品質ゲートは、繰り返し比較するためのものです。' },
      { en: 'LLM judging is scored per criterion (binary 0 / 1 levels recommended; "cannot assess" is excluded from the composite). In the rubric, choose what trace the judge may see (optional / required / forbidden); in the experiment, set judge samples to 2 or more to take the median and flag high dispersion.', ja: 'LLM採点は基準ごとに判定します（0 / 1 の二値を推奨。「判定不能」は合成スコアから除外）。ルーブリックで判定者に見せる実行履歴（任意 / 必須 / 禁止）を選び、実験の「判定サンプル数」を 2 以上にすると中央値を採用してばらつきを警告します。' },
      { en: 'Experiments with a judge rubric need a model in the judge slot (Settings → Model provider); the Experiments tab warns before you start and offers a button to the slot. A rubric whose trace policy is "required" works with turn cases only: scenario cases never produce a tool trace, so such an experiment is rejected. Set the policy to optional or use a dataset of turn cases.', ja: '審査ルーブリックを使う実験には judge スロットのモデルが必要です（設定 → モデルプロバイダ）。未設定なら実験タブが開始前に警告し、設定画面へのボタンを出します。軌跡ポリシーが「必須」のルーブリックはターン事例だけで使えます。シナリオ事例では軌跡が得られないため実験は拒否されるので、ポリシーを「任意」にするか、ターン事例だけのデータセットを使ってください。' },
    ],
    doc: 'docs/11-scenario-validation.md',
  },
  Memory: {
    title: { en: 'Memory', ja: '記憶' },
    summary: { en: 'Keep Wiki pages that Agents can retrieve at run time, and review memory proposals distilled from past runs.', ja: 'エージェントが実行時に参照できるWikiページを持ち、過去の実行から抽出された記憶の提案を確認します。' },
    steps: [
      { en: 'Create a Wiki space first, then add pages to it.', ja: '先にWikiを作成し、その中にページを追加します。' },
      { en: 'An Agent can only read the Wikis selected on the Agent screen.', ja: 'エージェントが読めるのは、エージェント画面で選択したWikiだけです。' },
    ],
    doc: 'docs/10-memory.md',
  },
  MCP: {
    title: { en: 'MCP', ja: 'MCP' },
    summary: { en: 'Register external MCP servers whose tools Agents can call, and preview the (locked) publication manifest.', ja: 'エージェントが呼べる外部MCPサーバーを登録し、公開マニフェスト（ロック中）をプレビューします。' },
    steps: [
      { en: 'Registered server tools appear as mcp__<server>__<tool> in the Agent screen.', ja: '登録したサーバーのツールは、エージェント画面で mcp__<サーバー名>__<ツール名> として現れます。' },
      { en: 'Outbound publication stays locked until auth and audit adapters exist.', ja: '外部への公開は、認証・監査アダプターが揃うまでロックされています。' },
    ],
    doc: 'docs/08-security-auth.md',
  },
  Status: {
    title: { en: 'Run status', ja: 'ステータス' },
    summary: { en: 'Browse saved runs with their traces, and create or restore database backups.', ja: '保存済みの実行とトレースを閲覧し、データベースのバックアップ作成・復元を行います。' },
    steps: [
      { en: 'Backups are written on the machine running the server, not downloaded to this browser.', ja: 'バックアップはサーバーが動いているマシン上に作られます。ブラウザへはダウンロードされません。' },
    ],
    doc: 'docs/17-operations-runbook.md',
  },
  Settings: {
    title: { en: 'Settings', ja: '設定' },
    summary: { en: 'Choose the display language and the model provider. The main slot runs Agents; the judge slot scores evaluations.', ja: '表示言語とモデルプロバイダを設定します。mainスロットはエージェント実行、judgeスロットは評価に使われます。' },
    steps: [
      { en: 'Set the main model before anything else — Agents cannot answer without it.', ja: '何よりも先にmainモデルを設定してください。これが無いとエージェントは応答できません。' },
      { en: 'API keys are stored write-only and are never sent back to this browser.', ja: 'APIキーは書き込み専用で保存され、ブラウザへ戻されることはありません。' },
    ],
    doc: 'docs/02-tech-stack.md',
  },
};

export function screenHelp(screen: ScreenName): ScreenHelp {
  return businessOf(screen)?.help ?? HELP[screen as CoreScreenName];
}
