/**
 * application層: 添付された契約書をレビューして「Agent が読む表」へ畳む（組込みツール `contract_review_draft`。docs/23 §9.1）。
 *
 * 添付ごとに: 本文（テキスト添付はそのまま / 画像は文字起こし）→ 条文分割 → 抽出 → 突き合わせ → レビュー → 行へ平坦化。
 * **何も保存しない**（文書もレビューも作らない。確定・締結登録は画面から人が押す）。
 *
 * - テキスト添付を優先し、無ければ画像を 1 通の契約書のページとして読む（チャットの画像は 2 枚までで、契約書の写真はページ単位で撮るため）。
 * - 自社の立場は審査基準の `ourRole`、甲乙は前文の当事者名と審査基準の自社名の一致で決める（決まらなければ立場別の基準は role-not-set）。
 * - 相手方の区分（取適法 / フリーランス法）は申告が無いので未入力扱い（支払期日は counterparty-profile-missing）。
 * - 途中で失敗したらそのまま投げる（読めた分だけ返すと、モデルが「これで全部」と誤解する）。
 */
import type { Row } from '../../domain/data/types';
import { applyConsistency } from '../../domain/contract/consistency';
import { counterpartyNameOf, createContractDocument, type ContractDocument } from '../../domain/contract/document';
import { enabledTopics } from '../../domain/contract/playbook';
import { reviewContract, type LlmCriterionAnswer, type ReviewOutcome, type TopicResult } from '../../domain/contract/review';
import type { Reason } from '../../domain/contract/reasons';
import { detectParties, segmentArticles, singlePage, type ContractPage } from '../../domain/contract/segmentation';
import { summarizeClauseValue } from '../../domain/contract/value-summary';
import { CONTRACT_REVIEW_DRAFT_SCHEMA } from '../../domain/etl/nodes/contract-review-draft';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ContractClauseExtractor } from './extract-clauses';
import type { ContractCriteriaAnswerer } from './llm-criteria';
import { matchOurParty } from './manage-documents';
import type { ContractPlaybookResolver } from './manage-playbooks';
import { criteriaRequestsFor } from './run-review';
import { systemClock, type Clock } from './support';
import type { TranscribeContractPagesUseCase } from './transcribe-pages';

/** 画面・API・ツールのすべてに出す固定文言（docs/23 §4.3）。 */
export const LEGAL_DISCLAIMER_JA = 'この結果は、ワークスペースに登録された審査基準と設定値（支払期日 60 日など）との照合です。法的な判断ではありません。適用の有無と最終判断は担当者・専門家が行ってください。';

export interface ReviewDraftAttachments {
  readonly documents: readonly { readonly name: string; readonly text: string; readonly pageCount?: number }[];
  readonly images: readonly { readonly name: string; readonly dataUrl: string }[];
}

export interface ReviewDraftOptions {
  readonly playbookId?: string;
  readonly llmCriteria?: boolean;
  readonly limit?: number;
}

/** 文書全体の所見 → 1 行の説明。 */
export function findingText(reason: Reason): string {
  const detail = reason.detail ?? {};
  switch (reason.code) {
    case 'stamp-duty-candidate':
      return detail['electronic'] === true
        ? `印紙税: ${String(detail['name'])} の候補ですが、電子契約は課税文書の作成に当たらないとされます（社内の判断に従ってください）`
        : `印紙税: ${String(detail['name'])} に当たる可能性があります（税額 ${detail['amount'] === null ? '不明' : `${String(detail['amount'])} 円`}。紙で締結するなら要否と金額を確かめてください）`;
    case 'stamp-duty-amount-unknown':
      return `印紙税: ${String(detail['name'])} の候補ですが、契約金額が分からず税額を決められません`;
    case 'deadline-mismatch':
      return `期限の突き合わせ: ${String(detail['message'])}`;
    case 'payment-basis-acceptance':
      return '支払期日が検収日基準で、受領日からの日数が決まりません';
    default:
      return reason.code;
  }
}

function topicRow(base: Row, document: ContractDocument, result: TopicResult): Row {
  const clause = document.clauses.find((entry) => entry.topicId === result.topicId);
  const evidence = clause?.evidence[0];
  return {
    ...base,
    row_type: 'topic',
    topic_id: result.topicId,
    topic_label: result.topicLabel,
    verdict: result.verdict,
    present: result.present,
    article_ref: clause?.articleRef ?? null,
    quote: evidence?.quote ?? null,
    quote_verified: evidence === undefined ? null : clause!.evidence.every((entry) => entry.verified),
    value_summary: summarizeClauseValue(clause?.value, { ...(document.parties.A.name === undefined ? {} : { A: document.parties.A.name }), ...(document.parties.B.name === undefined ? {} : { B: document.parties.B.name }) }),
    reasons: [...new Set(result.reasons.map((reason) => reason.code))].join(','),
    recommended_text: result.recommendedTexts.length === 0 ? null : result.recommendedTexts.join('\n'),
    findings: (clause?.warnings ?? []).map((warning) => warning.message).join('\n'),
    value_json: JSON.stringify(clause?.value ?? null),
    criteria_json: JSON.stringify(result.criteria),
  };
}

function documentRow(base: Row, document: ContractDocument, outcome: ReviewOutcome, extractionWarnings: readonly string[]): Row {
  const payment = outcome.results.flatMap((result) => result.criteria).map((criterion) => criterion.detail?.['worstCase']).find((value): value is string => typeof value === 'string');
  const lines = [
    ...outcome.documentFindings.map(findingText),
    ...(payment === undefined ? [] : [`支払期日の最長ケース: ${payment}`]),
    ...(document.ourParty === undefined ? ['自社が甲・乙のどちらか決められませんでした（審査基準の自社名を登録すると決まります）'] : []),
    ...extractionWarnings,
    LEGAL_DISCLAIMER_JA,
  ];
  return {
    ...base,
    row_type: 'document', topic_id: null, topic_label: null, verdict: null, present: null, article_ref: null, quote: null, quote_verified: null, value_summary: null,
    reasons: [...new Set(outcome.documentFindings.map((finding) => finding.code))].join(','),
    recommended_text: null,
    findings: lines.join('\n'),
    value_json: JSON.stringify({ counterparty: counterpartyNameOf(document) ?? null, ourParty: document.ourParty ?? null, contractNature: document.contractNature?.value ?? null }),
    criteria_json: '[]',
  };
}

export class ContractReviewDraftRowsProvider {
  constructor(
    private readonly resolver: ContractPlaybookResolver,
    private readonly extractor: ContractClauseExtractor,
    private readonly answerer: ContractCriteriaAnswerer,
    private readonly transcriber: TranscribeContractPagesUseCase,
    private readonly clock: Clock = systemClock,
  ) {}

  async rows(scope: TenantScope, attachments: ReviewDraftAttachments, options: ReviewDraftOptions = {}, signal?: AbortSignal): Promise<readonly Row[]> {
    const { playbook } = await this.resolver.resolve(scope, options.playbookId);
    const targets = attachments.documents.length > 0
      ? attachments.documents.map((entry) => ({ name: entry.name, read: async () => ({ body: entry.text, pages: singlePage(entry.text), sourceType: 'pdf-text' as const, pageCount: entry.pageCount }) }))
      : attachments.images.length === 0 ? [] : [{ name: attachments.images[0]!.name, read: async () => this.transcribe(attachments.images, signal) }];
    const limited = options.limit === undefined ? targets : targets.slice(0, options.limit);
    const rows: Row[] = [];
    for (const target of limited) {
      const read = await target.read();
      const now = this.clock().toISOString();
      const articles = segmentArticles(read.body, read.pages, playbook.extraction.chunkMaxChars);
      const detected = detectParties(read.body);
      const topics = enabledTopics(playbook);
      const extraction = await this.extractor.extract({ body: read.body, articles, topics, chunkMaxChars: playbook.extraction.chunkMaxChars, scanAllArticles: playbook.extraction.scanAllArticles }, signal);
      const names = { ...(extraction.parties ?? {}), ...detected };
      const ourParty = matchOurParty(names, playbook.ourCompanyNames);
      const document = createContractDocument({
        tenant: scope, id: 'attachment', title: target.name.slice(0, 200) || 'attachment',
        source: { type: read.sourceType, fileName: target.name.slice(0, 200), ...(read.pageCount === undefined ? {} : { pageCount: read.pageCount }) },
        body: read.body, pages: read.pages, articles,
        parties: { A: { label: '甲', ...(names.A === undefined ? {} : { name: names.A }) }, B: { label: '乙', ...(names.B === undefined ? {} : { name: names.B }) } },
        ...(ourParty === undefined ? {} : { ourParty }), ourRole: playbook.ourRole,
        counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' },
        ...(extraction.contractNature === undefined ? {} : { contractNature: extraction.contractNature }),
        clauses: applyConsistency(extraction.clauses, playbook.topics),
        status: 'confirmed', createdAt: now, updatedAt: now,
      });
      const answers: ReadonlyMap<string, LlmCriterionAnswer> = options.llmCriteria === false ? new Map() : (await this.answerer.answer(criteriaRequestsFor(document, playbook), [], signal)).answers;
      const outcome = reviewContract({ document, playbook, llmAnswers: answers });
      const base: Row = { file_name: target.name, playbook_name: playbook.name, overall: outcome.overall };
      for (const result of outcome.results) rows.push(topicRow(base, document, result));
      rows.push(documentRow(base, document, outcome, extraction.chunks.filter((chunk) => chunk.status === 'failed').map((chunk) => `読み取りに失敗した条文: ${chunk.articleRefs.join('、')}`)));
    }
    return rows;
  }

  /** 画像をページとして文字起こしし、ページ境界つきの本文にする。 */
  private async transcribe(images: ReviewDraftAttachments['images'], signal?: AbortSignal): Promise<{ readonly body: string; readonly pages: readonly ContractPage[]; readonly sourceType: 'image-ocr'; readonly pageCount: number }> {
    const result = await this.transcriber.execute({ images: images.map((image) => image.dataUrl), fileName: images[0]!.name }, signal);
    let body = '';
    const pages: ContractPage[] = [];
    for (const page of result.pages) {
      const start = body.length;
      body += `${page.text}\n`;
      pages.push({ page: page.index + 1, start, end: body.length, method: 'vision', warnings: page.warnings });
    }
    return { body: body.trim() === '' ? '（文字を読み取れませんでした）' : body, pages: body.trim() === '' ? singlePage('（文字を読み取れませんでした）') : pages, sourceType: 'image-ocr', pageCount: result.pages.length };
  }
}

export const CONTRACT_REVIEW_DRAFT_ROW_SCHEMA = CONTRACT_REVIEW_DRAFT_SCHEMA;
