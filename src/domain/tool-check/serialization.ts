/**
 * ドメイン: 検証ケースの直列化。
 *
 * 永続化アダプタはこの Serialized 型を JSON 化して1列（record_json）に保存する。
 * 復元は必ず createToolCheckCase を通し、保存済みデータにも同じ不変条件を課す。
 * 未知のキーは zod が落とす（前方互換: 新しいコードが足したキーを古いコードが読んでも壊れない）。
 */
import { z } from 'zod';
import { ToolCheckValidationError } from './errors';
import {
  createToolCheckCase, TOOL_CHECK_CELL_MODES, TOOL_CHECK_CELL_OPS, TOOL_CHECK_OUTCOMES, TOOL_CHECK_ROW_COUNT_OPS, TOOL_CHECK_STATUSES,
  type JsonCell, type ToolCheckCase, type ToolCheckExpectations, type ToolCheckLastResult,
} from './tool-check-case';

export interface SerializedToolCheckCase {
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  readonly id: string;
  readonly toolId: string;
  readonly toolVersion?: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonCell>>;
  readonly expectations: ToolCheckExpectations;
  readonly lastResult?: ToolCheckLastResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const jsonCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const expectationsSchema = z.object({
  rowCount: z.object({ op: z.enum(TOOL_CHECK_ROW_COUNT_OPS), value: z.number() }).optional(),
  columns: z.array(z.string()).optional(),
  cells: z.array(z.object({ column: z.string(), op: z.enum(TOOL_CHECK_CELL_OPS), value: jsonCellSchema, mode: z.enum(TOOL_CHECK_CELL_MODES) })).optional(),
  rows: z.array(z.object({
    where: z.object({ column: z.string(), value: jsonCellSchema }),
    present: z.boolean().optional(),
    cells: z.array(z.object({ column: z.string(), op: z.enum(TOOL_CHECK_CELL_OPS), value: jsonCellSchema })).optional(),
  })).optional(),
  judgments: z.array(z.object({
    nodeId: z.string(),
    where: z.object({ column: z.string(), value: jsonCellSchema }),
    verdict: z.array(z.string()),
    reasonContains: z.string().optional(),
  })).optional(),
  maxDurationMs: z.number().optional(),
  outcome: z.enum(TOOL_CHECK_OUTCOMES).optional(),
});
const lastResultSchema = z.object({
  status: z.enum(TOOL_CHECK_STATUSES),
  checkedAt: z.string(),
  toolVersion: z.string(),
  summary: z.string(),
});
const schema = z.object({
  scope: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  id: z.string(),
  toolId: z.string(),
  toolVersion: z.string().optional(),
  name: z.string(),
  arguments: z.record(z.string(), jsonCellSchema),
  expectations: expectationsSchema,
  lastResult: lastResultSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function serializeToolCheckCase(item: ToolCheckCase): SerializedToolCheckCase {
  const expectations: { -readonly [K in keyof ToolCheckExpectations]: ToolCheckExpectations[K] } = {};
  if (item.expectations.rowCount !== undefined) expectations.rowCount = { ...item.expectations.rowCount };
  if (item.expectations.columns !== undefined) expectations.columns = [...item.expectations.columns];
  if (item.expectations.cells !== undefined) expectations.cells = item.expectations.cells.map((cell) => ({ ...cell }));
  if (item.expectations.rows !== undefined) expectations.rows = item.expectations.rows.map((row) => ({ where: { ...row.where }, ...(row.present === undefined ? {} : { present: row.present }), ...(row.cells === undefined ? {} : { cells: row.cells.map((cell) => ({ ...cell })) }) }));
  if (item.expectations.judgments !== undefined) expectations.judgments = item.expectations.judgments.map((judgment) => ({ nodeId: judgment.nodeId, where: { ...judgment.where }, verdict: [...judgment.verdict], ...(judgment.reasonContains === undefined ? {} : { reasonContains: judgment.reasonContains }) }));
  if (item.expectations.maxDurationMs !== undefined) expectations.maxDurationMs = item.expectations.maxDurationMs;
  if (item.expectations.outcome !== undefined) expectations.outcome = item.expectations.outcome;
  return {
    scope: { tenantId: item.scope.tenantId, workspaceId: item.scope.workspaceId },
    id: item.id,
    toolId: item.toolId,
    ...(item.toolVersion === undefined ? {} : { toolVersion: item.toolVersion }),
    name: item.name,
    arguments: { ...item.arguments },
    expectations,
    ...(item.lastResult === undefined ? {} : { lastResult: { ...item.lastResult } }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function deserializeToolCheckCase(value: unknown): ToolCheckCase {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ToolCheckValidationError(`deserializeToolCheckCase: invalid SerializedToolCheckCase: ${issues}`);
  }
  // zod は optional キーを `undefined` 値で残すことがあるため、exactOptionalPropertyTypes に合わせて落とす。
  const { toolVersion, lastResult, ...rest } = parsed.data;
  return createToolCheckCase({
    ...rest,
    ...(toolVersion === undefined ? {} : { toolVersion }),
    ...(lastResult === undefined ? {} : { lastResult }),
    expectations: stripUndefined(rest.expectations),
  });
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
