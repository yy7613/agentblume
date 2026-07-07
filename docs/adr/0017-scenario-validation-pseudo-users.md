# ADR-0017: シナリオ検証を「Persona駆動の疑似ユーザー × 決定的オーケストレータ × 自己申告アンケート」で実装する

- Status: Accepted
- Date: 2026-07-05
- Context doc: [docs/11-scenario-validation.md](../11-scenario-validation.md)

## Context

`ideas.md` は検証について「疑似ユーザーエージェントに実際に利用させるフロー」と「フィードバック、アンケート、感想などの定性的評価の取得」を要求する。既存実装には保存済みAgent実行（bounded tool loop・Runトレース永続化・構造化出力）と検証画面の枠があるが、疑似ユーザー・複数ターン会話・アンケートは未実装。

## Decision

1. **疑似ユーザーは v16 では「Persona」（検証コンテキストのバージョン付きエンティティ）として実装する**。完全な Agent（`AgentKind.PseudoUser`）にはしない。
   - 理由: 疑似ユーザーに必要なのは「人物設定プロンプト + 構造化出力での発話/終了判断/アンケート回答」だけで、Tool・Skill・公開名管理は不要。`ModelProviderPort` を直接使う軽い構成で始める。
   - `docs/03` の `AgentKind` 列挙は仕様として維持し、疑似ユーザーがTool（例: 資料参照）を必要になった時点で Agent 種別へ昇格する。
2. **Persona → system prompt はテンプレートによる決定的生成**とし、画面でプレビュー・上書きできる（プロンプト自動生成と同じエスケープハッチ原則）。種別プリセットは novice / expert / busy / vague / skeptical / custom の6種。
3. **会話ループは application 層の決定的オーケストレータ**が制御する（LLMに進行を任せない）。終了条件は「疑似ユーザーの `endConversation:true`」「`maxUserTurns`（1..8、既定4）到達」「エラー」の3つのみ。LLM同士の無限対話を構造的に防ぐ。
4. **対象Agentの1ターン = 既存の保存済みAgent実行1 Run**。既存の上限（Tool call 4回 / model round 5回）・トレース永続化・read-only制約をそのまま継承する。多ターン化のために既存ユースケースへ**会話履歴を後方互換で追加**する（新設ではなく拡張）。
5. **アンケートは会話終了後に疑似ユーザー自身が Persona として回答**（self-report、構造化出力）。設問は scale / boolean / text の3型で Scenario にインライン保持し、既定テンプレート（達成・満足度・わかりやすさ・手間・信頼 + 良かった点・不満点・感想）を同梱する。第三者採点（LLM-as-Judge / Evaluator）は Phase 4。
6. **Persona / Scenario は Tool/Skill/Agent と同じ SemVer バージョニング + Repository + 契約テスト方式**。ScenarioRun は不変の実行記録として別Repositoryに保存し、各AgentターンはRun IDで既存トレースへリンクする。回帰比較（`ideas-v2.md §11`）はScenarioバージョン固定で成立させる。

## Consequences

- ✅ ideasの要求（疑似ユーザー実利用フロー・アンケート・感想）が既存機構の組み合わせで実現でき、新規のPort追加は不要（`ModelProviderPort` 再利用）。
- ✅ ターン数・Tool call・read-only の三重の上限で、コスト・暴走・副作用を構造的に抑制。
- ✅ トランスクリプトの各ターンからRunトレースへドリルダウンでき、「なぜこの応答になったか」を追える。
- ⚠️ self-report は Persona の性格がスコアへ混入する（せっかちPersonaは低め評価になりやすい）。これは「ユーザー体験の模擬」としては意図どおりだが、絶対値比較には向かない。同一Persona内の前後比較を基本とし、客観採点はJudge導入時に分離する。
- ⚠️ 同期実行のため長い会話はHTTPタイムアウトのリスク。v16はmaxUserTurns上限8で許容し、非同期実行/進捗ストリームは必要になってから。

## Alternatives considered

- **疑似ユーザーを最初からAgent種別として実装**: メタデータ・公開名・Tool結線が現時点では全て不要で、過剰。昇格パスを残して見送り。
- **進行もLLMに委任（自律対話）**: 終了しない・脱線するリスクをアプリで制御できない。決定的オーケストレータを採用。
- **アンケートを人間が回答**: ideasの自動検証フロー（疑似ユーザーに利用させる）の趣旨に反する。人間の定性評価は別途チャット画面で可能。

## 実装契約

[implementation/v16-scenario-validation.md](../../implementation/v16-scenario-validation.md) を単一の真実とする。
