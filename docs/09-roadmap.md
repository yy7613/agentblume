# 09. ロードマップと検証指標

段階的リリース。**拡張点は先に用意するが、初期リリースへ機能を詰め込まない**（`ideas-v2.md §7`）。

---

## 1. フェーズ全体像

```mermaid
flowchart LR
  P1["Phase 1<br/>ローカル縦切り"] --> P2["Phase 2<br/>接続とチーム利用"] --> P3["Phase 3<br/>拡張実行"] --> P4["Phase 4<br/>評価と運用"]

  P1 -.- P1d["個人開発で<br/>1本のジャーニー完結"]
  P2 -.- P2d["複数人・接続・権限"]
  P3 -.- P3d["コード・自動化・公開"]
  P4 -.- P4d["評価フライホイール"]

  classDef v1 fill:#e3f2fd,stroke:#1565c0,color:#0d47a1;
  class P1 v1;
```

### 相対タイムライン（イメージ・確定日程ではない）

```mermaid
gantt
  title ロードマップ（相対期間の目安）
  dateFormat YYYY-MM-DD
  axisFormat %m
  section Phase 1 ローカル縦切り
  CSV/JSON入力・基本変換・スキーマ伝播 :p1a, 2026-01-01, 60d
  Tool契約・Agent接続・チャット・保存   :p1b, after p1a, 45d
  section Phase 2 接続とチーム
  DB/API接続・Secrets・認証            :p2a, after p1b, 60d
  RBAC・バージョン・監査・公開前承認     :p2b, after p2a, 45d
  section Phase 3 拡張実行
  サンドボックス・MCP公開・Webhook      :p3a, after p2b, 60d
  Workflow Builder・cron・コード分岐    :p3b, after p3a, 60d
  section Phase 4 評価と運用
  評価・回帰・LLM-as-Judge・昇格・ポリシー :p4a, after p3b, 90d
```

> 日付はプレースホルダ。実期間は体制により変動する。

---

## 2. フェーズ別スコープ

### Phase 1: ローカル縦切り（= v1）
CSV/JSON入力、基本変換、スキーマ伝播、固定サンプルプレビュー、Tool契約、Agent接続、チャット、最小トレース、保存。

代表ジャーニーは [README.md](./README.md#7-v1スコープ縦切り一本) を参照。

### Phase 2: 接続とチーム利用
DB/API接続、Secrets Provider、認証アダプター、ワークスペースRBAC、バージョン、監査ログ、公開前承認。

### Phase 3: 拡張実行
カスタムコードのサンドボックス、MCP公開、Webhook、Workflow Builder、cron、コードプロジェクトへの分岐。

### Phase 4: 評価と運用
データセット評価、回帰、LLM-as-Judge、本番ログからの評価データ化、環境昇格、高度なポリシー制御。
加えて **長期記憶（`ideas-v3`）**: LLM Wiki（WikiPage + 検索）と Skillsベースの蒸留（Run → 提案 → 人手承認 → Skill.instructions 改訂）。詳細は [10-memory.md](./10-memory.md)。

---

## 3. 機能 → フェーズ対応（`ideas-v2.md §6` チェックリスト）

```mermaid
flowchart TB
  subgraph PH1["Phase 1"]
    F1["スキーマ自動伝播 + 型不一致インライン検知"]
    F2["式エディタ GUI↔テキスト二層"]
    F3["データプロファイリング"]
    F4["サンプル固定 & スナップショットテスト"]
    F5["副作用メタデータ宣言"]
    F6["プロンプト自動生成→人手レビュー"]
    F7["構造化出力スキーマGUIエディタ"]
    F8["エージェント横並びプレビュー・チャット"]
    F9["テンプレートギャラリー / レシピ"]
    F10["実行トレース最小可視化"]
  end
  subgraph PH2["Phase 2"]
    F11["認証・認可アダプターと管理UI差込口"]
    F12["外部SDKごとPort/Adapterと契約テスト"]
    F13["サブフロー化"]
  end
  subgraph PH3["Phase 3"]
    F14["カスタムコードノード（サンドボックス）"]
    F15["Mastraコードへ一方向エクスポート"]
    F16["cron/イベントトリガーGUI"]
    F17["Workflow Builderの制御ノード"]
  end
  subgraph PH4["Phase 4"]
    F18["長期記憶: LLM Wiki（WikiPage+検索）"]
    F19["長期記憶: Run→Skill蒸留（人手承認）"]
  end

  PH1 --> PH2 --> PH3 --> PH4

  classDef v1 fill:#e3f2fd,stroke:#1565c0;
  class F1,F2,F3,F4,F5,F6,F7,F8,F9,F10 v1;
  style PH1 fill:#e3f2fd,stroke:#1565c0
```

> 契約テストとPort/Adapterの骨格（`F12`）はPhase 1から用意し、Phase 2で実Adapterを充実させる。サブフロー化（`F13`）はコアが安定してから。

---

## 4. 検証指標

`ideas-v2.md §11`。テストケースごとに期待Skill/Tool・呼び出し要否・入力制約・順序・期待出力を定義し、次を測定する。

```mermaid
flowchart TB
  subgraph Selection["選択の正しさ"]
    M1["呼ぶべき時に正しいSkill/Toolを呼んだ割合"]
    M2["呼ぶべきでない時に呼ばなかった割合"]
  end
  subgraph Conformance["適合率"]
    M3["Tool引数・構造化出力のスキーマ適合率"]
    M4["呼び出し順序・承認手順の適合率"]
  end
  subgraph Outcome["結果"]
    M5["最終タスク成功率"]
    M6["応答時間"]
    M7["LLM・外部APIの実行コスト"]
  end
  subgraph Regression["回帰"]
    M8["同一固定データセットでの変更前後の差分"]
  end
```

| 指標 | 内容 | 対応データモデル |
|---|---|---|
| Skill/Tool選択率 | 呼ぶべき場合に正しく呼んだ割合 | `ValidationResult.skillHitRate / toolHitRate` |
| 非呼び出し率 | 呼ぶべきでない場合に呼ばなかった割合 | `notCallWhenUnneeded` |
| スキーマ適合率 | 引数・構造化出力のスキーマ適合 | `schemaConformance` |
| 順序適合率 | 呼び出し順序・承認手順の適合 | `orderConformance` |
| タスク成功率 | 最終タスクの成否 | `taskSuccessRate` |
| コスト・応答時間 | LLM/外部API実行コスト、レイテンシ | `cost / latency` |
| 回帰差分 | 固定データセットの変更前後差分 | `regressionDiff` |
| 定性評価 | フィードバック・アンケート・感想 | `feedback` |

検証の実行フローは [07-execution-model.md](./07-execution-model.md#4-検証疑似ユーザー実行)、データモデルは [03-domain-model.md](./03-domain-model.md#6-検証validationモデル) を参照。

---

## 5. 保留（別軸・将来）

ノーコード体験の深掘りからは外れるが、いずれ必要になるもの（`ideas-v2.md §13`）。

> **昇格**: 「メモリ」は `ideas-v3` により **長期記憶（LLM Wiki + Skillsベース）** として具体化され、Phase 4 の計画に昇格した（[10-memory.md](./10-memory.md)）。RAG（埋め込み検索）はその M4 段階に含む。
>
> **昇格**: 「マルチエージェント」は **サブエージェント委譲**（Agent集約への参照追加・ツール委譲実行・単一チャット面）として具体化され、v17 実装計画に昇格した（[12-multi-agent.md](./12-multi-agent.md) / [ADR-0018](./adr/0018-multi-agent-sub-agent-delegation.md)）。

```mermaid
mindmap
  root((将来拡張))
    観測
      トレースの本格版
    知識
      メモリ（→Phase4へ昇格）
      RAG
    協調
      マルチエージェント
      複数人の同時編集
    統制
      高度なABAC・ポリシー管理
    配信
      配信の高度化
    評価
      本番ログ→評価データ化のフライホイール
```

---

## 6. リリース判断のゲート

各フェーズは次を満たしてから次へ進む。

- [ ] **Phase 1 → 2**: 代表ジャーニー7ステップが縦切りで完結し、最小トレースで落ちた箇所を特定できる
- [ ] **Phase 2 → 3**: 認証・認可・監査・Secrets参照が全API経路で有効。契約テストが緑
- [ ] **Phase 3 → 4**: カスタムコードがサンドボックス制限下で実行され、公開エンドポイントが未認証既定でない
- [ ] **Phase 4**: 回帰差分とLLM-as-Judgeで品質を定量比較でき、本番ログを評価データへ還流できる
