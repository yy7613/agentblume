/**
 * 組込みツールのシードの共通部分（型と冪等ループ）。
 *
 * 業務の組込みツールは `src/builtin-tools/<業務>.ts` に `readonly BuiltinToolSeed[]` として置き、
 * `src/builtin-tools.ts` がここで一括登録する（ADR-0039）。業務を並行して足すときに、
 * 共有のシード関数を取り合わないため。
 */
import type { SaveToolInput } from '../application/tool/save-tool';
import type { TenantScope } from '../domain/shared/tenant-scope';

/** 1 つの組込みツール。scope はシード時に決まるので持たない。 */
export type BuiltinToolSeed = Omit<SaveToolInput, 'scope'>;

/** シードに要るユースケース（`App` の該当部分を構造的に受ける）。 */
export interface BuiltinToolSeedPorts {
  readonly listTools: { execute(scope: TenantScope): Promise<readonly { readonly internalId: string }[]> };
  readonly saveTool: { execute(input: SaveToolInput): Promise<unknown> };
}

/**
 * 並べた順に登録し、internalId の一覧を同じ順で返す。
 *
 * 冪等: 既に同じ internalId があれば何もしない（新しい版も作らない）。**定義を変えても既存の
 * ワークスペースには反映されない**ので、変えるときは internalId を変えるか移行を書くこと。
 * 業務をまたいで internalId が重なったら、どちらかが黙って登録されないので最初に落とす。
 */
export async function seedTools(ports: BuiltinToolSeedPorts, scope: TenantScope, seeds: readonly BuiltinToolSeed[]): Promise<readonly string[]> {
  const ids = seeds.map((seed) => seed.internalId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Error(`builtin tool is seeded twice: ${duplicate}`);
  const existing = new Set((await ports.listTools.execute(scope)).map((tool) => tool.internalId));
  for (const seed of seeds) {
    if (!existing.has(seed.internalId)) await ports.saveTool.execute({ scope, ...seed });
  }
  return ids;
}
