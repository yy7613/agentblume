# ADR-0026: Wikiを名前付きスペースへ分離しAgent版で参照を制限する

## Status

Accepted — 2026-07-11

## Context

ADR-0016のM1〜M3では、Workspace直下に複数の`WikiPage`を保存できる。しかし全ページが同じ検索空間にあり、Agentが参照してよい知識領域を指定できない。業務、顧客、環境など性質の異なる知識が同じ検索結果へ入ると、無関係な文脈の混入や誤回答につながる。

## Decision

1. `WikiSpace`を新しい集約ルートとして追加する。`id`、`name`、`description`、scope、作成・更新日時を持つ。
2. `WikiPage`は1つの`wikiId`へ所属する。既存データで`wikiId`が無いページは論理的に`default` Wikiへ所属させ、読み取り互換性を維持する。
3. Agent版は`wikis: [{ wikiId }]`をallowlistとしてsnapshot保存する。Wiki本文はAgent版へコピーせず、Wikiの更新は同じAgent版から利用可能とする。
4. Agent保存時に参照Wikiの存在、scope、重複を検証する。疑似ユーザーAgentにはWiki参照を許可しない。
5. 保存済みAgent実行時は、入力文を使ってallowlist内のWikiだけを検索する。Wikiごとの取得上限と全体文字数上限を設け、1つのWikiがcontextを占有しないようにする。
6. 手動ページ指定もAgent allowlistを越えられない。旧AgentにWiki参照が無い場合だけ、既存の手動アタッチ動作を互換モードとして残す。
7. 記憶提案は対象`wikiId`を保持し、承認時にも同じWikiへ保存する。ページを別Wikiへ暗黙移動しない。

## Consequences

- Agentごとに顧客別・業務別・環境別の知識を明示的に分離できる。
- Agent versionから「利用可能な知識領域」を監査できる。
- Wiki内容の更新にAgent再発行は不要だが、再現性が必要な評価ではWiki更新日時をRun観測へ追加する余地がある。
- 旧ページ・旧Agentは`default`/手動アタッチ互換で読み続けられる。
- Wiki間の共有、継承、優先順位、Wiki自体のバージョニングは今回の対象外とする。

