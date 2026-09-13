/**
 * application層: Stage 1 判定の実行（docs/20 §3）。
 *
 * 判定そのものは純粋関数（`judgeDocument`）で、この層の仕事は
 * 「対象を集める → 判定する → 仕訳と文書の状態を書く → 件数を数える」だけである。
 *
 * ## 確定済みの仕訳は上書きしない
 *
 * 再判定は日常的に起きる（ルールを直したら「未判定を判定」を押す）。そのとき **`confirmed` /
 * `exported` の仕訳を作り直すと、利用者が確認・修正した内容が黙って消える**。
 * 確定済みの仕訳が紐づいている文書は、判定結果だけを更新して仕訳には触れない（文書は `decided` のまま）。
 * 下書き（`draft`）の仕訳は判定が作ったものなので、同じ id のまま中身を差し替える。
 *
 * `exported`（CSV へ出した）文書は判定の対象にしない（domain の `withJudgment` も拒否する）。
 * 明示的に id を指定された場合も黙って飛ばす — 1 件の状態で一括判定を落とすほどの事ではない。
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import { toJournalDocumentSummary, withJudgment, type JournalDocument, type JournalDocumentSummary, type StoredJudgment } from '../../domain/journal/document';
import { createJournalEntry, type JournalEntryDraft } from '../../domain/journal/entry';
import { judgeDocument } from '../../domain/journal/judgment';
import type { ChartOfAccountsRepository, JournalDocumentRepository, JournalEntryRepository, JournalRuleRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 既定の対象（「未判定を判定」が拾う状態）。 */
export const JUDGEABLE_DOCUMENT_STATUSES = ['extracted', 'undecided'] as const;

export interface JudgeJournalDocumentsInput {
  readonly scope: TenantScope;
  /** 省略時は状態が `extracted` / `undecided` の全件。 */
  readonly documentIds?: readonly string[];
}

export interface JudgeJournalDocumentsResult {
  readonly judged: readonly JournalDocumentSummary[];
  readonly decided: number;
  readonly undecided: number;
  readonly skipped: number;
}

export class JudgeJournalDocumentsUseCase {
  constructor(
    private readonly documents: JournalDocumentRepository,
    private readonly rules: JournalRuleRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly entries: JournalEntryRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: JudgeJournalDocumentsInput): Promise<JudgeJournalDocumentsResult> {
    const at = this.now();
    const stamp = at.toISOString();
    const chart = (await this.charts.get(input.scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const rules = await this.rules.list(input.scope);
    const targets = await this.collect(input);

    const judged: JournalDocumentSummary[] = [];
    let decided = 0;
    let undecided = 0;
    let skipped = 0;

    for (const document of targets) {
      const judgment = judgeDocument({ document, rules, chart, now: at });
      let stored: StoredJudgment;
      if (judgment.stage === 'decided') {
        const entryId = await this.writeEntry(input.scope, document, judgment.ruleId, judgment.entry, stamp);
        stored = { stage: 'decided', ruleId: judgment.ruleId, entryId, specificity: judgment.specificity, candidates: judgment.candidates, judgedAt: stamp };
        decided += 1;
      } else if (judgment.stage === 'undecided') {
        stored = { stage: 'undecided', reasons: judgment.reasons, candidates: judgment.candidates, judgedAt: stamp };
        undecided += 1;
      } else {
        stored = { stage: 'skipped', reason: 'document-kind', judgedAt: stamp };
        skipped += 1;
      }
      const updated = withJudgment(document, stored, stamp);
      await this.documents.save(updated);
      judged.push(toJournalDocumentSummary(updated));
    }

    return { judged, decided, undecided, skipped };
  }

  /** 判定対象の文書本体を集める（`exported` は除く）。 */
  private async collect(input: JudgeJournalDocumentsInput): Promise<readonly JournalDocument[]> {
    if (input.documentIds !== undefined) {
      const found = await this.documents.findByIds(input.scope, input.documentIds);
      return found.filter((document) => document.status !== 'exported');
    }
    const summaries = await this.documents.list(input.scope);
    const ids = summaries
      .filter((summary) => (JUDGEABLE_DOCUMENT_STATUSES as readonly string[]).includes(summary.status))
      .map((summary) => summary.id);
    return this.documents.findByIds(input.scope, ids);
  }

  /**
   * 確定した仕訳を書く。戻り値は文書へ載せる仕訳 id。
   * 既存が `confirmed` / `exported` なら**何も書かず**その id を返す（利用者の確認結果を守る）。
   */
  private async writeEntry(
    scope: TenantScope,
    document: JournalDocument,
    ruleId: string,
    draft: JournalEntryDraft,
    at: string,
  ): Promise<string> {
    const existing = document.entryId === undefined ? null : await this.entries.findById(scope, document.entryId);
    if (existing !== null && existing.status !== 'draft') return existing.id;
    const entry = createJournalEntry({
      tenant: scope,
      ...(existing === null ? {} : { id: existing.id }),
      documentId: document.id,
      ruleId,
      date: draft.date,
      lines: draft.lines,
      description: draft.description,
      invoiceStatus: draft.invoiceStatus,
      ...(draft.registrationNumber === undefined ? {} : { registrationNumber: draft.registrationNumber }),
      ...(draft.item === undefined ? {} : { item: draft.item }),
      ...(draft.tags === undefined ? {} : { tags: draft.tags }),
      status: 'draft',
      decidedBy: 'rule',
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }, this.makeId);
    await this.entries.save(entry);
    return entry.id;
  }
}