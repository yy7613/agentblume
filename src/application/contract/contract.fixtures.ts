/**
 * application層: 契約のユースケースのテストが使う缶詰モデルと応答の組み立て（テスト専用）。
 *
 * application の非テストファイルは adapters を import できない（depcruise）ので、リポジトリの組み立ては
 * `src/adapters/storage/contract-repository.fixtures.ts` に置き、ここはモデル側だけを持つ。
 */
import { FLAT_VALUE_KEYS } from '../../domain/contract/clause-value';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { ContractModelGate, type Clock } from './support';

export type Responder = (request: ModelCompletionRequest, index: number) => unknown;

/**
 * 能力を差し替えられる缶詰モデル。応答は「キュー」か「リクエストを見て返す関数」で与える。
 * 関数が Error を返したら投げる（呼び出しそのものの失敗を表す）。
 */
export class FakeModel implements ModelProviderPort {
  readonly requests: ModelCompletionRequest[] = [];
  private readonly queue: unknown[] = [];
  responder: Responder | undefined;
  /** complete が呼ばれた直後に走らせる（中断を「呼び出しの途中で」起こすため）。 */
  onComplete: ((index: number) => void) | undefined;

  constructor(private readonly caps: readonly ModelCapability[] = ['chat', 'structured-output', 'vision']) {}

  capabilities(): readonly ModelCapability[] { return this.caps; }

  enqueue(...contents: readonly unknown[]): this {
    this.queue.push(...contents);
    return this;
  }

  respond(responder: Responder): this {
    this.responder = responder;
    return this;
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
    const index = this.requests.length;
    this.requests.push(request);
    const next = this.responder === undefined ? this.queue.shift() : this.responder(request, index);
    this.onComplete?.(index);
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('no scripted completion');
    return { message: { role: 'assistant', content: next === null ? null : typeof next === 'string' ? next : JSON.stringify(next) }, finishReason: 'stop' };
  }
}

export function gateFor(model: ModelProviderPort, options: { readonly enabled?: boolean; readonly snapshot?: { provider: string; model: string } } = {}): ContractModelGate {
  return new ContractModelGate(model, () => options.enabled ?? true, options.snapshot === undefined ? undefined : async () => options.snapshot);
}

/** ローカル日付の正午（TZ に依らず localDate が同じ日を返す）。 */
export function clockAt(date: string): Clock {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return () => new Date(y, m - 1, d, 12, 0, 0);
}

export function sequentialIds(prefix = 'id'): () => string {
  let next = 0;
  return () => { next += 1; return `${prefix}-${next}`; };
}

/** モデルが返す平坦な値（すべてのキーを null で持ち、上書きする）。 */
export function flat(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...Object.fromEntries(FLAT_VALUE_KEYS.map((key) => [key, null])), ...overrides };
}

export interface FindingInput {
  readonly topicId: string;
  readonly quote: string;
  readonly articleRef?: string | null;
  readonly value?: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly note?: string | null;
}

export function finding(input: FindingInput): Record<string, unknown> {
  return { topicId: input.topicId, articleRef: input.articleRef ?? null, quote: input.quote, value: flat(input.value), confidence: input.confidence ?? 0.9, note: input.note ?? null };
}

/** 抽出の応答 1 件（strict スキーマの形）。 */
export function extraction(findings: readonly Record<string, unknown>[], extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { parties: null, contractNature: null, signingDateText: null, findings, warnings: [], ...extra };
}

/** 抽出リクエストの user メッセージから文脈（その束で探すトピック）を読む。 */
export function extractionContext(request: ModelCompletionRequest): { readonly chunkIndex: number; readonly chunkCount: number; readonly topics: readonly { readonly id: string }[] } {
  return JSON.parse(userText(request).split('\n')[0]!.replace('抽出の文脈: ', '')) as never;
}

/** LLM 基準のリクエストの文脈。 */
export function criteriaContext(request: ModelCompletionRequest): { readonly topic: { readonly id: string }; readonly criteria: readonly { readonly criterionId: string; readonly question: string }[]; readonly ourParty: string } {
  return JSON.parse(userText(request).split('\n')[0]!.replace('判断の文脈: ', '')) as never;
}

export function userText(request: ModelCompletionRequest): string {
  const content = request.messages.find((message) => message.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part.type === 'text' ? part.text : `[image:${part.imageUrl}]`)).join('\n');
}

export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
