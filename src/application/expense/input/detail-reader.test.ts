/**
 * 経費専用の追加読取（InputReceiptDetailReader）と、下書きに対する追加読取（ExtractExpenseDetailUseCase）のテスト。
 * モデルは台本（ScriptedModelProvider）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import { scope } from '../../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpensePolicyRepository } from '../../../adapters/storage/in-memory-expense-repositories';
import type { ExpenseDetailRead } from '../../../domain/expense/detail-read';
import { ExpenseDetailExtractionUnavailableError, ExpenseDomainError } from '../../../domain/expense/errors';
import { ModelProviderError, type ModelCapability, type ModelCompletion } from '../../model/model-provider';
import type { ReceiptDetailReaderPort } from '../ports';
import type { ExpenseItemDraft } from '../receipt-drafts';
import type { ExpenseRepositories } from '../system-deps';
import { DETAIL_SYSTEM_PROMPT, InputReceiptDetailReader, missingModelCapability, modelSnapshotOf, type ExpenseModelBinding } from './detail-reader';
import { draftFromInput, ExtractExpenseDetailUseCase } from './extract-detail';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const AT = '2026-09-15T03:00:00.000Z';

function detailRead(overrides: Partial<ExpenseDetailRead> = {}): ExpenseDetailRead {
  return {
    registrationNumberText: null, payeeNameText: null, transactionDateText: null, issueDateText: null,
    attendees: { countText: null, names: [] }, purposeClues: [], route: { from: null, to: null, via: [], fareType: null }, notes: [],
    ...overrides,
  };
}

const stop = (content: string | null): ModelCompletion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });

function draft(overrides: Partial<ExpenseItemDraft> = {}): ExpenseItemDraft {
  return {
    categoryId: 'meal.entertainment',
    facts: { transactionDate: '2026-09-10', issueDate: '2026-09-10', payeeName: '割烹サンプル', amount: 38_000 },
    source: { type: 'image' },
    extraction: { method: 'llm', warnings: [], documentKind: 'receipt' },
    ...overrides,
  };
}

describe('missingModelCapability / modelSnapshotOf', () => {
  const provider = (capabilities: readonly ModelCapability[]) => ({ capabilities: () => capabilities, complete: async () => stop(null) });

  it('正常: モデル未設定 → 構造化出力 → vision の順に足りないものを返す', async () => {
    expect(await missingModelCapability(undefined, true)).toBe('model');
    expect(await missingModelCapability({ provider: provider(['structured-output', 'vision']), enabled: () => false }, true)).toBe('model');
    expect(await missingModelCapability({ provider: provider(['vision']), enabled: () => true }, true)).toBe('structured-output');
    expect(await missingModelCapability({ provider: provider(['structured-output']), enabled: () => true }, true)).toBe('vision');
    expect(await missingModelCapability({ provider: provider(['structured-output']), enabled: () => true }, false)).toBeUndefined();
    expect(await missingModelCapability({ provider: provider([]), enabled: async () => true, capabilities: async () => ['structured-output', 'vision'] }, true)).toBeUndefined();
  });

  it('例外: モデル名の取得に失敗しても結果は返す（undefined）', async () => {
    const base = { provider: provider([]), enabled: () => true };
    expect(await modelSnapshotOf({ ...base, snapshot: async () => { throw new Error('boom'); } })).toBeUndefined();
    expect(await modelSnapshotOf({ ...base, snapshot: async () => undefined })).toBeUndefined();
    expect(await modelSnapshotOf(base)).toBeUndefined();
    expect(await modelSnapshotOf({ ...base, snapshot: async () => ({ provider: 'lm-studio', model: 'gemma', extra: 1 } as never) })).toEqual({ provider: 'lm-studio', model: 'gemma' });
  });
});

describe('InputReceiptDetailReader', () => {
  let model: ScriptedModelProvider;
  let binding: ExpenseModelBinding;
  let reader: InputReceiptDetailReader;

  beforeEach(() => {
    model = new ScriptedModelProvider();
    binding = { provider: model, enabled: () => true, snapshot: async () => ({ provider: 'lm-studio', model: 'gemma-3-12b' }) };
    reader = new InputReceiptDetailReader({ repositories: { policies: new InMemoryExpensePolicyRepository() } as unknown as ExpenseRepositories, now: () => new Date(AT) }, binding);
  });

  it('正常: 使えるなら available は true。モデルの配線が無ければ false（test プロファイルの構成）', async () => {
    expect(await reader.available()).toBe(true);
    expect(await new InputReceiptDetailReader({ repositories: {} as ExpenseRepositories, now: () => new Date(AT) }).available()).toBe(false);
  });

  it('例外: 使えないときは足りないもの（missing）と設定の導線つきの 409 相当', async () => {
    const noVision = new InputReceiptDetailReader({ repositories: {} as ExpenseRepositories, now: () => new Date(AT) }, { ...binding, capabilities: () => ['structured-output'] });
    await expect(noVision.read({ scope, images: [PNG], draft: draft() })).rejects.toMatchObject({ code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', missing: 'vision' });
    const none = new InputReceiptDetailReader({ repositories: {} as ExpenseRepositories, now: () => new Date(AT) });
    const error = await none.read({ scope, images: [PNG], draft: draft() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExpenseDetailExtractionUnavailableError);
    expect((error as Error).message).toContain('Settings');
  });

  it('異常: 画像が 0 枚・5 枚以上は ExpenseDomainError（モデルを呼ばない）', async () => {
    await expect(reader.read({ scope, images: [], draft: draft() })).rejects.toThrow(ExpenseDomainError);
    await expect(reader.read({ scope, images: [PNG, PNG, PNG, PNG, PNG], draft: draft() })).rejects.toThrow(/1 to 4 images/u);
    expect(model.requests).toHaveLength(0);
  });

  it('正常: 印字どおりの文字列を読ませ、空欄だけを候補で埋め、印と記録を付ける（仕訳の読取の値は変えない）', async () => {
    model.enqueue(stop(JSON.stringify(detailRead({ registrationNumberText: 'T123456789012', attendees: { countText: '4名', names: [] }, purposeClues: ['お品代'], notes: ['日付がかすれている'] }))));
    const result = await reader.read({ scope, images: [PNG], draft: draft({ extraction: { method: 'llm', warnings: [], documentKind: 'receipt', flags: ['detail-read-failed'] } }) });
    expect(result.draft.facts).toEqual({ ...draft().facts, attendees: { count: 4 } });
    expect(result.draft.extraction).toMatchObject({
      flags: ['registration-number-rejected', 'transaction-date-substituted', 'attendees-read'],
      rejectedRegistrationNumber: 'T123456789012',
      detail: { promptVersion: 'expense-detail/v1', model: { provider: 'lm-studio', model: 'gemma-3-12b' }, readAt: AT, disagreements: [] },
    });
    expect(result.draft.extraction.detail?.raw.purposeClues).toEqual(['お品代']);
    expect(result.warnings[0]).toContain('数字 12 桁');
    const request = model.requests[0]!;
    expect(request.responseFormat).toMatchObject({ name: 'expense_detail_read', strict: true });
    expect(request.messages[0]).toEqual({ role: 'system', content: DETAIL_SYSTEM_PROMPT });
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: '読み取りの文脈: {"promptVersion":"expense-detail/v1","imageCount":1,"documentKind":"receipt"}' }, { type: 'image_url', imageUrl: PNG }]);
  });

  it('正常: 区間の設定がある費目では区間の候補を入れ、下書きに生の登録番号があれば上書きしない', async () => {
    model.enqueue(stop(JSON.stringify(detailRead({ route: { from: '中野', to: '霞ケ関', via: [], fareType: 'ic' }, registrationNumberText: 'T1234567890123' }))));
    const base = draft({ categoryId: 'transport.public', facts: { transactionDate: '2026-09-10', amount: 300 }, extraction: { method: 'llm', warnings: [], rejectedRegistrationNumber: 'T12' } });
    const result = await reader.read({ scope, images: [PNG], draft: base });
    expect(result.draft.facts.route).toEqual({ stations: ['中野', '霞ケ関'], trips: 1, fareType: 'ic' });
    expect(result.draft.extraction.rejectedRegistrationNumber).toBe('T12');
    expect(result.disagreements).toEqual([{ field: 'registrationNumber', journalValue: 'T12', detailValue: 'T1234567890123' }]);
    expect(result.draft.extraction.flags).toEqual(expect.arrayContaining(['route-read', 'reads-disagree']));
  });

  it('異常: 応答がスキーマに合わない・モデル呼び出しが失敗したら修復を求めず detail-read-failed の印（仕訳の読取は使える）', async () => {
    model.enqueue(stop('{"registrationNumberText": 1}'));
    const broken = await reader.read({ scope, images: [PNG], draft: draft({ extraction: { method: 'llm', warnings: [], flags: ['purpose-read', 'detail-read-failed'] } }) });
    expect(broken.draft.facts).toEqual(draft().facts);
    expect(broken.draft.extraction.flags).toEqual(['purpose-read', 'detail-read-failed']);
    expect(broken.warnings[0]).toContain('expense-detail/v1');
    expect(model.requests).toHaveLength(1);

    const failed = await reader.read({ scope, images: [PNG], draft: draft() });
    expect(failed.draft.extraction.flags).toEqual(['detail-read-failed']);
    expect(failed.warnings[0]).toContain('no scripted completion available');

    model.enqueue(stop('not json'), stop(null));
    expect((await reader.read({ scope, images: [PNG], draft: draft() })).draft.extraction.flags).toEqual(['detail-read-failed']);
    expect((await reader.read({ scope, images: [PNG], draft: draft() })).draft.extraction.flags).toEqual(['detail-read-failed']);
  });

  it('例外: 中断（signal）はそのまま投げる', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read({ scope, images: [PNG], draft: draft() }, controller.signal)).rejects.toBeInstanceOf(ModelProviderError);
  });

  it('境界: 候補を入れた事実が保存の形に合わなければ候補を入れず印も付けない（記録は残す）', async () => {
    model.enqueue(stop(JSON.stringify(detailRead({ attendees: { countText: '2名', names: [] } }))));
    const invalid = draft({ facts: { amount: 1.5 } as ExpenseItemDraft['facts'] });
    const result = await reader.read({ scope, images: [PNG], draft: invalid });
    expect(result.draft.facts).toEqual({ amount: 1.5 });
    expect(result.draft.extraction.flags).toBeUndefined();
    expect(result.draft.extraction.detail).toBeDefined();
    expect(result.warnings.at(-1)).toContain('形に合わなかった');
  });
});

describe('ExtractExpenseDetailUseCase', () => {
  const read = async (input: Parameters<ReceiptDetailReaderPort['read']>[0]) => ({ draft: input.draft, disagreements: [], warnings: ['ok'] });

  it('正常: 画面から戻ってきた下書きを検証してから読む（source の既定は image）', async () => {
    let seen: Parameters<ReceiptDetailReaderPort['read']>[0] | undefined;
    const reader: ReceiptDetailReaderPort = { available: async () => true, read: async (input) => { seen = input; return read(input); } };
    const result = await new ExtractExpenseDetailUseCase(reader).execute({
      scope, images: [PNG],
      draft: { categoryId: 'misc', categoryText: '雑費', facts: { amount: 500, payeeName: ' 店 ' }, extraction: { method: 'llm', warnings: ['w'], flags: ['payee-read', 'payee-read'] } },
    });
    expect(result.warnings).toEqual(['ok']);
    expect(seen?.draft).toEqual({ categoryId: 'misc', categoryText: '雑費', facts: { amount: 500, payeeName: '店' }, source: { type: 'image' }, extraction: { method: 'llm', warnings: ['w'], flags: ['payee-read'] } });
  });

  it('異常: 事実・印・記録・注意の形が不正なら ExpenseDomainError', () => {
    const base = { facts: {}, extraction: { method: 'llm' as const, warnings: [] } };
    expect(() => draftFromInput({ ...base, facts: { amount: 'x' } })).toThrow(ExpenseDomainError);
    expect(() => draftFromInput({ ...base, extraction: { ...base.extraction, flags: ['nope'] } })).toThrow(ExpenseDomainError);
    expect(() => draftFromInput({ ...base, extraction: { ...base.extraction, detail: { promptVersion: '' } } })).toThrow(ExpenseDomainError);
    expect(() => draftFromInput({ ...base, extraction: { ...base.extraction, warnings: [1 as unknown as string] } })).toThrow(ExpenseDomainError);
    expect(draftFromInput({ ...base, source: { type: 'pdf', fileName: 'a.pdf' } }).source).toEqual({ type: 'pdf', fileName: 'a.pdf' });
  });
});
