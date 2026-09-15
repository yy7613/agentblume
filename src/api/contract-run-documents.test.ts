/**
 * POST /runs のテキスト添付（docs/23 §9.4 C2〜C4）が HTTP の本文からツールの実行文脈まで届くこと。
 *
 * 契約書レビューの組込みツール `contract_review_draft` を持つエージェントで確かめる。
 * local + :memory: と台本模型で合成根を組み、LLM 機能は「設定済み」として扱う（仕訳の E2E と同じ）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import type { ModelCompletion } from '../application/model/model-provider';
import { BUILTIN_SCOPE, seedBuiltinTools } from '../builtin-tools';
import { CONTRACT_REVIEW_DRAFT_TOOL_ID } from '../builtin-tools/contract';
import { createApp } from '../composition/root';
import { FLAT_VALUE_KEYS } from '../domain/contract/clause-value';
import { SemVer } from '../domain/tool/semver';
import { buildServer } from './server';

const scope = BUILTIN_SCOPE;
const BODY = [
  '株式会社サンプル商事（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は、次のとおり契約を締結する。',
  '第1条（目的）',
  '甲は、乙に対し、保守業務を委託する。',
  '第2条（契約期間）',
  '本契約の有効期間は、2026年4月1日から2027年3月31日までとする。',
  '第3条（再委託）',
  '乙は、本業務の全部又は一部を第三者に再委託することができる。',
].join('\n');

const stop = (content: string): ModelCompletion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
const value = (overrides: Record<string, unknown>) => ({ ...Object.fromEntries(FLAT_VALUE_KEYS.map((key) => [key, null])), ...overrides });

afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /runs: documents（テキスト添付）', () => {
  it('正常: 本文の documents が contract_review_draft の実行文脈へ届き、モデルには目印だけが載る', async () => {
    vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
    const model = new ScriptedModelProvider();
    const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 保存先ログは出さない */ } });
    const server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
    try {
      await seedBuiltinTools(app);
      await app.saveAgent.execute({
        scope, internalId: 'reviewer', workingName: 'reviewer-draft', displayName: 'Reviewer', publishName: 'reviewer', owner: 'owner', kind: 'normal',
        systemPrompt: '添付の契約書をツールで確認してください。', tools: [{ internalId: CONTRACT_REVIEW_DRAFT_TOOL_ID, version: SemVer.parse('1.0.0') }],
      });
      model.enqueue(
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'contract_review_draft', arguments: {} }] }, finishReason: 'tool_calls' },
        stop(JSON.stringify({
          parties: null, contractNature: null, signingDateText: null, warnings: [],
          findings: [
            { topicId: 'term', articleRef: '第2条', quote: '本契約の有効期間は、2026年4月1日から2027年3月31日までとする。', value: value({ term_start: '2026-04-01', term_end: '2027-03-31', term_months: 12 }), confidence: 0.9, note: null },
            { topicId: 'subcontracting', articleRef: '第3条', quote: '乙は、本業務の全部又は一部を第三者に再委託することができる。', value: value({ permission_policy: 'free' }), confidence: 0.9, note: null },
          ],
        })),
        stop('再委託の条項を交渉してください。'),
      );

      const res = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'reviewer' }, message: '確認して', mode: 'preview', documents: [{ name: 'contract.pdf', text: BODY, pageCount: 1 }] } });

      expect(res.statusCode).toBe(200);
      const run = res.json().run as { trace: { kind: string; name?: string; outputPreview?: Record<string, unknown>[] }[] };
      const rows = run.trace.find((event) => event.kind === 'tool-result' && event.name === 'contract_review_draft')?.outputPreview ?? [];
      expect(rows.find((row) => row['topic_id'] === 'subcontracting')).toMatchObject({ verdict: 'negotiate', file_name: 'contract.pdf' });
      const user = model.requests[0]?.messages.find((message) => message.role === 'user');
      expect(user?.content).toContain('[Attached document: contract.pdf, 1 pages,');
      expect(user?.content).not.toContain('第3条（再委託）');
    } finally {
      await server.close();
      app.close();
    }
  });

  it('異常: 本文の上限を超える documents は 400 で、実行しない', async () => {
    const app = createApp({ profile: 'test' });
    const server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
    try {
      const res = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'reviewer' }, message: 'x', mode: 'preview', documents: [{ name: 'a', text: 'x'.repeat(300_001) }] } });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
      app.close();
    }
  });
});
