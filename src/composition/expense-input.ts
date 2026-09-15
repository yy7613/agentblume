/**
 * Composition: 経費精算「入力と規程」（経費専用の追加読取・交通費・規程のヒアリング。UC7〜UC9）の組み立て。
 *
 * `feature` のキーは `expense` で始める（`ExpenseAppFeature` に展開され、api の `ExpenseInputRouteDeps` を満たす）。
 * モデルは `core.context.modelProvider`。**test プロファイルでは使えない側へ倒す**（main モデルの設定の有無と能力を毎回読む）。
 * `detailReader` は骨格の読取（`POST /expense/receipts/extract` の `detail: true`）が、`policyHearingAvailable` は
 * `/runtime/capabilities` が使う。
 */
import { InputCheckFactsProvider } from '../application/expense/input/check-facts';
import { InputReceiptDetailReader, type ExpenseModelBinding } from '../application/expense/input/detail-reader';
import { ExtractExpenseDetailUseCase } from '../application/expense/input/extract-detail';
import { ExportExpenseFaresCsvUseCase, ImportExpenseFaresCsvUseCase } from '../application/expense/input/fare-transfer';
import { LookupExpenseFareUseCase } from '../application/expense/input/lookup-fare';
import { GetExpenseFaresUseCase, SaveExpenseFaresUseCase } from '../application/expense/input/manage-fares';
import { ExpensePolicyHearingUseCases } from '../application/expense/input/policy-hearing';
import { expenseInputRowSources } from '../application/expense/input/row-sources';
import { SaveExpensePolicyUseCase } from '../application/expense/manage-policy';
import type { ReceiptDetailReaderPort } from '../application/expense/ports';
import type { ExpenseCoreServices, ExpenseSystemComposition } from './expense-core';

/** App のうち「入力と規程」の部分。 */
export interface ExpenseInputFeature {
  readonly expenseExtractDetail: ExtractExpenseDetailUseCase;
  readonly expenseGetFares: GetExpenseFaresUseCase;
  readonly expenseSaveFares: SaveExpenseFaresUseCase;
  readonly expenseExportFaresCsv: ExportExpenseFaresCsvUseCase;
  readonly expenseImportFaresCsv: ImportExpenseFaresCsvUseCase;
  readonly expenseLookupFare: LookupExpenseFareUseCase;
  readonly expensePolicyHearings: ExpensePolicyHearingUseCases;
}

export interface ExpenseInputComposition extends ExpenseSystemComposition<ExpenseInputFeature> {
  readonly detailReader: ReceiptDetailReaderPort;
  /** 規程のヒアリングが使えるか（`/runtime/capabilities` の `expense.policyHearing.enabled`）。 */
  readonly policyHearingAvailable: () => Promise<boolean>;
}

/** 文脈からモデルの配線を作る。test プロファイルは常に「モデル未設定」。 */
export function expenseModelBinding(core: Pick<ExpenseCoreServices, 'context'>): ExpenseModelBinding {
  const { context } = core;
  const resolveSnapshot = context.resolveModelSnapshot;
  return {
    provider: context.modelProvider,
    enabled: async () => context.profile !== 'test' && await context.mainModelConfigured(),
    capabilities: () => context.mainModelCapabilities(),
    ...(resolveSnapshot === undefined ? {} : {
      snapshot: async () => {
        const snapshot = await resolveSnapshot();
        return { provider: snapshot.provider, model: snapshot.model };
      },
    }),
  };
}

export function composeExpenseInput(core: ExpenseCoreServices): ExpenseInputComposition {
  const model = expenseModelBinding(core);
  const detailReader = new InputReceiptDetailReader(core, model);
  const hearings = new ExpensePolicyHearingUseCases(core, new SaveExpensePolicyUseCase(core.repositories.policies, core.now), model);
  return {
    feature: {
      expenseExtractDetail: new ExtractExpenseDetailUseCase(detailReader),
      expenseGetFares: new GetExpenseFaresUseCase(core),
      expenseSaveFares: new SaveExpenseFaresUseCase(core),
      expenseExportFaresCsv: new ExportExpenseFaresCsvUseCase(core),
      expenseImportFaresCsv: new ImportExpenseFaresCsvUseCase(core),
      expenseLookupFare: new LookupExpenseFareUseCase(core),
      expensePolicyHearings: hearings,
    },
    rowSources: expenseInputRowSources(core),
    checkFacts: new InputCheckFactsProvider(core),
    detailReader,
    policyHearingAvailable: () => hearings.available(),
  };
}
