# v11 実装契約: Agent Structured Output

> Increment 11 の単一の真実。Increment 1〜10を前提とする。

## 1. 目的

Agentの最終応答をGUIで定義したJSON object schemaへ拘束し、Model Providerへschemaを提示すると同時に、アプリケーション境界でも再検証する。

## 2. Schema scope

- v11はobject直下のprimitive fieldに限定する。
- field type: `string | number | integer | boolean`。
- fieldごとにname、description、requiredを保持する。
- schema nameは英数字・underscore・hyphenで1〜64文字。
- field nameは非空かつ重複不可。未定義fieldは拒否する。
- nested object、array、enum、unionは後続Incrementへ分離する。

## 3. Provider / runtime

- `ModelCompletionRequest.responseFormat`へname、strict、JSON Schemaを渡す。
- LM Studio adapterはOpenAI互換`response_format: { type: "json_schema", json_schema: ... }`へ変換する。
- structured output未対応Providerへ暗黙fallbackしない。
- 最終assistant contentをJSON parseし、required、型、integer、追加fieldを再検証する。
- 検証済みobjectをRun recordの`structuredResponse`へ保存する。

## 4. UI

- Agent Builderでstructured outputを有効化し、fieldの追加・削除・型・requiredを編集できる。
- 保存済みAgent chatは検証済みJSONを整形表示する。

## 5. 完了条件

- domain不変条件、serialization、LM Studio wire変換、runtime成功/失敗、API/UIをテストする。
- Playwright、typecheck、全test、coverage、depcruise、production build、実HTTP smokeが成功する。
