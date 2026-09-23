import { describe, expect, it } from 'vitest';
import { splitAgentToolOperations, type DesignChatOperation } from './design-chat-agent-tool';

const addFilter: DesignChatOperation = { op: 'add-node', id: 'f', type: 'filter', config: { column: 'a', op: 'eq', value: 1 }, after: 'src' };

describe('splitAgentToolOperations（set-agent-tool をグラフの操作から分けて当てる）', () => {
  it('正常: グラフの操作だけなら順序を保ってそのまま返し、agentTool は付かない', () => {
    const split = splitAgentToolOperations([addFilter], { name: 'population', description: 'old' });
    expect(split).toEqual({ ok: true, graphOperations: [addFilter], changes: [] });
  });

  it('正常: 名前を書かない set-agent-tool はいまの名前を残し、一覧の 1 行は固定の nodeId で出る', () => {
    const split = splitAgentToolOperations([addFilter, { op: 'set-agent-tool', description: 'new text' }], { name: 'population', description: 'old' });
    expect(split).toEqual({
      ok: true,
      graphOperations: [addFilter],
      agentTool: { name: 'population', description: 'new text' },
      changes: [{ op: 'set-agent-tool', nodeId: 'agent-tool', summary: 'set the tool description for the agent (new text)' }],
    });
  });

  it('異常: 最初の違反で止め、何番目の操作かを言う（後ろの操作は見ない）', () => {
    const split = splitAgentToolOperations([addFilter, { op: 'set-agent-tool', description: 'ok', name: 'bad name' }, { op: 'set-agent-tool', description: '' }], undefined);
    expect(split).toEqual({ ok: false, problem: expect.stringMatching(/^operation 2 \('set-agent-tool'\): the tool name "bad name" does not match/) });
  });

  it('境界: 空白だけの説明文は「無い」と同じ扱い', () => {
    const split = splitAgentToolOperations([{ op: 'set-agent-tool', description: '   ' }], undefined);
    expect(split).toEqual({ ok: false, problem: expect.stringContaining("operation 1 ('set-agent-tool'): the tool description is missing") });
  });
});
