# v3 実装契約: PreviewToolユースケース + Composition Root + 縦切りデモ

> 本書は Increment 3（[ADR-0005](../docs/adr/0005-composition-root-profiles.md)）の**単一の真実**。
> 前提: Increment 1・2 完成（305テストgreen、`domain/tool`・`application/tool`・`adapters/storage` あり）。
> 参照: [01-architecture.md §5](../docs/01-architecture.md) / [02-tech-stack.md §5](../docs/02-tech-stack.md) / [07-execution-model.md §2](../docs/07-execution-model.md)

## 0. 規約（従来どおり）
TypeScript strict / `noUncheckedIndexedAccess` / ESM・相対import拡張子なし / Vitest v4。例外は各コンテキストのエラー型。入力非mutate。テスト同居。カバレッジ90%目標。設定ファイル（package.json/tsconfig/vitest.config/.dependency-cruiser.cjs）は**編集済み・編集禁止**。

## 1. 依存ルール（.dependency-cruiser.cjs に追加済み・遵守必須）
- `src/(domain|application|adapters)` → `src/composition` の import **禁止**。
- `src/` 直下のエントリポイント（`demo.ts` 等）→ `src/adapters` の直接 import **禁止**（composition 経由）。
- 従来ルール（domain→application/adapters 禁止、application→adapters 禁止）継続。**application のテストも adapters を import しない**（インラインFakeを使う）。

## 2. `src/application/tool/preview-tool.ts`（+ `preview-tool.test.ts`）

```typescript
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { ToolId } from '../../domain/tool/ids';
import type { Tool } from '../../domain/tool/tool';
import type { SemVer } from '../../domain/tool/semver';
import { EtlEngine } from '../etl/engine';
import type { PropagationResult, PreviewResult } from '../etl/engine';

export interface PreviewToolOptions {
  readonly version?: SemVer;    // 省略時 latest
  readonly rowLimit?: number;   // engine.preview へ委譲（既定は engine 側の100）
}
export interface ToolInspection { readonly tool: Tool; readonly propagation: PropagationResult; }
export interface ToolPreview   { readonly tool: Tool; readonly result: PreviewResult; }

export class PreviewToolUseCase {
  constructor(repo: ToolRepository, engine: EtlEngine);
  /** 保存済みToolのスキーマ点検（実行なし）。未存在→ToolNotFoundError */
  async inspect(scope: TenantScope, internalId: ToolId, options?: PreviewToolOptions): Promise<ToolInspection>;
  /** 保存済みToolのプレビュー実行（行数制限つき）。未存在→ToolNotFoundError */
  async preview(scope: TenantScope, internalId: ToolId, options?: PreviewToolOptions): Promise<ToolPreview>;
}
```
- 取得は `options.version` 指定時 `repo.findVersion`、無指定時 `repo.findLatest`。`null` → `ToolNotFoundError`（`domain/tool/errors`）。
- `inspect` = `engine.propagateSchemas(tool.graph)`、`preview` = `engine.preview(tool.graph, { rowLimit })`。
- **テスト**（インラインFakeリポジトリ + 実 `EtlEngine(createDefaultRegistry())`）: latest取得でpreviewが期待行 / version指定で旧バージョンのgraphが実行される（v1とv2でgraphを変え結果差で確認）/ 未存在→ToolNotFoundError / rowLimit伝播（truncated）/ inspectがpropagation（state・schema）を返す。

## 3. `src/composition/root.ts`（+ `root.test.ts`）

```typescript
export type Profile = 'local' | 'test';
export interface AppOptions {
  readonly profile?: Profile;   // 既定: env AGENTCONTEXT_PROFILE（'local'|'test'）→ 無ければ 'local'
  readonly dbPath?: string;     // localのみ有効。既定: env AGENTCONTEXT_DB_PATH → 無ければ ':memory:'
}
export interface App {
  readonly profile: Profile;
  readonly repo: ToolRepository;
  readonly engine: EtlEngine;
  readonly saveTool: SaveToolUseCase;
  readonly getTool: GetToolUseCase;
  readonly listToolVersions: ListToolVersionsUseCase;
  readonly previewTool: PreviewToolUseCase;
  close(): void;                // SqliteToolRepository の close を委譲（InMemory は no-op）
}
export function createApp(options?: AppOptions): App;
```
- レジストリは `createDefaultRegistry()`、エンジンは `new EtlEngine(registry)` を共有。
- `profile==='local'` → `new SqliteToolRepository(dbPath)`、`'test'` → `new InMemoryToolRepository()`。
- 不正な env 値（'local'/'test' 以外）→ `ToolValidationError`（メッセージに値を含める）。options.profile が env より優先。
- **テスト**: test プロファイルで save→preview 縦切り往復 / local + ':memory:' で同往復（sqlite実路）/ close() 後も例外なく完了 / env優先順位（`vi.stubEnv` 使用、options指定がenvを上書き）/ 不正profile→ToolValidationError。
- composition のテストは adapters/application を import してよい（composition 自身のテストなので）。※ ただし `root.test.ts` は `src/composition/` 配下に置くこと。

## 4. `src/demo.ts` 書き換え（縦切りジャーニー）

Composition Root 経由で v1ジャーニー7ステップを実証する（[README §7](../docs/README.md)）:
1. `createApp({ profile: 'local', dbPath: ':memory:' })`。
2. Increment 1 と同等の CSV→select→filter→rename→cast グラフを構築。
3. `saveTool.execute(...)` で保存（1.0.0）→ グラフを少し変えて再保存（1.0.1、bump省略=patch）。
4. `listToolVersions` でバージョン一覧を表示。
5. `previewTool.inspect` で各ノードのスキーマ状態を表示（従来のスキーマ遷移表示を維持）。
6. `previewTool.preview` で最終出力行を表示。
7. 旧バージョン(1.0.0)を `version` 指定でpreviewし、**最新版と結果が異なる**ことを表示（バージョン固定の実証）。
8. `app.close()`。
- 出力は従来同様 `console.log` の人間可読形式。副作用・外部通信なし。exit 0。
- 実行コマンドは `npm run demo`（`node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx src/demo.ts` に更新済み）。
- **adapters を直接 import しない**（depcruiseルール）。composition のみ。

## 5. 完了条件（DoD）
- [ ] `npx tsc --noEmit` エラー0。
- [ ] `npx vitest run` 全green（既存305 + 新規）。
- [ ] `npx vitest run --coverage` 閾値クリア。
- [ ] `npx depcruise src --config .dependency-cruiser.cjs` 違反0（新ルール含む）。
- [ ] `npm run demo` が保存→バージョン→取得→プレビューの縦切りを出力し exit 0。
