/**
 * v3 縦切りジャーニーデモ（v3 実装契約 §4 / README §7）。
 *
 * `npm run demo` で実行する。Composition Root（createApp）経由で
 * 保存(1.0.0) → 再保存(1.0.1) → バージョン一覧 → inspect（スキーマ状態）→
 * preview（最終出力行）→ 旧バージョン指定 preview（結果差の実証）→ close
 * の縦切りを実演する。副作用・外部通信なし。終了コード 0 で正常終了する。
 *
 * adapters は直接 import しない（composition 経由のみ / depcruise ルール）。
 *
 * ジャーニー:
 *   csv-source → select → filter(age gte 18) → rename(name→displayName) → cast(age→string)
 *   v1.0.1 では filter を age gte 26 に変更し、バージョン固定の結果差を示す。
 */
// Mastra 用 env（テレメトリ無効化・オフライン）を最初に確定させる。import順が意味を持つ（並べ替え禁止）。
import './mastra-runtime-env';
import { createApp } from './composition/root';
import type { App } from './composition/root';
import type { Cell, Row, Schema, Table } from './domain/data/types';
import type { GraphNode, ToolGraph } from './domain/etl/graph';
import type { TenantScope } from './domain/shared/tenant-scope';
import { SemVer } from './domain/tool/semver';

/** README §7 相当のサンプル CSV（複数型を含む 4 行）。 */
const SAMPLE_CSV = [
  'id,name,age,active,joined',
  '1,Alice,30,true,2020-01-15',
  '2,Bob,17,false,2021-06-01',
  '3,Carol,25,true,2019-11-30',
  '4,Dave,15,true,2022-03-22',
].join('\n');

/** filter の閾値だけを差し替えて README §7 のジャーニーグラフを作る。 */
function makeJourneyGraph(minAge: number): ToolGraph {
  return {
    nodes: [
      { id: 'src', type: 'csv-source', config: { text: SAMPLE_CSV } },
      { id: 'sel', type: 'select', config: { columns: ['id', 'name', 'age', 'active'] } },
      { id: 'flt', type: 'filter', config: { column: 'age', op: 'gte', value: minAge } },
      { id: 'ren', type: 'rename', config: { renames: [{ from: 'name', to: 'displayName' }] } },
      { id: 'cst', type: 'cast', config: { casts: [{ column: 'age', to: 'string' }] } },
    ],
    edges: [
      { from: 'src', to: 'sel' },
      { from: 'sel', to: 'flt' },
      { from: 'flt', to: 'ren' },
      { from: 'ren', to: 'cst' },
    ],
  };
}

/** ノードの人間可読ラベルを config から導出する（デモ出力用）。 */
function describeNode(gn: GraphNode): string {
  const config = gn.config as Record<string, unknown>;
  switch (gn.type) {
    case 'csv-source':
      return 'csv-source';
    case 'select':
      return `select[${(config['columns'] as string[]).join(',')}]`;
    case 'filter':
      return `filter[${String(config['column'])} ${String(config['op'])} ${String(config['value'])}]`;
    case 'rename': {
      const renames = config['renames'] as ReadonlyArray<{ from: string; to: string }>;
      return `rename[${renames.map((r) => `${r.from} -> ${r.to}`).join(', ')}]`;
    }
    case 'cast': {
      const casts = config['casts'] as ReadonlyArray<{ column: string; to: string }>;
      return `cast[${casts.map((c) => `${c.column} -> ${c.to}`).join(', ')}]`;
    }
    default:
      return gn.type;
  }
}

/** スキーマを "name:type(?)" のカンマ区切り文字列にする。 */
function formatSchema(schema: Schema): string {
  if (schema.columns.length === 0) return '(no columns)';
  return schema.columns.map((c) => `${c.name}:${c.type}${c.nullable ? '?' : ''}`).join(', ');
}

/** 1 セルを表示用文字列にする（Date は ISO、null は "null"、string は引用符付き）。 */
function formatCell(value: Cell): string {
  if (value === null) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

/** 1 行を "k=v, k=v" 形式にする（列順に従う）。 */
function formatRow(row: Row, schema: Schema): string {
  return schema.columns.map((c) => `${c.name}=${formatCell(row[c.name] ?? null)}`).join(', ');
}

/** テーブルの全行を "row[i] { ... }" 形式で出力する。 */
function printRows(output: Table): void {
  output.rows.forEach((row, i) => {
    console.log(`  row[${i}] { ${formatRow(row, output.schema)} }`);
  });
}

const scope: TenantScope = { tenantId: 'demo-tenant', workspaceId: 'demo-ws' };
const TOOL_ID = 'adult-users';

async function main(app: App): Promise<void> {
  console.log('=== agentblume v3 vertical-slice demo (via composition root) ===');
  console.log(`profile: ${app.profile} (sqlite :memory:)`);
  console.log('journey: csv-source -> select -> filter -> rename -> cast');
  console.log('');
  console.log('--- input CSV ---');
  console.log(SAMPLE_CSV);
  console.log('');

  // 1) 保存 1.0.0（filter: age gte 18）。
  const v1 = await app.saveTool.execute({
    scope,
    internalId: TOOL_ID,
    workingName: 'adult-users-working',
    displayName: 'Adult Users',
    publishName: 'adult_users',
    owner: 'demo@example.com',
    sideEffect: 'read-only',
    graph: makeJourneyGraph(18),
  });
  console.log('--- save (initial) ---');
  console.log(`saved ${TOOL_ID}@${v1.metadata.version.toString()} (filter: age gte 18)`);

  // 2) グラフを少し変えて再保存 → 1.0.1（bump 省略 = patch）。
  const v2 = await app.saveTool.execute({
    scope,
    internalId: TOOL_ID,
    workingName: 'adult-users-working',
    displayName: 'Adult Users',
    publishName: 'adult_users',
    owner: 'demo@example.com',
    sideEffect: 'read-only',
    graph: makeJourneyGraph(26),
  });
  console.log('');
  console.log('--- save (updated graph) ---');
  console.log(`saved ${TOOL_ID}@${v2.metadata.version.toString()} (filter: age gte 26)`);

  // 3) バージョン一覧。
  const versions = await app.listToolVersions.execute(scope, TOOL_ID);
  console.log('');
  console.log('--- versions ---');
  console.log(`${TOOL_ID}: ${versions.map((v) => v.toString()).join(', ')}`);

  // 4) inspect（latest = 1.0.1）: 各ノードのスキーマ状態を表示。
  const { tool: inspected, propagation } = await app.previewTool.inspect(scope, TOOL_ID);
  const nodeById = new Map<string, GraphNode>(inspected.graph.nodes.map((n) => [n.id, n]));
  console.log('');
  console.log(`--- inspect: schema propagation (latest ${inspected.metadata.version.toString()}) ---`);
  console.log(`topological order: ${propagation.order.join(' -> ')}`);
  console.log(`hasErrors: ${propagation.hasErrors}`);
  for (const id of propagation.order) {
    const inf = propagation.nodes[id];
    if (inf === undefined) continue;
    const gn = nodeById.get(id);
    console.log('');
    console.log(`[${id}] ${gn !== undefined ? describeNode(gn) : id}`);
    console.log(`  type   : ${gn?.type ?? '(unknown)'}`);
    console.log(`  state  : ${inf.state}`);
    console.log(`  schema : ${formatSchema(inf.schema)}`);
    for (const issue of inf.issues) {
      const col = issue.column ? ` (column: ${issue.column})` : '';
      console.log(`  issue  : [${issue.severity}] ${issue.message}${col}`);
    }
  }

  // 5) preview（latest = 1.0.1）: 最終出力行を表示。
  const latest = await app.previewTool.preview(scope, TOOL_ID);
  console.log('');
  console.log(`--- preview: final output (latest ${latest.tool.metadata.version.toString()}) ---`);
  console.log(`terminal node : ${latest.result.terminalId}`);
  console.log(`output schema : ${formatSchema(latest.result.output.schema)}`);
  console.log(`output rows   : ${latest.result.output.rows.length}`);
  printRows(latest.result.output);

  // 6) 旧バージョン(1.0.0)を version 指定で preview → 最新版と結果が異なる。
  const pinned = await app.previewTool.preview(scope, TOOL_ID, { version: SemVer.of(1, 0, 0) });
  console.log('');
  console.log(`--- preview: pinned version ${pinned.tool.metadata.version.toString()} ---`);
  console.log(`output rows   : ${pinned.result.output.rows.length}`);
  printRows(pinned.result.output);

  console.log('');
  console.log('--- version pinning: result difference ---');
  console.log(`latest 1.0.1 (age gte 26): ${latest.result.output.rows.length} row(s)`);
  console.log(`pinned 1.0.0 (age gte 18): ${pinned.result.output.rows.length} row(s)`);
  console.log(
    `same tool id, different version -> different result: ${
      latest.result.output.rows.length !== pinned.result.output.rows.length
    }`,
  );

  console.log('');
  console.log('=== demo complete ===');
}

const app = createApp({ profile: 'local', dbPath: ':memory:' });
try {
  await main(app);
} finally {
  app.close();
}
