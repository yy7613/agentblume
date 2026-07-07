# 11. シナリオ検証（種別疑似ユーザー × 複数ターン会話 × アンケート）

> 参照: [03-domain-model.md §6](./03-domain-model.md) / [07-execution-model.md §4](./07-execution-model.md)
>
> **凡例**: ✅ = ideasに明記 / 🔷 = 本仕様書が補う具体化

検証対象のAgentに対し、**種別（ペルソナ）を持つ疑似ユーザー**が**複数ターンの会話**で実際にタスクを試み、終了後に**アンケート（定量）と感想（定性）**を回答する仕組み。実装は Increment 16（[ADR-0017](./adr/0017-scenario-validation-pseudo-users.md) / [implementation/v16-scenario-validation.md](../implementation/v16-scenario-validation.md)）。

---

## 1. 全体像

```mermaid
flowchart LR
  subgraph Def["定義（バージョン付き）"]
    P["Persona<br/>種別疑似ユーザー"]
    S["Scenario<br/>目標・対象Agent・上限ターン・<br/>期待Tool・アンケート設問"]
  end
  subgraph Exec["実行"]
    ORCH["会話オーケストレータ<br/>（決定的・ターン交互）"]
    PU["疑似ユーザー<br/>（Persona prompt + 構造化出力）"]
    TA["検証対象Agent<br/>（保存済み・Tool Calling・トレース）"]
    SV["アンケート回答<br/>（構造化出力）"]
  end
  subgraph Out["結果"]
    RUNREC["ScenarioRun<br/>全文トランスクリプト + 各ターンRun参照"]
    REP["レポート<br/>定量（達成/ターン数/Tool適合）<br/>定性（アンケート/感想）"]
  end

  P --> S --> ORCH
  ORCH <--> PU
  ORCH <--> TA
  ORCH --> SV --> RUNREC --> REP
```

- 疑似ユーザーの各発話・終了判断・アンケートはすべて **構造化出力**（既存の Structured Output 機構）で受け取り、アプリ側で検証する。
- 検証対象Agentの各ターンは既存の **保存済みAgent実行**（bounded tool loop・Runトレース永続化）をそのまま使う。1ターン = 1 Run。

---

## 2. Persona（種別疑似ユーザー）✅→🔷

`ideas.md`「ユーザープロファイルで動作する疑似ユーザーエージェント」の具体化。**種別プリセット + カスタム属性**で定義する。

### 種別プリセット（archetype）

| 種別 | 挙動の型 |
|---|---|
| `novice`（初心者） | 用語を知らない。説明を求める。曖昧な表現で依頼する |
| `expert`（専門家） | 正確な用語で具体的に要求。回答の粗を突く |
| `busy`（せっかち） | 短文。結論を急ぐ。冗長な回答に不満を示す |
| `vague`（曖昧） | 要件を小出しにする。目標を最初に明かさない |
| `skeptical`（懐疑的） | 回答の根拠を求める。誤りを疑って確認する |
| `custom` | プリセットなし。属性と追加指示のみで構成 |

### Persona 属性（🔷）

```typescript
interface Persona {
  metadata: /* internalId / 名称 / SemVer / owner / tenant — Tool/Skill/Agentと同じ共通形 */;
  archetype: 'novice' | 'expert' | 'busy' | 'vague' | 'skeptical' | 'custom';
  knowledgeLevel: 'low' | 'mid' | 'high';
  patience: 'low' | 'mid' | 'high';       // 何ターンで諦めるかの傾向（プロンプトに反映）
  tone: string;                            // 口調（例: 丁寧・くだけた・事務的）
  verbosity: 'terse' | 'normal' | 'chatty';
  language: 'ja' | 'en';
  extraInstructions?: string;              // 自由記述の追加人物設定
}
```

Persona から疑似ユーザーの system prompt を**決定的に生成**する（テンプレート合成。LLMは使わない）。生成結果は画面でプレビュー・上書き可能（エスケープハッチ原則）。

### Persona登録 → 疑似ユーザーAgentへの統合（v18・[ADR-0019](./adr/0019-persona-pseudo-user-agent-integration.md)）

Persona は「ユーザープロファイル」として存続し、**登録操作で `kind='pseudo-user'` の Agent として実体化**する。

```mermaid
flowchart LR
  P["Persona<br/>（プロファイル定義・SemVer）"] -->|登録（ベースプロンプト生成）| PA["疑似ユーザーAgent<br/>kind='pseudo-user'・persona@version を出所として保持"]
  PA -->|シナリオが選択（SemVer固定）| S["Scenario.pseudoUser"]
  S -->|実行時に goal/context を合成| RUN["会話ループ"]
  P -.改訂時は再生成→新Agent版.-> PA
```

- Agentの `systemPrompt` = Personaから生成した**目標非依存のベースプロンプト**（編集可）。goal/context はシナリオ実行時に合成 → 1つの疑似ユーザーAgentを複数シナリオで再利用できる。
- v18時点の疑似ユーザーAgentは Tools / Skills / サブエージェントを持てない（将来解除）。
- シナリオの疑似ユーザー選択は **Agent参照に統一**（既存のPersona直接参照は後方互換として読み込み・実行のみ維持、deprecated）。

---

## 3. Scenario（検証パターン）🔷

```typescript
interface Scenario {
  metadata: /* SemVer付き共通形 */;
  target: { agentId: string; version: SemVer };   // 検証対象（バージョン固定）
  pseudoUser?: { agentId: string; version: SemVer }; // 疑似ユーザーAgent（v18〜。kind='pseudo-user' 検証）
  persona?: { personaId: string; version: SemVer };  // 直接参照（deprecated・後方互換）。pseudoUserと排他でどちらか必須
  goal: string;                 // 疑似ユーザーが達成したいこと（例: 先月の売上サマリを得る）
  context?: string;             // 状況設定（例: 経理締め前で急いでいる）
  maxUserTurns: number;         // 1..8（既定4）— LLM同士の無限対話の防止
  expectedTools?: string[];     // 期待するTool公開名（適合率算出用, ideas-v2 §11）
  survey: SurveyQuestion[];     // アンケート設問（既定テンプレをコピーして編集可）
}
```

**再現性**: 対象Agent・Persona・Scenario はすべて **SemVer固定**で参照する。同じ Scenario バージョンの再実行が回帰比較の単位（`ideas-v2.md §11` の「変更前後の回帰差分」）。

---

## 4. 会話ループ（複数ターン）🔷

```mermaid
sequenceDiagram
  participant ORCH as オーケストレータ
  participant PU as 疑似ユーザー（LLM+Persona）
  participant TA as 対象Agent（保存済み実行）
  participant Runs as RunRepository

  ORCH->>PU: goal/context + これまでの会話
  PU-->>ORCH: { message, endConversation, goalAchieved }（構造化出力）
  alt endConversation = true か maxUserTurns 到達
    ORCH->>PU: アンケート依頼（会話全文 + 設問）
    PU-->>ORCH: { 回答..., impressions }（構造化出力）
  else 継続
    ORCH->>TA: message（+会話履歴）
    TA->>Runs: Run記録（Tool Calling・トレース）
    TA-->>ORCH: 応答
    Note over ORCH: 次のターンへ（PUに応答を渡す）
  end
```

- **終了条件**は3つ: ①疑似ユーザーが `endConversation:true` を返す（目標達成 or 諦め）②`maxUserTurns` 到達 ③エラー。ステータスとして記録する。
- 対象Agentの1ターンには既存の上限（Tool call 最大4回・model round 最大5回）がそのまま適用される。
- preview/test 実行の既存規則に従い、**対象AgentのTool集合が read-only の場合のみ実行**する（[07-execution-model.md](./07-execution-model.md)）。

---

## 5. アンケート（定量）と感想（定性）✅→🔷

会話終了後、**疑似ユーザー自身が Persona として**回答する（self-report）。第三者採点（LLM-as-Judge / Evaluator agent）は Phase 4 で追加。

### 設問型

| kind | 回答 | 例 |
|---|---|---|
| `scale` | 整数 min..max（既定1..5） | 満足度は? |
| `boolean` | yes/no | 目的は達成できたか? |
| `text` | 自由記述 | 感想・不満だった点は? |

### 既定テンプレート（DEFAULT_SURVEY）

1. 目的を達成できましたか（boolean）
2. 総合満足度（scale 1-5）
3. 回答のわかりやすさ（scale 1-5）
4. 手間の少なさ — 少ないほど高評価（scale 1-5）
5. 回答をどの程度信頼できましたか（scale 1-5）
6. 良かった点（text）
7. 不満・困った点（text）
8. **感想（自由記述）**（text）— `impressions` として独立フィールドにも保持

---

## 6. ScenarioRun（結果の記録）🔷

```typescript
interface ScenarioRun {
  id: string; scope: TenantScope;
  scenario: { id: string; version: SemVer };   // 実行時点の固定参照
  status: 'completed' | 'max-turns' | 'error';
  goalAchieved: boolean | null;                 // 疑似ユーザー申告
  transcript: Turn[];                           // { speaker: 'user'|'agent', message, runId?(agentターン) }
  survey: { questionId: string; value: number | boolean | string }[];
  impressions: string;                          // 感想
  metrics: {
    userTurns: number; agentRuns: number; totalToolCalls: number;
    expectedToolHit?: { expected: string[]; called: string[]; hitRate: number };
    durationMs: number; usage: RunUsage;        // トークン合計
  };
  startedAt: string; finishedAt: string;
}
```

- `transcript` の各Agentターンは既存 `RunRepository` の Run を `runId` で参照 → Status画面のトレースへドリルダウン可能。
- `expectedToolHit` は期待Tool集合と実呼び出し集合（トレース由来）の比較（`ideas-v2.md §11` の選択率指標の会話版）。

---

## 7. 検証画面の拡張 🔷

| タブ | 内容 |
|---|---|
| **Personas** | 種別プリセットから作成・属性編集・生成プロンプトのプレビュー/上書き・バージョン保存 |
| **Scenarios** | 対象Agent+バージョン選択・Persona選択・goal/context・上限ターン・期待Tool・アンケート設問編集・実行ボタン |
| **Runs** | 実行履歴一覧 → トランスクリプト全文・各ターンのRunトレースリンク・アンケート結果（スケールはバー表示）・感想 |

同一Scenarioの複数Run比較（回帰ビュー）は次段。

---

## 8. 非目標

- LLM-as-Judge / Evaluator agent による第三者採点（Phase 4）
- 複数Persona一括実行・統計集計（次段。まず1実行を確実に）
- ~~疑似ユーザーの完全なAgent化~~ → **v18で統合**（[ADR-0019](./adr/0019-persona-pseudo-user-agent-integration.md)）。残る非目標: 疑似ユーザーAgentへの Tools / Skills / サブエージェント付与（将来解除）
- write/external-action Tool を含むAgentへのシナリオ実行
