/**
 * 応用: 設計アシスタントとモデルの 1 往復（v50 R2）。
 *
 * 1 ターン（`design-tool-chat.ts`）と会話の圧縮（`design-chat-compact.ts`）が同じ呼び方・同じ消費の数え方・
 * 同じ応答の読み方を使うので、ここに 1 つだけ置く（どちらかだけが変わると、画面の目安がずれる）。
 */
import type { z } from 'zod';
import { ModelProviderError, type ModelCompletionRequest, type ModelProviderPort, type ModelUsage } from '../model/model-provider';

/**
 * 直前の呼び出しの消費（v49 §3）。**モデルが数えた実数**だけを載せ、推定はしない。
 * 取れなかった項目は省く（画面は取れたものだけで比率かトークン数を出す）。
 */
export interface DesignChatUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly contextWindow?: number;
}

/** モデルの応答 1 回分（本文と、モデルが数えた消費）。 */
export interface DesignChatAnswer {
  readonly content: string;
  readonly usage?: ModelUsage;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * モデルへの 1 往復。中断はそのまま通し、それ以外の失敗は ModelProviderError に包む。
 * `usage` も一緒に返すのは、応答に載せるのが**直前の呼び出し**の消費だから（契約 §3.2）。
 */
export async function askDesignModel(model: ModelProviderPort, request: ModelCompletionRequest, signal?: AbortSignal): Promise<DesignChatAnswer> {
  try {
    const completion = await model.complete(request, signal);
    return { content: completion.message.content ?? '', ...(completion.usage === undefined ? {} : { usage: completion.usage }) };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (error instanceof ModelProviderError) throw error;
    throw new ModelProviderError(`design assistant could not reach the model: ${describe(error)}`, error);
  }
}

/** モデルが数えた実数だけを残す（負・小数・非数は「数えられていない」と同じ扱い）。 */
function tokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * プロバイダが答える文脈の長さ。任意メソッドなので、持たないプロバイダでは何も起きない。
 * 実装が投げても比率が出ないだけなので、ここで飲み込む（1 ターンを落とす理由にはならない）。
 */
async function contextWindowOf(model: ModelProviderPort): Promise<number | undefined> {
  if (model.contextWindow === undefined) return undefined;
  try {
    const value = await model.contextWindow();
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 直前の呼び出しの消費（契約 §3）。モデルが数えた `usage` と、プロバイダが答える文脈の長さを合わせる。
 * どちらも best-effort で、取れない項目は載せない（推定はしない）。
 */
export async function usageOf(model: ModelProviderPort, answer: { readonly usage?: ModelUsage }): Promise<DesignChatUsage | undefined> {
  const promptTokens = tokenCount(answer.usage?.promptTokens);
  const completionTokens = tokenCount(answer.usage?.completionTokens);
  const contextWindow = await contextWindowOf(model);
  const usage: DesignChatUsage = {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** JSON でない応答は差し戻さずに失敗させる（構造化出力の約束が守られていない）。 */
export function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ModelProviderError('design assistant returned invalid JSON', error);
  }
}

export function invalidResponse(error: z.ZodError): ModelProviderError {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  return new ModelProviderError(`design assistant returned an invalid response: ${issues}`);
}
