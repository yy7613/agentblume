/**
 * application層: 添付された帳票を読み取って「Agent が読む表」へ畳む。
 *
 * ETL の `journal-attachment` ソースノードは domain にあり、モデルにも実行文脈にも到達できない。
 * 実行直前に `ResolveDataSourceGraphUseCase` がこのポートを呼んで行を差し込む
 * （`journal-entries` と同じ規律）。仕訳 BC 側にこのファイルを置き、**列の意味は仕訳 BC が所有する**。
 *
 * 読み取り自体は既存の `ExtractJournalDocumentUseCase`（取込タブと同じもの）に委ねる。
 * ここがやるのは、返ってきた事実を固定列へ平坦化することだけ:
 * - セル（`Cell`）は入れ子を持てないので、税率別の内訳は 10% / 8% の 4 列へ展開する。
 * - 取りこぼす細部（明細・その他の税率）は `facts_json` に JSON 文字列で添える。
 * - インボイス区分は事実に含まれないので、登録番号・取引日・帳票種別から domain の規則で決める。
 *
 * **保存はしない。** 読み取った結果を返すだけで、帳票も仕訳も作らない（判定・確定は画面から人が押す）。
 */
import type { Row } from '../../domain/data/types';
import { JOURNAL_ATTACHMENT_SCHEMA } from '../../domain/etl/nodes/journal-attachment';
import type { DocumentFacts, TotalsByRate } from '../../domain/journal/document';
import { resolveInvoiceStatus } from '../../domain/journal/tax';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExtractJournalDocumentUseCase } from './extract-document';

/** いまの実行に添付された帳票（画像）。 */
export interface JournalAttachment {
  readonly name: string;
  readonly dataUrl: string;
}

export interface JournalAttachmentRowsOptions {
  /** 読む添付の枚数上限。省略時は全部。 */
  readonly limit?: number;
}

function rateOf(totals: readonly TotalsByRate[] | undefined, rate: 10 | 8): TotalsByRate | undefined {
  return (totals ?? []).find((entry) => entry.rate === rate);
}

/** 税率別の 1 行ぶん（対象額・税額）。読めていなければ null。 */
function rateCells(totals: readonly TotalsByRate[] | undefined, rate: 10 | 8): { readonly taxable: number | null; readonly tax: number | null } {
  const found = rateOf(totals, rate);
  if (found === undefined) return { taxable: null, tax: null };
  return { taxable: found.taxableAmount, tax: found.taxAmount ?? null };
}

/**
 * 読み取り結果 1 件 → 表の 1 行。
 * 読めなかった項目は **null**（帳票に書いていない項目があるのは普通のこと）。
 */
export function journalAttachmentRow(
  fileName: string,
  kind: string,
  facts: DocumentFacts,
  extraction: { readonly confidence?: number; readonly warnings: readonly string[] },
  today: string,
): Row {
  const ten = rateCells(facts.totalsByRate, 10);
  const eight = rateCells(facts.totalsByRate, 8);
  const invoiceStatus = resolveInvoiceStatus({
    ...(facts.registrationNumber === undefined ? {} : { registrationNumber: facts.registrationNumber }),
    ...(facts.transactionDate === undefined ? {} : { transactionDate: facts.transactionDate }),
    ...(facts.direction === undefined ? {} : { direction: facts.direction }),
    kind: kind as never,
  }, today);
  return {
    file_name: fileName,
    kind,
    issuer_name: facts.issuerName ?? null,
    registration_number: facts.registrationNumber ?? null,
    invoice_status: invoiceStatus,
    issue_date: facts.issueDate ?? null,
    transaction_date: facts.transactionDate ?? null,
    grand_total: facts.grandTotal ?? null,
    tax_10_taxable: ten.taxable,
    tax_10_tax: ten.tax,
    tax_8_taxable: eight.taxable,
    tax_8_tax: eight.tax,
    description: facts.description ?? null,
    confidence: extraction.confidence ?? null,
    // 読み取りの申告（税率別合計が合わない等）。無ければ空文字（null にすると「申告が読めなかった」と紛れる）。
    warnings: extraction.warnings.join(' / '),
    facts_json: JSON.stringify(facts),
  };
}

/**
 * `journal-attachment` ソースノードの行を供給するポートの実装。
 * `ResolveDataSourceGraphUseCase` が受け取る `JournalAttachmentReadPort` を構造的に満たす
 * （リゾルバ側は型だけを宣言し、こちらは import しない — 仕訳 BC がデータソース BC に依存しない）。
 */
export class JournalAttachmentRowsProvider {
  constructor(
    private readonly extract: ExtractJournalDocumentUseCase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async rows(_scope: TenantScope, attachments: readonly JournalAttachment[], options?: JournalAttachmentRowsOptions): Promise<readonly Row[]> {
    const targets = options?.limit === undefined ? attachments : attachments.slice(0, options.limit);
    const today = this.now().toISOString().slice(0, 10);
    const rows: Row[] = [];
    // 1 枚ずつ読む（別々の帳票なので、まとめて 1 回の読み取りにすると混ざる）。
    // 途中で失敗したらそのまま投げる: 読めた分だけ黙って返すと、モデルが「これで全部」と誤解する。
    for (const attachment of targets) {
      const result = await this.extract.execute({ images: [attachment.dataUrl], fileName: attachment.name });
      rows.push(journalAttachmentRow(attachment.name, result.kind, result.facts, result.extraction, today));
    }
    return rows;
  }
}

/** 供給する行の列（ノードの固定スキーマと必ず一致する）。 */
export const JOURNAL_ATTACHMENT_ROW_SCHEMA = JOURNAL_ATTACHMENT_SCHEMA;
