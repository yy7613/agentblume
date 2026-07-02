# v5 実装契約: Tool 開発画面（React + ノード UI）

> Increment 5 の単一の真実。前提は Increment 1〜4。

## 1. 目的

CSV / JSON 固定サンプルと v1 の変換ノードをキャンバスで編集し、未保存のままスキーマとサンプル行を確認し、検証済み構成だけを明示的に保存できる Tool 開発画面を提供する。

## 2. Draft API

- `DraftToolUseCase.inspect(graph)` は `EtlEngine.propagateSchemas(graph)` を返す。
- `DraftToolUseCase.preview(graph, { rowLimit? })` は `EtlEngine.preview(graph, ...)` を返す。
- repository・Tool metadata・SemVer には依存しない。
- `POST /tool-drafts/infer-schema`: `{ graph }` → `{ propagation }`。
- `POST /tool-drafts/preview`: `{ graph, rowLimit?: 1..10000 }` → `{ result }`。
- エラー形式と HTTP mapping は既存 API に従う。

## 3. UI 境界

- `src/ui/api` は HTTP DTO と API client を所有する。
- UI からバックエンド内部レイヤを import しない。DTO は JSON wire representation として定義する。
- 開発時は Vite proxy で `/health`、`/tools`、`/tool-drafts` を `http://127.0.0.1:3030` へ転送する。

## 4. 画面

- 左ナビ: 8画面を示し、Increment 5 では Tool を active、他を disabled 表示。
- metadata: internal / working / display / publish name、owner、side effect、scope。
- palette: `json-source` / `csv-source` / `select` / `filter` / `rename` / `cast`。
- canvas: node/edge編集、選択、削除、state badge、issue表示。
- inspector: 6 node の config をフォーム編集。上流 schema が得られる設定は列候補を表示。
- preview: 選択ノード（未選択時 terminal）の schema と sample rows、truncated 状態。
- version: 明示 Save、version 履歴更新、指定 version の復元。

## 5. Preview 導線

1. graph 変更を 300ms debounce。
2. draft infer-schema を呼ぶ。
3. `hasErrors` なら node issue を表示し、preview は呼ばない。
4. 正常なら draft preview を呼び、選択ノードの table を表示する。
5. 新しい変更時は古い request を abort し、古い response を state へ反映しない。
6. Draft API は保存しない。Save ボタンだけが `POST /tools` を呼ぶ。

## 6. テスト・完了条件

- Draft use case と HTTP route の正常・異常・rowLimit テスト。
- API client の request / response / error / abort テスト。
- Zustand store の graph編集・DTO復元・非同期状態テスト。
- UI の palette、inspector、debounced preview、issue、save/version復元テスト。
- `npm run typecheck`, `npm test`, `npm run test:cov`, `npm run depcruise`, `npm run build` が成功する。
