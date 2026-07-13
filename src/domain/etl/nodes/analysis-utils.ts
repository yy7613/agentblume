import type { Cell, Column, Row, Schema } from '../../data/types';
import { findColumn } from '../../data/schema';
import { SchemaError } from '../errors';
import type { SchemaIssue } from '../node';

export function numericColumns(schema: Schema, names: readonly string[], node: string): SchemaIssue[] {
  return names.flatMap((name) => {
    const column = findColumn(schema, name);
    if (column === undefined) return [{ severity: 'error' as const, message: `${node}: column not found: ${name}`, column: name }];
    return column.type === 'number' ? [] : [{ severity: 'error' as const, message: `${node}: column '${name}' must be number`, column: name }];
  });
}

export function existingColumns(schema: Schema, names: readonly string[], node: string): SchemaIssue[] {
  return names.flatMap((name) => findColumn(schema, name) === undefined ? [{ severity: 'error' as const, message: `${node}: column not found: ${name}`, column: name }] : []);
}

export function requireColumns(schema: Schema, names: readonly string[], node: string): void {
  const missing = names.filter((name) => findColumn(schema, name) === undefined);
  if (missing.length > 0) throw new SchemaError(`${node}: column(s) not found: ${missing.join(', ')}`);
}

export function requireNumbers(schema: Schema, names: readonly string[], node: string): void {
  requireColumns(schema, names, node);
  const nonNumeric = names.filter((name) => findColumn(schema, name)?.type !== 'number');
  if (nonNumeric.length > 0) throw new SchemaError(`${node}: column(s) must be number: ${nonNumeric.join(', ')}`);
}

export function numberValue(row: Row, column: string): number | undefined {
  const value = row[column];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function cell(row: Row, column: string): Cell { return row[column] ?? null; }

export function groupKey(row: Row, columns: readonly string[]): string {
  return JSON.stringify(columns.map((column) => {
    const value = cell(row, column);
    return value instanceof Date ? ['date', value.toISOString()] : [typeof value, value];
  }));
}

export function groupValues(row: Row, columns: readonly string[]): Row {
  return Object.fromEntries(columns.map((column) => [column, cell(row, column)]));
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos); const upper = Math.ceil(pos);
  const left = sorted[lower]; const right = sorted[upper];
  if (left === undefined || right === undefined) return null;
  return left + (right - left) * (pos - lower);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function standardDeviation(values: readonly number[], variance: 'sample' | 'population'): number | null {
  if (values.length === 0 || (variance === 'sample' && values.length < 2)) return null;
  const average = mean(values);
  if (average === null) return null;
  const divisor = variance === 'sample' ? values.length - 1 : values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / divisor);
}

export function schema(columns: readonly Column[]): Schema { return { columns: [...columns] }; }
