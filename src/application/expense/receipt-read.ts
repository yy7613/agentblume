/**
 * application層: 帳票の読取ポートの型（葉モジュール）。
 *
 * `extract-receipt.ts`（ポートを使うユースケース）と `receipt-drafts.ts`（読取結果を明細の下書きへ写す純関数）の
 * 両方が使うので、循環しないよう分けて置く。
 */
import type { PaymentMethod, TotalsByRate } from '../../domain/journal/document';

/** 仕訳の `DocumentFacts` のうち経費が使う部分（構造的に同形）。 */
export interface ReceiptSourceFacts {
  readonly issuerName?: string;
  readonly registrationNumber?: string;
  readonly issueDate?: string;
  readonly transactionDate?: string;
  readonly grandTotal?: number;
  readonly totalsByRate?: readonly TotalsByRate[];
  readonly lines?: readonly { readonly description: string; readonly amount: number; readonly taxRate?: TotalsByRate['rate'] }[];
  readonly paymentMethod?: PaymentMethod;
  readonly description?: string;
  readonly extra?: { readonly [key: string]: unknown };
}

export interface ReceiptReadResult {
  /** 仕訳の `DocumentKind` の値（文字列として受ける）。 */
  readonly documentKind: string;
  readonly facts: ReceiptSourceFacts;
  readonly warnings: readonly string[];
  readonly confidence?: number;
  readonly model?: { readonly provider: string; readonly model: string };
}

export interface ReceiptReaderPort {
  read(input: { readonly images: readonly string[]; readonly text?: string; readonly fileName?: string }, signal?: AbortSignal): Promise<ReceiptReadResult>;
}
