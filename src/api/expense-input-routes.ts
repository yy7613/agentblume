/**
 * api層: 経費精算「入力と規程（追加読取・運賃マスタ・規程のヒアリング。docs/21 §20.9.4）」のルート。
 *
 * `expense-routes.ts` の `registerExpenseRoutes` が呼び、`ExpenseRouteDeps` はこの deps を extends する（ADR-0039 と同じ登録点を業務の内側に置いた）。
 * 認可は `expense-input-authorization.ts` に全ルートを載せる（`authorization.test.ts` の網羅テストが検査する）。
 * 例外の写像（404 / 409 / 502）は骨格の `expense-error-mapping.ts` が持つので、ここは domain の例外を投げるだけ。
 * モデルを回すルート（追加読取・ヒアリングの開始と回答）は `clientAbortSignal` を通し、切断でモデル呼び出しごと止める。
 * 応答にテナントを含めない。ヒアリングの一覧は原文（規程文）を含めない要約にする。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { ExtractExpenseDetailUseCase } from '../application/expense/input/extract-detail';
import type { ExportExpenseFaresCsvUseCase, ImportExpenseFaresCsvUseCase } from '../application/expense/input/fare-transfer';
import type { LookupExpenseFareUseCase } from '../application/expense/input/lookup-fare';
import type { GetExpenseFaresUseCase, SaveExpenseFaresUseCase } from '../application/expense/input/manage-fares';
import type { ExpensePolicyHearingUseCases } from '../application/expense/input/policy-hearing';
import type { FareRoute, StationAlias } from '../domain/expense/fare-table';
import type { ExpensePolicyHearing } from '../domain/expense/policy-hearing';
import { scopeOf } from './authentication';
import { clientAbortSignal } from './client-abort';
import { BadRequestError } from './error-mapping';
import {
  acceptExpensePolicyHearingBodySchema, answerExpensePolicyHearingBodySchema, expenseInputActionBodySchema, expenseInputScopeQuerySchema,
  extractExpenseDetailBodySchema, importExpenseFaresBodySchema, listExpensePolicyHearingsQuerySchema, lookupExpenseFareBodySchema,
  saveExpenseFaresBodySchema, startExpensePolicyHearingBodySchema,
} from './expense-input-schemas';

/** 使うユースケース（composition の `ExpenseInputFeature` が満たす）。 */
export interface ExpenseInputRouteDeps {
  readonly expenseExtractDetail: ExtractExpenseDetailUseCase;
  readonly expenseGetFares: GetExpenseFaresUseCase;
  readonly expenseSaveFares: SaveExpenseFaresUseCase;
  readonly expenseExportFaresCsv: ExportExpenseFaresCsvUseCase;
  readonly expenseImportFaresCsv: ImportExpenseFaresCsvUseCase;
  readonly expenseLookupFare: LookupExpenseFareUseCase;
  readonly expensePolicyHearings: ExpensePolicyHearingUseCases;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

/** 応答用のヒアリング（テナント抜き）。 */
export function expenseHearingResponse(hearing: ExpensePolicyHearing) {
  const { tenant: _tenant, ...rest } = hearing;
  return rest;
}

/** 一覧用の要約（規程文・回答・案の中身を含めない）。 */
export function expenseHearingSummary(hearing: ExpensePolicyHearing) {
  const candidate = hearing.proposal?.candidate ?? {};
  const proposedItemCount = (candidate.categories?.length ?? 0) + Object.keys(candidate.claimRules ?? {}).length + (candidate.preApprovalRules?.length ?? 0)
    + (candidate.approvalRoutes?.length ?? 0) + Object.keys(candidate.severityOverrides ?? {}).length;
  return {
    id: hearing.id,
    mode: hearing.mode,
    status: hearing.status,
    ...(hearing.source.fileName === undefined ? {} : { fileName: hearing.source.fileName }),
    turnCount: hearing.turns.length,
    proposedItemCount,
    droppedCount: hearing.proposal?.dropped.length ?? 0,
    ...(hearing.model === undefined ? {} : { model: hearing.model }),
    createdAt: hearing.createdAt,
    updatedAt: hearing.updatedAt,
  };
}

export function registerExpenseInputRoutes(app: FastifyInstance, deps: ExpenseInputRouteDeps): void {
  /* 追加読取 -------------------------------------------------------------- */

  app.post('/expense/receipts/extract-detail', async (request, reply) => {
    const body = parseWith(extractExpenseDetailBodySchema, request.body, 'invalid body');
    const result = await deps.expenseExtractDetail.execute({ scope: scopeOf(request), images: body.images, draft: body.draft as Parameters<ExtractExpenseDetailUseCase['execute']>[0]['draft'] }, clientAbortSignal(request, reply));
    return { result };
  });

  /* 運賃マスタ ------------------------------------------------------------ */

  app.get('/expense/fares', async (request) => {
    parseWith(expenseInputScopeQuerySchema, request.query, 'invalid query');
    return deps.expenseGetFares.execute(scopeOf(request));
  });

  app.put('/expense/fares', async (request) => {
    const body = parseWith(saveExpenseFaresBodySchema, request.body, 'invalid body');
    const table = await deps.expenseSaveFares.execute({ scope: scopeOf(request), routes: body.routes as unknown as readonly FareRoute[], stationAliases: body.stationAliases as readonly StationAlias[] });
    return { table };
  });

  app.get('/expense/fares/export', async (request) => {
    parseWith(expenseInputScopeQuerySchema, request.query, 'invalid query');
    return deps.expenseExportFaresCsv.execute(scopeOf(request));
  });

  app.post('/expense/fares/import', async (request) => {
    const body = parseWith(importExpenseFaresBodySchema, request.body, 'invalid body');
    return { table: await deps.expenseImportFaresCsv.execute({ scope: scopeOf(request), content: body.content }) };
  });

  app.post('/expense/fares/lookup', async (request) => {
    const body = parseWith(lookupExpenseFareBodySchema, request.body, 'invalid body');
    const result = await deps.expenseLookupFare.execute({
      scope: scopeOf(request), stations: body.stations,
      ...(body.fareType === undefined ? {} : { fareType: body.fareType }),
      ...(body.date === undefined ? {} : { date: body.date }),
      ...(body.trips === undefined ? {} : { trips: body.trips }),
      ...(body.employeeId === undefined ? {} : { employeeId: body.employeeId }),
    });
    return { result };
  });

  /* 規程のヒアリング ------------------------------------------------------ */

  app.post('/expense/policy-hearings', async (request, reply) => {
    const body = parseWith(startExpensePolicyHearingBodySchema, request.body, 'invalid body');
    const hearing = await deps.expensePolicyHearings.start({
      scope: scopeOf(request), mode: body.mode,
      ...(body.documentText === undefined ? {} : { documentText: body.documentText }),
      ...(body.fileName === undefined ? {} : { fileName: body.fileName }),
    }, clientAbortSignal(request, reply));
    return { hearing: expenseHearingResponse(hearing) };
  });

  app.get('/expense/policy-hearings', async (request) => {
    const query = parseWith(listExpensePolicyHearingsQuerySchema, request.query, 'invalid query');
    const hearings = await deps.expensePolicyHearings.list(scopeOf(request), query.status === undefined ? {} : { status: query.status });
    return { hearings: hearings.map(expenseHearingSummary) };
  });

  app.get<{ Params: { id: string } }>('/expense/policy-hearings/:id', async (request) => {
    parseWith(expenseInputScopeQuerySchema, request.query, 'invalid query');
    return { hearing: expenseHearingResponse(await deps.expensePolicyHearings.get(scopeOf(request), request.params.id)) };
  });

  app.post<{ Params: { id: string } }>('/expense/policy-hearings/:id/answers', async (request, reply) => {
    const body = parseWith(answerExpensePolicyHearingBodySchema, request.body, 'invalid body');
    const hearing = await deps.expensePolicyHearings.answer({ scope: scopeOf(request), id: request.params.id, answers: body.answers }, clientAbortSignal(request, reply));
    return { hearing: expenseHearingResponse(hearing) };
  });

  app.get<{ Params: { id: string } }>('/expense/policy-hearings/:id/diff', async (request) => {
    parseWith(expenseInputScopeQuerySchema, request.query, 'invalid query');
    return deps.expensePolicyHearings.diff(scopeOf(request), request.params.id);
  });

  app.post<{ Params: { id: string } }>('/expense/policy-hearings/:id/accept', async (request) => {
    const body = parseWith(acceptExpensePolicyHearingBodySchema, request.body, 'invalid body');
    const result = await deps.expensePolicyHearings.accept({ scope: scopeOf(request), id: request.params.id, changeIds: body.changeIds, basePolicyUpdatedAt: body.basePolicyUpdatedAt });
    return { hearing: expenseHearingResponse(result.hearing), policy: result.policy };
  });

  app.post<{ Params: { id: string } }>('/expense/policy-hearings/:id/cancel', async (request) => {
    parseWith(expenseInputActionBodySchema, request.body, 'invalid body');
    return { hearing: expenseHearingResponse(await deps.expensePolicyHearings.cancel(scopeOf(request), request.params.id)) };
  });
}
