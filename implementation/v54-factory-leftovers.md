# v54: Factory 画面の残り（マニュアルの写真撮り直しで見つかったもの）

## G1 候補がエージェントの内部IDのまま出る

- 現状: `src/ui/factory/FactoryPage.tsx` の `candidateLabel` は、画面を開いたときに一度だけ読んだエージェント一覧から表示名を引く。開いたまま Run の完了を待つと、Run が作ったエージェントが一覧に無く `fc90388d-…@1.0.0` と出る。
- 直す: 引けない id があれば（または Run が完了・状態が変わったら）エージェント一覧を読み直す。読み直しても無ければ内部IDのまま（従来どおり）。何度も読み直さない（同じ id で繰り返し取りに行かない）。

## G2 日本語の画面に英語が残る

| 場所 | 現状 | 直す |
|---|---|---|
| タイムラインの承認依頼の行 | `Review the proposed plan for …`（`checkpoint.prompt` の原文） | 計画承認カードと同じ `planApprovalSummary` の日本語文を使う |
| 目標未達の理由（`report.qualityReasons`） | `avgSatisfaction 3.00 is below the target 4` 等、`run-factory.ts` の英語の定型文（5 種） | 画面側で定型文を日本語にする（保存データ・サーバーの文は変えない）。訳の無い文は原文のまま |
| 改善を回した回の総括 | Analyst（モデル）が英語で書く | Run の言語（無ければ既定 `ja`）を Analyst の指示に渡し、総括をその言語で書かせる。Run が言語を持たないなら、Factory の開始要求に言語を足す（UI は表示言語を送る。省略時は従来どおり） |

## G3 計画でデータソースを空にすると Run ごと落ちる

- 現状: Planner の出力で新規作成のツールの `dataSourceId` が空だと `validateFactoryPlan: tools.1.dataSourceId must be a non-empty string` で Run が失敗する。`planner-role.ts` の `repairDataSourceIds` は書き間違い（編集距離）だけを直し、空は直さない。
- 直す: 決定的に補える場合は補う — Run のデータソースが 1 つだけならそれ。複数なら、ほかのツールも追加データソースも使っていない残りがちょうど 1 つならそれ。補えないときは、Planner の既存の出し直し（あれば）に「どのツールのデータソースが空か・選べる id の一覧」を理由として渡す。出し直しが無いなら Run の失敗理由を、直し方（データソースを 1 つに絞る等）が分かる文にする。再利用（`reuse`）の空は従来どおり許す。

## 完了条件

typecheck・depcruise 違反 0・`test:cov` 合格。各項目にテスト（修正前コードで赤になる形）。
