# v22 実装契約: バージョン付き評価資産

> 前提: v21までgreen。[ADR-0021](../docs/adr/0021-versioned-evaluation-assets.md)に従う。

## 1. Domain

- `EvaluationDataset`: 共通metadataと1件以上のcaseを持つ。
- `turn` case: `id/input/reference?/expectedTools?/tags/source`。
- `scenario` case: `id/scenario{id,version}/tags/source`。
- case id、tag、期待Toolは各配列内で一意。空文字を拒否する。
- `EvaluatorProfile`: 1件以上のmetricを持ち、metric idは一意、weightは有限の正数。
- v22で許可するscorerは `keyword-coverage`、`completeness`、`tone-consistency`、`content-similarity`。
- すべての生成関数は防御的コピーを返す。

## 2. Application

- Save/Query use caseでSemVer bump、Scenario参照整合、NotFoundを扱う。
- JSON importはexport済みDatasetまたはcase配列を受ける。CSV importはturn caseのみ。
- importは保存せず正規化したcaseを返す。
- JSON exportは2-space indentの安定したfield順、CSV exportはturn caseのみ。

## 3. Storage

- Dataset/ProfileごとにRepository Port、InMemory、SQLite、共有contract suiteを作る。
- SQLiteはscope、internalId、SemVer検索列と完全JSON recordを保存する。

## 4. API

- `POST/GET /evaluation-datasets`
- `GET /evaluation-datasets/:id`、`GET /evaluation-datasets/:id/versions`
- `POST /evaluation-datasets/import`、`GET /evaluation-datasets/:id/export`
- `POST/GET /evaluator-profiles`
- `GET /evaluator-profiles/:id`、`GET /evaluator-profiles/:id/versions`

## 5. UI

- ValidationにDatasetsタブを追加する。
- Dataset/turn/scenario case編集、JSON/CSV import/export、EvaluatorProfile編集を提供する。

## 6. DoD

- domain/application/repository/API/UI testsを追加する。
- `npm test`、`npm run typecheck`、`npm run depcruise`、`npm run build`、Playwrightがgreen。

## 7. 実装結果

- Status: Complete (2026-07-10)
- 115 test files / 837 tests green。
- coverage: statements 91.02%、branches 81.10%、functions 90.68%、lines 93.96%。
- typecheck / dependency-cruiser / production build / Playwright 4 tests green。
