/**
 * Composition: 契約書レビューと期限台帳（docs/23-contract.md）の組み立て。
 *
 * リポジトリの選択（SQLite / InMemory）・ユースケース・行ソース（`contract-*` ノード）・機能フラグをここで組み、
 * `root.ts` へは `ContractAppFeature` と行ソースだけを返す（ADR-0039）。
 * 判定・期限計算は純関数なので profile 非依存。LLM を使う文字起こし・抽出・LLM 基準だけが文脈のモデルを使い、
 * test プロファイルでは使えない側へ倒す（缶詰モデルの能力を見に行かない）。
 */
import {
  InMemoryContractDocumentRepository, InMemoryContractPlaybookRepository, InMemoryContractReviewRepository, InMemorySignedContractRepository,
} from '../adapters/storage/in-memory-contract-repositories';
import {
  SqliteContractDocumentRepository, SqliteContractPlaybookRepository, SqliteContractReviewRepository, SqliteSignedContractRepository,
} from '../adapters/storage/sqlite-contract-repositories';
import { CONTRACT_CAPABILITIES_DISABLED, ContractCapabilitiesUseCase, type ContractCapabilities } from '../application/contract/capabilities';
import { ContractClauseExtractor, ExtractContractClausesUseCase } from '../application/contract/extract-clauses';
import { ContractClauseRowsProvider, ContractDeadlineRowsProvider } from '../application/contract/ledger-rows';
import { ContractCriteriaAnswerer } from '../application/contract/llm-criteria';
import {
  ConfirmContractClausesUseCase, DeleteContractDocumentUseCase, GetContractDocumentUseCase, ImportContractDocumentUseCase,
  ListContractDocumentsUseCase, UpdateContractDocumentUseCase,
} from '../application/contract/manage-documents';
import {
  ContractPlaybookResolver, CreatePlaybookFromTemplateUseCase, DeleteContractPlaybookUseCase, GetContractPlaybookUseCase,
  ListContractPlaybooksUseCase, ListPlaybookTemplatesUseCase, SaveContractPlaybookUseCase,
} from '../application/contract/manage-playbooks';
import { ContractReviewDraftRowsProvider } from '../application/contract/review-draft-rows';
import { contractRowSources } from '../application/contract/row-sources';
import { FinalizeContractReviewUseCase, GetContractReviewUseCase, RunContractReviewUseCase, SaveContractReviewDecisionsUseCase } from '../application/contract/run-review';
import {
  CompleteContractDeadlineUseCase, DeleteSignedContractUseCase, GetSignedContractUseCase, ListContractDeadlinesUseCase, ListSignedContractsUseCase,
  PreviewContractDeadlinesUseCase, RegisterSignedContractUseCase, TerminateSignedContractUseCase, UpdateSignedContractUseCase,
} from '../application/contract/signed-contracts';
import { ContractModelGate } from '../application/contract/support';
import { TranscribeContractPagesUseCase } from '../application/contract/transcribe-pages';
import type { ContractDocumentRepository, ContractPlaybookRepository, ContractReviewRepository, SignedContractRepository } from '../domain/contract/repositories';
import type { BusinessComposition, BusinessCompositionContext } from './business';

/** App のうち契約の部分（キーは `contract` で始める。ADR-0039）。 */
export interface ContractAppFeature {
  readonly contractPlaybookRepo: ContractPlaybookRepository;
  readonly contractDocumentRepo: ContractDocumentRepository;
  readonly contractReviewRepo: ContractReviewRepository;
  readonly contractSignedRepo: SignedContractRepository;
  readonly contractListPlaybooks: ListContractPlaybooksUseCase;
  readonly contractGetPlaybook: GetContractPlaybookUseCase;
  readonly contractSavePlaybook: SaveContractPlaybookUseCase;
  readonly contractDeletePlaybook: DeleteContractPlaybookUseCase;
  readonly contractListTemplates: ListPlaybookTemplatesUseCase;
  readonly contractCreatePlaybookFromTemplate: CreatePlaybookFromTemplateUseCase;
  readonly contractImportDocument: ImportContractDocumentUseCase;
  readonly contractUpdateDocument: UpdateContractDocumentUseCase;
  readonly contractGetDocument: GetContractDocumentUseCase;
  readonly contractListDocuments: ListContractDocumentsUseCase;
  readonly contractDeleteDocument: DeleteContractDocumentUseCase;
  readonly contractTranscribePages: TranscribeContractPagesUseCase;
  readonly contractExtractClauses: ExtractContractClausesUseCase;
  readonly contractConfirmClauses: ConfirmContractClausesUseCase;
  readonly contractRunReview: RunContractReviewUseCase;
  readonly contractGetReview: GetContractReviewUseCase;
  readonly contractSaveDecisions: SaveContractReviewDecisionsUseCase;
  readonly contractFinalizeReview: FinalizeContractReviewUseCase;
  readonly contractPreviewDeadlines: PreviewContractDeadlinesUseCase;
  readonly contractRegisterSigned: RegisterSignedContractUseCase;
  readonly contractListSigned: ListSignedContractsUseCase;
  readonly contractGetSigned: GetSignedContractUseCase;
  readonly contractUpdateSigned: UpdateSignedContractUseCase;
  readonly contractDeleteSigned: DeleteSignedContractUseCase;
  readonly contractTerminateSigned: TerminateSignedContractUseCase;
  readonly contractCompleteDeadline: CompleteContractDeadlineUseCase;
  readonly contractListDeadlines: ListContractDeadlinesUseCase;
  /** `GET /runtime/capabilities` の `contract`。 */
  readonly contractCapabilities: ContractCapabilitiesUseCase;
}

export function composeContract(context: BusinessCompositionContext): BusinessComposition<ContractAppFeature> {
  const { unitOfWork, modelProvider, resolveModelSnapshot, errorLogger } = context;
  const playbookRepo = context.pickRepository<ContractPlaybookRepository>((db) => new SqliteContractPlaybookRepository(db), () => new InMemoryContractPlaybookRepository());
  const documentRepo = context.pickRepository<ContractDocumentRepository>((db) => new SqliteContractDocumentRepository(db), () => new InMemoryContractDocumentRepository());
  const reviewRepo = context.pickRepository<ContractReviewRepository>((db) => new SqliteContractReviewRepository(db), () => new InMemoryContractReviewRepository());
  const signedRepo = context.pickRepository<SignedContractRepository>((db) => new SqliteSignedContractRepository(db), () => new InMemorySignedContractRepository());

  // LLM を回してよいか（能力ではなく設定の有無。test は常に false）。能力は使う直前にゲートが見る。
  const llmEnabled = async (): Promise<boolean> => context.profile !== 'test' && await context.mainModelConfigured();
  const gate = new ContractModelGate(modelProvider, llmEnabled, resolveModelSnapshot === undefined ? undefined : async () => {
    const snapshot = await resolveModelSnapshot();
    return { provider: snapshot.provider, model: snapshot.model };
  });
  const resolver = new ContractPlaybookResolver(playbookRepo);
  const extractor = new ContractClauseExtractor(gate);
  const answerer = new ContractCriteriaAnswerer(gate, errorLogger);
  const transcriber = new TranscribeContractPagesUseCase(gate);
  const ledger = new ListContractDeadlinesUseCase(signedRepo, resolver);

  const capabilitiesResolver = async (): Promise<ContractCapabilities> => {
    if (context.profile === 'test' || !await context.mainModelConfigured()) return CONTRACT_CAPABILITIES_DISABLED;
    const capabilities = await context.mainModelCapabilities();
    const structured = capabilities.includes('structured-output');
    return { extraction: { enabled: structured, vision: capabilities.includes('vision') }, review: { llm: structured } };
  };

  const rowSources = contractRowSources({
    // 添付の契約書を読んで判定する（保存しない）。テキスト添付と画像はどちらも実行文脈から来る。
    reviewDraft: new ContractReviewDraftRowsProvider(resolver, extractor, answerer, transcriber),
    deadlines: new ContractDeadlineRowsProvider(ledger),
    clauses: new ContractClauseRowsProvider(signedRepo, resolver),
  });

  return {
    rowSources,
    feature: {
      contractPlaybookRepo: playbookRepo,
      contractDocumentRepo: documentRepo,
      contractReviewRepo: reviewRepo,
      contractSignedRepo: signedRepo,
      contractListPlaybooks: new ListContractPlaybooksUseCase(playbookRepo),
      contractGetPlaybook: new GetContractPlaybookUseCase(resolver),
      contractSavePlaybook: new SaveContractPlaybookUseCase(playbookRepo, unitOfWork),
      contractDeletePlaybook: new DeleteContractPlaybookUseCase(playbookRepo),
      contractListTemplates: new ListPlaybookTemplatesUseCase(),
      contractCreatePlaybookFromTemplate: new CreatePlaybookFromTemplateUseCase(playbookRepo, unitOfWork),
      contractImportDocument: new ImportContractDocumentUseCase(documentRepo, resolver),
      contractUpdateDocument: new UpdateContractDocumentUseCase(documentRepo, reviewRepo, resolver, unitOfWork),
      contractGetDocument: new GetContractDocumentUseCase(documentRepo),
      contractListDocuments: new ListContractDocumentsUseCase(documentRepo),
      contractDeleteDocument: new DeleteContractDocumentUseCase(documentRepo, reviewRepo, unitOfWork),
      contractTranscribePages: transcriber,
      contractExtractClauses: new ExtractContractClausesUseCase(documentRepo, reviewRepo, resolver, extractor, unitOfWork),
      contractConfirmClauses: new ConfirmContractClausesUseCase(documentRepo, reviewRepo, resolver, unitOfWork),
      contractRunReview: new RunContractReviewUseCase(documentRepo, reviewRepo, resolver, answerer, unitOfWork),
      contractGetReview: new GetContractReviewUseCase(reviewRepo, documentRepo, playbookRepo),
      contractSaveDecisions: new SaveContractReviewDecisionsUseCase(reviewRepo),
      contractFinalizeReview: new FinalizeContractReviewUseCase(reviewRepo, documentRepo, unitOfWork),
      contractPreviewDeadlines: new PreviewContractDeadlinesUseCase(documentRepo, reviewRepo, resolver),
      contractRegisterSigned: new RegisterSignedContractUseCase(documentRepo, reviewRepo, signedRepo, resolver, unitOfWork),
      contractListSigned: new ListSignedContractsUseCase(signedRepo),
      contractGetSigned: new GetSignedContractUseCase(signedRepo),
      contractUpdateSigned: new UpdateSignedContractUseCase(signedRepo),
      contractDeleteSigned: new DeleteSignedContractUseCase(signedRepo, documentRepo, reviewRepo, unitOfWork),
      contractTerminateSigned: new TerminateSignedContractUseCase(signedRepo),
      contractCompleteDeadline: new CompleteContractDeadlineUseCase(signedRepo),
      contractListDeadlines: ledger,
      contractCapabilities: new ContractCapabilitiesUseCase(capabilitiesResolver, errorLogger),
    },
  };
}
