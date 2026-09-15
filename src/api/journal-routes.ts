/**
 * api層: 仕訳（journal）のルート（docs/20-journal.md §9 / docs/04-api-spec.md §3.4）。
 *
 * | ルート | 応答 |
 * |---|---|
 * | GET /journal/chart | 200 { chart } — 未保存なら標準セット（保存はしない） |
 * | PUT /journal/chart | 200 { chart } — 全体を置き換え |
 * | POST /journal/chart/reset | 200 { chart } — 標準セットへ戻して保存 |
 * | GET /journal/chart/export | 200 { content } — 科目 CSV（BOM 付き） |
 * | POST /journal/chart/import | 200 { chart } — 勘定科目の一覧だけを置き換え |
 * | GET /journal/rules | 200 { rules }（priority 降順） |
 * | POST /journal/rules | 200 { rule } — id 省略で新規、指定で上書き |
 * | DELETE /journal/rules/:id | 204 |
 * | POST /journal/rules/test | 200 { result } — 草案 × 文書群。保存しない |
 * | GET /journal/documents | 200 { documents } — **要約**（証憑本体を含まない） |
 * | POST /journal/documents | 200 { document } |
 * | GET /journal/documents/:id | 200 { document } — 本体つき |
 * | PUT /journal/documents/:id | 200 { document } |
 * | DELETE /journal/documents/:id | 204 |
 * | POST /journal/documents/import-csv | 200 { result } — 読めなかった行は skippedRows |
 * | POST /journal/documents/judge | 200 { result } — 省略時は未判定の全件 |
 * | GET /journal/csv-presets | 200 { presets } |
 * | GET /journal/entries | 200 { entries } |
 * | POST /journal/entries | 200 { entry } |
 * | PUT /journal/entries/:id | 200 { entry } |
 * | POST /journal/entries/:id/confirm | 200 { entry } |
 * | DELETE /journal/entries/:id | 204 |
 * | GET /journal/export | 200 { result } — 仕訳 CSV |
 * | POST /journal/documents/extract | 200 { result } — 画像 / テキストから facts を LLM 抽出（**保存しない**） |
 * | POST /journal/hearings | 200 { hearing } — Stage 2 開始（既に開いていればそれを返す） |
 * | GET /journal/hearings | 200 { hearings } — `documentId` で絞れる |
 * | GET /journal/hearings/:id | 200 { hearing } |
 * | POST /journal/hearings/:id/answers | 200 { hearing, warnings } |
 * | POST /journal/hearings/:id/accept | 200 { hearing, rule, entry?, chart } |
 * | POST /journal/hearings/:id/cancel | 200 { hearing } — 文書は未判定へ戻る |
 *
 * 抽出と回答は**モデルを回すので遅い**（実測で 1 枚 17〜229 秒）。利用者は待ちきれずに閉じるので、
 * どちらも `clientAbortSignal` を通し、切断でモデル呼び出しごと止める。
 * 画面は `GET /runtime/capabilities` の `journal` を見て、使えない機能の導線を出さない。
 *
 * 応答の文書 / ルール / 仕訳は永続化用の Serialized から `tenant` を除いた形（scope は Principal 由来で、
 * クライアントは自分のスコープしか見られないため返す意味が無い）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { JournalCapabilities, JournalCapabilitiesUseCase } from '../application/journal/capabilities';
import type { ExportChartCsvUseCase, ImportChartCsvUseCase } from '../application/journal/chart-transfer';
import type { ExportJournalEntriesUseCase } from '../application/journal/export-entries';
import type { ExtractJournalDocumentUseCase } from '../application/journal/extract-document';
import type {
  AcceptJournalHearingUseCase, AnswerJournalHearingUseCase, CancelJournalHearingUseCase,
  GetJournalHearingUseCase, ListJournalHearingsUseCase, StartJournalHearingUseCase,
} from '../application/journal/hearing';
import type { ImportJournalCsvUseCase } from '../application/journal/import-csv';
import type { JudgeJournalDocumentsUseCase } from '../application/journal/judge-documents';
import type { GetChartOfAccountsUseCase, ResetChartOfAccountsUseCase, SaveChartOfAccountsUseCase } from '../application/journal/manage-chart';
import type {
  DeleteJournalDocumentUseCase, GetJournalDocumentUseCase, ListJournalDocumentsUseCase, SaveJournalDocumentUseCase,
} from '../application/journal/manage-documents';
import type {
  ConfirmJournalEntryUseCase, DeleteJournalEntryUseCase, ListJournalEntriesUseCase, SaveJournalEntryUseCase,
} from '../application/journal/manage-entries';
import type {
  DeleteJournalRuleUseCase, ListJournalRulesUseCase, SaveJournalRuleUseCase, TestJournalRuleUseCase,
} from '../application/journal/manage-rules';
import { JOURNAL_CSV_PRESETS } from '../domain/journal/csv-presets';
import type { JournalDocument } from '../domain/journal/document';
import type { JournalEntry } from '../domain/journal/entry';
import type { HearingSession } from '../domain/journal/hearing';
import type { JournalRule } from '../domain/journal/rule';
import {
  serializeHearingSession, serializeJournalDocument, serializeJournalEntry, serializeJournalRule,
  type SerializedHearingSession, type SerializedJournalDocument, type SerializedJournalEntry, type SerializedJournalRule,
} from '../domain/journal/serialization';
import { scopeOf } from './authentication';
import { clientAbortSignal } from './client-abort';
import { BadRequestError } from './error-mapping';
import {
  acceptJournalHearingBodySchema, answerJournalHearingBodySchema, extractJournalDocumentBodySchema,
  journalChartActionBodySchema, journalChartImportBodySchema, journalChartQuerySchema,
  journalDocumentActionQuerySchema, journalDocumentListQuerySchema, journalEntryActionBodySchema,
  journalEntryListQuerySchema, journalExportQuerySchema, journalHearingActionBodySchema,
  journalHearingActionQuerySchema, journalHearingListQuerySchema, journalImportCsvBodySchema, journalJudgeBodySchema,
  journalRuleListQuerySchema, journalRuleTestBodySchema, saveJournalChartBodySchema,
  saveJournalDocumentBodySchema, saveJournalEntryBodySchema, saveJournalRuleBodySchema,
  startJournalHearingBodySchema,
} from './journal-schemas';

export interface JournalRouteDeps {
  readonly getJournalChart: GetChartOfAccountsUseCase;
  readonly saveJournalChart: SaveChartOfAccountsUseCase;
  readonly resetJournalChart: ResetChartOfAccountsUseCase;
  readonly exportJournalChartCsv: ExportChartCsvUseCase;
  readonly importJournalChartCsv: ImportChartCsvUseCase;
  readonly saveJournalRule: SaveJournalRuleUseCase;
  readonly listJournalRules: ListJournalRulesUseCase;
  readonly deleteJournalRule: DeleteJournalRuleUseCase;
  readonly testJournalRule: TestJournalRuleUseCase;
  readonly saveJournalDocument: SaveJournalDocumentUseCase;
  readonly listJournalDocuments: ListJournalDocumentsUseCase;
  readonly getJournalDocument: GetJournalDocumentUseCase;
  readonly deleteJournalDocument: DeleteJournalDocumentUseCase;
  readonly importJournalCsv: ImportJournalCsvUseCase;
  readonly judgeJournalDocuments: JudgeJournalDocumentsUseCase;
  readonly saveJournalEntry: SaveJournalEntryUseCase;
  readonly listJournalEntries: ListJournalEntriesUseCase;
  readonly confirmJournalEntry: ConfirmJournalEntryUseCase;
  readonly deleteJournalEntry: DeleteJournalEntryUseCase;
  readonly exportJournalEntries: ExportJournalEntriesUseCase;
  /* フェーズ 2（LLM 抽出とヒアリング）。 */
  readonly extractJournalDocument: ExtractJournalDocumentUseCase;
  readonly startJournalHearing: StartJournalHearingUseCase;
  readonly answerJournalHearing: AnswerJournalHearingUseCase;
  readonly acceptJournalHearing: AcceptJournalHearingUseCase;
  readonly cancelJournalHearing: CancelJournalHearingUseCase;
  readonly getJournalHearing: GetJournalHearingUseCase;
  readonly listJournalHearings: ListJournalHearingsUseCase;
}

/** `GET /runtime/capabilities` の `journal` に要る依存（`draft-tool-routes.ts` が業務ごとに集める）。 */
export interface JournalRuntimeCapabilityDeps {
  /** 仕訳の LLM 抽出・ヒアリングの可否（仕訳画面が取込タブの選択肢を出し分ける）。 */
  readonly journalCapabilities: JournalCapabilitiesUseCase;
}

/** `GET /runtime/capabilities` へ足すキー。画面は `journal` を見て、使えない機能の導線を出さない。 */
export async function journalRuntimeCapabilities(deps: JournalRuntimeCapabilityDeps): Promise<{ readonly journal: JournalCapabilities }> {
  return { journal: await deps.journalCapabilities.execute() };
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

/** API 応答用の文書（scope 抜き）。証憑本体はそのまま返す（1 件取得の用途がそれ）。 */
export function journalDocumentResponse(document: JournalDocument): Omit<SerializedJournalDocument, 'tenant'> {
  const { tenant: _tenant, ...rest } = serializeJournalDocument(document);
  return rest;
}

export function journalRuleResponse(rule: JournalRule): Omit<SerializedJournalRule, 'tenant'> {
  const { tenant: _tenant, ...rest } = serializeJournalRule(rule);
  return rest;
}

export function journalEntryResponse(entry: JournalEntry): Omit<SerializedJournalEntry, 'tenant'> {
  const { tenant: _tenant, ...rest } = serializeJournalEntry(entry);
  return rest;
}

export function journalHearingResponse(session: HearingSession): Omit<SerializedHearingSession, 'tenant'> {
  const { tenant: _tenant, ...rest } = serializeHearingSession(session);
  return rest;
}

export function registerJournalRoutes(app: FastifyInstance, deps: JournalRouteDeps): void {
  /* 科目マスタ ------------------------------------------------------------ */

  app.get('/journal/chart', async (request) => {
    parseWith(journalChartQuerySchema, request.query, 'invalid query');
    // saved は「保存済みか標準セットのままか」。永続データではなく、この応答の由来を示す。
    const { chart, saved } = await deps.getJournalChart.execute(scopeOf(request));
    return { chart: { ...chart, saved } };
  });

  app.put('/journal/chart', async (request) => {
    const body = parseWith(saveJournalChartBodySchema, request.body, 'invalid body');
    const chart = await deps.saveJournalChart.execute({
      scope: scopeOf(request), accounts: body.accounts, dimensions: body.dimensions, taxCategories: body.taxCategories,
    });
    return { chart };
  });

  app.post('/journal/chart/reset', async (request) => {
    parseWith(journalChartActionBodySchema, request.body, 'invalid body');
    return { chart: await deps.resetJournalChart.execute(scopeOf(request)) };
  });

  app.get('/journal/chart/export', async (request) => {
    parseWith(journalChartQuerySchema, request.query, 'invalid query');
    return { content: await deps.exportJournalChartCsv.execute(scopeOf(request)) };
  });

  app.post('/journal/chart/import', async (request) => {
    const body = parseWith(journalChartImportBodySchema, request.body, 'invalid body');
    return { chart: await deps.importJournalChartCsv.execute({ scope: scopeOf(request), content: body.content }) };
  });

  /* ルール ---------------------------------------------------------------- */

  app.get('/journal/rules', async (request) => {
    parseWith(journalRuleListQuerySchema, request.query, 'invalid query');
    const rules = await deps.listJournalRules.execute(scopeOf(request));
    return { rules: rules.map(journalRuleResponse) };
  });

  app.post('/journal/rules', async (request) => {
    const body = parseWith(saveJournalRuleBodySchema, request.body, 'invalid body');
    const rule = await deps.saveJournalRule.execute({ scope: scopeOf(request), rule: body.rule });
    return { rule: journalRuleResponse(rule) };
  });

  app.delete<{ Params: { id: string } }>('/journal/rules/:id', async (request, reply) => {
    parseWith(journalDocumentActionQuerySchema, request.query, 'invalid query');
    await deps.deleteJournalRule.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  // 保存しないので参照権限で足りる（POST なのは草案と文書 id の一覧を本文で渡すため）。
  app.post('/journal/rules/test', async (request) => {
    const body = parseWith(journalRuleTestBodySchema, request.body, 'invalid body');
    const result = await deps.testJournalRule.execute({ scope: scopeOf(request), rule: body.rule, documentIds: body.documentIds });
    return { result };
  });

  /* 文書 ------------------------------------------------------------------ */

  app.get('/journal/documents', async (request) => {
    const query = parseWith(journalDocumentListQuerySchema, request.query, 'invalid query');
    const documents = await deps.listJournalDocuments.execute(scopeOf(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { documents };
  });

  // 静的パスを :id より先に登録する（Fastify のルータは静的を優先するが、意図を並びでも示す）。
  app.post('/journal/documents/import-csv', async (request) => {
    const body = parseWith(journalImportCsvBodySchema, request.body, 'invalid body');
    const result = await deps.importJournalCsv.execute({
      scope: scopeOf(request),
      content: body.content,
      ...(body.preset === undefined ? {} : { preset: body.preset }),
      ...(body.columnMapping === undefined ? {} : { columnMapping: body.columnMapping }),
      ...(body.fileName === undefined ? {} : { fileName: body.fileName }),
      ...(body.accountHint === undefined ? {} : { accountHint: body.accountHint }),
    });
    return { result };
  });

  app.post('/journal/documents/judge', async (request) => {
    const body = parseWith(journalJudgeBodySchema, request.body, 'invalid body');
    const result = await deps.judgeJournalDocuments.execute({
      scope: scopeOf(request),
      ...(body.documentIds === undefined ? {} : { documentIds: body.documentIds }),
    });
    return { result };
  });

  app.post('/journal/documents', async (request) => {
    const body = parseWith(saveJournalDocumentBodySchema, request.body, 'invalid body');
    const document = await deps.saveJournalDocument.execute({
      scope: scopeOf(request),
      ...(body.id === undefined ? {} : { id: body.id }),
      kind: body.kind,
      source: body.source,
      facts: body.facts,
      ...(body.extraction === undefined ? {} : { extraction: body.extraction }),
    });
    return { document: journalDocumentResponse(document) };
  });

  app.get<{ Params: { id: string } }>('/journal/documents/:id', async (request) => {
    parseWith(journalDocumentActionQuerySchema, request.query, 'invalid query');
    const document = await deps.getJournalDocument.execute(scopeOf(request), request.params.id);
    return { document: journalDocumentResponse(document) };
  });

  app.put<{ Params: { id: string } }>('/journal/documents/:id', async (request) => {
    const body = parseWith(saveJournalDocumentBodySchema, request.body, 'invalid body');
    // 対象は必ずパスの id（本文の id は無視する。食い違うときに URL を正とする）。
    const document = await deps.saveJournalDocument.execute({
      scope: scopeOf(request),
      id: request.params.id,
      kind: body.kind,
      source: body.source,
      facts: body.facts,
      ...(body.extraction === undefined ? {} : { extraction: body.extraction }),
    });
    return { document: journalDocumentResponse(document) };
  });

  app.delete<{ Params: { id: string } }>('/journal/documents/:id', async (request, reply) => {
    parseWith(journalDocumentActionQuerySchema, request.query, 'invalid query');
    await deps.deleteJournalDocument.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  /** CSV プリセットは定数（スコープに依らない）。 */
  app.get('/journal/csv-presets', async () => ({ presets: JOURNAL_CSV_PRESETS }));

  /* 仕訳 ------------------------------------------------------------------ */

  app.get('/journal/entries', async (request) => {
    const query = parseWith(journalEntryListQuerySchema, request.query, 'invalid query');
    const entries = await deps.listJournalEntries.execute(scopeOf(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.documentId === undefined ? {} : { documentId: query.documentId }),
    });
    return { entries: entries.map(journalEntryResponse) };
  });

  app.post('/journal/entries', async (request) => {
    const body = parseWith(saveJournalEntryBodySchema, request.body, 'invalid body');
    return { entry: journalEntryResponse(await deps.saveJournalEntry.execute(entryInput(scopeOf(request), body))) };
  });

  app.put<{ Params: { id: string } }>('/journal/entries/:id', async (request) => {
    const body = parseWith(saveJournalEntryBodySchema, request.body, 'invalid body');
    const entry = await deps.saveJournalEntry.execute({ ...entryInput(scopeOf(request), body), id: request.params.id });
    return { entry: journalEntryResponse(entry) };
  });

  app.post<{ Params: { id: string } }>('/journal/entries/:id/confirm', async (request) => {
    parseWith(journalEntryActionBodySchema, request.body, 'invalid body');
    return { entry: journalEntryResponse(await deps.confirmJournalEntry.execute(scopeOf(request), request.params.id)) };
  });

  app.delete<{ Params: { id: string } }>('/journal/entries/:id', async (request, reply) => {
    parseWith(journalDocumentActionQuerySchema, request.query, 'invalid query');
    await deps.deleteJournalEntry.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.get('/journal/export', async (request) => {
    const query = parseWith(journalExportQuerySchema, request.query, 'invalid query');
    const result = await deps.exportJournalEntries.execute({
      scope: scopeOf(request),
      format: query.format ?? 'generic',
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      markExported: query.markExported === 'true',
    });
    return { result };
  });

  /* 帳票の LLM 読取（フェーズ 2。docs/20 §6） ----------------------------- */

  /**
   * 画像 / テキスト → facts。**保存しない**（利用者が確認・修正してから `POST /journal/documents`）。
   * モデル未設定・vision 非対応は 409 `JOURNAL_EXTRACTION_UNAVAILABLE`（設定画面で直せる）。
   */
  app.post('/journal/documents/extract', async (request, reply) => {
    const body = parseWith(extractJournalDocumentBodySchema, request.body, 'invalid body');
    const result = await deps.extractJournalDocument.execute({
      ...(body.images === undefined ? {} : { images: body.images }),
      ...(body.text === undefined ? {} : { text: body.text }),
      ...(body.fileName === undefined ? {} : { fileName: body.fileName }),
      ...(body.hintKind === undefined ? {} : { hintKind: body.hintKind }),
    }, clientAbortSignal(request, reply));
    return { result };
  });

  /* ヒアリング（Stage 2。docs/20 §7） ------------------------------------ */

  app.post('/journal/hearings', async (request, reply) => {
    const body = parseWith(startJournalHearingBodySchema, request.body, 'invalid body');
    const hearing = await deps.startJournalHearing.execute(
      { scope: scopeOf(request), documentId: body.documentId },
      clientAbortSignal(request, reply),
    );
    return { hearing: journalHearingResponse(hearing) };
  });

  app.get('/journal/hearings', async (request) => {
    const query = parseWith(journalHearingListQuerySchema, request.query, 'invalid query');
    const hearings = await deps.listJournalHearings.execute(scopeOf(request), {
      ...(query.documentId === undefined ? {} : { documentId: query.documentId }),
    });
    return { hearings: hearings.map(journalHearingResponse) };
  });

  app.get<{ Params: { id: string } }>('/journal/hearings/:id', async (request) => {
    parseWith(journalHearingActionQuerySchema, request.query, 'invalid query');
    const hearing = await deps.getJournalHearing.execute(scopeOf(request), request.params.id);
    return { hearing: journalHearingResponse(hearing) };
  });

  /** 回答 → 次の質問か提案。`warnings` は「提案を採れなかった理由」「打ち切り」を利用者へ見せるため。 */
  app.post<{ Params: { id: string } }>('/journal/hearings/:id/answers', async (request, reply) => {
    const body = parseWith(answerJournalHearingBodySchema, request.body, 'invalid body');
    const result = await deps.answerJournalHearing.execute(
      { scope: scopeOf(request), hearingId: request.params.id, answers: body.answers },
      clientAbortSignal(request, reply),
    );
    return { hearing: journalHearingResponse(result.hearing), warnings: result.warnings };
  });

  /** 受け入れ: 選ばれた id だけをマスタへ登録 → ルール保存 → 再判定。 */
  app.post<{ Params: { id: string } }>('/journal/hearings/:id/accept', async (request) => {
    const body = parseWith(acceptJournalHearingBodySchema, request.body, 'invalid body');
    const result = await deps.acceptJournalHearing.execute({
      scope: scopeOf(request),
      hearingId: request.params.id,
      ...(body.registerAccountIds === undefined ? {} : { registerAccountIds: body.registerAccountIds }),
      ...(body.registerDimensionValueIds === undefined ? {} : { registerDimensionValueIds: body.registerDimensionValueIds }),
      ...(body.registerTaxCodes === undefined ? {} : { registerTaxCodes: body.registerTaxCodes }),
      ...(body.rule === undefined ? {} : { rule: body.rule }),
      ...(body.entry === undefined ? {} : { entry: body.entry }),
    });
    return {
      hearing: journalHearingResponse(result.hearing),
      rule: journalRuleResponse(result.rule),
      ...(result.entry === undefined ? {} : { entry: journalEntryResponse(result.entry) }),
      chart: result.chart,
    };
  });

  app.post<{ Params: { id: string } }>('/journal/hearings/:id/cancel', async (request) => {
    parseWith(journalHearingActionBodySchema, request.body, 'invalid body');
    const hearing = await deps.cancelJournalHearing.execute(scopeOf(request), request.params.id);
    return { hearing: journalHearingResponse(hearing) };
  });
}

/** 仕訳の保存入力（POST と PUT で同じ形。`accountName` は受け取ってもマスタから写し直す）。 */
function entryInput(scope: ReturnType<typeof scopeOf>, body: z.infer<typeof saveJournalEntryBodySchema>) {
  return {
    scope,
    ...(body.id === undefined ? {} : { id: body.id }),
    ...(body.documentId === undefined ? {} : { documentId: body.documentId }),
    ...(body.ruleId === undefined ? {} : { ruleId: body.ruleId }),
    date: body.date,
    lines: body.lines.map((line) => ({
      side: line.side,
      accountId: line.accountId,
      accountName: line.accountName ?? '',
      ...(line.dimensionValues === undefined ? {} : { dimensionValues: line.dimensionValues }),
      taxCode: line.taxCode,
      amount: line.amount,
      ...(line.taxAmount === undefined ? {} : { taxAmount: line.taxAmount }),
      ...(line.partner === undefined ? {} : { partner: line.partner }),
    })),
    description: body.description,
    invoiceStatus: body.invoiceStatus,
    ...(body.registrationNumber === undefined ? {} : { registrationNumber: body.registrationNumber }),
    ...(body.item === undefined ? {} : { item: body.item }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.decidedBy === undefined ? {} : { decidedBy: body.decidedBy }),
  };
}