/**
 * application層: 画像 / PDF の読取（docs/21 §6.1 / §20.7.1 / ADR-0040 §4 / ADR-0043 §10）。
 *
 * **仕訳の読取ユースケースをそのまま使う**。帳票の読取は業務が違っても同じ事実（発行者・日付・金額・税率別内訳・登録番号）で、
 * プロンプトには実測で詰めた誤読対策が既に入っている。経費用に別のプロンプトを作ると対策を二重に保守することになる。
 * 経費の application は仕訳の application を import しないので、読取は `ReceiptReaderPort` 越しに使い、
 * 実装は composition が仕訳の組み立て結果を包んで注入する。モデル未設定（409）・スキーマ違反（502）はそのまま通す。
 *
 * `detail: true` のときだけ、経費専用の追加読取（C の `ReceiptDetailReaderPort`）を続けて呼ぶ（12B 級で 1 枚数分かかるので既定 off）。
 * 保存しない（利用者が確認・修正してから明細として保存する）。
 */
import { ExpenseDetailExtractionUnavailableError } from '../../domain/expense/errors';
import type { ExpensePolicyRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { loadExpensePolicy } from './manage-policy';
import type { ReceiptDetailReaderPort } from './ports';
import { receiptDraftsFromRead, type ReceiptDraftsResult } from './receipt-drafts';
import type { ReceiptReaderPort } from './receipt-read';

export type { ReceiptReaderPort, ReceiptReadResult, ReceiptSourceFacts } from './receipt-read';

export interface ExtractReceiptInput {
  readonly scope: TenantScope;
  readonly images: readonly string[];
  readonly text?: string;
  readonly fileName?: string;
  /** 経費専用の追加読取も続けて行うか（既定 false）。 */
  readonly detail?: boolean;
}

export type ExtractReceiptResult = ReceiptDraftsResult;

export class ExtractReceiptUseCase {
  constructor(
    private readonly reader: ReceiptReaderPort,
    private readonly policies: ExpensePolicyRepository,
    private readonly detailReader?: ReceiptDetailReaderPort,
  ) {}

  async execute(input: ExtractReceiptInput, signal?: AbortSignal): Promise<ExtractReceiptResult> {
    // 追加読取が使えないのに頼まれたら、遅い仕訳の読取を回す前に断る（待たせてから失敗させない）。
    if (input.detail === true && (this.detailReader === undefined || !await this.detailReader.available())) {
      throw new ExpenseDetailExtractionUnavailableError('the expense detail extraction is not available; choose a model that supports structured output and images in the settings', 'model');
    }
    const read = await this.reader.read({
      images: input.images,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
    }, signal);
    // 費目の推定は保存済みの規程の別名で行う（未保存なら初期テンプレートの別名）。
    const { policy } = await loadExpensePolicy(this.policies, input.scope);
    const result = receiptDraftsFromRead(read, policy, input.fileName);
    if (input.detail !== true || this.detailReader === undefined) return result;
    const drafts = [];
    const warnings = [...result.warnings];
    for (const draft of result.drafts) {
      const detailed = await this.detailReader.read({ scope: input.scope, images: input.images, draft }, signal);
      drafts.push(detailed.draft);
      warnings.push(...detailed.warnings);
    }
    return { ...result, drafts, warnings };
  }
}
