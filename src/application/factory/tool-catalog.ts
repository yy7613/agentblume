/**
 * application層: Agent Factory の「既存ツールカタログ」（docs/16-agent-factory.md §4 Stage 1 / Stage 2 再利用）。
 *
 * Factoryは毎回Toolを新規生成するのではなく、**同じworkspaceに保存済みのToolで足りるなら再利用する**。
 * その判断材料としてPlannerへ渡す要約リストを、ここで `ToolRepository` から決定的に組み立てる
 * （ロールはrepositoryを触らず、値として受け取るという既存の流儀を守るため、取得はuse case側の責務）。
 *
 * 収録対象は「Factoryが割り当ててよいTool」だけに絞る:
 * - `sideEffect` が `read-only` / `session-write`（`write` / `external-action` はFactoryの計画自体が禁止）
 * - `state` が `deprecated` / `archived` でない（撤収予定のToolを新しいAgentへ配らない）
 *
 * 件数は上限（既定20件）で切り捨てる。切り捨てた場合も `totalCount` に総数を残し、Plannerへ
 * 「他にもN件ある」と伝えられるようにする。並び順は決定的（組み込み → publishName昇順）。
 */
import type { TenantScope } from '../../domain/tool/ids';
import type { SideEffect } from '../../domain/tool/metadata';
import type { ToolRepository } from '../../domain/tool/tool-repository';

/** Plannerへ提示する既存Tool 1件の要約（グラフ本体は渡さない: 判断に必要な契約面だけ）。 */
export interface ExistingToolCatalogEntry {
  readonly internalId: string;
  /** 再利用時に採用するバージョン（保存済みの最新版）。 */
  readonly latestVersion: string;
  readonly publishName: string;
  readonly displayName: string;
  /** Tool Calling契約の関数名（`agentTool.name`。未設定なら `publishName`）。 */
  readonly toolName: string;
  /** Tool Calling契約の説明（`agentTool.description`。未設定なら `displayName`）。 */
  readonly description: string;
  /** Tool引数（`inputSchema`）の列を `name:type` で並べたもの。引数なしToolは空配列。 */
  readonly inputs: readonly string[];
  readonly sideEffect: SideEffect;
  readonly owner: string;
}

export interface ExistingToolCatalog {
  readonly entries: readonly ExistingToolCatalogEntry[];
  /** 再利用候補の総数（`entries` は `limit` で切り捨てられている場合がある）。 */
  readonly totalCount: number;
}

/** Plannerのプロンプトへ載せる既存Toolの最大件数（超過分は切り捨て、件数だけ伝える）。 */
export const MAX_EXISTING_TOOL_CATALOG_ENTRIES = 20;

/** 組み込みツール（`src/builtin-tools.ts`）のowner。上限で切り捨てられないよう先頭へ並べる。 */
const BUILTIN_OWNER = 'builtin';

/** Factoryが計画・割り当てしてよい副作用か（Stage 1の計画制約と同じ規則）。 */
export function isReusableSideEffect(sideEffect: SideEffect): boolean {
  return sideEffect === 'read-only' || sideEffect === 'session-write';
}

/** 保存済みToolから再利用候補のカタログを組み立てる（副作用なし・呼び出し順に依存しない）。 */
export async function buildExistingToolCatalog(
  tools: ToolRepository,
  scope: TenantScope,
  limit: number = MAX_EXISTING_TOOL_CATALOG_ENTRIES,
): Promise<ExistingToolCatalog> {
  const summaries = await tools.list(scope);
  const entries: ExistingToolCatalogEntry[] = [];
  for (const summary of summaries) {
    if (!isReusableSideEffect(summary.sideEffect)) continue;
    if (summary.state === 'deprecated' || summary.state === 'archived') continue;
    const tool = await tools.findLatest(scope, summary.internalId);
    if (tool === null) continue;
    entries.push({
      internalId: tool.metadata.internalId,
      latestVersion: tool.metadata.version.toString(),
      publishName: tool.metadata.publishName,
      displayName: tool.metadata.displayName,
      toolName: tool.agentTool?.name ?? tool.metadata.publishName,
      description: tool.agentTool?.description ?? tool.metadata.displayName,
      inputs: (tool.inputSchema?.columns ?? []).map((column) => `${column.name}:${column.type}`),
      sideEffect: tool.sideEffect,
      owner: tool.metadata.owner,
    });
  }
  entries.sort(compareEntries);
  return { entries: entries.slice(0, Math.max(0, limit)), totalCount: entries.length };
}

function compareEntries(left: ExistingToolCatalogEntry, right: ExistingToolCatalogEntry): number {
  const leftBuiltin = left.owner === BUILTIN_OWNER ? 0 : 1;
  const rightBuiltin = right.owner === BUILTIN_OWNER ? 0 : 1;
  if (leftBuiltin !== rightBuiltin) return leftBuiltin - rightBuiltin;
  return left.publishName.localeCompare(right.publishName);
}
