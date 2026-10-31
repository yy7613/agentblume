import type { ModelRequestMessage } from './model-provider';

/** A single explicit precision request only. Conflicting per-metric precisions require their own contract. */
export function requestedDecimalPlaces(messages: readonly ModelRequestMessage[]): number | undefined {
  const content = messages.filter(m => m.role === 'user').at(-1)?.content;
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '').normalize('NFKC');
  if (/丸め(?:ない|ず)|無丸め|\bunrounded\b|\bfull[- ]precision\b|\b(?:do not|don't)\s+round\b/iu.test(text)) return undefined;
  const values = [...text.matchAll(/小数(?:点(?:以下|第)?|第)?\s*(\d+)\s*(?:桁|位)|\b(\d+)\s+decimal\s+places\b/giu)].map(m => Number(m[1] ?? m[2]));
  return values.length && values.every(n => n === values[0] && Number.isInteger(n) && n >= 0 && n <= 15) ? values[0] : undefined;
}

/** Add rounded display rows without replacing a single original numeric value or changing its precision. */
export function withNumericDisplay(value: unknown, decimalPlaces: number | undefined): unknown {
  if (decimalPlaces === undefined || !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 15 || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>, rows = object['rows'];
  if (!Array.isArray(rows) || !rows.length || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) return value;
  const displayRows = rows.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, cell]) => {
    if (typeof cell !== 'number' || !Number.isFinite(cell) || Number.isInteger(cell)) return [key, cell];
    const rendered = cell.toFixed(decimalPlaces);
    return [key, Number(rendered) === 0 ? 0 : Number(rendered)];
  })));
  return { displayDecimalPlaces: decimalPlaces, displayRows,
    displayNote: 'displayRows contains deterministically rounded numeric values at the requested decimal precision. Copy these numeric values for final answers at this precision; identifiers and integer counts are unchanged. Use the original full-precision rows below for any further calculation or other precision.', ...object };
}
