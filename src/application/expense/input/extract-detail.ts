/**
 * application層: 既に読んだ下書きに対して、同じ画像で経費専用の追加読取だけを行う（`POST /expense/receipts/extract-detail`。docs/21 §20.7.1）。
 *
 * 画面の「追加で読む」ボタンが明細ごとに呼ぶ（12B 級で 1 枚数分かかるので、取込の既定は off）。**保存しない**。
 * 画面から戻ってきた下書きは信用せず、事実・読取の印・記録の形を domain の検証に通してから読む。
 */
import type { ItemExtraction } from '../../../domain/expense/claim';
import { validateDetailRecord, validateExtractionFlags } from '../../../domain/expense/detail-read';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { validateReceiptFacts } from '../../../domain/expense/receipt-facts';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ReceiptDetailReaderPort, ReceiptDetailReadResult } from '../ports';
import type { ExpenseItemDraft } from '../receipt-drafts';

export interface ExtractExpenseDetailDraftInput {
  readonly categoryId?: string;
  readonly categoryText?: string;
  readonly facts: unknown;
  readonly source?: { readonly type: 'image' | 'pdf'; readonly fileName?: string };
  readonly extraction: {
    readonly method: ItemExtraction['method'];
    readonly model?: { readonly provider: string; readonly model: string };
    readonly confidence?: number;
    readonly warnings: readonly string[];
    readonly documentKind?: string;
    readonly rejectedRegistrationNumber?: string;
    readonly flags?: readonly string[];
    readonly detail?: unknown;
  };
}

export interface ExtractExpenseDetailInput {
  readonly scope: TenantScope;
  readonly images: readonly string[];
  readonly draft: ExtractExpenseDetailDraftInput;
}

export function draftFromInput(input: ExtractExpenseDetailDraftInput): ExpenseItemDraft {
  const facts = validateReceiptFacts(input.facts, 'draft.facts');
  const flags = validateExtractionFlags(input.extraction.flags, 'draft.extraction.flags');
  const detail = validateDetailRecord(input.extraction.detail, 'draft.extraction.detail');
  const { flags: _flags, detail: _detail, ...extraction } = input.extraction;
  if (extraction.warnings.some((warning) => typeof warning !== 'string')) throw new ExpenseDomainError('draft.extraction.warnings must be strings');
  return {
    ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
    ...(input.categoryText === undefined ? {} : { categoryText: input.categoryText }),
    facts,
    source: input.source ?? { type: 'image' },
    extraction: { ...extraction, warnings: [...extraction.warnings], ...(flags === undefined ? {} : { flags }), ...(detail === undefined ? {} : { detail }) },
  };
}

export class ExtractExpenseDetailUseCase {
  constructor(private readonly reader: ReceiptDetailReaderPort) {}

  async execute(input: ExtractExpenseDetailInput, signal?: AbortSignal): Promise<ReceiptDetailReadResult> {
    const draft = draftFromInput(input.draft);
    return this.reader.read({ scope: input.scope, images: input.images, draft }, signal);
  }
}
