import { describe, expect, it } from 'vitest';
import { fixTargetsForFailure } from './fix-targets';

const agentLabel = ['Open agent settings', 'エージェント設定を開く'];
const modelTarget = { screen: 'Settings', label: ['Open model settings', 'モデル設定を開く'] };
const mcpTarget = { screen: 'MCP', label: ['Open MCP settings', 'MCP設定を開く'] };

describe('fixTargetsForFailure', () => {
  it('失敗したツールとノードが分かっていれば、そのノードを開く遷移を先頭に出し、ボタンはツール名とノードIDを名指しする', () => {
    const targets = fixTargetsForFailure({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: month', tool: { internalId: 'sales-lookup', version: '1.2.0', publishName: 'sales_lookup' }, nodeId: 'in-1' });
    expect(targets).toEqual([{
      screen: 'Tool',
      open: { internalId: 'sales-lookup', version: '1.2.0', nodeId: 'in-1', section: 'agent-context' },
      label: ['Open node "in-1" in tool "sales_lookup"', 'ツール「sales_lookup」のノード「in-1」を開いて直す'],
    }]);
  });

  it('ノードが不明ならツールだけを開き、publishName が無ければ internalId で名指しする', () => {
    const targets = fixTargetsForFailure({ code: 'ETL_GRAPH', message: 'graph has a cycle', tool: { internalId: 'sales-lookup' } });
    expect(targets).toEqual([{ screen: 'Tool', open: { internalId: 'sales-lookup' }, label: ['Open tool "sales-lookup"', 'ツール「sales-lookup」を開いて直す'] }]);
  });

  it.each([
    ['tool name is not a valid function name: 売上', 'agent-context'],
    ["tool inputSchema does not match agent-input node 'in'", 'agent-context'],
    ['tool declares inputSchema but has no agent-input node', 'agent-context'],
    ['required argument missing: month', 'agent-context'],
    ["invalid argument 'score': expected number, received \"x\" (string)", 'agent-context'],
    ['unknown argument(s): region', 'agent-context'],
    ["invalid operator 'like' for argument 'op': expected one of eq, neq", 'agent-context'],
    ['tool output exceeded the configured limit', 'output'],
    ['agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output', 'output'],
    ["declared output schema does not match the graph's inferred output (mismatch at 'x')", 'output'],
  ])('%s → Tool 画面の区画 %s へ深リンクする', (message, section) => {
    const targets = fixTargetsForFailure({ code: 'AGENT_RUN', message, tool: { internalId: 't' } });
    expect(targets[0]?.open).toEqual({ internalId: 't', section });
  });

  it('TOOL_ARGUMENTS は形が未知でも引数定義（agent-context）の区画へ向ける', () => {
    expect(fixTargetsForFailure({ code: 'TOOL_ARGUMENTS', message: 'something new about arguments', tool: { internalId: 't' } })[0]?.open).toEqual({ internalId: 't', section: 'agent-context' });
  });

  it('ツール定義由来でツールが不明なら、エージェントから辿る（ETL_* / TOOL_ARGUMENTS / 定義不整合の定型文）', () => {
    expect(fixTargetsForFailure({ code: 'ETL_SCHEMA', message: 'sort: column(s) not found: age', agent: { internalId: 'sales-agent' } }))
      .toEqual([{ screen: 'Agent', open: { internalId: 'sales-agent' }, label: agentLabel }]);
    for (const message of [
      "tool inputSchema does not match agent-input node 'in'",
      'tool declares inputSchema but has no agent-input node',
      'tool name is not a valid function name: 売上',
      'agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output',
      "filter node 'f1' references an unavailable Agent input",
    ]) {
      expect(fixTargetsForFailure({ code: 'AGENT_RUN', message }).map((target) => target.screen), message).toEqual(['Agent']);
    }
  });

  it('ツール定義由来でツールが分かっているときは Agent ではなく Tool を1つだけ出す（重複させない）', () => {
    const targets = fixTargetsForFailure({ code: 'ETL_GRAPH', message: 'graph has a cycle', tool: { internalId: 't' }, agent: { internalId: 'a' } });
    expect(targets.map((target) => target.screen)).toEqual(['Tool']);
  });

  it('モデル失敗（MODEL_PROVIDER / JUDGE_PROVIDER / 能力不足・未設定・診断の model 検査）はモデル設定へ', () => {
    expect(fixTargetsForFailure({ code: 'MODEL_PROVIDER', message: 'fetch failed' })).toEqual([modelTarget]);
    expect(fixTargetsForFailure({ code: 'JUDGE_PROVIDER', message: 'HTTP 401' })).toEqual([modelTarget]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'configured model provider does not support tool-calling' })).toEqual([modelTarget]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'LM Studio model is not configured' })).toEqual([modelTarget]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'model settings could not be resolved: main slot is empty' })).toEqual([modelTarget]);
  });

  it('MCP を含む失敗は MCP 設定へ（ローカライズ済み文言でも「MCP」は言語非依存なので判定できる）', () => {
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: "MCP tool 'mcp__files__read' is unavailable: its MCP server could not be resolved for this run" })).toEqual([mcpTarget]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'MCPサーバー「files」のツールを読み込めませんでした' })).toEqual([mcpTarget]);
  });

  it('エージェント定義由来はエージェントへ。区画は上限・予算・関数呼び出し無効 → harness、未接続ツール・参照切れ・重複関数名 → tools', () => {
    const agent = { internalId: 'a' };
    for (const message of ['tool call limit exceeded: maximum 4', 'model round limit exceeded: maximum 5', 'run budget exhausted: model rounds', 'model requested a tool call but function invocation is disabled for this agent']) {
      expect(fixTargetsForFailure({ code: 'AGENT_RUN', message, agent }), message).toEqual([{ screen: 'Agent', open: { internalId: 'a', section: 'harness' }, label: agentLabel }]);
    }
    for (const message of ['model requested unknown tool: lookup', 'referenced tool not found: t@1.0.0', 'referenced skill not found: s@1.0.0', 'ambiguous tool versions: t@1.0.0 and t@1.1.0', 'duplicate function name(s): a — later tools with the same name are unreachable']) {
      expect(fixTargetsForFailure({ code: 'AGENT_RUN', message, agent }), message).toEqual([{ screen: 'Agent', open: { internalId: 'a', section: 'tools' }, label: agentLabel }]);
    }
    // サブエージェントの参照切れは区画を特定しない（エージェントを開くだけ）。
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'additional sub-agent not found: sub@1.0.0', agent })).toEqual([{ screen: 'Agent', open: { internalId: 'a' }, label: agentLabel }]);
    // agent が不明なら画面遷移だけ（open 無し）。
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'model requested unknown tool: lookup' })).toEqual([{ screen: 'Agent', label: agentLabel }]);
  });

  it('MCP 絡みでエージェントも遷移先になるときは、エージェント側の区画を mcp にする', () => {
    const targets = fixTargetsForFailure({ code: 'AGENT_RUN', message: 'model requested unknown tool: mcp__files__read (MCP server unreachable)', agent: { internalId: 'a' } });
    expect(targets).toEqual([mcpTarget, { screen: 'Agent', open: { internalId: 'a', section: 'mcp' }, label: agentLabel }]);
  });

  it('複数の形に当たる場合は具体的な順（Tool → Settings → MCP → Agent）に並び、同じ画面は畳む', () => {
    const targets = fixTargetsForFailure({
      code: 'AGENT_RUN',
      message: 'model requested unknown tool: mcp__files__read (MCP server unreachable)',
      tool: { internalId: 't' },
      agent: { internalId: 'a' },
    });
    expect(targets.map((target) => target.screen)).toEqual(['Tool', 'MCP', 'Agent']);
  });

  it('何にも当たらなければ空（ボタン無しで文言だけ出す）', () => {
    expect(fixTargetsForFailure({ code: 'INTERNAL', message: 'internal error' })).toEqual([]);
    expect(fixTargetsForFailure({ code: 'RUN_CANCELLED', message: 'run cancelled by the user' })).toEqual([]);
  });
});

describe('fixTargetsForFailure の境界', () => {
  it('ETL_SCHEMA でツール・ノード・エージェントがすべて分かるときは、ノードつきの Tool だけを出す（Agent を重ねない）', () => {
    expect(fixTargetsForFailure({ code: 'ETL_SCHEMA', message: 'sort: column(s) not found: total', tool: { internalId: 't', version: '1.0.0' }, nodeId: 'sort-1', agent: { internalId: 'a' } }))
      .toEqual([{ screen: 'Tool', open: { internalId: 't', version: '1.0.0', nodeId: 'sort-1' }, label: ['Open node "sort-1" in tool "t"', 'ツール「t」のノード「sort-1」を開いて直す'] }]);
  });

  it('TOOL_ARGUMENTS でツールが不明ならエージェントから辿る（区画は無し。エージェントも不明なら open 無し）', () => {
    expect(fixTargetsForFailure({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: x', agent: { internalId: 'a' } }))
      .toEqual([{ screen: 'Agent', open: { internalId: 'a' }, label: agentLabel }]);
    expect(fixTargetsForFailure({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: x' })).toEqual([{ screen: 'Agent', label: agentLabel }]);
  });

  it('ETL_* の code とエージェント定義の形が同時に当たっても Agent は1つに畳み、区画は形から決める', () => {
    expect(fixTargetsForFailure({ code: 'ETL_SCHEMA', message: 'referenced tool not found: t@1.0.0', agent: { internalId: 'a' } }))
      .toEqual([{ screen: 'Agent', open: { internalId: 'a', section: 'tools' }, label: agentLabel }]);
  });

  it('MCP を含んでもエージェント定義の形に当たらなければ MCP 設定だけ（エージェントが分かっていても）。参照切れはエージェント側の MCP 区画も出す', () => {
    const agent = { internalId: 'a' };
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: "MCP tool 'mcp__files__read' is unavailable: its MCP server could not be resolved for this run", agent })).toEqual([mcpTarget]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: "MCP server 'files' is disabled, so its tools are skipped at run time", agent })).toEqual([mcpTarget]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'referenced MCP server not found: files', agent }))
      .toEqual([mcpTarget, { screen: 'Agent', open: { internalId: 'a', section: 'mcp' }, label: agentLabel }]);
  });

  it('MCP の判定は大文字の「MCP」だけ（小文字の mcp では当たらない）。診断の解決失敗も MCP を含むので MCP 設定へ向く', () => {
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'mcp server down' })).toEqual([]);
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: "MCP server 'files' could not be resolved: connect ECONNREFUSED" })).toEqual([mcpTarget]);
  });

  it('4画面すべてに当たるときは Tool → Settings → MCP → Agent の順に1つずつ並ぶ', () => {
    const targets = fixTargetsForFailure({
      code: 'AGENT_RUN',
      message: 'configured model provider does not support tool-calling; MCP; model requested unknown tool: x',
      tool: { internalId: 't' },
      agent: { internalId: 'a' },
    });
    expect(targets.map((target) => target.screen)).toEqual(['Tool', 'Settings', 'MCP', 'Agent']);
    expect(targets[3]?.open).toEqual({ internalId: 'a', section: 'mcp' });
  });

  it('ツールの version が無ければ open に version キーを作らない', () => {
    const [target] = fixTargetsForFailure({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: x', tool: { internalId: 'sales-lookup' }, nodeId: 'in-1' });
    expect(target?.open).toEqual({ internalId: 'sales-lookup', nodeId: 'in-1', section: 'agent-context' });
    expect(Object.keys(target?.open ?? {})).not.toContain('version');
  });

  it('ラベルはツール名・ノードIDの特殊文字（. ( ) +）をそのまま名指しする', () => {
    const [target] = fixTargetsForFailure({ code: 'ETL_SCHEMA', message: 'x', tool: { internalId: 'id', publishName: 'sales.lookup (v2)+' }, nodeId: 'filter-1.a' });
    expect(target?.label).toEqual(['Open node "filter-1.a" in tool "sales.lookup (v2)+"', 'ツール「sales.lookup (v2)+」のノード「filter-1.a」を開いて直す']);
  });

  it('ローカライズ済みの日本語文言では英語形の判定は効かない（生メッセージを渡す前提）。code が空でも落ちない', () => {
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'モデル設定を確認してください' })).toEqual([]);
    expect(fixTargetsForFailure({ code: '', message: '' })).toEqual([]);
  });

  it('agent-output の上限超過（SESSION_QUOTA_EXCEEDED）は Tool 画面の出力区画へ、失敗ノードつきで向ける', () => {
    const [target] = fixTargetsForFailure({ code: 'SESSION_QUOTA_EXCEEDED', message: 'agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output', tool: { internalId: 't' }, nodeId: 'out-1' });
    expect(target?.open).toEqual({ internalId: 't', nodeId: 'out-1', section: 'output' });
  });

  it('サブエージェントの関数名不正はエージェントを開くだけ（区画は特定しない）', () => {
    expect(fixTargetsForFailure({ code: 'AGENT_RUN', message: 'sub-agent tool name is not a valid function name: x', agent: { internalId: 'a' } }))
      .toEqual([{ screen: 'Agent', open: { internalId: 'a' }, label: agentLabel }]);
  });
});
