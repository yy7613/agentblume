# v9 実装契約: 保存済みAgent実行

> Increment 9 の単一の真実。Increment 1〜8を前提とする。

## 1. 目的

保存済みAgent versionを実行単位として指定し、固定参照された複数Toolをモデルへ提示して、モデルが選択した1 Toolを実行する。system promptとTool候補をRunリクエストへ重複指定しない。

## 2. Run request

- `POST /runs` は従来のinline Tool形式に加えて `{ scope, agent: { internalId, version? }, message, mode }` を受ける。
- version省略時は実行開始時点のlatest Agentを解決し、Run recordには解決済みversionを保存する。
- Agent内のTool参照は保存済み固定versionだけを解決する。

## 3. Tool selection

- Agentに紐づく全Tool definitionを最初のmodel requestへ渡す。
- preview/testでは候補の1つでもwrite/external-actionならfail closedとする。
- modelが選択した公開名に対応するToolだけを実行する。
- Tool callなしの直接応答を許可する。
- 1 completion内の複数callと、Tool結果後の追加callは拒否する。反復的な複数Tool callは後続Incrementへ分離する。

## 4. Trace / UI

- Run recordにAgent internalId/version/publishNameを保持する。
- 実際に呼ばれたToolがある場合だけTool参照を保持する。
- Agent Builderから保存済みversionを実行できるchatを提供する。
- StatusはAgent runと従来のTool runを同じ一覧で表示する。

## 5. 完了条件

- 保存済みAgentのversion解決、複数Tool候補提示、選択Tool実行、直接応答、fail-closedをunit/API testで確認する。
- Agent Builder chatとStatus表示をUI testで確認する。
- Playwright、typecheck、全test、coverage、depcruise、production buildが成功する。
