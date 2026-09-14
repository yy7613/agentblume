/**
 * application層: 添付帳票を読み取り、保存済みのルールで判定して「仕訳案」の表にする。
 *
 * 仕訳画面の 取込 → 判定 を 1 本のツールとして通すためのもの（docs/20 §14.4）。
 * 読み取りは `ExtractJournalDocumentUseCase`（取込タブと同じ）、判定は domain の純粋関数
 * `judgeDocument` に委ねる。**保存はしない** — 帳票も仕訳も作らず、判定結果を返すだけ。
 * 帳簿へ残すのは画面から人が押す（docs/20 §14.1）。
 *
 * `judgeDocument` は確定時に仕訳案（`JournalEntryDraft`）そのものを返すので、
 * ここで仕訳を組み直す必要は無い。やるのは行への平坦化だけ:
 * - 確定した帳票は **1 行 = 1 仕訳行**（借方・貸方それぞれ）。
 * - 確定しなかった帳票は、行の代わりに `decided = false` と理由を持つ 1 行。
 *   空表にすると「仕訳が無い」と「判定できなかった」を区別できないため。
 */
import type { Row } from '../../domain/data/types';
import { JOURNAL_DRAFT_ENTRY_SCHEMA } from '../../domain/etl/nodes/journal-draft-entry';
import { findAccount, type ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import type { DocumentFacts, DocumentKind, UndecidedReason } from '../../domain/journal/document';
import type { JournalEntryDraft } from '../../domain/journal/entry';
import { judgeDocument } from '../../domain/journal/judgment';
import type { ChartOfAccountsRepository, JournalRuleRepository } from '../../domain/journal/repositories';
import type { JournalRule } from '../../domain/journal/rule';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExtractJournalDocumentUseCase } from './extract-document';

/** いまの実行に添付された帳票（画像）。 */
export interface JournalDraftEntryAttachment {
  readonly name: string;
  readonly dataUrl: string;
}

export interface JournalDraftEntryRowsOptions {
  /** 読む添付の枚数上限。省略時は全部。 */
  readonly limit?: number;
}

/** 確定しなかった理由を 1 語で（複数あれば先頭。詳細は画面で見る）。 */
function reasonOf(reasons: readonly UndecidedReason[]): string {
  return reasons[0]?.code ?? 'unknown';
}

/** 判定できない帳票種別・確定しなかった帳票の 1 行（仕訳の列はすべて null）。 */
function undecidedRow(fileName: string, reason: string, facts: DocumentFacts): Row {
  return {
    file_name: fileName,
    decided: false,
    reason,
    rule_id: null,
    rule_name: null,
    line_no: null,
    side: null,
    account: null,
    tax_code: null,
    amount: null,
    partner: null,
    date: null,
    description: null,
    invoice_status: null,
    facts_json: JSON.stringify(facts),
  };
}

/** 確定した仕訳案を 1 行 = 1 仕訳行へ。科目名は**現在のマスタ**から引き直す（改名に追従する）。 */
export function journalDraftEntryRows(
  fileName: string,
  entry: JournalEntryDraft,
  rule: { readonly id: string; readonly name: string } | undefined,
  chart: ChartOfAccounts,
  facts: DocumentFacts,
): readonly Row[] {
  const factsJson = JSON.stringify(facts);
  return entry.lines.map((line, index) => ({
    file_name: fileName,
    decided: true,
    reason: null,
    rule_id: rule?.id ?? null,
    rule_name: rule?.name ?? null,
    line_no: index + 1,
    side: line.side,
    // マスタから消えた科目だけ、判定時の名称へ落とす（名前が空の行を Agent に見せない）。
    account: findAccount(chart, line.accountId)?.name ?? line.accountName,
    tax_code: line.taxCode,
    amount: line.amount,
    partner: line.partner ?? null,
    date: entry.date,
    description: entry.description,
    invoice_status: entry.invoiceStatus,
    facts_json: factsJson,
  }));
}

/**
 * `journal-draft-entry` ソースノードの行を供給するポートの実装。
 * リゾルバ側は型だけを宣言し、こちらは import しない（仕訳 BC がデータソース BC に依存しない）。
 */
export class JournalDraftEntryRowsProvider {
  constructor(
    private readonly extract: ExtractJournalDocumentUseCase,
    private readonly rules: JournalRuleRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async rows(scope: TenantScope, attachments: readonly JournalDraftEntryAttachment[], options?: JournalDraftEntryRowsOptions): Promise<readonly Row[]> {
    const targets = options?.limit === undefined ? attachments : attachments.slice(0, options.limit);
    if (targets.length === 0) return [];
    // マスタが未保存のワークスペースでも科目名が出るよう、標準セットへ落とす（出力と同じ規律）。
    const chart = (await this.charts.get(scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const rules: readonly JournalRule[] = await this.rules.list(scope);
    const at = this.now();

    const rows: Row[] = [];
    // 1 枚ずつ読む（別々の帳票なので、まとめて 1 回の読み取りにすると混ざる）。
    for (const attachment of targets) {
      const read = await this.extract.execute({ images: [attachment.dataUrl], fileName: attachment.name });
      const judgment = judgeDocument({ document: { kind: read.kind as DocumentKind, facts: read.facts }, rules, chart, now: at });
      if (judgment.stage === 'decided') {
        const rule = rules.find((candidate) => candidate.id === judgment.ruleId);
        rows.push(...journalDraftEntryRows(attachment.name, judgment.entry, rule === undefined ? undefined : { id: rule.id, name: rule.name }, chart, read.facts));
        continue;
      }
      // 判定できない帳票種別（見積書・納品書）は `skipped`。理由の語をそのまま返す。
      rows.push(undecidedRow(attachment.name, judgment.stage === 'skipped' ? 'document-kind' : reasonOf(judgment.reasons), read.facts));
    }
    return rows;
  }
}

/** 供給する行の列（ノードの固定スキーマと必ず一致する）。 */
export const JOURNAL_DRAFT_ENTRY_ROW_SCHEMA = JOURNAL_DRAFT_ENTRY_SCHEMA;
