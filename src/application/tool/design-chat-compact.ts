/**
 * 応用: 設計アシスタントの会話の圧縮（v49 §3.1 / v50 R2）。
 *
 * `DesignToolChatUseCase.compact` はここへの薄い委譲（API と root の配線はユースケースのまま）。
 */
import { z } from 'zod';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ModelProviderPort } from '../model/model-provider';
import type { PromptCatalogPort } from '../prompt/prompt-catalog-port';
import { askDesignModel, invalidResponse, parseJson, usageOf, type DesignChatUsage } from './design-chat-model';
import {
  DESIGN_CHAT_SUMMARY_MAX_CHARS,
  buildDesignChatCompactRequest,
  buildDesignChatShortenRequest,
  type DesignChatCompactTurn,
} from './design-chat-prompt';

/** 会話の圧縮 1 回分の材料（v49 §3.1）。畳むターンは画面が選ぶ（直近 4 ターンは残す）。 */
export interface DesignChatCompactInput {
  readonly scope: TenantScope;
  /** 前回までの要約（あれば新しい要約へ畳み込む。画面は返ってきた要約で**置き換える**）。 */
  readonly previousSummary?: string;
  readonly turns: readonly DesignChatCompactTurn[];
  readonly language: 'ja' | 'en';
}

export interface DesignChatCompactResult {
  /** 次のターンの材料になる覚え書き。 */
  readonly summary: string;
  /** 直前の呼び出しの消費（1 ターンの応答と同じ形）。 */
  readonly usage?: DesignChatUsage;
}

/** 圧縮の応答。要約が欠けていても捨てずに空として読む（呼び手が 1 回だけ問い直す）。 */
const summarySchema = z.object({ summary: z.string().default('') });

/** 圧縮の応答（`{ summary }`）を読む。要約が無い / 空白だけのときは空文字（呼び手が 1 回だけ問い直す）。 */
function parseSummary(content: string): string {
  const parsed = summarySchema.safeParse(parseJson(content));
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data.summary.trim();
}

/**
 * 会話の古いターンを、次のターンで読む覚え書きへ畳む（v49 §3.1）。
 *
 * 要約をモデルに書かせるのは、会話に散らばる**決定と意図**（「全国は除く」「地域は引数にする」）が
 * 機械的な切り詰めでは落ちるため。適用した変更の要約は正確な記録なので、材料として一緒に渡す。
 * ここではグラフを一切見ない（畳むのは会話であって、キャンバスではない）。
 * 使えるかどうか（モデルの設定）の判定は呼び手（ユースケース）が済ませてから呼ぶ。
 */
export async function compactDesignChat(model: ModelProviderPort, prompts: PromptCatalogPort, input: DesignChatCompactInput, signal?: AbortSignal): Promise<DesignChatCompactResult> {
  const request = buildDesignChatCompactRequest(prompts, {
    turns: input.turns,
    language: input.language,
    ...(input.previousSummary === undefined ? {} : { previousSummary: input.previousSummary }),
  });

  let answer = await askDesignModel(model, request, signal);
  let summary = parseSummary(answer.content);
  if (summary === '') {
    // 空の要約は会話を捨てるのと同じ（画面は要約で**置き換える**）。同じ材料でもう 1 回だけ聞く。
    answer = await askDesignModel(model, request, signal);
    summary = parseSummary(answer.content);
  } else if (summary.length > DESIGN_CHAT_SUMMARY_MAX_CHARS) {
    // 末尾を切らずに書き直させる: 切ると、最後に来がちな「未解決の質問」だけが落ちる。
    answer = await askDesignModel(model, buildDesignChatShortenRequest(prompts, request, answer.content), signal);
    const shortened = parseSummary(answer.content);
    // 2 回目が空でも、まだ長くても、得られた文をそのまま返す（長くても会話全体よりは短い）。
    if (shortened !== '') summary = shortened;
  }
  const usage = await usageOf(model, answer);
  return { summary, ...(usage === undefined ? {} : { usage }) };
}
