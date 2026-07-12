export const NODE_TYPES = ['agent-input', 'json-source', 'csv-source', 'select', 'filter', 'rename', 'cast', 'join', 'union', 'sort', 'distinct', 'fill-null', 'replace', 'agent-output', 'workspace-output'] as const;
export type ToolNodeType = (typeof NODE_TYPES)[number];

export interface NodeCatalogItem {
  readonly type: ToolNodeType;
  readonly label: string;
  readonly labelJa: string;
  readonly kind: 'source' | 'transform' | 'sink';
  /** 入力ポート数（domain側 EtlNode.inputArity と同値。source=0 / 通常transform=1 / join・union=2）。 */
  readonly inputArity: 0 | 1 | 2;
  readonly description: string;
  readonly descriptionJa: string;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
}

export const NODE_CATALOG: readonly NodeCatalogItem[] = [
  {
    type: 'agent-input', label: 'Agent input', labelJa: 'エージェント入力', kind: 'source', inputArity: 0,
    description: 'Accept Tool Calling arguments as a single input row.', descriptionJa: 'ツール呼び出し引数を1行の入力として受け取ります。',
    defaultConfig: {
      schema: { columns: [{ name: 'query', type: 'string', nullable: false }] },
      sample: { query: 'sample' },
    },
  },
  {
    type: 'json-source', label: 'JSON source', labelJa: 'JSON入力', kind: 'source', inputArity: 0,
    description: 'Load fixed JSON rows.', descriptionJa: '固定JSON行を読み込みます。', defaultConfig: { rows: [{ id: 1, name: 'Alice', age: 30 }, { id: 2, name: 'Bob', age: 17 }] },
  },
  {
    type: 'csv-source', label: 'CSV source', labelJa: 'CSV入力', kind: 'source', inputArity: 0,
    description: 'Load fixed CSV text.', descriptionJa: '固定CSVテキストを読み込みます。', defaultConfig: { text: 'id,name,age\n1,Alice,30\n2,Bob,17', delimiter: ',', header: true, inferTypes: true },
  },
  { type: 'select', label: 'Select', labelJa: '列選択', kind: 'transform', inputArity: 1, description: 'Keep only selected columns.', descriptionJa: '必要な列だけを残します。', defaultConfig: { columns: [] } },
  { type: 'filter', label: 'Filter', labelJa: '行フィルター', kind: 'transform', inputArity: 1, description: 'Keep only rows matching a condition.', descriptionJa: '条件に合う行だけを残します。', defaultConfig: { column: '', op: 'eq', value: '' } },
  { type: 'rename', label: 'Rename', labelJa: '列名変更', kind: 'transform', inputArity: 1, description: 'Rename columns.', descriptionJa: '列名を変更します。', defaultConfig: { renames: [] } },
  { type: 'cast', label: 'Cast', labelJa: '型変換', kind: 'transform', inputArity: 1, description: 'Convert column data types.', descriptionJa: '列のデータ型を変換します。', defaultConfig: { casts: [] } },
  { type: 'join', label: 'Join', labelJa: '結合', kind: 'transform', inputArity: 2, description: 'Join two inputs on key columns.', descriptionJa: '2つの入力をキー列で結合します。', defaultConfig: { mode: 'inner', keys: [], rightSuffix: '_right' } },
  { type: 'union', label: 'Union', labelJa: '縦結合', kind: 'transform', inputArity: 2, description: 'Append rows of two inputs by column name.', descriptionJa: '2つの入力を列名で縦に連結します。', defaultConfig: { strict: false } },
  { type: 'sort', label: 'Sort', labelJa: '並べ替え', kind: 'transform', inputArity: 1, description: 'Sort rows by one or more keys.', descriptionJa: '複数キーで行を並べ替えます。', defaultConfig: { keys: [] } },
  { type: 'distinct', label: 'Distinct', labelJa: '重複排除', kind: 'transform', inputArity: 1, description: 'Remove duplicate rows.', descriptionJa: '重複する行を取り除きます。', defaultConfig: { columns: [] } },
  { type: 'fill-null', label: 'Fill null', labelJa: 'null処理', kind: 'transform', inputArity: 1, description: 'Fill null cells or drop such rows.', descriptionJa: 'nullを定数で埋めるか行を削除します。', defaultConfig: { rules: [] } },
  { type: 'replace', label: 'Replace', labelJa: '値置換', kind: 'transform', inputArity: 1, description: 'Replace matching cell values.', descriptionJa: '一致するセルの値を置換します。', defaultConfig: { rules: [] } },
  { type: 'agent-output', label: 'Agent output', labelJa: 'エージェント出力', kind: 'sink', inputArity: 1, description: 'Format a bounded result for the Agent.', descriptionJa: '上限付きの結果をエージェントへ返します。', defaultConfig: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
  { type: 'workspace-output', label: 'Workspace output', labelJa: 'ワークスペース出力', kind: 'sink', inputArity: 1, description: 'Store a temporary session artifact and return its reference.', descriptionJa: 'セッションの一時Artifactへ保存し、参照を返します。', defaultConfig: { name: 'tool-output', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 10 } },
];

export function catalogItem(type: ToolNodeType): NodeCatalogItem {
  return NODE_CATALOG.find((item) => item.type === type) as NodeCatalogItem;
}

/** 入力ポート番号（toInput）→ React Flow の target handle id。 */
export function inputHandleId(toInput: number): string {
  return `in-${toInput}`;
}

/** React Flow の target handle id → toInput。単一入力の無名ハンドルは undefined。 */
export function toInputOf(targetHandle: string | null | undefined): number | undefined {
  if (targetHandle === null || targetHandle === undefined) return undefined;
  const match = /^in-(\d+)$/.exec(targetHandle);
  return match === null ? undefined : Number(match[1]);
}
