/**
 * ノード設定フォームで使う値変換だけを集約する。
 * React・ストアへ依存させず、入力の解釈を単体テストできるようにする。
 */
import type { ColumnDto, DataType, JsonCell, SchemaDto } from '../api/types';

export interface JoinKeyDraft { readonly left: string; readonly right: string }
export interface SortKeyDraft { readonly column: string; readonly direction?: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' }
export interface FillRuleDraft { readonly column: string; readonly strategy: string; readonly value?: JsonCell }
export interface ReplaceRuleDraft { readonly column: string; readonly from: JsonCell; readonly to: JsonCell }

export const DATA_TYPES: readonly DataType[] = ['string', 'number', 'boolean', 'date', 'null', 'unknown'];

export function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function coerceScalar(raw: string, type?: DataType): Exclude<JsonCell, null> {
  if (type === 'number' && raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
}

export function coerceCell(raw: string, type?: DataType): JsonCell {
  return raw === 'null' ? null : coerceScalar(raw, type);
}

export function cellText(cell: JsonCell | undefined): string {
  return cell === null ? 'null' : String(cell ?? '');
}

export function parseSortKeys(value: string): SortKeyDraft[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [column = '', direction = '', nulls = ''] = line.split(':').map((part) => part.trim());
    return {
      column,
      ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
      ...(nulls === 'first' || nulls === 'last' ? { nulls } : {}),
    };
  });
}

export function parseReplaceRules(value: string, columns: readonly ColumnDto[]): ReplaceRuleDraft[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [column = '', from = '', to = ''] = line.split(':').map((part) => part.trim());
    const type = columns.find((candidate) => candidate.name === column)?.type;
    return { column, from: coerceCell(from, type), to: coerceCell(to, type) };
  });
}

export function parsePairs(value: string, rightKey: 'to' | 'type'): Array<{ from: string; to: string } | { column: string; to: string }> {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [left = '', right = ''] = line.split(':', 2).map((part) => part.trim());
    return rightKey === 'to' ? { from: left, to: right } : { column: left, to: right };
  });
}

export function columnsText(schema: SchemaDto | undefined): string {
  return (schema?.columns ?? []).map((column) => `${column.name}:${column.type}:${column.nullable ? 'optional' : 'required'}`).join('\n');
}

export function parseColumns(value: string): ColumnDto[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', rawType = '', presence = 'required'] = line.split(':').map((part) => part.trim());
    if (name === '') throw new Error('列名が必要です');
    if (!DATA_TYPES.includes(rawType as DataType)) throw new Error(`未対応の型です: ${rawType}`);
    if (presence !== 'required' && presence !== 'optional') throw new Error(`required/optionalを指定してください: ${presence}`);
    return { name, type: rawType as DataType, nullable: presence === 'optional' };
  });
}
