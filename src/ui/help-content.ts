/**
 * アプリ内ヘルプの文言（画面ごと）。
 *
 * **リポジトリ内の Markdown はブラウザから開けない**（本番の静的配信は `dist/ui` だけで、
 * `docs/` は配信対象に入らない。dev の Vite でだけ偶然開けても、同じUIが本番でリンク切れになる）。
 * そのため「短い説明をダイアログで見せる」＋「もっと詳しく知りたい人向けにファイルパスを示す」構成にする。
 */
import type { ScreenName } from './screens';

/** 日英ペア。表示側が `text(en, ja)` で解決する。 */
export interface HelpText {
  readonly en: string;
  readonly ja: string;
}

export interface ScreenHelp {
  readonly title: HelpText;
  /** この画面が何をするところか（1-2文）。 */
  readonly summary: HelpText;
  /** ここで何をすればよいか。順番に並べる。 */
  readonly steps: readonly HelpText[];
  /** 参照ドキュメントのリポジトリ内パス（ブラウザからは開けないので文字列として示す）。 */
  readonly doc?: string;
}

const HELP: Readonly<Record<ScreenName, ScreenHelp>> = {
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
  Validation: {
    title: { en: 'Validation', ja: '検証' },
    summary: { en: 'Define personas and scenarios, run them against an Agent, and score the results before promoting a version.', ja: 'ペルソナとシナリオを定義してエージェントに実行させ、結果を採点してからバージョンを昇格します。' },
    steps: [
      { en: 'Personas → Scenarios → Runs is the usual order.', ja: 'ペルソナ → シナリオ → 実行 の順で進めます。' },
      { en: 'Datasets, Experiments, and Quality gates are for repeatable comparison.', ja: 'データセット・実験・品質ゲートは、繰り返し比較するためのものです。' },
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
  return HELP[screen];
}
