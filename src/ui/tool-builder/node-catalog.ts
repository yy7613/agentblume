export const NODE_TYPES = ['agent-input', 'json-source', 'csv-source', 'select', 'filter', 'rename', 'cast'] as const;
export type ToolNodeType = (typeof NODE_TYPES)[number];

export interface NodeCatalogItem {
  readonly type: ToolNodeType;
  readonly label: string;
  readonly kind: 'source' | 'transform';
  readonly description: string;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
}

export const NODE_CATALOG: readonly NodeCatalogItem[] = [
  {
    type: 'agent-input', label: 'Agent input', kind: 'source',
    description: 'Tool Calling引数を1行の入力として受け取ります。',
    defaultConfig: {
      schema: { columns: [{ name: 'query', type: 'string', nullable: false }] },
      sample: { query: 'sample' },
    },
  },
  {
    type: 'json-source', label: 'JSON source', kind: 'source',
    description: '固定 JSON 行を読み込みます。', defaultConfig: { rows: [{ id: 1, name: 'Alice', age: 30 }, { id: 2, name: 'Bob', age: 17 }] },
  },
  {
    type: 'csv-source', label: 'CSV source', kind: 'source',
    description: '固定 CSV テキストを読み込みます。', defaultConfig: { text: 'id,name,age\n1,Alice,30\n2,Bob,17', delimiter: ',', header: true, inferTypes: true },
  },
  { type: 'select', label: 'Select', kind: 'transform', description: '必要な列だけを残します。', defaultConfig: { columns: [] } },
  { type: 'filter', label: 'Filter', kind: 'transform', description: '条件に合う行だけを残します。', defaultConfig: { column: '', op: 'eq', value: '' } },
  { type: 'rename', label: 'Rename', kind: 'transform', description: '列名を変更します。', defaultConfig: { renames: [] } },
  { type: 'cast', label: 'Cast', kind: 'transform', description: '列のデータ型を変換します。', defaultConfig: { casts: [] } },
];

export function catalogItem(type: ToolNodeType): NodeCatalogItem {
  return NODE_CATALOG.find((item) => item.type === type) as NodeCatalogItem;
}
