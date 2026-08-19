/**
 * application層: 単一Agent実行のランタイムハーネス（Agent単位のopt-in）
 *
 * `RunAgentPreviewUseCase.perform()` のループへ最小のフックだけを差し込み、実体はここに置く。
 * 提供する組み込みツールは workspace_* と同じ「ETLツールではないランタイム組み込みツール」であり、
 * ETL Toolエンティティの side-effect ガードの対象外（副作用はWiki/Session Artifactに限定される）。
 *
 * - todoProvider : todos_add / todos_complete（Run内メモリ + セッションArtifact `harness-todos`）
 * - fileMemory   : memory_list / memory_read / memory_write（専用Wiki `agent-memory--<agentId>`）
 * - webSearch    : web_search（WebSearchUseCase の fetch→resolve を使う）
 * - compaction   : モデル往復前の文脈圧縮（純関数 compactModelMessages）
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntimeHarness } from '../../domain/agent/agent';
import type { AgentId } from '../../domain/agent/ids';
import type { WikiSpaceId } from '../../domain/memory/ids';
import { createWikiPage, reviseWikiPage } from '../../domain/memory/wiki-page';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { createWikiSpace } from '../../domain/memory/wiki-space';
import type { AgentSession } from '../../domain/session/agent-session';
import { SessionQuotaExceededError } from '../../domain/session/errors';
import { createSessionArtifact } from '../../domain/session/session-artifact';
import type { SessionArtifactRepository } from '../../domain/session/session-repository';
import type { RunId } from '../../domain/run/ids';
import type { TenantScope } from '../../domain/tool/ids';
import type { ModelRequestMessage, ModelToolCall, ModelToolDefinition } from '../model/model-provider';
import type { WebSearchUseCase } from '../search/web-search';
import { AgentRunError } from './errors';

/** ハーネス明示設定Agentのノード内絶対上限（既定の MAX_MODEL_ROUNDS=5 を拡張）。 */
export const HARNESS_MAX_MODEL_ROUNDS = 8;
/** ハーネス明示設定Agentのノード内絶対上限（既定の MAX_TOOL_CALLS=4 を拡張）。 */
export const HARNESS_MAX_TOOL_CALLS = 12;
/** compaction を発火させるメッセージ合計文字数。 */
export const HARNESS_COMPACTION_BUDGET_CHARS = 24_000;
/** TODOリストを保存するセッションArtifactの名前。 */
export const HARNESS_TODOS_ARTIFACT_NAME = 'harness-todos';
/** TODO永続化Artifactの origin.toolId（ETL Toolではない組み込み由来を示す）。 */
export const HARNESS_TODOS_TOOL_ID = 'builtin-harness-todos';
export const HARNESS_TODOS_TOOL_VERSION = '1.0.0';

const TODO_MAX_ITEMS_PER_CALL = 10;
const TODO_MAX_CONTENT_CHARS = 500;
const MEMORY_MAX_TITLE_CHARS = 200;
const MEMORY_MAX_BODY_CHARS = 8_000;
const MEMORY_LIST_LIMIT = 50;
/** memory_read が返す本文の上限。write上限(8000)より小さく取り、文脈を食い潰さない。 */
const MEMORY_READ_BODY_CHARS = 4_000;
const WEB_SEARCH_MAX_RESULTS = 5;
const WEB_SEARCH_SNIPPET_CHARS = 300;
const COMPACTED_TOOL_CONTENT_CHARS = 240;
const COMPACTED_SUFFIX = '… [compacted]';
/** 圧縮対象から外す、直近の tool ロールメッセージ件数。 */
const PRESERVED_RECENT_TOOL_MESSAGES = 2;

export type HarnessTodoStatus = 'pending' | 'completed';
export interface HarnessTodo {
  readonly index: number;
  readonly content: string;
  readonly status: HarnessTodoStatus;
}

/** 専用のFile memory Wiki空間ID。Agent internalId ごとに1つ。 */
export function agentMemoryWikiId(agentInternalId: AgentId): WikiSpaceId {
  return `agent-memory--${agentInternalId}`;
}

// ---------------------------------------------------------------------------
// compaction（純関数）
// ---------------------------------------------------------------------------

export interface CompactionResult {
  readonly messages: readonly ModelRequestMessage[];
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly compacted: boolean;
  /** 削除後に残っている履歴メッセージ件数（次回の圧縮呼び出しへ渡す）。 */
  readonly remainingHistoryCount: number;
}

function contentChars(content: ModelRequestMessage['content']): number {
  if (content === null) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : part.imageUrl.length), 0);
}

/** メッセージ列の合計文字数。compaction の予算判定に使う。 */
export function totalMessageChars(messages: readonly ModelRequestMessage[]): number {
  return messages.reduce((total, message) => total + contentChars(message.content), 0);
}

function truncatedToolMessage(message: ModelRequestMessage): ModelRequestMessage {
  const content = message.content;
  if (typeof content !== 'string' || content.length <= COMPACTED_TOOL_CONTENT_CHARS) return message;
  return { ...message, content: `${content.slice(0, COMPACTED_TOOL_CONTENT_CHARS)}${COMPACTED_SUFFIX}` };
}

/**
 * 予算超過時だけ文脈を圧縮する純関数。
 *
 * 1. 直近 `PRESERVED_RECENT_TOOL_MESSAGES` 件を除く tool ロールの content を切り詰める。
 * 2. それでも超過なら、system直後に注入された履歴メッセージを古い順にペアで削除する。
 *
 * 入力は変更せず、圧縮が起きなければ `compacted:false` と同内容のコピーを返す。
 */
export function compactModelMessages(
  messages: readonly ModelRequestMessage[],
  options: { readonly budgetChars: number; readonly historyCount: number },
): CompactionResult {
  const beforeChars = totalMessageChars(messages);
  const historyCount = Math.max(0, Math.min(options.historyCount, Math.max(0, messages.length - 1)));
  if (beforeChars <= options.budgetChars) {
    return { messages: [...messages], beforeChars, afterChars: beforeChars, compacted: false, remainingHistoryCount: historyCount };
  }

  const toolIndexes = messages.flatMap((message, index) => (message.role === 'tool' ? [index] : []));
  const truncatable = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - PRESERVED_RECENT_TOOL_MESSAGES)));
  let next: ModelRequestMessage[] = messages.map((message, index) => (truncatable.has(index) ? truncatedToolMessage(message) : message));

  let remainingHistoryCount = historyCount;
  let afterChars = totalMessageChars(next);
  while (afterChars > options.budgetChars && remainingHistoryCount > 0) {
    const removed = Math.min(2, remainingHistoryCount);
    next = [...next.slice(0, 1), ...next.slice(1 + removed)];
    remainingHistoryCount -= removed;
    afterChars = totalMessageChars(next);
  }
  return { messages: next, beforeChars, afterChars, compacted: afterChars < beforeChars, remainingHistoryCount };
}

// ---------------------------------------------------------------------------
// ランタイムツール
// ---------------------------------------------------------------------------

export interface HarnessToolResult {
  readonly content: string;
  readonly preview: readonly Readonly<Record<string, unknown>>[];
}

export interface AgentRuntimeHarnessOptions {
  readonly harness: AgentRuntimeHarness;
  readonly scope: TenantScope;
  readonly runId: RunId;
  /** File memory の専用Wiki空間IDを決めるAgent internalId。未保存プレビューでは未指定。 */
  readonly agentId?: AgentId;
  readonly session?: AgentSession;
  readonly artifacts?: SessionArtifactRepository;
  readonly wiki?: WikiRepository;
  readonly webSearch?: WebSearchUseCase;
  readonly now?: () => Date;
  readonly makeId?: () => string;
}

/** 1 Run（1ノード実行）ぶんのハーネス状態と組み込みツール。 */
export class AgentRuntimeHarnessRuntime {
  private todos: HarnessTodo[] = [];
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private cachedDefinitions?: readonly ModelToolDefinition[];

  constructor(private readonly options: AgentRuntimeHarnessOptions) {
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? randomUUID;
  }

  /** Run開始時の復元（セッションがあればTODOを最新revisionから読み戻す）。 */
  async prepare(): Promise<void> {
    const { session, artifacts } = this.options;
    if (!this.options.harness.todoProvider || session === undefined || artifacts === undefined) return;
    const named = (await artifacts.list(session.scope, session.id)).filter((artifact) => artifact.name === HARNESS_TODOS_ARTIFACT_NAME);
    const latest = named.reduce<{ readonly id: string; readonly revision: number } | undefined>(
      (best, artifact) => (best === undefined || artifact.revision > best.revision ? artifact : best), undefined);
    if (latest === undefined) return;
    const stored = await artifacts.find(session.scope, session.id, latest.id);
    this.todos = parseTodos(stored?.payload);
  }

  /** このRunで注入する組み込みツール定義。設定・依存が揃わないものは注入しない。 */
  definitions(): readonly ModelToolDefinition[] {
    if (this.cachedDefinitions !== undefined) return this.cachedDefinitions;
    const { harness, wiki, webSearch, agentId } = this.options;
    const definitions: ModelToolDefinition[] = [];
    if (harness.todoProvider) definitions.push(...todoDefinitions());
    if (harness.fileMemory && wiki !== undefined && agentId !== undefined) definitions.push(...memoryDefinitions());
    if (harness.webSearch && webSearch !== undefined && webSearch.listProviders().length > 0) definitions.push(webSearchDefinition());
    this.cachedDefinitions = definitions;
    return definitions;
  }

  isHarnessTool(name: string): boolean {
    return this.definitions().some((definition) => definition.name === name);
  }

  async execute(call: ModelToolCall): Promise<HarnessToolResult> {
    switch (call.name) {
      case 'todos_add': return this.executeTodosAdd(call);
      case 'todos_complete': return this.executeTodosComplete(call);
      case 'memory_list': return this.executeMemoryList();
      case 'memory_read': return this.executeMemoryRead(call);
      case 'memory_write': return this.executeMemoryWrite(call);
      case 'web_search': return this.executeWebSearch(call);
      default: throw new AgentRunError(`unknown runtime harness tool: ${call.name}`);
    }
  }

  /** テストと復元検証のための現在のTODOスナップショット。 */
  snapshotTodos(): readonly HarnessTodo[] { return this.todos.map((todo) => ({ ...todo })); }

  // --- todo provider -------------------------------------------------------

  private async executeTodosAdd(call: ModelToolCall): Promise<HarnessToolResult> {
    const items = call.arguments['items'];
    if (!Array.isArray(items) || items.length === 0 || items.length > TODO_MAX_ITEMS_PER_CALL) {
      throw new AgentRunError(`todos_add requires 1..${TODO_MAX_ITEMS_PER_CALL} items`);
    }
    const contents = items.map((item) => {
      const content = typeof item === 'string' ? item.trim() : '';
      if (content === '' || content.length > TODO_MAX_CONTENT_CHARS) {
        throw new AgentRunError(`todos_add items must be strings of 1..${TODO_MAX_CONTENT_CHARS} characters`);
      }
      return content;
    });
    for (const content of contents) this.todos.push({ index: this.todos.length + 1, content, status: 'pending' });
    await this.persistTodos(call.id);
    return this.todoResult();
  }

  private async executeTodosComplete(call: ModelToolCall): Promise<HarnessToolResult> {
    const indexes = call.arguments['indexes'];
    if (!Array.isArray(indexes) || indexes.length === 0) throw new AgentRunError('todos_complete requires a non-empty indexes array');
    const ignored: number[] = [];
    for (const value of indexes) {
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new AgentRunError('todos_complete indexes must be 1-based integers');
      const todo = this.todos[value - 1];
      if (todo === undefined) { ignored.push(value); continue; }
      this.todos[value - 1] = { ...todo, status: 'completed' };
    }
    await this.persistTodos(call.id);
    return this.todoResult(ignored);
  }

  private todoResult(ignored: readonly number[] = []): HarnessToolResult {
    const todos = this.snapshotTodos();
    return {
      content: JSON.stringify({ todos, ...(ignored.length === 0 ? {} : { ignored }) }),
      preview: todos.slice(0, 10).map((todo) => ({ index: todo.index, status: todo.status })),
    };
  }

  /** TODOの変更を新revisionのセッションArtifactへ保存する（セッションが無ければRun内メモリのみ）。 */
  private async persistTodos(toolCallId: string): Promise<void> {
    const { session, artifacts } = this.options;
    if (session === undefined || artifacts === undefined) return;
    const payload = { todos: this.snapshotTodos() };
    const encoded = JSON.stringify(payload);
    const sizeBytes = new TextEncoder().encode(encoded).byteLength;
    if (sizeBytes > session.quota.maxArtifactBytes) throw new SessionQuotaExceededError(`artifact exceeds maxArtifactBytes (${sizeBytes} > ${session.quota.maxArtifactBytes})`);
    const usage = await artifacts.usage(session.scope, session.id);
    if (usage.count >= session.quota.maxArtifacts || usage.bytes + sizeBytes > session.quota.maxBytes) throw new SessionQuotaExceededError('session artifact quota exceeded');

    const idempotencyKey = `${this.options.runId}:${toolCallId}:${HARNESS_TODOS_ARTIFACT_NAME}`;
    if (await artifacts.findByIdempotencyKey(session.scope, session.id, idempotencyKey) !== null) return;
    const named = (await artifacts.list(session.scope, session.id)).filter((artifact) => artifact.name === HARNESS_TODOS_ARTIFACT_NAME);
    const revision = named.length === 0 ? 1 : Math.max(...named.map((artifact) => artifact.revision)) + 1;
    const artifact = createSessionArtifact({
      id: this.makeId(), scope: session.scope, sessionId: session.id,
      name: HARNESS_TODOS_ARTIFACT_NAME, kind: 'json', revision,
      contentType: 'application/json', sizeBytes,
      checksum: createHash('sha256').update(encoded).digest('hex'),
      counts: { rows: this.todos.length },
      origin: {
        runId: this.options.runId, toolId: HARNESS_TODOS_TOOL_ID, toolVersion: HARNESS_TODOS_TOOL_VERSION,
        toolCallId, sinkNodeId: HARNESS_TODOS_ARTIFACT_NAME,
        ...(this.options.agentId === undefined ? {} : { agentId: this.options.agentId }),
      },
      createdAt: this.now().toISOString(), expiresAt: session.expiresAt,
    });
    await artifacts.save(artifact, payload, idempotencyKey);
  }

  // --- file memory ---------------------------------------------------------

  private get memoryWikiId(): WikiSpaceId { return agentMemoryWikiId(this.options.agentId as string); }

  private async executeMemoryList(): Promise<HarnessToolResult> {
    const wiki = this.options.wiki as WikiRepository;
    const pages = (await wiki.list(this.options.scope, this.memoryWikiId))
      .slice(0, MEMORY_LIST_LIMIT)
      .map((page) => ({ title: page.title, updatedAt: page.updatedAt }));
    return { content: JSON.stringify({ wikiId: this.memoryWikiId, pages }), preview: pages.slice(0, 10) };
  }

  private async executeMemoryRead(call: ModelToolCall): Promise<HarnessToolResult> {
    const wiki = this.options.wiki as WikiRepository;
    const title = requireText(call.arguments['title'], 'memory_read', 'title', MEMORY_MAX_TITLE_CHARS);
    const summary = await this.findMemoryPage(title);
    if (summary === undefined) {
      return { content: JSON.stringify({ found: false, title }), preview: [{ title, found: false }] };
    }
    const page = await wiki.find(this.options.scope, summary.id);
    if (page === null) return { content: JSON.stringify({ found: false, title }), preview: [{ title, found: false }] };
    const truncated = page.body.length > MEMORY_READ_BODY_CHARS;
    return {
      content: JSON.stringify({ found: true, title: page.title, version: page.version, updatedAt: page.updatedAt, truncated, body: truncated ? `${page.body.slice(0, MEMORY_READ_BODY_CHARS)}…` : page.body }),
      preview: [{ title: page.title, version: page.version }],
    };
  }

  private async executeMemoryWrite(call: ModelToolCall): Promise<HarnessToolResult> {
    const wiki = this.options.wiki as WikiRepository;
    const scope = this.options.scope;
    const title = requireText(call.arguments['title'], 'memory_write', 'title', MEMORY_MAX_TITLE_CHARS);
    const body = requireText(call.arguments['body'], 'memory_write', 'body', MEMORY_MAX_BODY_CHARS);
    const updatedAt = this.now().toISOString();
    // 専用Wiki空間は初回書き込み時に冪等へ自動作成する（UIからの事前作成を要求しない）。
    if (await wiki.findSpace(scope, this.memoryWikiId) === null) {
      await wiki.saveSpace(createWikiSpace({
        id: this.memoryWikiId, tenant: scope,
        name: `Agent memory: ${this.options.agentId as string}`,
        description: 'Auto-created runtime harness file memory.',
        createdAt: updatedAt,
      }));
    }
    const summary = await this.findMemoryPage(title);
    const existing = summary === undefined ? null : await wiki.find(scope, summary.id);
    const page = existing === null
      ? createWikiPage({ id: this.makeId(), tenant: scope, wikiId: this.memoryWikiId, title, body, sourceRuns: [this.options.runId], updatedAt })
      : reviseWikiPage(existing, { title, body, addSourceRun: this.options.runId, updatedAt });
    await wiki.save(page);
    const result = { wikiId: this.memoryWikiId, title: page.title, version: page.version, created: existing === null };
    return { content: JSON.stringify(result), preview: [result] };
  }

  private async findMemoryPage(title: string): Promise<{ readonly id: string; readonly title: string } | undefined> {
    const wiki = this.options.wiki as WikiRepository;
    const pages = await wiki.list(this.options.scope, this.memoryWikiId);
    return pages.find((page) => page.title === title) ?? pages.find((page) => page.title.toLowerCase() === title.toLowerCase());
  }

  // --- web search ----------------------------------------------------------

  private async executeWebSearch(call: ModelToolCall): Promise<HarnessToolResult> {
    const search = this.options.webSearch as WebSearchUseCase;
    const provider = search.listProviders()[0];
    if (provider === undefined) throw new AgentRunError('web_search has no configured search provider');
    const query = requireText(call.arguments['query'], 'web_search', 'query', 2_000);
    const requested = call.arguments['maxResults'];
    const maxResults = typeof requested === 'number' && Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), WEB_SEARCH_MAX_RESULTS)
      : WEB_SEARCH_MAX_RESULTS;
    const cached = await search.fetch(this.options.scope, { provider: provider.id, query, maxResults });
    const rows = search.resolve(this.options.scope, {
      cacheKey: cached.cacheKey, provider: cached.provider, query: cached.query,
      maxResults: cached.maxResults, includeDomains: cached.includeDomains,
    });
    const results = rows.slice(0, maxResults).map((row) => ({
      title: cellText(row['title']),
      url: cellText(row['url']),
      snippet: clip(cellText(row['snippet']), WEB_SEARCH_SNIPPET_CHARS),
    }));
    return { content: JSON.stringify({ provider: cached.provider, query: cached.query, results }), preview: results };
  }
}

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function requireText(value: unknown, tool: string, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > max) throw new AgentRunError(`${tool} requires ${field} of 1..${max} characters`);
  return text;
}

function cellText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function parseTodos(payload: unknown): HarnessTodo[] {
  const items = (payload as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(items)) return [];
  const todos: HarnessTodo[] = [];
  for (const item of items) {
    const candidate = item as { content?: unknown; status?: unknown };
    if (typeof candidate?.content !== 'string' || candidate.content === '') continue;
    todos.push({ index: todos.length + 1, content: candidate.content, status: candidate.status === 'completed' ? 'completed' : 'pending' });
  }
  return todos;
}

function todoDefinitions(): readonly ModelToolDefinition[] {
  return [
    {
      name: 'todos_add',
      description: 'Append TODO items to the task list for this run. Returns the complete, updated TODO list.',
      parameters: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' }, description: `TODO items to append (1-${TODO_MAX_ITEMS_PER_CALL}, each 1-${TODO_MAX_CONTENT_CHARS} characters).` } },
        required: ['items'],
        additionalProperties: false,
      },
    },
    {
      name: 'todos_complete',
      description: 'Mark TODO items as completed by their 1-based index. Returns the complete, updated TODO list.',
      parameters: {
        type: 'object',
        properties: { indexes: { type: 'array', items: { type: 'integer' }, description: '1-based indexes of the TODO items to complete.' } },
        required: ['indexes'],
        additionalProperties: false,
      },
    },
  ];
}

function memoryDefinitions(): readonly ModelToolDefinition[] {
  return [
    {
      name: 'memory_list',
      description: 'List the titles of notes stored in this Agent\'s persistent memory.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'memory_read',
      description: 'Read one persistent memory note by its exact title.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Title of the note, as returned by memory_list.' } },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_write',
      description: 'Create or replace a persistent memory note. Reuse an existing title to revise that note.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: `Note title (1-${MEMORY_MAX_TITLE_CHARS} characters).` },
          body: { type: 'string', description: `Note body (1-${MEMORY_MAX_BODY_CHARS} characters).` },
        },
        required: ['title', 'body'],
        additionalProperties: false,
      },
    },
  ];
}

function webSearchDefinition(): ModelToolDefinition {
  return {
    name: 'web_search',
    description: 'Search the public web and return the most relevant results as title, url and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        maxResults: { type: 'integer', minimum: 1, maximum: WEB_SEARCH_MAX_RESULTS, description: `Maximum results to return (1-${WEB_SEARCH_MAX_RESULTS}, default ${WEB_SEARCH_MAX_RESULTS}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}
