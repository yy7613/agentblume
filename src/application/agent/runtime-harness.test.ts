import { describe, expect, it } from 'vitest';
import type { ModelRequestMessage } from '../model/model-provider';
import {
  agentMemoryWikiId, compactModelMessages, totalMessageChars,
  HARNESS_COMPACTION_BUDGET_CHARS, HARNESS_MAX_MODEL_ROUNDS, HARNESS_MAX_TOOL_CALLS,
} from './runtime-harness';

const fill = (length: number, character = 'x') => character.repeat(length);
const toolMessage = (id: string, length: number): ModelRequestMessage => ({ role: 'tool', content: fill(length), toolCallId: id });

describe('compactModelMessages', () => {
  it('予算内なら何もせず同内容を返す（境界: ちょうど予算は非圧縮）', () => {
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: fill(5) },
      toolMessage('a', 300), toolMessage('b', 300), toolMessage('c', 300),
      { role: 'user', content: fill(95) },
    ];
    expect(totalMessageChars(messages)).toBe(1_000);

    const exact = compactModelMessages(messages, { budgetChars: 1_000, historyCount: 0 });
    expect(exact.compacted).toBe(false);
    expect(exact.beforeChars).toBe(1_000);
    expect(exact.afterChars).toBe(1_000);
    expect(exact.messages).toEqual(messages);

    // 1文字でも超えたら圧縮する。
    const over = compactModelMessages(messages, { budgetChars: 999, historyCount: 0 });
    expect(over.compacted).toBe(true);
    expect(over.afterChars).toBeLessThan(over.beforeChars);
  });

  it('直近2件を除くtoolメッセージだけを240字+マーカーへ切り詰める', () => {
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: fill(1) },
      toolMessage('a', 1_000), toolMessage('b', 1_000), toolMessage('c', 1_000),
    ];
    const result = compactModelMessages(messages, { budgetChars: 1_000, historyCount: 0 });
    expect(result.compacted).toBe(true);
    expect(String(result.messages[1]?.content)).toBe(`${fill(240)}… [compacted]`);
    // 直近2件のtool結果は無傷のまま残る。
    expect(String(result.messages[2]?.content)).toHaveLength(1_000);
    expect(String(result.messages[3]?.content)).toHaveLength(1_000);
    expect(result.afterChars).toBe(1 + 253 + 1_000 + 1_000);
    // 入力は破壊しない。
    expect(String(messages[1]?.content)).toHaveLength(1_000);
  });

  it('240字以下のtoolメッセージは触らない', () => {
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: fill(1) },
      toolMessage('a', 10), toolMessage('b', 10), toolMessage('c', 10),
      { role: 'user', content: fill(100) },
    ];
    const result = compactModelMessages(messages, { budgetChars: 10, historyCount: 0 });
    expect(result.messages).toEqual(messages);
    expect(result.compacted).toBe(false);
  });

  it('tool切り詰めでも足りなければ、system直後の履歴を古い順にペアで削除する', () => {
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: fill(10) },
      { role: 'user', content: fill(500, 'a') },
      { role: 'assistant', content: fill(500, 'b') },
      { role: 'user', content: fill(500, 'c') },
      { role: 'assistant', content: fill(500, 'd') },
      { role: 'user', content: fill(200, 'z') },
    ];
    const all = compactModelMessages(messages, { budgetChars: 1_000, historyCount: 4 });
    expect(all.messages.map((message) => String(message.content).slice(0, 1))).toEqual(['x', 'z']);
    expect(all.remainingHistoryCount).toBe(0);
    expect(all.beforeChars).toBe(2_210);
    expect(all.afterChars).toBe(210);

    // 予算を満たした時点で削除を止める（1ペアだけ落とす）。
    const partial = compactModelMessages(messages, { budgetChars: 1_500, historyCount: 4 });
    expect(partial.messages.map((message) => String(message.content).slice(0, 1))).toEqual(['x', 'c', 'd', 'z']);
    expect(partial.remainingHistoryCount).toBe(2);
    expect(partial.afterChars).toBe(1_210);
  });

  it('履歴が奇数件なら最後は1件だけ削除し、履歴が尽きたら超過のまま返す', () => {
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: fill(10) },
      { role: 'user', content: fill(400, 'a') },
      { role: 'assistant', content: fill(400, 'b') },
      { role: 'user', content: fill(400, 'c') },
      { role: 'user', content: fill(900, 'z') },
    ];
    const result = compactModelMessages(messages, { budgetChars: 100, historyCount: 3 });
    expect(result.messages.map((message) => String(message.content).slice(0, 1))).toEqual(['x', 'z']);
    expect(result.remainingHistoryCount).toBe(0);
    // 履歴を出し切っても予算内に収まらないことはある（system/現ターンは残す）。
    expect(result.afterChars).toBe(910);
    expect(result.compacted).toBe(true);
  });

  it('マルチモーダルcontentとnull contentも文字数へ算入する', () => {
    const messages: ModelRequestMessage[] = [
      { role: 'assistant', content: null },
      { role: 'user', content: [{ type: 'text', text: fill(7) }, { type: 'image_url', imageUrl: fill(3) }] },
    ];
    expect(totalMessageChars(messages)).toBe(10);
  });
});

describe('runtime harness constants', () => {
  it('ハーネス明示設定Agentのノード内上限を既定より広く取る', () => {
    expect(HARNESS_MAX_MODEL_ROUNDS).toBe(8);
    expect(HARNESS_MAX_TOOL_CALLS).toBe(12);
    expect(HARNESS_COMPACTION_BUDGET_CHARS).toBe(24_000);
  });

  it('File memoryの専用wikiIdはAgent internalIdから決まる', () => {
    expect(agentMemoryWikiId('sales-agent')).toBe('agent-memory--sales-agent');
  });
});
