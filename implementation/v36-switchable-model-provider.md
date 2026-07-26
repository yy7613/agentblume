# v36 実装契約: 切替可能モデルプロバイダ（Mastraへの通信委譲 + 暗号化設定 + UI選択）

> 方針: **抽象（`ModelProviderPort`）はこちらで維持し、ワイヤ通信（ベンダー差異）だけを `@mastra/core/llm` のモデルルーターへ委譲する**。我々のコードにベンダー分岐は持ち込まない。案「ベンダー別アダプタ増殖」・案「Mastraに実行系ごと委譲」の両方を退けた中間解。
> APIキーは **SQLiteに生値を保存しない**（AES-256-GCM封緘、鍵はDB外の鍵ファイル）。
> 前提: v35まで完成・全green。新規依存なし（@mastra/core は導入済み）。

## 0. 規約

strict / Zod v4 / Vitest / 非mutate / depcruise 0違反 / カバレッジゲート(90/90/90/80)維持 / 秘密値をDB・ログ・エラー・API応答に出さない。

## 1. 通信アダプタ（`src/adapters/model/mastra-model-provider.ts`）

- `MastraModelProvider implements ModelProviderPort`。`options.model` = `'openai/gpt-4o'` 形式の文字列 or OpenAI互換 `{id, url?, apiKey?, headers?}`。Mastraとの接点は `ModelRouterLanguageModel.doStream()` のみ。
- AI SDK v2 型は深いimportをせず `Parameters<ModelRouterLanguageModel['doStream']>[0]` 等で公開シグネチャから導出。
- タイムアウトは現行LM Studioアダプタと同じ二段構え（total + idle、パート受信で再アーム、read と abort を race）。エラーは中立文言の `ModelProviderError` へ正規化し、apiKey/headers値は伏せ字化（二重防御）。
- ストリームパート: `text-delta` 蓄積 / `tool-input-start|delta` + 確定 `tool-call`（確定値優先）/ `finish`（usage・finishReason）/ その他は破棄。tool引数の空文字→`{}`、非JSON・非objectは拒否（LM Studio版の規律）。
- **オフラインファースト確認済み**: コンストラクタ・auth解決・登録簿はネットワーク不要。models.dev 取得は auto-refresh 経路のみで既定無効 → 恒久化のため `MASTRA_OFFLINE=1` を `server.ts` / `demo.ts` / `llmops-gate.ts` の起動初期化で設定。
- **罠（重要）**: Mastraは登録簿に実在する接頭辞（`lmstudio/` 等）だと `modelSupportsTemperature` に基づき **temperature を黙って削除**する。カスタムエンドポイントは登録簿に無い接頭辞 **`local/`** を使う規約（factory側で一元化、テストで固定）。
- 既存 `LmStudioModelProvider` はファイル・テストとも温存（未配線のフォールバック）。

## 2. 設定の暗号化永続化

- domain `src/domain/model-settings/`: `SealedSecret {v:1, alg:'aes-256-gcm', iv, tag, data, hint}`（hint=平文末尾4文字のみ、マスク表示用）。`ModelSlotSettings` = `{source:'registry', model:'provider/model', apiKey?}` | `{source:'openai-compatible', baseUrl, model, apiKey?}`。`ModelSettings {scope, main?, judge?, updatedAt}`（スロット未設定=env既定を使用）。
- application Ports: `SecretCipherPort {seal/open}` / `ModelProviderFactoryPort` / `ModelCatalogPort`。
- adapter `AesGcmSecretCipher`: 鍵は32バイトランダムの**鍵ファイル**。パス解決 `AGENTCONTEXT_SECRET_KEY_PATH` → DBと同ディレクトリ `agentblume.secret.key` → `~/.agentblume/secret.key`。`wx`+0o600で既存鍵を上書きしない。初回seal/openまで遅延読込。testプロファイルは `ephemeral()`（ファイル不使用）。復号失敗は `SecretCipherError` → HTTP 409（キー再入力を促す。秘密値を含まない）。
- 非漏洩の検証: SQLiteファイル生バイトgrep / API応答文字列assert / エラー文言伏せ字化のテストを常備。

## 3. 切替層（`src/application/model-settings/switchable-model-provider.ts`）

- `SwitchableModelProvider implements ModelProviderPort`（main/judgeの2インスタンス）。`complete()` 毎に設定を読み、sha256設定ハッシュ一致でアダプタ再利用、不一致で `factory.create`。設定なし→envDefault（現行 `LM_STUDIO_*` / `JUDGE_LM_STUDIO_*` から構築、**未設定時は従来と完全等価**）。
- 復号失敗・設定読込失敗は env へ黙って落とさず失敗させる（別モデルが黙って動くのを防ぐ）。
- `capabilities()` は同期契約のため「最後に解決したアダプタ」の値。
- **snapshot動的化**: `currentSnapshot()`/`lastSnapshot()` を提供し、Run記録は `RunObservabilityOptions.resolveModel`、実験は `CreateExperimentUseCase` のsnapshot関数化、judgeは `StructuredJudgeEvaluator` のコンストラクタ拡張で「実際に使った設定」を記録。

## 4. API / UI

- `GET/PUT /model-settings`（apiKeyは write-only 平文: 文字列=保存 / 省略=維持 / 空文字=クリア。応答は常に `{configured, hint?}` のマスクのみ）/ `POST /model-settings/test`（candidate可、常に200 `{ok,...}`）/ `GET /model-catalog`（Mastra `PROVIDER_REGISTRY` 由来、プロバイダ毎50モデル上限）/ `GET /model-catalog/openai-compatible-models`（`{baseUrl}/models`。apiKeyはquery禁止、`slot`指定で保存済みキー使用）。
- 設定画面に「モデル」セクション: main/judge 各スロット = ソースradio（レジストリ/OpenAI互換）→ プロバイダ・モデルのドロップダウン（手入力フォールバック）→ APIキー（password、placeholderでhint表示、「保存済みキーを削除」チェック）→ テスト/保存/env既定に戻す。フォーム⇔DTO変換は `src/ui/settings/model-settings-form.ts`（純関数）。
- 旧「Model provider」env表示カードは「Environment defaults」へ改称。

## 5. 挙動差分・既知の制約

- localプロファイルの実行経路が `LmStudioModelProvider` → `SwitchableModelProvider`（中身 `MastraModelProvider`）へ。snapshot.provider ラベルが `lm-studio` → `openai-compatible` に変わり **modelConfigHash も変化**（`AGENTCONTEXT_MODEL_PRICING_JSON` を provider=lm-studio で書いている場合は要更新）。
- Mastra経路は `stream_options.include_usage` を送らないため、usageを自発返却しないサーバーでは usage が undefined（LM Studioは返す）。
- `suggestAnalysisConfig` の有効判定は依然 `LM_STUDIO_MODEL` env 依存（UI設定では有効化されない。要対応なら次版）。
- `error-messages.ts` の `isModelFailure()` が `code.startsWith('MODEL')` のため、`MODEL_SETTINGS_VALIDATION`/`MODEL_CATALOG` がLM Studio前提の文言に吸われる（完全一致リスト化が本筋、未対応）。
- モデル設定のスコープ既定は `AGENTCONTEXT_TENANT_ID`/`AGENTCONTEXT_WORKSPACE_ID`（`local`/`default`）。UIも同スコープを使用。

## 6. 検証

`npx vitest run` 228 files / **2062 passed**、`npm run typecheck` 0、`npm run depcruise` 0（688 modules）、`npm run test:cov` **合格**（Stmts 91.21 / Branch 81.82 / Funcs 92.09 / Lines 95.53 — v35時点から4指標とも改善）。vitestは大文字ドライブ（`E:\`）で実行。
