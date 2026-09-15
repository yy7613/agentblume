import { describe, expect, it, vi } from 'vitest';
import { policyFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpensePolicyRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { ExpenseDetailExtractionUnavailableError } from '../../domain/expense/errors';
import { createExpensePolicy } from '../../domain/expense/policy';
import { ExtractReceiptUseCase, type ReceiptReaderPort, type ReceiptReadResult } from './extract-receipt';
import type { ReceiptDetailReaderPort, ReceiptDetailReadResult } from './ports';

class FakeReader implements ReceiptReaderPort {
  readonly calls: { input: Parameters<ReceiptReaderPort['read']>[0]; signal: AbortSignal | undefined }[] = [];
  constructor(private readonly outcome: ReceiptReadResult | Error) {}
  async read(input: Parameters<ReceiptReaderPort['read']>[0], signal?: AbortSignal): Promise<ReceiptReadResult> {
    this.calls.push({ input, signal });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

/** 仕訳の読取ユースケースが投げる「モデル未設定」相当（409 に写される）。 */
class ModelNotConfiguredError extends Error {
  readonly status = 409;
}

const RESULT: ReceiptReadResult = { documentKind: 'receipt', facts: { issuerName: 'ゆうびん局', grandTotal: 84, transactionDate: '2026-09-10' }, warnings: [] };

describe('ExtractReceiptUseCase', () => {
  it('正常: 画像・テキスト・ファイル名と signal をそのまま読取ポートへ渡す', async () => {
    const reader = new FakeReader(RESULT);
    const controller = new AbortController();
    await new ExtractReceiptUseCase(reader, new InMemoryExpensePolicyRepository()).execute({ scope, images: ['data:image/png;base64,AA'], text: '本文', fileName: 'a.pdf' }, controller.signal);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]!.input).toEqual({ images: ['data:image/png;base64,AA'], text: '本文', fileName: 'a.pdf' });
    expect(reader.calls[0]!.signal).toBe(controller.signal);
  });

  it('境界: テキスト・ファイル名を省略したら入力に含めない', async () => {
    const reader = new FakeReader(RESULT);
    const result = await new ExtractReceiptUseCase(reader, new InMemoryExpensePolicyRepository()).execute({ scope, images: [] });
    expect(reader.calls[0]!.input).toEqual({ images: [] });
    expect(reader.calls[0]!.signal).toBeUndefined();
    expect(result.drafts[0]!.source).toEqual({ type: 'image' });
  });

  it('正常: 費目の推定は保存済みの規程の別名で行う（未保存なら初期テンプレート）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const useCase = new ExtractReceiptUseCase(new FakeReader(RESULT), policies);
    // 初期テンプレートには「ゆうびん」の別名が無い
    expect((await useCase.execute({ scope, images: [] })).drafts[0]).not.toHaveProperty('categoryId');
    const base = policyFixture();
    await policies.save(scope, createExpensePolicy({ ...base, categories: base.categories.map((category) => (category.id === 'communication' ? { ...category, aliases: [...category.aliases, 'ゆうびん'] } : category)) }));
    expect((await useCase.execute({ scope, images: [] })).drafts[0]!.categoryId).toBe('communication');
  });

  it('例外: 読取ポートの例外（モデル未設定の 409 など）はそのまま伝える', async () => {
    const error = new ModelNotConfiguredError('no vision model');
    await expect(new ExtractReceiptUseCase(new FakeReader(error), new InMemoryExpensePolicyRepository()).execute({ scope, images: ['x'] })).rejects.toBe(error);
  });
});

/** 追加読取の偽物（C の実装の代わり）。読むたびに目的を埋め、印と警告を足す。 */
class FakeDetailReader implements ReceiptDetailReaderPort {
  readonly reads: Parameters<ReceiptDetailReaderPort['read']>[0][] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly available = vi.fn(async () => this.usable);
  constructor(private readonly usable: boolean) {}
  async read(input: Parameters<ReceiptDetailReaderPort['read']>[0], signal?: AbortSignal): Promise<ReceiptDetailReadResult> {
    this.reads.push(input);
    this.signals.push(signal);
    return {
      draft: { ...input.draft, facts: { ...input.draft.facts, purpose: '客先訪問' }, extraction: { ...input.draft.extraction, flags: ['purpose-read'] } },
      disagreements: [],
      warnings: [`目的を読み取りました（${this.reads.length} 件目）`],
    };
  }
}

describe('ExtractReceiptUseCase: 経費専用の追加読取（detail。§20.7.1）', () => {
  it('例外: 追加読取を配線していない・使えないのに detail: true なら、遅い仕訳の読取を回す前に EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE（missing = model）', async () => {
    for (const detailReader of [undefined, new FakeDetailReader(false)]) {
      const reader = new FakeReader(RESULT);
      const error = await new ExtractReceiptUseCase(reader, new InMemoryExpensePolicyRepository(), detailReader).execute({ scope, images: ['x'], detail: true }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExpenseDetailExtractionUnavailableError);
      expect(error).toMatchObject({ code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', missing: 'model' });
      expect(reader.calls).toEqual([]);
      expect(detailReader?.reads ?? []).toEqual([]);
    }
  });

  it('正常: 使えるとき、仕訳の読取の下書きを追加読取の結果で置き換え、警告を後ろに足す（画像と signal はそのまま渡す）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const plain = await new ExtractReceiptUseCase(new FakeReader(RESULT), policies).execute({ scope, images: ['data:image/png;base64,AA'], fileName: 'r.png' });
    const detailReader = new FakeDetailReader(true);
    const controller = new AbortController();
    const result = await new ExtractReceiptUseCase(new FakeReader(RESULT), policies, detailReader).execute({ scope, images: ['data:image/png;base64,AA'], fileName: 'r.png', detail: true }, controller.signal);
    expect(detailReader.reads).toEqual([{ scope, images: ['data:image/png;base64,AA'], draft: plain.drafts[0] }]);
    expect(detailReader.signals).toEqual([controller.signal]);
    expect(result.drafts).toEqual([{ ...plain.drafts[0], facts: { ...plain.drafts[0]!.facts, purpose: '客先訪問' }, extraction: { ...plain.drafts[0]!.extraction, flags: ['purpose-read'] } }]);
    expect(result.warnings).toEqual([...plain.warnings, '目的を読み取りました（1 件目）']);
  });

  it('境界: detail を省略・false にすれば、追加読取を配線していても尋ねも読みもしない', async () => {
    const detailReader = new FakeDetailReader(true);
    for (const detail of [undefined, false]) {
      await new ExtractReceiptUseCase(new FakeReader(RESULT), new InMemoryExpensePolicyRepository(), detailReader).execute({ scope, images: ['x'], ...(detail === undefined ? {} : { detail }) });
    }
    expect(detailReader.available).not.toHaveBeenCalled();
    expect(detailReader.reads).toEqual([]);
  });

  it('例外: 追加読取の失敗はそのまま伝える（下書きを半端に返さない）', async () => {
    const detailReader = new FakeDetailReader(true);
    vi.spyOn(detailReader, 'read').mockRejectedValue(new Error('schema violation'));
    await expect(new ExtractReceiptUseCase(new FakeReader(RESULT), new InMemoryExpensePolicyRepository(), detailReader).execute({ scope, images: ['x'], detail: true })).rejects.toThrow('schema violation');
  });
});
