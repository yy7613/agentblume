/**
 * 組み込みツール（あらかじめ用意されたツール）のシード。
 *
 * 手動確認用の `sample-data.ts` と同じ層・同じ流儀だが、こちらは環境変数に関係なく
 * **サーバー起動時に必ず**呼び出す。よく使うツールを毎回作り直さずエージェントへ
 * 割り当てられるようにするため。冪等: 既に同じ internalId があれば何もしない。
 *
 * 定義は `src/builtin-tools/<業務>.ts` に分け、ここは並べて共通ループ（`seed.ts`）へ渡すだけにする（ADR-0039）。
 */
import type { App } from './composition/root';
import { CORE_BUILTIN_TOOLS } from './builtin-tools/core';
import { JOURNAL_BUILTIN_TOOLS } from './builtin-tools/journal';
import { EXPENSE_BUILTIN_TOOLS } from './builtin-tools/expense';
import { RECEIVABLES_BUILTIN_TOOLS } from './builtin-tools/receivables';
import { CONTRACT_BUILTIN_TOOLS } from './builtin-tools/contract';
import { seedTools, type BuiltinToolSeed } from './builtin-tools/seed';

export { CURRENT_DATETIME_TOOL_ID } from './builtin-tools/core';
export { JOURNAL_ATTACHMENT_TOOL_ID, JOURNAL_DRAFT_ENTRY_TOOL_ID, JOURNAL_ENTRIES_TOOL_ID } from './builtin-tools/journal';

export const BUILTIN_SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;

/** 登録順。応答の toolIds もこの順になる。 */
export const BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  ...CORE_BUILTIN_TOOLS,
  ...JOURNAL_BUILTIN_TOOLS,
  ...EXPENSE_BUILTIN_TOOLS,
  ...RECEIVABLES_BUILTIN_TOOLS,
  ...CONTRACT_BUILTIN_TOOLS,
];

export interface BuiltinToolsResult {
  readonly toolIds: readonly string[];
}

export async function seedBuiltinTools(app: App): Promise<BuiltinToolsResult> {
  return { toolIds: await seedTools(app, BUILTIN_SCOPE, BUILTIN_TOOLS) };
}
