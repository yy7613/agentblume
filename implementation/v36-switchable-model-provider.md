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

## 4.5 レビュー是正（v36.1）

初版のレビューで見つかった問題をすべて修正した。要点:

**秘密の取り扱い**
- **キーは宛先に紐づく**: 保存済みAPIキーを流用するのは「要求 baseUrl / provider が保存済みスロットと一致する」ときだけ（`sameModelDestination`）。保存時も、キー未入力で宛先が変わったら既存キーを**継承せずクリア**する。旧実装は任意の宛先へキーを送れた。
- `GET /model-catalog/openai-compatible-models` を **POST 化**（単純GETのままだと `<img src>` だけで保存済みキーを外部URLへ送らせるCSRFが成立した）。baseUrl は全経路で保存時と同じ http(s)・userinfo禁止の検証を通す。
- 鍵ファイルの既定を `~/.agentblume/secret.key` に変更（旧: DBと同ディレクトリ = フォルダごとの同期・ZIP・コミットで鍵と暗号文が一緒に動く）。旧パスに鍵があればそれを読む後方互換あり。`.gitignore` に鍵とDBを追加。
- `SecretCipherError.reason` を `key-unavailable`(500) / `decrypt-failed`(409) に分離（前者は再入力しても直らないため案内を変える）。エラー本文から絶対パスを除去。4文字以下のキーは hint を作らない。

**ランタイムの正しさ**
- **usage 欠落の是正**: Mastra は `includeUsage` を配線しないため OpenAI互換経路で usage が落ち、コスト・トークン集計が無言で消えていた。ルーターインスタンスの `resolveLanguageModel` をインスタンス単位でシャドウし、解決された内側モデルの config へ `includeUsage` と `transformRequestBody`（`response_format.json_schema.strict` の注入にも使用）を後付けする。リクエストボディを直接アサートするテストで固定。
- 空ストリーム（choiceデルタ皆無）を「無言の成功」にせず `ModelProviderError` へ。
- judge スロットにも指紋の事前解決を配線（失敗レコードに古い指紋が残り、さらに `model:''` がドメイン検証に落ちて judge の失敗がケース全体の失敗へ化けていた）。`resumeSavedRun` でも設定解決を先に走らせ、capabilities ガードが古い値で通らないようにした。
- 価格解決に後方互換エイリアス（`openai-compatible` → `lm-studio` / `lm-studio-judge`）。`modelConfigHash` の入力は平文キーではなくキー指紋。`SwitchableModelProvider` は in-flight な解決を共有。`doStream()` の await も abort と race。
- `MASTRA_OFFLINE` / `MASTRA_TELEMETRY_DISABLED` は副作用専用モジュール `src/mastra-runtime-env.ts` に集約し、Mastra を使う全モジュールの**最初の import** に置く（ESM のホイスティングで `import` 後の代入は手遅れなため。import順が意味を持つ）。

**API・UI**
- `/model-catalog` を2段構成に（見出しは `modelCount` のみ、モデル一覧は `GET /model-catalog/:providerId/models`）。50件の辞書順クリップで OpenRouter の主要モデルが全滅していた問題を解消し、非チャットモデル（embedding/whisper/画像/TTS 等）を除外。
- `isModelFailure` を完全一致リスト化（`MODEL_SETTINGS_VALIDATION` / `MODEL_CATALOG` が実行エラー文言に化けていた）。エラー文言から LM Studio 決め打ちを排除。
- テストボタンが「編集中の設定を送れないときに保存済み設定をテストして ok を返す」嘘の成功を解消（送れない状態は disabled、保存済みをテストする場合は明示）。
- 揮発ストレージ警告、`usedStoredKey:false` の注記、モデル一覧取得の race（古い応答の破棄）、AbortSignal、`role="alert"/"status"`、テスト失敗文言の日本語化、`autoComplete="new-password"`。
- 分析アシスタントの有効判定を `LM_STUDIO_MODEL` env 固定から「env または保存済み main スロット」の動的判定へ（UIで設定しても永久に無効だった）。

## 4.6 カタログの簡素化（後続改訂）

初版のカタログは登録簿の全138プロバイダを並べ、プロバイダごとのモデル一覧（バンドル済みの静的データ）まで返していた。選択肢が過剰である上、**モデル名の固定値は必ず陳腐化し**、Azure / Bedrock / Vertex では利用者がデプロイしたモデルしか使えないため誤誘導になる。次のとおり改めた。

- `/model-catalog` は**主要プロバイダの見出しだけ**を返す（`openai` / `anthropic` / `google` は登録簿由来、`azure-ai-foundry` / `aws-bedrock` / `google-vertex` / `openai-compatible` はOpenAI互換の接続先プリセット）。**Azure / Bedrock / Vertex は Mastra の `PROVIDER_REGISTRY` に無い**ため、`baseUrlTemplate`（`<resource>` 等の穴あき）と `baseUrlHosts`（保存済み設定からの逆引き）を持つプリセットとして表現する。
- `GET /model-catalog/:providerId/models`（静的モデル一覧）は**廃止**。モデルは常に手入力で、候補が出るのは `POST /model-catalog/openai-compatible-models` で**実際に問い合わせた**ときだけ。見出しは代わりに `docUrl`（提供元のモデル一覧）を持つ。
- UIの「ソース」ラジオは廃止し、接続方式はプロバイダ選択から導出する（`ModelSlotFormValue.source` は派生値）。雛形の穴が残る baseUrl は保存・取得を塞ぐ（そのまま送ると 400 になるだけなので手前で止める）。
- 絞り込みで一覧から外れたプロバイダも、**保存済みであれば選択肢に残す**（`providerOptionsFor`）。黙って別プロバイダへ付け替えると保存時に設定が化けるため。

## 5. 挙動差分・既知の制約

- localプロファイルの実行経路が `LmStudioModelProvider` → `SwitchableModelProvider`（中身 `MastraModelProvider`）へ。snapshot.provider ラベルが `lm-studio` → `openai-compatible` に変わり **modelConfigHash も変化**（`AGENTCONTEXT_MODEL_PRICING_JSON` を provider=lm-studio で書いている場合は要更新）。
- Mastra経路は `stream_options.include_usage` を送らないため、usageを自発返却しないサーバーでは usage が undefined（LM Studioは返す）。
- モデル設定のスコープ既定は `AGENTCONTEXT_TENANT_ID`/`AGENTCONTEXT_WORKSPACE_ID`（`local`/`default`）。UIも同スコープを使用。
- 価格表の provider ラベルは `openai-compatible` だが、`lm-studio` / `lm-studio-judge` で書かれた既存の `AGENTCONTEXT_MODEL_PRICING_JSON` もエイリアスで引ける（完全一致が優先。逆方向は引かない）。
- usage/strict の補正は Mastra 内部構造（`resolveLanguageModel` が返す openai-compatible モデルの config）に依存する。SDK更新時に壊れたら、リクエストボディをアサートするテストが落ちて気づける設計。
- 実験の snapshot は、モデル設定が復号できない場合 `provider:'unresolved'` になり得る（起票自体は止めない = Run側と同じ方針）。
- MCPサーバー設定の env/headers は依然平文（v35のまま）。封緘するなら JSON等価編集との両立設計が必要。

## 6. 検証

v36.1（レビュー是正後）: `npx vitest run` 228 files / **2148 passed**、`npm run typecheck` 0、`npm run depcruise` 0（690 modules）、`npm run test:cov` **合格**（Stmts 91.31 / Branch 81.98 / Funcs 92.14 / Lines 95.60）。vitestは大文字ドライブ（`E:\`）で実行。
