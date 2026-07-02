/**
 * Composition Root（v3 実装契約 §3 / ADR-0005）
 *
 * プロファイルに応じてアダプタ実装を選択し、ユースケース群を配線して App を返す。
 * composition だけが adapters 実装を import してよい（depcruise ルール）。
 *
 * - profile 'local' → SqliteToolRepository（dbPath 既定 ':memory:'）
 * - profile 'test'  → InMemoryToolRepository
 * - 既定値は env AGENTCONTEXT_PROFILE / AGENTCONTEXT_DB_PATH。options が env より優先。
 * - 不正な profile 値 → ToolValidationError（メッセージに値を含める）。
 */
import { InMemoryToolRepository } from '../adapters/storage/in-memory-tool-repository';
import { SqliteToolRepository } from '../adapters/storage/sqlite-tool-repository';
import { EtlEngine } from '../application/etl/engine';
import { PreviewToolUseCase } from '../application/tool/preview-tool';
import { GetToolUseCase, ListToolVersionsUseCase } from '../application/tool/query-tool';
import { SaveToolUseCase } from '../application/tool/save-tool';
import { createDefaultRegistry } from '../domain/etl/nodes/index';
import { ToolValidationError } from '../domain/tool/errors';
import type { ToolRepository } from '../domain/tool/tool-repository';

/** 実行プロファイル。 */
export type Profile = 'local' | 'test';

/** createApp のオプション。 */
export interface AppOptions {
  /** 既定: env AGENTCONTEXT_PROFILE（'local'|'test'）→ 無ければ 'local'。 */
  readonly profile?: Profile;
  /** local のみ有効。既定: env AGENTCONTEXT_DB_PATH → 無ければ ':memory:'。 */
  readonly dbPath?: string;
}

/** 配線済みアプリケーション。 */
export interface App {
  readonly profile: Profile;
  readonly repo: ToolRepository;
  readonly engine: EtlEngine;
  readonly saveTool: SaveToolUseCase;
  readonly getTool: GetToolUseCase;
  readonly listToolVersions: ListToolVersionsUseCase;
  readonly previewTool: PreviewToolUseCase;
  /** SqliteToolRepository の close を委譲する（InMemory は no-op）。 */
  close(): void;
}

/** options → env → 既定 'local' の順で profile を決定・検証する。 */
function resolveProfile(optionProfile: Profile | undefined): Profile {
  const raw = optionProfile ?? process.env['AGENTCONTEXT_PROFILE'] ?? 'local';
  if (raw !== 'local' && raw !== 'test') {
    throw new ToolValidationError(
      `createApp: invalid profile: "${raw}" (expected 'local' or 'test')`,
    );
  }
  return raw;
}

/** プロファイルに応じてリポジトリを構築し、close を確定する。 */
function createRepository(
  profile: Profile,
  dbPath: string | undefined,
): { repo: ToolRepository; close: () => void } {
  if (profile === 'local') {
    const path = dbPath ?? process.env['AGENTCONTEXT_DB_PATH'] ?? ':memory:';
    const sqlite = new SqliteToolRepository(path);
    return { repo: sqlite, close: () => sqlite.close() };
  }
  return { repo: new InMemoryToolRepository(), close: () => {} };
}

/** プロファイルに従いアダプタとユースケースを配線した App を生成する。 */
export function createApp(options?: AppOptions): App {
  const profile = resolveProfile(options?.profile);
  const { repo, close } = createRepository(profile, options?.dbPath);

  const engine = new EtlEngine(createDefaultRegistry());

  return {
    profile,
    repo,
    engine,
    saveTool: new SaveToolUseCase(repo, engine),
    getTool: new GetToolUseCase(repo),
    listToolVersions: new ListToolVersionsUseCase(repo),
    previewTool: new PreviewToolUseCase(repo, engine),
    close,
  };
}
