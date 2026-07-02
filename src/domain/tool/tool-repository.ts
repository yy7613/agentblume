/**
 * ドメイン: ToolRepository ポート（v2 実装契約 §9）— interface, 型のみ。
 *
 * 永続化の抽象。実装（InMemory/SQLite）は adapters 層に置く。
 * テナント分離: 別テナント/ワークスペースで保存したものは相互に不可視。
 */
import type { TenantScope, ToolId } from './ids';
import type { ToolSummary } from './metadata';
import type { SemVer } from './semver';
import type { Tool } from './tool';

/** Tool の保存・取得ポート。 */
export interface ToolRepository {
  /**
   * metadata.version で保存する。
   * 既存 (tenant, internalId, version) への再保存は VersionConflictError。
   */
  save(tool: Tool): Promise<void>;

  /** 指定バージョンを取得。無→null。 */
  findVersion(scope: TenantScope, internalId: ToolId, version: SemVer): Promise<Tool | null>;

  /** SemVer 最大のバージョンを取得。無→null。 */
  findLatest(scope: TenantScope, internalId: ToolId): Promise<Tool | null>;

  /** 全バージョンを昇順で返す（無→空配列）。 */
  listVersions(scope: TenantScope, internalId: ToolId): Promise<SemVer[]>;

  /** テナント内の各 internalId の最新サマリを返す。 */
  list(scope: TenantScope): Promise<ToolSummary[]>;
}
