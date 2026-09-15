/**
 * 契約の組込みツール 3 本（docs/23 §9）のシード定義。
 * 冪等性・読むだけ・description の必須語・引数スキーマと agent-input の一致・保存時の点検で落ちないこと。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCOPE, seedBuiltinTools } from '../builtin-tools';
import { createApp, type App } from '../composition/root';
import { CONTRACT_CLAUSES_SCHEMA } from '../domain/etl/nodes/contract-clauses-source';
import { CONTRACT_DEADLINES_SCHEMA } from '../domain/etl/nodes/contract-deadlines-source';
import { CONTRACT_REVIEW_DRAFT_SCHEMA } from '../domain/etl/nodes/contract-review-draft';
import {
  CONTRACT_BUILTIN_TOOLS, CONTRACT_CLAUSES_ARGUMENTS, CONTRACT_CLAUSES_TOOL_ID, CONTRACT_DEADLINES_ARGUMENTS, CONTRACT_DEADLINES_TOOL_ID, CONTRACT_REVIEW_DRAFT_TOOL_ID,
} from './contract';

const apps: App[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });
function newApp(): App {
  const app = createApp({ profile: 'test' });
  apps.push(app);
  return app;
}

describe('契約の組込みツールの定義', () => {
  it('正常: 3 本とも読むだけで、internalId・公開名・関数名が業務の接頭辞で揃う', () => {
    expect(CONTRACT_BUILTIN_TOOLS.map((tool) => [tool.internalId, tool.publishName, tool.agentTool?.name, tool.sideEffect])).toEqual([
      [CONTRACT_REVIEW_DRAFT_TOOL_ID, 'contract_review_draft', 'contract_review_draft', 'read-only'],
      [CONTRACT_DEADLINES_TOOL_ID, 'contract_deadlines', 'contract_deadlines', 'read-only'],
      [CONTRACT_CLAUSES_TOOL_ID, 'contract_clauses', 'contract_clauses', 'read-only'],
    ]);
    for (const tool of CONTRACT_BUILTIN_TOOLS) expect(tool.internalId.startsWith('builtin-contract-')).toBe(true);
  });

  it('正常: description に「法的助言ではない」「引数なし / 絞り込み」「読むだけ」の必須語が入る', () => {
    const [review, deadlines, clauses] = CONTRACT_BUILTIN_TOOLS.map((tool) => tool.agentTool?.description ?? '');
    expect(review).toContain('not legal advice');
    expect(review).toContain('Takes no arguments');
    expect(review).toContain('It only proposes');
    expect(review).toContain('If nothing is attached it fails');
    expect(deadlines).toContain('It only reads');
    expect(deadlines).toContain('within_days');
    expect(clauses).toContain('not legal advice');
    expect(clauses).toContain('It only reads');
    // タグの語彙は description に全部書く（モデルが 1 タグをそのまま渡せるように）。
    for (const tag of ['missing', 'no-cap', 'cap-fixed', 'cap-fees-paid', 'cap-unspecified', 'auto-renewal', 'no-auto-renewal', 'payment-over-limit', 'promissory-note', 'subcontract-free', 'subcontract-consent', 'subcontract-notify', 'subcontract-prohibited', 'ip-ours', 'ip-theirs', 'ip-shared', 'ip-unspecified', 'court-exclusive', 'court-non-exclusive', 'unverified']) {
      expect(clauses).toContain(tag);
    }
  });

  it('境界: 引数スキーマと agent-input ノードの schema が一致し、引数なしのツールは agent-input を持たない', () => {
    const argumentsOf = (id: string) => CONTRACT_BUILTIN_TOOLS.find((tool) => tool.internalId === id)?.graph.nodes.find((node) => node.type === 'agent-input')?.config as { schema?: unknown } | undefined;
    expect(argumentsOf(CONTRACT_DEADLINES_TOOL_ID)?.schema).toEqual(CONTRACT_DEADLINES_ARGUMENTS);
    expect(argumentsOf(CONTRACT_CLAUSES_TOOL_ID)?.schema).toEqual(CONTRACT_CLAUSES_ARGUMENTS);
    expect(argumentsOf(CONTRACT_REVIEW_DRAFT_TOOL_ID)).toBeUndefined();
    expect(CONTRACT_BUILTIN_TOOLS.find((tool) => tool.internalId === CONTRACT_REVIEW_DRAFT_TOOL_ID)?.inputSchema).toBeUndefined();
  });
});

describe('契約の組込みツールのシード', () => {
  it('正常: シードで保存でき（保存時の点検で行ソースが落ちない）、再実行しても版を増やさない', async () => {
    const app = newApp();
    const first = await seedBuiltinTools(app);
    const second = await seedBuiltinTools(app);
    expect(second).toEqual(first);
    for (const id of [CONTRACT_REVIEW_DRAFT_TOOL_ID, CONTRACT_DEADLINES_TOOL_ID, CONTRACT_CLAUSES_TOOL_ID]) {
      expect(first.toolIds).toContain(id);
      expect((await app.getTool.latest(BUILTIN_SCOPE, id)).metadata.version.toString()).toBe('1.0.0');
    }
  });

  it('正常: 出力スキーマは各ソースの固定スキーマの列を持つ（0 件でも列が消えない）', async () => {
    const app = newApp();
    await seedBuiltinTools(app);
    const deadlines = await app.previewTool.preview(BUILTIN_SCOPE, CONTRACT_DEADLINES_TOOL_ID);
    expect(deadlines.result.output.schema.columns.map((column) => column.name)).toEqual(CONTRACT_DEADLINES_SCHEMA.columns.map((column) => column.name));
    expect(deadlines.result.output.rows).toEqual([]);
    const clauses = await app.previewTool.preview(BUILTIN_SCOPE, CONTRACT_CLAUSES_TOOL_ID);
    expect(clauses.result.output.schema.columns.map((column) => column.name)).toEqual(CONTRACT_CLAUSES_SCHEMA.columns.map((column) => column.name));
    // 添付を読むツールは文脈の無いプレビューでは書き換えず、固定スキーマの空表になる。
    const review = await app.previewTool.preview(BUILTIN_SCOPE, CONTRACT_REVIEW_DRAFT_TOOL_ID);
    expect(review.result.output.schema.columns.map((column) => column.name)).toEqual(CONTRACT_REVIEW_DRAFT_SCHEMA.columns.map((column) => column.name));
  });
});
