/**
 * ExtractJournalDocumentUseCase のテスト。
 *
 * モデルは缶詰（ネットワークを使わない）。焦点は 3 つ:
 * 1. **モデルの出力を信じない**（和暦・全角・カンマ・ハイフンを正規化し、通らない項目は落として理由を残す）。
 * 2. **実機で出た誤読を warnings で捕まえる**（登録番号の桁数・税率別合計のずれ・税込税抜の食い違い・0 円行）。
 * 3. **使えないときの断り方**（モデル未設定 / vision 非対応 / 入力不正）が利用者に直せる形になっている。
 */
import { describe, expect, it } from 'vitest';
import { JournalDomainError } from '../../domain/journal/errors';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { JournalExtractionSchemaError, JournalExtractionUnavailableError } from './errors';
import { EXTRACT_IMAGE_MAX_CHARS, EXTRACT_MAX_IMAGES, ExtractJournalDocumentUseCase, PROMPT_TEMPLATE_VERSION } from './extract-document';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/** 能力を差し替えられる缶詰モデル（`ScriptedModelProvider` は常に全能力を返すため）。 */
class FakeModel implements ModelProviderPort {
  readonly requests: ModelCompletionRequest[] = [];
  private readonly queue: ModelCompletion[] = [];

  constructor(private readonly caps: readonly ModelCapability[] = ['chat', 'structured-output', 'vision']) {}

  capabilities(): readonly ModelCapability[] { return this.caps; }

  enqueue(...contents: readonly unknown[]): this {
    for (const content of contents) {
      this.queue.push({ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finishReason: 'stop' });
    }
    return this;
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (signal?.aborted === true) throw new Error('aborted');
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('no scripted completion');
    return next;
  }
}

interface RawFactsInput { readonly [key: string]: unknown }

/** モデルが返す facts の雛形（すべてのキーを null で持ち、テストごとに上書きする）。 */
function facts(overrides: RawFactsInput = {}): RawFactsInput {
  return {
    direction: 'out', issuerName: null, recipientName: null, registrationNumber: null,
    issueDate: null, transactionDate: null, dueDate: null, grandTotal: null,
    totalsByRate: null, lines: null, paymentMethod: null, description: null, extra: null,
    ...overrides,
  };
}

function response(overrides: { kind?: string; facts?: RawFactsInput; fieldEvidence?: unknown; warnings?: unknown } = {}) {
  return {
    kind: overrides.kind ?? 'invoice',
    facts: overrides.facts ?? facts(),
    fieldEvidence: overrides.fieldEvidence ?? null,
    warnings: overrides.warnings ?? null,
  };
}

function usecase(model: FakeModel, enabled = true) {
  return new ExtractJournalDocumentUseCase(model, () => enabled, async () => ({ provider: 'lm-studio', model: 'gemma-4-12b' }));
}

describe('ExtractJournalDocumentUseCase（正常系）', () => {
  it('正常: テキストだけでも抽出でき、method / model / confidence / fieldEvidence が付く', async () => {
    const model = new FakeModel().enqueue(response({
      kind: 'invoice',
      facts: facts({ issuerName: 'サンプル商事 霞が関支店', transactionDate: '2026-08-31', issueDate: '2026-09-05', grandTotal: 1230, registrationNumber: 'T1234567890123' }),
      fieldEvidence: { grandTotal: { sourceText: '合計 ¥1,230', confidence: 0.9 }, issuerName: { sourceText: 'サンプル商事 霞が関支店', confidence: 0.7 } },
    }));
    const result = await usecase(model).execute({ text: '請求書 合計 1,230 円' });

    expect(result.kind).toBe('invoice');
    expect(result.facts).toMatchObject({ issuerName: 'サンプル商事 霞が関支店', transactionDate: '2026-08-31', issueDate: '2026-09-05', grandTotal: 1230 });
    expect(result.extraction.method).toBe('llm');
    expect(result.extraction.model).toEqual({ provider: 'lm-studio', model: 'gemma-4-12b' });
    expect(result.extraction.confidence).toBeCloseTo(0.8, 5);
    expect(result.extraction.fieldEvidence?.['grandTotal']).toEqual({ sourceText: '合計 ¥1,230', confidence: 0.9 });
    // 画像が無ければ image_url パートも無い（vision 非対応モデルでも通る要）。
    const parts = model.requests[0]?.messages[1]?.content;
    expect(Array.isArray(parts) && parts.every((part) => part.type === 'text')).toBe(true);
    expect(JSON.stringify(parts)).toContain(PROMPT_TEMPLATE_VERSION);
  });

  it('正常: 和暦・全角数字・カンマ・ハイフン付き登録番号を正規化する', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({
        registrationNumber: 'Ｔ－１２３４－５６７８－９０１２－３',
        issueDate: '令和8年9月5日',
        transactionDate: 'R8.8.31',
        grandTotal: '¥１，２３０',
        description: 'ｶ)サンプル ショウジ',
      }),
    }));
    const result = await usecase(model).execute({ text: 'x' });

    expect(result.facts.registrationNumber).toBe('T1234567890123');
    expect(result.facts.issueDate).toBe('2026-09-05');
    expect(result.facts.transactionDate).toBe('2026-08-31');
    expect(result.facts.grandTotal).toBe(1230);
    // 摘要は正規化され、相手先が切り出される（法人略号 `ｶ)` は落ちる）。
    expect(result.facts.descriptionNorm).toBe('サンプル ショウジ');
    expect(result.facts.counterpartyHint).toBe('サンプル');
  });

  it('正常: 複数税率（税込・税抜混在なし）とお預り / お釣を読み、合計と矛盾しなければ警告を出さない', async () => {
    const model = new FakeModel().enqueue(response({
      kind: 'simplified_invoice',
      facts: facts({
        registrationNumber: 'T9870654320108',
        transactionDate: '2026-09-10',
        grandTotal: 1230,
        totalsByRate: [
          { rate: 10, taxableAmount: 550, taxAmount: 50, amountIncludesTax: true },
          { rate: 8, taxableAmount: 680, taxAmount: 50, amountIncludesTax: true },
        ],
        lines: [
          { description: '弁当', quantity: 1, unitPrice: 680, amount: 680, taxRate: 8, reducedRateMark: true },
          { description: '雑貨', quantity: 1, unitPrice: 550, amount: 550, taxRate: 10, reducedRateMark: false },
        ],
        extra: { receivedAmount: 2000, changeAmount: 770 },
      }),
    }));
    const result = await usecase(model).execute({ images: [PNG] });

    expect(result.facts.totalsByRate).toHaveLength(2);
    expect(result.facts.lines).toHaveLength(2);
    expect(result.facts.extra).toEqual({ receivedAmount: 2000, changeAmount: 770 });
    // 550 + 680 = 1230 = 合計、お預り 2000 − お釣 770 = 1230 なので突き合わせは沈黙する。
    expect(result.extraction.warnings).toEqual([]);
  });

  it('正常: 画像を渡すと image_url パートとして送る（枚数の上限まで）', async () => {
    const model = new FakeModel().enqueue(response());
    await usecase(model).execute({ images: [PNG, PNG], text: 'メモ', fileName: 'receipt.png' });
    const parts = model.requests[0]?.messages[1]?.content;
    expect(Array.isArray(parts) ? parts.filter((part) => part.type === 'image_url').length : 0).toBe(2);
  });
});

describe('ExtractJournalDocumentUseCase（実機で出た誤読を warnings で捕まえる）', () => {
  it('異常: 登録番号が 14 桁なら採用せず、読み取った生の文字列と桁数を warning に残す', async () => {
    const model = new FakeModel().enqueue(response({ kind: 'simplified_invoice', facts: facts({ registrationNumber: 'T98706543201087', grandTotal: 1230, transactionDate: '2026-09-10' }) }));
    const result = await usecase(model).execute({ images: [PNG] });

    expect(result.facts.registrationNumber).toBeUndefined();
    const warning = result.extraction.warnings.find((entry) => entry.includes('T98706543201087'));
    expect(warning).toBeDefined();
    expect(warning).toContain('14 桁');
  });

  it('異常: 登録番号が 12 桁でも同じく落として残す（同じ数字が並ぶと桁を数え違える）', async () => {
    const model = new FakeModel().enqueue(response({ kind: 'receipt', facts: facts({ registrationNumber: 'T111111111111', grandTotal: 1000, transactionDate: '2026-09-10' }) }));
    const result = await usecase(model).execute({ images: [PNG] });

    expect(result.facts.registrationNumber).toBeUndefined();
    expect(result.extraction.warnings.some((entry) => entry.includes('T111111111111') && entry.includes('12 桁'))).toBe(true);
  });

  it('異常: 税率別合計が総額と合わなければ差額つきで警告する（8% を 680 → 880 と誤読した実測）', async () => {
    const model = new FakeModel().enqueue(response({
      kind: 'simplified_invoice',
      facts: facts({
        registrationNumber: 'T9876543210987', transactionDate: '2026-09-10', grandTotal: 1230,
        totalsByRate: [
          { rate: 10, taxableAmount: 550, taxAmount: 50, amountIncludesTax: true },
          { rate: 8, taxableAmount: 880, taxAmount: 65, amountIncludesTax: true },
        ],
      }),
    }));
    const result = await usecase(model).execute({ images: [PNG] });

    const warning = result.extraction.warnings.find((entry) => entry.includes('税率別の内訳の合計'));
    expect(warning).toContain('1430');
    expect(warning).toContain('1230');
    expect(warning).toContain('200 円');
    // 値は勝手に直さない（帳簿の数字を推測で書き換えない）。
    expect(result.facts.totalsByRate?.[1]?.taxableAmount).toBe(880);
  });

  it('境界: 税率行ごとの端数（税率行数まで）のずれは警告しない（国税庁 Q&A 問57）', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({
        registrationNumber: 'T9876543210987', transactionDate: '2026-09-10', grandTotal: 1230,
        totalsByRate: [
          { rate: 10, taxableAmount: 551, taxAmount: 50, amountIncludesTax: true },
          { rate: 8, taxableAmount: 680, taxAmount: 50, amountIncludesTax: true },
        ],
      }),
    }));
    const result = await usecase(model).execute({ images: [PNG] });
    expect(result.extraction.warnings.some((entry) => entry.includes('税率別の内訳の合計'))).toBe(false);
  });

  it('異常: 同じ帳票の税率行で税込 / 税抜が割れていたら警告する', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({
        registrationNumber: 'T9876543210987', transactionDate: '2026-09-10', grandTotal: 1280,
        totalsByRate: [
          { rate: 10, taxableAmount: 550, taxAmount: 50, amountIncludesTax: true },
          { rate: 8, taxableAmount: 676, taxAmount: 54, amountIncludesTax: false },
        ],
      }),
    }));
    const result = await usecase(model).execute({ images: [PNG] });
    expect(result.extraction.warnings.some((entry) => entry.includes('税込 / 税抜が行ごとに食い違っている'))).toBe(true);
  });

  it('境界: 対象額 0 円の税率行は落として理由を残す（記載の無い行の捏造）', async () => {
    const model = new FakeModel().enqueue(response({
      kind: 'receipt',
      facts: facts({
        registrationNumber: 'T9876543210987', transactionDate: '2026-09-10', grandTotal: 1000,
        totalsByRate: [
          { rate: 10, taxableAmount: 1000, taxAmount: 90, amountIncludesTax: true },
          { rate: 8, taxableAmount: 0, taxAmount: 0, amountIncludesTax: true },
        ],
      }),
    }));
    const result = await usecase(model).execute({ images: [PNG] });

    expect(result.facts.totalsByRate).toHaveLength(1);
    expect(result.extraction.warnings.some((entry) => entry.includes('対象額 0 円'))).toBe(true);
  });

  it('境界: 取引年月日が無ければ発行日で代用し、代用したことを残す（経過措置の判定日が変わる）', async () => {
    const model = new FakeModel().enqueue(response({ facts: facts({ issueDate: '2026-09-05', transactionDate: null, grandTotal: 1000, registrationNumber: 'T1234567890123' }) }));
    const result = await usecase(model).execute({ text: 'x' });

    expect(result.facts.transactionDate).toBe('2026-09-05');
    expect(result.extraction.warnings.some((entry) => entry.includes('発行日（2026-09-05）で代用'))).toBe(true);
  });

  it('異常: 明細合計・単価 × 数量・お預り − お釣 のずれをそれぞれ警告する', async () => {
    const model = new FakeModel().enqueue(response({
      kind: 'other',
      facts: facts({
        transactionDate: '2026-09-10', grandTotal: 1000,
        lines: [{ description: '雑貨', quantity: 3, unitPrice: 100, amount: 500, taxRate: 10, reducedRateMark: false }],
        extra: { receivedAmount: 2000, changeAmount: 500 },
      }),
    }));
    const warnings = (await usecase(model).execute({ text: 'x' })).extraction.warnings;

    expect(warnings.some((entry) => entry.includes('明細の合計'))).toBe(true);
    expect(warnings.some((entry) => entry.includes('単価 × 数量'))).toBe(true);
    expect(warnings.some((entry) => entry.includes('お預り'))).toBe(true);
  });

  it('異常: 8% の明細に軽減税率の記号が無い / 請求書なのに登録番号が無い を警告する', async () => {
    const model = new FakeModel().enqueue(response({
      kind: 'invoice',
      facts: facts({
        transactionDate: '2026-09-10', grandTotal: 1080,
        lines: [{ description: '弁当', quantity: null, unitPrice: null, amount: 1080, taxRate: 8, reducedRateMark: null }],
      }),
    }));
    const warnings = (await usecase(model).execute({ text: 'x' })).extraction.warnings;

    expect(warnings.some((entry) => entry.includes('軽減税率の記号'))).toBe(true);
    expect(warnings.some((entry) => entry.includes('登録番号'))).toBe(true);
  });

  it('境界: 日付も金額も読めない帳票は「仕訳日が決まらない」と警告する', async () => {
    const model = new FakeModel().enqueue(response({ kind: 'unknown', facts: facts() }));
    const warnings = (await usecase(model).execute({ text: 'x' })).extraction.warnings;
    expect(warnings.some((entry) => entry.includes('仕訳日が決まらない'))).toBe(true);
  });

  it('異常: 解釈できない日付・金額・明細は落として理由を残す（抽出全体は失敗させない）', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({ transactionDate: '来月末', grandTotal: '不明', lines: [{ description: 'x', quantity: null, unitPrice: null, amount: 'いくらか', taxRate: null, reducedRateMark: null }] }),
    }));
    const result = await usecase(model).execute({ text: 'x' });

    expect(result.facts.transactionDate).toBeUndefined();
    expect(result.facts.grandTotal).toBeUndefined();
    expect(result.facts.lines).toBeUndefined();
    expect(result.extraction.warnings.some((entry) => entry.includes('日付として解釈できなかった'))).toBe(true);
    expect(result.extraction.warnings.some((entry) => entry.includes('金額として解釈できなかった'))).toBe(true);
  });
});

describe('ExtractJournalDocumentUseCase（スキーマ違反と修復）', () => {
  it('正常: 1 回目が JSON でなくても、修復の 1 回で正しければ結果を返す', async () => {
    const model = new FakeModel().enqueue('これは JSON ではありません', response({ facts: facts({ grandTotal: 500, transactionDate: '2026-09-10' }) }));
    const result = await usecase(model).execute({ text: 'x' });

    expect(result.facts.grandTotal).toBe(500);
    expect(model.requests).toHaveLength(2);
    // 修復依頼には「何が駄目だったか」が載る。
    expect(String(model.requests[1]?.messages.at(-1)?.content)).toContain('JSON として読めなかった');
  });

  it('例外: 修復しても壊れていれば JOURNAL_EXTRACTION_SCHEMA（何が合わなかったかを持つ）', async () => {
    const model = new FakeModel().enqueue({ kind: 'invoice' }, { kind: 'nope', facts: 42 });
    await expect(usecase(model).execute({ text: 'x' })).rejects.toBeInstanceOf(JournalExtractionSchemaError);

    const retry = new FakeModel().enqueue({ kind: 'invoice' }, { kind: 'nope', facts: 42 });
    const error = await usecase(retry).execute({ text: 'x' }).catch((thrown: unknown) => thrown) as JournalExtractionSchemaError;
    expect(error.code).toBe('JOURNAL_EXTRACTION_SCHEMA');
    expect(error.issues.join(' ')).toContain('kind');
  });
});

describe('ExtractJournalDocumentUseCase（使えないとき・入力不正）', () => {
  it('異常: 入力が空なら JournalDomainError（モデルを呼ばない）', async () => {
    const model = new FakeModel();
    await expect(usecase(model).execute({ text: '   ' })).rejects.toBeInstanceOf(JournalDomainError);
    expect(model.requests).toHaveLength(0);
  });

  it('境界: 画像は 4 枚まで、1 枚 4,200,000 文字まで', async () => {
    const model = new FakeModel();
    await expect(usecase(model).execute({ images: Array.from({ length: EXTRACT_MAX_IMAGES + 1 }, () => PNG) })).rejects.toThrow(/at most 4 images/u);
    const huge = `data:image/png;base64,${'A'.repeat(EXTRACT_IMAGE_MAX_CHARS)}`;
    await expect(usecase(model).execute({ images: [huge] })).rejects.toThrow(/at most 4200000 characters/u);
  });

  it('異常: data URL でない画像は 400（外部 URL・SVG を送らせない）', async () => {
    const model = new FakeModel();
    await expect(usecase(model).execute({ images: ['https://example.com/a.png'] })).rejects.toBeInstanceOf(JournalDomainError);
    await expect(usecase(model).execute({ images: ['data:image/svg+xml;base64,PHN2Zz4='] })).rejects.toBeInstanceOf(JournalDomainError);
  });

  it('例外: vision 非対応のモデルに画像を渡したら 409 相当（テキストで送る導線を案内する）', async () => {
    const model = new FakeModel(['chat', 'structured-output']);
    const error = await usecase(model).execute({ images: [PNG] }).catch((thrown: unknown) => thrown) as JournalExtractionUnavailableError;
    expect(error).toBeInstanceOf(JournalExtractionUnavailableError);
    expect(error.code).toBe('JOURNAL_EXTRACTION_UNAVAILABLE');
    expect(error.message).toContain('vision');
    expect(error.message).toContain('Settings');
    // テキストだけなら同じモデルで通る。
    model.enqueue(response());
    await expect(usecase(model).execute({ text: 'x' })).resolves.toMatchObject({ kind: 'invoice' });
  });

  it('例外: structured output 非対応・モデル未設定はどちらも JOURNAL_EXTRACTION_UNAVAILABLE', async () => {
    await expect(usecase(new FakeModel(['chat'])).execute({ text: 'x' })).rejects.toBeInstanceOf(JournalExtractionUnavailableError);
    await expect(usecase(new FakeModel(), false).execute({ text: 'x' })).rejects.toBeInstanceOf(JournalExtractionUnavailableError);
  });

  it('境界: available() は「設定済み × structured output」（画像の可否は別）', async () => {
    await expect(usecase(new FakeModel()).available()).resolves.toBe(true);
    await expect(usecase(new FakeModel(['chat'])).available()).resolves.toBe(false);
    await expect(usecase(new FakeModel(), false).available()).resolves.toBe(false);
  });

  it('例外: 既に中断されたシグナルではモデルが走らない（利用者の中断が効く）', async () => {
    const model = new FakeModel().enqueue(response());
    const controller = new AbortController();
    controller.abort();
    await expect(usecase(model).execute({ text: 'x' }, controller.signal)).rejects.toThrow();
  });
});

describe('ExtractJournalDocumentUseCase（0% と読まれた税率の立て直し）', () => {
  it('異常: 実機再現 — 10%/8% の行が両方 0% で返っても、消費税額との比から税率を立て直して警告する', async () => {
    // gemma-4-12b が適格請求書の 2 行を両方 0% で返した実例（対象額と税額は正しかった）。
    const model = new FakeModel().enqueue(response({
      facts: facts({
        grandTotal: 67960,
        totalsByRate: [
          { rate: 0, taxableAmount: 50000, taxAmount: 5000, amountIncludesTax: false },
          { rate: 0, taxableAmount: 12000, taxAmount: 960, amountIncludesTax: false },
        ],
      }),
    }));
    const result = await usecase(model).execute({ text: '請求書' });

    expect(result.facts.totalsByRate?.map((entry) => entry.rate)).toEqual([10, 8]);
    expect(result.extraction.warnings.some((warning) => warning.includes('10% と判断'))).toBe(true);
    expect(result.extraction.warnings.some((warning) => warning.includes('8% と判断'))).toBe(true);
  });

  it('境界: 税込表記の行でも、税を除いた額との比から税率を立て直す', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({ grandTotal: 55000, totalsByRate: [{ rate: 0, taxableAmount: 55000, taxAmount: 5000, amountIncludesTax: true }] }),
    }));
    const result = await usecase(model).execute({ text: '請求書' });

    expect(result.facts.totalsByRate?.[0]?.rate).toBe(10);
  });

  it('異常: どの税率にも合わない消費税額なら 0% のままにし、矛盾していることだけを警告する', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({ grandTotal: 50777, totalsByRate: [{ rate: 0, taxableAmount: 50000, taxAmount: 777, amountIncludesTax: false }] }),
    }));
    const result = await usecase(model).execute({ text: '請求書' });

    expect(result.facts.totalsByRate?.[0]?.rate).toBe(0);
    expect(result.extraction.warnings.some((warning) => warning.includes('0% なのに消費税額'))).toBe(true);
    expect(result.extraction.warnings.some((warning) => warning.includes('と判断'))).toBe(false);
  });

  it('境界: 消費税額の無い 0% 行（輸出免税・対象外）はそのまま通し、警告も出さない', async () => {
    const model = new FakeModel().enqueue(response({
      facts: facts({ grandTotal: 50000, totalsByRate: [{ rate: 0, taxableAmount: 50000, taxAmount: null, amountIncludesTax: false }] }),
    }));
    const result = await usecase(model).execute({ text: '請求書' });

    expect(result.facts.totalsByRate?.[0]?.rate).toBe(0);
    expect(result.extraction.warnings.some((warning) => warning.includes('0% なのに消費税額'))).toBe(false);
  });
});
