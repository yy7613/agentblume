/**
 * v1 ジャーニー実行デモ（実装契約 §12 / README §7）。
 *
 * `npm run demo`（= `tsx src/demo.ts`）で実行する。
 * README §7 の代表ジャーニーを実ノード（createDefaultRegistry）と実 EtlEngine で
 * 構築し、各ノードのスキーマ状態（type/state/列）と最終プレビュー行を人間可読に
 * console.log する。副作用・外部通信なし。終了コード 0 で正常終了する。
 *
 * ジャーニー:
 *   csv-source → select → filter(age gte 18) → rename(name→displayName) → cast(age→string)
 */
import type { Cell, Row, Schema, Table } from './domain/data/types';
import { createDefaultRegistry } from './domain/etl/nodes/index';
import { EtlEngine } from './application/etl/engine';
import type { GraphNode, ToolGraph } from './domain/etl/graph';

/** README §7 相当のサンプル CSV（複数型を含む 4 行）。 */
const SAMPLE_CSV = [
  'id,name,age,active,joined',
  '1,Alice,30,true,2020-01-15',
  '2,Bob,17,false,2021-06-01',
  '3,Carol,25,true,2019-11-30',
  '4,Dave,15,true,2022-03-22',
].join('\n');

/** README §7 のジャーニーを表す ToolGraph。 */
const journey: ToolGraph = {
  nodes: [
    { id: 'src', type: 'csv-source', config: { text: SAMPLE_CSV } },
    { id: 'sel', type: 'select', config: { columns: ['id', 'name', 'age', 'active'] } },
    { id: 'flt', type: 'filter', config: { column: 'age', op: 'gte', value: 18 } },
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

/** ノードごとの人間可読ラベル（デモ出力用）。 */
const NODE_LABELS: Record<string, string> = {
  src: 'csv-source',
  sel: "select[id,name,age,active]",
  flt: 'filter[age gte 18]',
  ren: 'rename[name -> displayName]',
  cst: 'cast[age -> string]',
};

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
  return schema.columns
    .map((c) => `${c.name}=${formatCell(row[c.name] ?? null)}`)
    .join(', ');
}

function main(): void {
  const registry = createDefaultRegistry();
  const engine = new EtlEngine(registry);
  const nodeById = new Map<string, GraphNode>(journey.nodes.map((n) => [n.id, n]));

  console.log('=== AgentContext v1 journey demo ===');
  console.log('journey: csv-source -> select -> filter -> rename -> cast');
  console.log('');
  console.log('--- input CSV ---');
  console.log(SAMPLE_CSV);
  console.log('');

  // 1) スキーマ伝播。
  const prop = engine.propagateSchemas(journey);
  console.log('--- schema propagation (per node) ---');
  console.log(`topological order: ${prop.order.join(' -> ')}`);
  console.log(`hasErrors: ${prop.hasErrors}`);
  for (const id of prop.order) {
    const inf = prop.nodes[id];
    if (inf === undefined) continue;
    const gn = nodeById.get(id);
    const label = NODE_LABELS[id] ?? gn?.type ?? id;
    console.log('');
    console.log(`[${id}] ${label}`);
    console.log(`  type   : ${gn?.type ?? '(unknown)'}`);
    console.log(`  state  : ${inf.state}`);
    console.log(`  schema : ${formatSchema(inf.schema)}`);
    if (inf.issues.length > 0) {
      for (const issue of inf.issues) {
        const col = issue.column ? ` (column: ${issue.column})` : '';
        console.log(`  issue  : [${issue.severity}] ${issue.message}${col}`);
      }
    }
  }

  // 2) プレビュー実行（最終出力の行を表示）。
  const preview = engine.preview(journey);
  const output: Table = preview.output;

  console.log('');
  console.log('--- preview: final output ---');
  console.log(`terminal node : ${preview.terminalId}`);
  console.log(`output schema : ${formatSchema(output.schema)}`);
  console.log(`output rows   : ${output.rows.length}`);
  output.rows.forEach((row, i) => {
    console.log(`  row[${i}] { ${formatRow(row, output.schema)} }`);
  });

  console.log('');
  console.log('--- preview: row counts per node ---');
  for (const id of prop.order) {
    const np = preview.nodes[id];
    if (np === undefined) continue;
    const label = NODE_LABELS[id] ?? id;
    const trunc = np.truncated ? ' (truncated)' : '';
    console.log(`  [${id}] ${label}: ${np.table.rows.length} row(s)${trunc}`);
  }

  console.log('');
  console.log('=== demo complete ===');
}

main();
