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
import { InMemoryRunRepository } from '../adapters/storage/in-memory-run-repository';
import { SqliteRunRepository } from '../adapters/storage/sqlite-run-repository';
import { LmStudioModelProvider } from '../adapters/model/lm-studio-model-provider';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { RunAgentPreviewUseCase } from '../application/agent/run-agent-preview';
import { QueryRunsUseCase } from '../application/agent/query-runs';
import { EtlEngine } from '../application/etl/engine';
import type { ModelProviderPort } from '../application/model/model-provider';
import { DraftToolUseCase } from '../application/tool/draft-tool';
import { PreviewToolUseCase } from '../application/tool/preview-tool';
import { GetToolUseCase, ListToolVersionsUseCase, ListToolsUseCase } from '../application/tool/query-tool';
import { SaveToolUseCase } from '../application/tool/save-tool';
import { createDefaultRegistry } from '../domain/etl/nodes/index';
import { ToolValidationError } from '../domain/tool/errors';
import type { ToolRepository } from '../domain/tool/tool-repository';
import type { RunRepository } from '../domain/run/run-repository';
import { InMemoryAgentRepository } from '../adapters/storage/in-memory-agent-repository';
import { SqliteAgentRepository } from '../adapters/storage/sqlite-agent-repository';
import { GenerateAgentPromptUseCase } from '../application/agent/generate-agent-prompt';
import { QueryAgentsUseCase } from '../application/agent/query-agents';
import { SaveAgentUseCase } from '../application/agent/save-agent';
import type { AgentRepository } from '../domain/agent/agent-repository';
import { InMemorySkillRepository } from '../adapters/storage/in-memory-skill-repository';
import { SqliteSkillRepository } from '../adapters/storage/sqlite-skill-repository';
import { GenerateSkillPromptUseCase } from '../application/skill/generate-skill-prompt';
import { QuerySkillsUseCase } from '../application/skill/query-skills';
import { SaveSkillUseCase } from '../application/skill/save-skill';
import type { SkillRepository } from '../domain/skill/skill-repository';

/** 実行プロファイル。 */
export type Profile = 'local' | 'test';

/** createApp のオプション。 */
export interface AppOptions {
  /** 既定: env AGENTCONTEXT_PROFILE（'local'|'test'）→ 無ければ 'local'。 */
  readonly profile?: Profile;
  /** local のみ有効。既定: env AGENTCONTEXT_DB_PATH → 無ければ ':memory:'。 */
  readonly dbPath?: string;
  /** テスト・埋め込み用の明示provider。省略時はprofileに従う。 */
  readonly modelProvider?: ModelProviderPort;
  readonly runRepository?: RunRepository;
  readonly agentRepository?: AgentRepository;
  readonly skillRepository?: SkillRepository;
}

/** 配線済みアプリケーション。 */
export interface App {
  readonly profile: Profile;
  readonly repo: ToolRepository;
  readonly engine: EtlEngine;
  readonly modelProvider: ModelProviderPort;
  readonly runRepo: RunRepository;
  readonly agentRepo: AgentRepository;
  readonly skillRepo: SkillRepository;
  readonly runAgentPreview: RunAgentPreviewUseCase;
  readonly queryRuns: QueryRunsUseCase;
  readonly saveAgent: SaveAgentUseCase;
  readonly queryAgents: QueryAgentsUseCase;
  readonly generateAgentPrompt: GenerateAgentPromptUseCase;
  readonly saveSkill: SaveSkillUseCase;
  readonly querySkills: QuerySkillsUseCase;
  readonly generateSkillPrompt: GenerateSkillPromptUseCase;
  readonly draftTool: DraftToolUseCase;
  readonly saveTool: SaveToolUseCase;
  readonly getTool: GetToolUseCase;
  readonly listToolVersions: ListToolVersionsUseCase;
  readonly listTools: ListToolsUseCase;
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
): { repo: ToolRepository; close: () => void; path?: string } {
  if (profile === 'local') {
    const path = dbPath ?? process.env['AGENTCONTEXT_DB_PATH'] ?? ':memory:';
    const sqlite = new SqliteToolRepository(path);
    return { repo: sqlite, close: () => sqlite.close(), path };
  }
  return { repo: new InMemoryToolRepository(), close: () => {} };
}

function resolveModelTimeoutMs(): number {
  const raw = process.env['LM_STUDIO_TIMEOUT_MS'];
  if (raw === undefined) return 120_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolValidationError(`createApp: invalid LM_STUDIO_TIMEOUT_MS: "${raw}"`);
  }
  return value;
}

/** プロファイルに従いアダプタとユースケースを配線した App を生成する。 */
export function createApp(options?: AppOptions): App {
  const profile = resolveProfile(options?.profile);
  const { repo, close: closeTools, path } = createRepository(profile, options?.dbPath);
  const runAdapter = options?.runRepository !== undefined
    ? { repo: options.runRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteRunRepository(path ?? ':memory:'); return { repo: sqlite as RunRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryRunRepository() as RunRepository, close: () => {} };
  const agentAdapter = options?.agentRepository !== undefined
    ? { repo: options.agentRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteAgentRepository(path ?? ':memory:'); return { repo: sqlite as AgentRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemoryAgentRepository() as AgentRepository, close: () => {} };
  const skillAdapter = options?.skillRepository !== undefined
    ? { repo: options.skillRepository, close: () => {} }
    : profile === 'local'
      ? (() => { const sqlite = new SqliteSkillRepository(path ?? ':memory:'); return { repo: sqlite as SkillRepository, close: () => sqlite.close() }; })()
      : { repo: new InMemorySkillRepository() as SkillRepository, close: () => {} };

  const engine = new EtlEngine(createDefaultRegistry());
  const modelProvider = options?.modelProvider ?? (profile === 'test'
    ? new ScriptedModelProvider()
    : new LmStudioModelProvider({
        baseUrl: process.env['LM_STUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1',
        model: process.env['LM_STUDIO_MODEL'] ?? '',
        timeoutMs: resolveModelTimeoutMs(),
        ...(process.env['LM_STUDIO_API_KEY'] !== undefined ? { apiKey: process.env['LM_STUDIO_API_KEY'] } : {}),
      }));

  return {
    profile,
    repo,
    engine,
    modelProvider,
    runRepo: runAdapter.repo,
    agentRepo: agentAdapter.repo,
    skillRepo: skillAdapter.repo,
    runAgentPreview: new RunAgentPreviewUseCase(repo, engine, modelProvider, runAdapter.repo, undefined, undefined, agentAdapter.repo, skillAdapter.repo),
    queryRuns: new QueryRunsUseCase(runAdapter.repo),
    saveAgent: new SaveAgentUseCase(agentAdapter.repo, repo, skillAdapter.repo),
    queryAgents: new QueryAgentsUseCase(agentAdapter.repo),
    generateAgentPrompt: new GenerateAgentPromptUseCase(repo, skillAdapter.repo),
    saveSkill: new SaveSkillUseCase(skillAdapter.repo, repo),
    querySkills: new QuerySkillsUseCase(skillAdapter.repo),
    generateSkillPrompt: new GenerateSkillPromptUseCase(repo),
    draftTool: new DraftToolUseCase(engine),
    saveTool: new SaveToolUseCase(repo, engine),
    getTool: new GetToolUseCase(repo),
    listToolVersions: new ListToolVersionsUseCase(repo),
    listTools: new ListToolsUseCase(repo),
    previewTool: new PreviewToolUseCase(repo, engine),
    close: () => {
      try { closeTools(); }
      finally {
        try { runAdapter.close(); }
        finally {
          try { agentAdapter.close(); }
          finally { skillAdapter.close(); }
        }
      }
    },
  };
}
