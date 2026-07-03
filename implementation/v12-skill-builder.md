# v12 実装契約: Skill Builder

> Increment 12 の単一の真実。Increment 1〜11を前提とする。

## 1. 目的

再利用可能なAgent能力をSkillとして定義し、責務・発火条件・入出力説明・固定Tool依存からprompt草案を生成してversion保存する。

## 2. Skill aggregate

- Tool/Agentと同じpublishable metadataとSemVerを持つ。
- responsibility、activationCondition、inputDescription、outputDescriptionを非空で保持する。
- 生成草案を人が編集したinstructionsを非空で保存する。
- Tool依存はinternalId + SemVerへ固定し、保存時に存在確認する。
- 同一Tool versionの重複参照を拒否する。

## 3. Prompt generation

- Skill責務、発火条件、入出力、依存Tool公開名から決定的なprompt草案を生成する。
- 未保存draftと保存済みSkillの両方から生成できる。
- 草案は保存せず、常に編集可能なresponseとして返す。

## 4. API / UI

- `POST /skills`、`GET /skills`、`GET /skills/:id`、`GET /skills/:id/versions`。
- `POST /skill-drafts/generate-prompt`、`POST /skills/:id/generate-prompt`。
- Skillナビを有効化し、metadata、責務、発火条件、I/O説明、Tool選択、prompt草案、version保存を提供する。
- AgentへのSkill参照とSkill由来system prompt合成は次Incrementへ分離する。

## 5. 完了条件

- domain、serialization、InMemory/SQLite repository contract、use case、API、UI、E2Eをテストする。
- typecheck、全test、coverage、depcruise、production build、実HTTP smokeが成功する。
