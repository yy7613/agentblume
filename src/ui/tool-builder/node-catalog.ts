export const NODE_TYPES = ['agent-input', 'json-source', 'csv-source', 'select', 'filter', 'rename', 'cast'] as const;
export type ToolNodeType = (typeof NODE_TYPES)[number];

export interface NodeCatalogItem {
  readonly type: ToolNodeType;
  readonly label: string;
  readonly labelJa: string;
  readonly kind: 'source' | 'transform';
  readonly description: string;
  readonly descriptionJa: string;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
}

export const NODE_CATALOG: readonly NodeCatalogItem[] = [
  {
    type: 'agent-input', label: 'Agent input', labelJa: 'エージェント入力', kind: 'source',
    description: 'Accept Tool Calling arguments as a single input row.', descriptionJa: 'ツール呼び出し引数を1行の入力として受け取ります。',
    defaultConfig: {
      schema: { columns: [{ name: 'query', type: 'string', nullable: false }] },
      sample: { query: 'sample' },
    },
  },
  {
    type: 'json-source', label: 'JSON source', labelJa: 'JSON入力', kind: 'source',
    description: 'Load fixed JSON rows.', descriptionJa: '固定JSON行を読み込みます。', defaultConfig: { rows: [{ id: 1, name: 'Alice', age: 30 }, { id: 2, name: 'Bob', age: 17 }] },
  },
  {
    type: 'csv-source', label: 'CSV source', labelJa: 'CSV入力', kind: 'source',
    description: 'Load fixed CSV text.', descriptionJa: '固定CSVテキストを読み込みます。', defaultConfig: { text: 'id,name,age\n1,Alice,30\n2,Bob,17', delimiter: ',', header: true, inferTypes: true },
  },
  { type: 'select', label: 'Select', labelJa: '列選択', kind: 'transform', description: 'Keep only selected columns.', descriptionJa: '必要な列だけを残します。', defaultConfig: { columns: [] } },
  { type: 'filter', label: 'Filter', labelJa: '行フィルター', kind: 'transform', description: 'Keep only rows matching a condition.', descriptionJa: '条件に合う行だけを残します。', defaultConfig: { column: '', op: 'eq', value: '' } },
  { type: 'rename', label: 'Rename', labelJa: '列名変更', kind: 'transform', description: 'Rename columns.', descriptionJa: '列名を変更します。', defaultConfig: { renames: [] } },
  { type: 'cast', label: 'Cast', labelJa: '型変換', kind: 'transform', description: 'Convert column data types.', descriptionJa: '列のデータ型を変換します。', defaultConfig: { casts: [] } },
];

export function catalogItem(type: ToolNodeType): NodeCatalogItem {
  return NODE_CATALOG.find((item) => item.type === type) as NodeCatalogItem;
}
