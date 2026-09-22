/**
 * Composition: 仕訳（docs/20-journal.md）の組み立て。
 *
 * リポジトリの選択（SQLite / InMemory）・ユースケース・行ソース（`journal-*` ノード）・機能フラグをここで組み、
 * `root.ts` へは `JournalAppFeature` と行ソースだけを返す（ADR-0039）。
 * 判定は純粋関数なのでモデル配線に依らず profile 非依存に組む。LLM を使う抽出とヒアリングだけが文脈のモデルを使う。
 */
import {
  InMemoryChartOfAccountsRepository, InMemoryJournalDocumentRepository, InMemoryJournalEntryRepository,
  InMemoryJournalHearingRepository, InMemoryJournalRuleRepository,
} from '../adapters/storage/in-memory-journal-repositories';
import {
  SqliteChartOfAccountsRepository, SqliteJournalDocumentRepository, SqliteJournalEntryRepository,
  SqliteJournalHearingRepository, SqliteJournalRuleRepository,
} from '../adapters/storage/sqlite-journal-repositories';
import { JournalAttachmentRowsProvider } from '../application/journal/attachment-rows';
import { JOURNAL_CAPABILITIES_DISABLED, JournalCapabilitiesUseCase, type JournalCapabilities } from '../application/journal/capabilities';
import { ExportChartCsvUseCase, ImportChartCsvUseCase } from '../application/journal/chart-transfer';
import { JournalDraftEntryRowsProvider } from '../application/journal/draft-entry-rows';
import { JournalEntryRowsProvider } from '../application/journal/entry-rows';
import { ExportJournalEntriesUseCase } from '../application/journal/export-entries';
import { ExtractJournalDocumentUseCase } from '../application/journal/extract-document';
import {
  AcceptJournalHearingUseCase, AnswerJournalHearingUseCase, CancelJournalHearingUseCase,
  GetJournalHearingUseCase, ListJournalHearingsUseCase, StartJournalHearingUseCase,
} from '../application/journal/hearing';
import { ImportJournalCsvUseCase } from '../application/journal/import-csv';
import { JudgeJournalDocumentsUseCase } from '../application/journal/judge-documents';
import { GetChartOfAccountsUseCase, ResetChartOfAccountsUseCase, SaveChartOfAccountsUseCase } from '../application/journal/manage-chart';
import {
  DeleteJournalDocumentUseCase, GetJournalDocumentUseCase, ListJournalDocumentsUseCase, SaveJournalDocumentUseCase,
} from '../application/journal/manage-documents';
import {
  ConfirmJournalEntryUseCase, DeleteJournalEntryUseCase, ListJournalEntriesUseCase, SaveJournalEntryUseCase,
} from '../application/journal/manage-entries';
import {
  DeleteJournalRuleUseCase, ListJournalRulesUseCase, SaveJournalRuleUseCase, TestJournalRuleUseCase,
} from '../application/journal/manage-rules';
import { journalRowSources } from '../application/journal/row-sources';
import type {
  ChartOfAccountsRepository, JournalDocumentRepository, JournalEntryRepository,
  JournalHearingRepository, JournalRuleRepository,
} from '../domain/journal/repositories';
import type { BusinessComposition, BusinessCompositionContext } from './business';

/** App のうち仕訳の部分。 */
export interface JournalAppFeature {
  /* 仕訳（docs/20-journal.md）。 */
  readonly journalChartRepo: ChartOfAccountsRepository;
  readonly journalDocumentRepo: JournalDocumentRepository;
  readonly journalRuleRepo: JournalRuleRepository;
  readonly journalEntryRepo: JournalEntryRepository;
  /** フェーズ 1 では読み書きするユースケースがまだ無い（Stage 2 が載るまで置いておく）。 */
  readonly journalHearingRepo: JournalHearingRepository;
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
  /* フェーズ 2（LLM 抽出と Stage 2 ヒアリング）。 */
  readonly extractJournalDocument: ExtractJournalDocumentUseCase;
  readonly startJournalHearing: StartJournalHearingUseCase;
  readonly answerJournalHearing: AnswerJournalHearingUseCase;
  readonly acceptJournalHearing: AcceptJournalHearingUseCase;
  readonly cancelJournalHearing: CancelJournalHearingUseCase;
  readonly getJournalHearing: GetJournalHearingUseCase;
  readonly listJournalHearings: ListJournalHearingsUseCase;
  /** 仕訳の LLM 抽出・ヒアリングの可否（`GET /runtime/capabilities` の `journal`）。 */
  readonly journalCapabilities: JournalCapabilitiesUseCase;
}

export function composeJournal(context: BusinessCompositionContext): BusinessComposition<JournalAppFeature> {
  const { modelProvider, mainModelConfigured, resolveModelSnapshot, errorLogger } = context;
  // 仕訳（v5）: 5つの集約。証憑本体は record_json に同梱するので payload 置き場は要らない。
  const chartRepo = context.pickRepository<ChartOfAccountsRepository>((db) => new SqliteChartOfAccountsRepository(db), () => new InMemoryChartOfAccountsRepository());
  const documentRepo = context.pickRepository<JournalDocumentRepository>((db) => new SqliteJournalDocumentRepository(db), () => new InMemoryJournalDocumentRepository());
  const ruleRepo = context.pickRepository<JournalRuleRepository>((db) => new SqliteJournalRuleRepository(db), () => new InMemoryJournalRuleRepository());
  const entryRepo = context.pickRepository<JournalEntryRepository>((db) => new SqliteJournalEntryRepository(db), () => new InMemoryJournalEntryRepository());
  const hearingRepo = context.pickRepository<JournalHearingRepository>((db) => new SqliteJournalHearingRepository(db), () => new InMemoryJournalHearingRepository());

  /**
   * 仕訳の LLM 機能を回してよいか（能力ではなく**設定の有無**）。分析アシスタントと同じ判定だが、
   * `ANALYSIS_ASSISTANT_ENABLED` では切らない（仕訳の抽出は分析アシスタントとは別の機能である）。
   */
  const llmEnabled = mainModelConfigured;
  // 取込タブと添付読み取りで同じ 1 つを使う（読み取りの規則を 2 か所に分けない）。
  const extractJournalDocument = new ExtractJournalDocumentUseCase(modelProvider, llmEnabled, context.promptCatalog, resolveModelSnapshot === undefined ? undefined : async () => resolveModelSnapshot(), errorLogger);

  /**
   * 仕訳の LLM 機能（抽出・ヒアリング）が使えるか。
   *
   * 画面が「使えない理由」を出し分けられるよう、モデル側の能力をそのまま答える:
   * テキストからの抽出も Stage 2 のヒアリングも structured output があれば足り、
   * 画像（PDF はブラウザで画像化する）は vision も要る。判定は毎回行う（モデル設定は UI から変わる）。
   */
  const capabilitiesResolver = async (): Promise<JournalCapabilities> => {
    if (context.profile === 'test') return JOURNAL_CAPABILITIES_DISABLED;
    try {
      // 切替可能な配線では保存済み設定を解決してから能力を読む（diagnoseAgentTools と同じ手順）。
      const capabilities = await context.mainModelCapabilities();
      const structured = capabilities.includes('structured-output');
      const vision = capabilities.includes('vision');
      return {
        extraction: { enabled: structured, vision: structured && vision },
        // Stage 2 は構造化出力だけで足りる（質問も提案も JSON で受け取る。画像は見ない）。
        hearing: { enabled: structured },
      };
    } catch {
      // 設定が読めない / 復号できない場合は「使えない」側へ倒す。
      return JOURNAL_CAPABILITIES_DISABLED;
    }
  };
  // 判定は純粋関数なので profile 非依存。ヒアリングの受け入れ（再判定）もこの 1 つを共有する。
  const judgeJournalDocuments = new JudgeJournalDocumentsUseCase(documentRepo, ruleRepo, chartRepo, entryRepo);

  const rowSources = journalRowSources({
    // `journal-entries` ソースは domain からリポジトリへ届かないため、実行直前に行を差し込むポートを渡す。
    entries: new JournalEntryRowsProvider(entryRepo, chartRepo),
    // `journal-attachment` ソースは実行中の添付を読む。domain からはモデルにも実行文脈にも届かない。
    attachments: new JournalAttachmentRowsProvider(extractJournalDocument),
    // `journal-draft-entry` は 読み取り → 保存済みルールで判定 → 仕訳案 までを 1 本で通す（保存しない）。
    draftEntries: new JournalDraftEntryRowsProvider(extractJournalDocument, ruleRepo, chartRepo),
  });

  return {
    rowSources,
    feature: {
      journalChartRepo: chartRepo,
      journalDocumentRepo: documentRepo,
      journalRuleRepo: ruleRepo,
      journalEntryRepo: entryRepo,
      journalHearingRepo: hearingRepo,
      getJournalChart: new GetChartOfAccountsUseCase(chartRepo),
      saveJournalChart: new SaveChartOfAccountsUseCase(chartRepo),
      resetJournalChart: new ResetChartOfAccountsUseCase(chartRepo),
      exportJournalChartCsv: new ExportChartCsvUseCase(chartRepo),
      importJournalChartCsv: new ImportChartCsvUseCase(chartRepo),
      saveJournalRule: new SaveJournalRuleUseCase(ruleRepo, chartRepo),
      listJournalRules: new ListJournalRulesUseCase(ruleRepo),
      deleteJournalRule: new DeleteJournalRuleUseCase(ruleRepo),
      testJournalRule: new TestJournalRuleUseCase(documentRepo, chartRepo),
      saveJournalDocument: new SaveJournalDocumentUseCase(documentRepo),
      listJournalDocuments: new ListJournalDocumentsUseCase(documentRepo),
      getJournalDocument: new GetJournalDocumentUseCase(documentRepo),
      deleteJournalDocument: new DeleteJournalDocumentUseCase(documentRepo, entryRepo),
      importJournalCsv: new ImportJournalCsvUseCase(documentRepo),
      judgeJournalDocuments,
      saveJournalEntry: new SaveJournalEntryUseCase(entryRepo, chartRepo),
      listJournalEntries: new ListJournalEntriesUseCase(entryRepo),
      confirmJournalEntry: new ConfirmJournalEntryUseCase(entryRepo),
      deleteJournalEntry: new DeleteJournalEntryUseCase(entryRepo, documentRepo),
      exportJournalEntries: new ExportJournalEntriesUseCase(entryRepo, chartRepo),
      // フェーズ 2: 抽出とヒアリング。モデルは main スロット（切替可能な配線ならその実体）。
      extractJournalDocument,
      startJournalHearing: new StartJournalHearingUseCase(documentRepo, hearingRepo, chartRepo, modelProvider, llmEnabled, context.promptCatalog),
      answerJournalHearing: new AnswerJournalHearingUseCase(documentRepo, hearingRepo, chartRepo, modelProvider, llmEnabled, context.promptCatalog),
      acceptJournalHearing: new AcceptJournalHearingUseCase(documentRepo, hearingRepo, chartRepo, ruleRepo, entryRepo, judgeJournalDocuments),
      cancelJournalHearing: new CancelJournalHearingUseCase(documentRepo, hearingRepo),
      getJournalHearing: new GetJournalHearingUseCase(hearingRepo),
      listJournalHearings: new ListJournalHearingsUseCase(hearingRepo),
      journalCapabilities: new JournalCapabilitiesUseCase(capabilitiesResolver),
    },
  };
}
