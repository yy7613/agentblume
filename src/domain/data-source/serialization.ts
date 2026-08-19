/**
 * ドメイン: DataSource の直列化境界(ADR-0035: adapters での生キャスト禁止)
 *
 * 永続化アダプタは DataSource をそのまま JSON.stringify して1列に保存する
 * (独立した Serialized 型は設けない — 全フィールドがプリミティブで境界表現と一致するため)。
 * 復元は deserializeDataSource を必ず通し、保存済み JSON を構造検証してから返す。
 *
 * ## 寛容スキーマの方針
 *
 * 保存済みの正当な既存行が必ず読めることを優先する。
 * - 現行型で optional のフィールド(defaultSchema)は optional のまま受け入れる。
 * - 未知フィールドは拒否しない(z.object の既定 strip 動作で読み飛ばす)。
 * - createdAt / updatedAt は型どおり素の string とし、日時形式までは検証しない。
 * - sizeBytes は型どおり number とし、整数・非負までは検証しない。
 */
import { z } from 'zod';
import { DataSourceDomainError } from './errors';
import type { DataSource } from './data-source';

const tenantScopeSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });
const baseShape = {
  id: z.string(),
  tenant: tenantScopeSchema,
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
};
const dataSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    ...baseShape,
    kind: z.literal('file'),
    format: z.enum(['csv', 'json']),
    contentType: z.enum(['text/csv', 'application/json']),
    sizeBytes: z.number(),
  }),
  z.object({
    ...baseShape,
    kind: z.literal('database'),
    connectionId: z.string(),
    driver: z.literal('postgresql'),
    defaultSchema: z.string().optional(),
  }),
]);

/** 保存済み JSON(JSON.parse 済みの unknown)を検証して DataSource として返す。不正は DataSourceDomainError。 */
export function deserializeDataSource(value: unknown): DataSource {
  const parsed = dataSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new DataSourceDomainError(`deserializeDataSource: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}
