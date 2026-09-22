---
id: validation/pseudo-user
version: pseudo-user/v1
description: シナリオ実行の疑似ユーザーが会話終了後にアンケートへ答える際の指示文・検証落ちの再依頼文・評点の向きを示す一文。ja/en はシナリオの言語（persona.language）で選ぶ。
---

## instruction.ja
上記の会話を踏まえ、この人物として各設問へ回答する。指定されたJSONスキーマに従い全設問へ回答すること。

## instruction.en
Based on the conversation above, answer every question as this persona, following the given JSON schema.

## direction.ja
評点は数が大きいほど高評価である（最小値 = 最も悪い、最大値 = 最も良い）。自由記述の内容と評点を一致させること。

## direction.en
Higher scores mean a better evaluation (the minimum value is the worst, the maximum value is the best). Keep your free-text answers consistent with your scores.

## repair.ja
前回の回答は検証に通らなかった: {{reason}}。指定のJSONスキーマ（範囲も含む）を満たすJSONだけを返し直すこと。{{direction}}

## repair.en
Your previous answer failed validation: {{reason}}. Return only JSON that satisfies the given schema, including the allowed ranges. {{direction}}
