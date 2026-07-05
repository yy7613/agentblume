# v14 実装契約: UI言語設定

> Increment 14 の単一の真実。Increment 1〜13を前提とする。

## 1. 目的

Web UIの表示言語をEnglish / 日本語から選択できるようにし、画面遷移や再読み込みをまたいで選択を維持する。

## 2. 言語境界

- 言語状態はReact ContextでUI全体へ提供する。
- 選択値は`agentcontext.language`としてブラウザのlocalStorageへ保存する。
- `html[lang]`を`en`または`ja`へ同期する。
- 保存値がない場合と不正値の場合はEnglishを既定とする。
- API DTO、内部ID、公開名、環境変数、trace event kindなどの機械可読値は翻訳しない。

## 3. 対象

- 8画面ナビ。
- Chat、Agent、Skill、Tool、MCP、Validation、Settings、Statusの見出し・説明・主要操作・空状態。
- Settings画面に表示言語選択を追加する。

## 4. 完了条件

- 言語変更が即座に全画面へ反映される。
- 再読み込み後も日本語選択が維持される。
- component testとPlaywrightで切替・永続化を検証する。
- typecheck、全test、coverage、depcruise、production buildが成功する。
