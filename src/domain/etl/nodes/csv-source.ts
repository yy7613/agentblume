/**
 * ドメイン: v1 ノード `csv-source`（実装契約 §9.2）
 *
 * kind: source / arity: 0。
 * CSV テキスト（RFC4180 サブセット）をパースして Table を出力する。
 *
 * パース仕様:
 * - ダブルクオート囲みフィールド、`""` によるクオートエスケープ、クオート内の
 *   区切り文字を尊重する。
 * - **クオート内の改行は v1 範囲外**（行はまず改行で分割する）。
 * - `header:true`（既定）→ 1行目を列名に。`false` → `col1,col2,...`。
 * - `inferTypes:true`（既定）→ 各セル文字列を number/boolean/date に緩く変換、
 *   無理なら文字列のまま。空文字 → null。`inferTypes:false` → 全て文字列（空→null）。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { inferSchemaFromRows } from '../../data/schema';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

/** `csv-source` の設定。 */
export interface CsvSourceConfig {
  readonly text: string;
  readonly delimiter?: string;
  readonly header?: boolean;
  readonly inferTypes?: boolean;
}

const configSchema = z.object({
  text: z.string(),
  delimiter: z.string().min(1).optional(),
  header: z.boolean().optional(),
  inferTypes: z.boolean().optional(),
});

/** ISO 8601 らしき日付文字列（緩め）。日付のみ / 日時（Z or ±hh:mm）を許可。 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** 改行で行に分割する（CRLF/CR/LF 対応）。末尾の空行は落とす。 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  // 末尾の空行（ファイル末尾の改行由来）を1つ落とす。中間の空行は保持。
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * 1行を区切り文字でフィールドに分割する（RFC4180 サブセット）。
 * クオート内の区切り文字・`""` エスケープを尊重する。
 */
function parseLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // `""` はエスケープされたダブルクオート。
        if (line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        // 閉じクオート。
        inQuotes = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    // 非クオート状態。
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (line.startsWith(delimiter, i)) {
      fields.push(current);
      current = '';
      i += delimiter.length;
      continue;
    }
    current += ch;
    i += 1;
  }

  fields.push(current);
  return fields;
}

/** 生フィールド文字列を（inferTypes に応じて）Cell に変換する。空文字 → null。 */
function toCell(raw: string, inferTypes: boolean): Cell {
  if (raw === '') return null;
  if (!inferTypes) return raw;

  // boolean（厳密に 'true'/'false'）。
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // number（NaN/空にはならないよう慎重に）。
  // 先頭末尾の空白のみのケースや純粋数値のみを number 化する。
  const trimmed = raw.trim();
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }

  // date（ISO 8601 らしき文字列のみ）。
  if (ISO_DATE_RE.test(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return raw;
}

/** CSV テキストを行データにパースする（共通ロジック）。 */
function parseCsv(config: CsvSourceConfig): Row[] {
  const delimiter = config.delimiter ?? ',';
  const header = config.header ?? true;
  const inferTypes = config.inferTypes ?? true;

  const lines = splitLines(config.text);
  if (lines.length === 0) return [];

  const rowsOfFields = lines.map((line) => parseLine(line, delimiter));

  let headerNames: string[];
  let dataRows: string[][];

  if (header) {
    const first = rowsOfFields[0] ?? [];
    headerNames = first.map((name, idx) => (name === '' ? `col${idx + 1}` : name));
    dataRows = rowsOfFields.slice(1);
  } else {
    // 列数は最初の行から決める。
    const width = rowsOfFields[0]?.length ?? 0;
    headerNames = Array.from({ length: width }, (_v, idx) => `col${idx + 1}`);
    dataRows = rowsOfFields;
  }

  return dataRows.map((fields) => {
    const row: Record<string, Cell> = {};
    for (let c = 0; c < headerNames.length; c += 1) {
      const name = headerNames[c];
      if (name === undefined) continue;
      // 列数不足の行では該当セルを null 扱い（欠損）。
      const raw = c < fields.length ? (fields[c] ?? '') : '';
      row[name] = c < fields.length ? toCell(raw, inferTypes) : null;
    }
    return row;
  });
}

class CsvSourceNode implements EtlNode<CsvSourceConfig> {
  readonly type = 'csv-source';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): CsvSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`csv-source: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], config: CsvSourceConfig): SchemaInference {
    const rows = parseCsv(config);
    return { schema: inferSchemaFromRows(rows), state: 'inferred', issues: [] };
  }

  execute(_inputs: readonly Table[], config: CsvSourceConfig): Table {
    const rows = parseCsv(config);
    return { schema: inferSchemaFromRows(rows), rows };
  }
}

/** `csv-source` ノードのシングルトン。 */
export const csvSourceNode: EtlNode<CsvSourceConfig> = new CsvSourceNode();
