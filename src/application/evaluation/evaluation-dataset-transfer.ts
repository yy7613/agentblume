import { deserializeEvaluationCases, deserializeEvaluationDataset, serializeEvaluationCase, serializeEvaluationDataset, type SerializedEvaluationCase } from '../../domain/evaluation/assets-serialization';
import { normalizeEvaluationCases, type EvaluationCase, type EvaluationDataset, type TurnEvaluationCase } from '../../domain/evaluation/evaluation-dataset';
import { EvaluationDomainError } from '../../domain/evaluation/errors';

export type EvaluationDatasetTransferFormat = 'json' | 'csv';

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new EvaluationDomainError('ImportEvaluationDataset: unterminated CSV quote');
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((item) => item.some((value) => value.trim().length > 0));
}

function csvValue(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function splitPipe(value: string): string[] { return value.trim() === '' ? [] : value.split('|').map((item) => item.trim()).filter(Boolean); }

function importCsv(content: string): readonly EvaluationCase[] {
  const rows = parseCsv(content);
  const header = rows[0];
  if (header === undefined) throw new EvaluationDomainError('ImportEvaluationDataset: CSV is empty');
  const columns = new Map(header.map((name, index) => [name.trim(), index]));
  for (const required of ['id', 'input']) if (!columns.has(required)) throw new EvaluationDomainError(`ImportEvaluationDataset: CSV is missing '${required}' column`);
  const read = (row: readonly string[], name: string): string => row[columns.get(name) ?? -1] ?? '';
  const cases = rows.slice(1).map((row) => {
    const kind = read(row, 'kind');
    if (kind !== '' && kind !== 'turn') throw new EvaluationDomainError('ImportEvaluationDataset: CSV supports only turn cases');
    const reference = read(row, 'reference');
    const expectedTools = splitPipe(read(row, 'expectedTools'));
    return {
      id: read(row, 'id'), kind: 'turn' as const, input: read(row, 'input'),
      ...(reference !== '' ? { reference } : {}),
      ...(expectedTools.length > 0 ? { expectedTools } : {}),
      tags: splitPipe(read(row, 'tags')), source: 'import' as const,
    };
  });
  return normalizeEvaluationCases(cases);
}

export class ImportEvaluationCasesUseCase {
  execute(format: EvaluationDatasetTransferFormat, content: string): readonly EvaluationCase[] {
    if (typeof content !== 'string' || content.trim().length === 0) throw new EvaluationDomainError('ImportEvaluationDataset: content must be non-empty');
    if (format === 'csv') return importCsv(content);
    try {
      const value = JSON.parse(content) as unknown;
      if (Array.isArray(value)) return normalizeEvaluationCases(deserializeEvaluationCases(value).map((entry) => ({ ...entry, source: 'import' as const })));
      return normalizeEvaluationCases(deserializeEvaluationDataset(value).cases.map((entry) => ({ ...entry, source: 'import' as const })));
    } catch (error) {
      if (error instanceof EvaluationDomainError) throw error;
      throw new EvaluationDomainError(`ImportEvaluationDataset: invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`);
    }
  }
}

function exportCsv(cases: readonly TurnEvaluationCase[]): string {
  const header = ['id', 'kind', 'input', 'reference', 'expectedTools', 'tags', 'source'];
  const rows = cases.map((entry) => [entry.id, entry.kind, entry.input, entry.reference ?? '', entry.expectedTools?.join('|') ?? '', entry.tags.join('|'), entry.source]);
  return [header, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n');
}

export class ExportEvaluationDatasetUseCase {
  execute(dataset: EvaluationDataset, format: EvaluationDatasetTransferFormat): string {
    if (format === 'json') return `${JSON.stringify(serializeEvaluationDataset(dataset), null, 2)}\n`;
    if (dataset.cases.some((entry) => entry.kind !== 'turn')) throw new EvaluationDomainError('ExportEvaluationDataset: CSV supports only datasets containing turn cases');
    return exportCsv(dataset.cases as readonly TurnEvaluationCase[]);
  }
}

export function serializeImportedCases(cases: readonly EvaluationCase[]): readonly SerializedEvaluationCase[] {
  return cases.map(serializeEvaluationCase);
}
