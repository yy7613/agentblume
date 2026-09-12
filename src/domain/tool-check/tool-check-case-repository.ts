/**
 * ドメイン: 検証ケースのリポジトリ境界。
 *
 * ケースは版を持たず (scope, id) で upsert する。一覧は「新しい定義が先」（updatedAt 降順、
 * 同時刻は id 昇順で安定）に返し、toolId で絞り込める（ツール検証画面は選択中ツールのケースだけを見せる）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { ToolCheckCase } from './tool-check-case';

export interface ToolCheckCaseListOptions {
  readonly toolId?: string;
}

export interface ToolCheckCaseRepository {
  save(item: ToolCheckCase): Promise<void>;
  find(scope: TenantScope, id: string): Promise<ToolCheckCase | null>;
  list(scope: TenantScope, options?: ToolCheckCaseListOptions): Promise<readonly ToolCheckCase[]>;
  /** 戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, id: string): Promise<boolean>;
}
