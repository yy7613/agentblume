/** 未保存 Tool draft の検査・プレビュー HTTP routes。 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { JudgeReadiness } from '../application/evaluation/judge-readiness';
import type { DiagnoseToolUseCase } from '../application/tool/diagnose-tool';
import type { DraftToolUseCase } from '../application/tool/draft-tool';
import type { ResolveAiJudgmentsUseCase } from '../application/tool/resolve-ai-judgments';
import type { SuggestAnalysisConfigUseCase } from '../application/tool/suggest-analysis-config';
import type { SuggestCalculateExpressionUseCase } from '../application/tool/suggest-calculate-expression';
import type { SuggestToolCheckCasesUseCase } from '../application/tool-check/suggest-tool-check-cases';
import { SemVer } from '../domain/tool/semver';
import { createTool } from '../domain/tool/tool';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { analysisSuggestionBodySchema, calculateSuggestionBodySchema, draftInspectBodySchema, draftPreviewBodySchema, saveToolBodySchema } from './schemas';
import { previewResponse } from './tool-routes';
import { journalRuntimeCapabilities, type JournalRuntimeCapabilityDeps } from './journal-routes';
import { expenseRuntimeCapabilities, type ExpenseRuntimeCapabilityDeps } from './expense-routes';
import { receivablesRuntimeCapabilities, type ReceivablesRuntimeCapabilityDeps } from './receivables-routes';
import { contractRuntimeCapabilities, type ContractRuntimeCapabilityDeps } from './contract-routes';

/** 業務の機能フラグ（`/runtime/capabilities` へ業務ごとのキーを足す。ADR-0039）に要る依存。 */
export interface BusinessRuntimeCapabilityDeps extends JournalRuntimeCapabilityDeps, ExpenseRuntimeCapabilityDeps, ReceivablesRuntimeCapabilityDeps, ContractRuntimeCapabilityDeps {}

export interface DraftToolRouteDeps extends BusinessRuntimeCapabilityDeps {
  readonly draftTool: DraftToolUseCase;
  readonly suggestAnalysisConfig: SuggestAnalysisConfigUseCase;
  readonly suggestCalculateExpression: SuggestCalculateExpressionUseCase;
  readonly suggestToolCheckCases: SuggestToolCheckCasesUseCase;
  readonly diagnoseTool: DiagnoseToolUseCase;
  /** `ai-judge` ノードを実際に回せるか（main スロット + 構造化出力）。UI がノードを出すかの機能フラグ。 */
  readonly resolveAiJudgments: ResolveAiJudgmentsUseCase;
  /** judge スロットの設定状態（実験画面が「judge 未設定」を起票前に示すため）。毎回現在の設定を見る。 */
  readonly judgeReadiness: () => Promise<JudgeReadiness>;
}

/** 未保存 draft を表す版。採番は保存時に決まるので、診断結果にはこの値が「未保存」の印として載る。 */
const DRAFT_TOOL_VERSION = SemVer.of(0, 0, 0);

function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new BadRequestError(`invalid body: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

export function registerDraftToolRoutes(app: FastifyInstance, deps: DraftToolRouteDeps): void {
  app.post('/tool-drafts/infer-schema', async (request) => {
    const body = parseWith(draftInspectBodySchema, request.body);
    return { propagation: await deps.draftTool.inspect(body.graph, scopeOf(request)) };
  });

  // 全行で計算し、返す行数だけ rowLimit で絞る（各ノードの rowCount は全行数）。
  app.post('/tool-drafts/preview', async (request) => {
    const body = parseWith(draftPreviewBodySchema, request.body);
    const result = await deps.draftTool.preview(
      body.graph,
      body.rowLimit === undefined ? undefined : { rowLimit: body.rowLimit },
      scopeOf(request),
    );
    return { result: previewResponse(result) };
  });
  // 未保存 Tool のプリフライト診断。POST /tools と同じ body を受け、保存と同じ createTool 検証を
  // 通した Tool を検査する（保存も採番もしない）。
  app.post('/tool-drafts/diagnose', async (request) => {
    const body = parseWith(saveToolBodySchema, request.body);
    const scope = scopeOf(request);
    const tool = createTool({
      metadata: {
        internalId: body.internalId, workingName: body.workingName, displayName: body.displayName,
        publishName: body.publishName, version: DRAFT_TOOL_VERSION, owner: body.owner,
        state: body.state ?? 'draft', tenant: scope,
      },
      sideEffect: body.sideEffect,
      graph: body.graph,
      ...(body.inputSchema !== undefined ? { inputSchema: body.inputSchema } : {}),
      ...(body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {}),
      ...(body.agentTool !== undefined ? { agentTool: body.agentTool } : {}),
    });
    return { diagnostics: await deps.diagnoseTool.execute(scope, tool) };
  });
  // UI が「AI 補助」のボタンを出すかどうかを決めるための機能フラグ。いずれも現在のモデル設定を毎回見る。
  // judge は「設定済みか」に加えて provider / model を返し、実験画面が起票前に judge 未設定を示せるようにする。
  app.get('/runtime/capabilities', async () => ({
    analysisAssistant: { enabled: await deps.suggestAnalysisConfig.available() },
    calculateAssistant: { enabled: await deps.suggestCalculateExpression.available() },
    toolCheckSuggestions: { enabled: await deps.suggestToolCheckCases.available() },
    // AI 判定ノード。判定はモデルを要するので、使えないときは UI が設定ダイアログで先に警告する（実行して初めて失敗させない）。
    aiJudge: { enabled: await deps.resolveAiJudgments.available() },
    judge: await deps.judgeReadiness(),
    // 業務ごとのキー（仕訳は `journal`）。業務は自分のキーだけを返し、ほかのキーを上書きしない。
    ...(await journalRuntimeCapabilities(deps)),
    ...(await expenseRuntimeCapabilities(deps)),
    ...(await receivablesRuntimeCapabilities(deps)),
    ...(await contractRuntimeCapabilities(deps)),
  }));
  app.post('/tool-drafts/suggest-analysis-config', async (request) => {
    const body = parseWith(analysisSuggestionBodySchema, request.body);
    return { proposal: await deps.suggestAnalysisConfig.execute({ graph: body.graph, nodeId: body.nodeId, intent: body.intent }) };
  });
  // 式の提案。検分（判定 → 修復 1 回 → プレビュー）まで済ませた提案だけを返す。適用は UI の明示操作。
  app.post('/tool-drafts/suggest-calculate-expression', async (request) => {
    const body = parseWith(calculateSuggestionBodySchema, request.body);
    return { proposal: await deps.suggestCalculateExpression.execute({ graph: body.graph, nodeId: body.nodeId, intent: body.intent }) };
  });
}