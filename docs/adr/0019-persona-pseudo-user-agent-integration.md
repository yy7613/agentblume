# ADR-0019: ペルソナ登録を疑似ユーザーエージェントへ統合する

- Status: Accepted
- Date: 2026-07-05
- Context doc: [docs/11-scenario-validation.md](../11-scenario-validation.md), [ADR-0017](./0017-scenario-validation-pseudo-users.md)（本ADRはその決定1の昇格パスを実行する）

## Context

v16では疑似ユーザーを検証コンテキストの `Persona` エンティティとして実装し、Scenario は Persona を直接参照している。`ideas.md` は本来「**ユーザープロファイルで動作する疑似ユーザーエージェント**」をAgent種別として要求しており（`AgentKind` に `'pseudo-user'` は定義済み・未活用）、ペルソナ登録を疑似ユーザーエージェントの選択に統合する指示が出た。

## Decision

1. **Persona は「ユーザープロファイル」として存続する。** 属性（種別・知識・忍耐・口調…）の構造化定義と決定的プロンプト生成の源泉。廃止しない。
2. **登録操作で Persona から `kind='pseudo-user'` の Agent を実体化する。**
   - 疑似ユーザーAgentの `systemPrompt` = Personaから生成した**ベースプロンプト**（目標非依存。goal/contextはシナリオ実行時に合成）。生成後は人が編集可能（エスケープハッチ）。
   - Agent は出所として `persona?: { personaId, version }`（SemVer固定）を保持する。Persona改訂時は「再生成して新バージョン登録」をUIが案内する（自動同期はしない — 一方向生成の既存原則）。
3. **Scenario の疑似ユーザー選択は Agent 参照に統一する。** `Scenario.pseudoUser = { agentId, version }`（保存時に `kind==='pseudo-user'` を検証）。
   - **後方互換**: 既存の `persona` 直接参照フィールドは読み込み・実行とも維持（deprecated）。新規保存はどちらか一方を必須とし、UIは Agent 参照のみを作る。
4. **v18時点の疑似ユーザーAgentは Tools / Skills / サブエージェントを持てない**（保存時拒否）。会話ターンは v16 同様 `ModelProviderPort` 直呼び（ベースプロンプト + goal合成 + 構造化ターン出力）。Tool付き疑似ユーザー（資料を引きながら振る舞う等）は将来の解除項目として明記する。
5. **Chat画面等の扱い**: `kind='pseudo-user'` のAgentは通常のAgent一覧に表示されるが、Chat/通常実行の対象selectorでは既定で除外（種別フィルタ）。直接の動作確認はシナリオ検証経由を正とする。

## Consequences

- ✅ 「ペルソナを登録すると疑似ユーザーエージェントとして選べる」という単一の流れになる。選択の概念が Persona と Agent の二重から Agent に統一される。
- ✅ 疑似ユーザーがAgentになったことで、バージョニング・公開状態・（将来）Tool付与・評価用Agent（`'evaluator'`）への同型拡張が既存機構で手に入る。
- ✅ ベース/目標の分離により、1つの疑似ユーザーAgentを複数シナリオで再利用できる（v16はPersona×goalが実行時結合だったものを、Agent×goalの結合に置き換え）。
- ⚠️ プロンプト生成の分離（ベース生成 + 実行時goal合成）が必要 — v16の `buildPersonaSystemPrompt(persona, goal, context)` を分割する（内部リファクタ。関数の外部契約は維持または移行）。
- ⚠️ Persona改訂とAgent版の乖離が起こり得る。出所参照（persona@version）をAgentに記録し、UIで「新しいPersona版から再生成」を提示することで管理する。

## Alternatives considered

- **Scenarioが Persona と Agent の両方を選べるユニオンを恒久サポート**: 選択概念が統一されず、指示（統合）に反する。ユニオンは移行期の後方互換に限定。
- **Personaを廃止しAgentに属性を直接持たせる**: プロファイルの構造化定義（種別・属性）と検証指標の紐付けが失われ、プロンプト再生成の源泉も消える。却下。
- **実行時に Persona から毎回動的合成（Agent化しない）**: v16の現状。疑似ユーザーの版管理・編集可能プロンプト・Agent機構の再利用ができない。指示により昇格。

## 実装契約

[implementation/v18-pseudo-user-agent-integration.md](../../implementation/v18-pseudo-user-agent-integration.md) を単一の真実とする。
