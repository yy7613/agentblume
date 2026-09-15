/**
 * POST /runs の本文のテキスト添付（docs/23 §9.4 C2）。画像添付（images）の形は変えずに `documents` を足した。
 */
import { describe, expect, it } from 'vitest';
import { runAgentBodySchema } from './schemas';

const scope = { tenantId: 't', workspaceId: 'w' };
const agentBody = { scope, agent: { internalId: 'agent' }, message: 'この契約書を見て' };
const toolBody = { scope, tool: { internalId: 'tool' }, systemPrompt: 'use tools', message: 'hi' };

describe('runAgentBodySchema: documents', () => {
  it.each([['保存済みエージェント', agentBody], ['ツールのプレビュー', toolBody]] as const)('正常: %s の本文でテキスト添付を受け付ける', (_label, body) => {
    const parsed = runAgentBodySchema.safeParse({ ...body, documents: [{ name: 'contract.pdf', text: '第1条', pageCount: 12 }] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.documents).toEqual([{ name: 'contract.pdf', text: '第1条', pageCount: 12 }]);
  });

  it('正常: 省略できる（従来の本文のまま通る）', () => {
    const parsed = runAgentBodySchema.safeParse(agentBody);
    expect(parsed.success && parsed.data.documents).toBeUndefined();
  });

  it('境界: 1 件 300,000 文字・2 件・合計 400,000 文字までは通る', () => {
    expect(runAgentBodySchema.safeParse({ ...agentBody, documents: [{ name: 'a', text: 'x'.repeat(300_000) }] }).success).toBe(true);
    expect(runAgentBodySchema.safeParse({ ...agentBody, documents: [{ name: 'a', text: 'x'.repeat(200_000) }, { name: 'b', text: 'x'.repeat(200_000) }] }).success).toBe(true);
  });

  it.each([
    ['1 件が 300,000 文字を超える', [{ name: 'a', text: 'x'.repeat(300_001) }]],
    ['3 件', [{ name: 'a', text: 'x' }, { name: 'b', text: 'x' }, { name: 'c', text: 'x' }]],
    ['合計が 400,000 文字を超える', [{ name: 'a', text: 'x'.repeat(200_001) }, { name: 'b', text: 'x'.repeat(200_000) }]],
    ['本文が空', [{ name: 'a', text: '' }]],
    ['名前が空', [{ name: '', text: 'x' }]],
    ['ページ数が 0', [{ name: 'a', text: 'x', pageCount: 0 }]],
  ])('異常: %s は受け付けない', (_label, documents) => {
    expect(runAgentBodySchema.safeParse({ ...agentBody, documents }).success).toBe(false);
  });

  it('例外: 画像添付の規則は変わらない（外部 URL は拒否、data URL は通る）', () => {
    expect(runAgentBodySchema.safeParse({ ...agentBody, images: [{ name: 'a.png', dataUrl: 'https://example.com/a.png' }] }).success).toBe(false);
    expect(runAgentBodySchema.safeParse({ ...agentBody, images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAA=' }], documents: [{ name: 'c', text: 'x' }] }).success).toBe(true);
  });
});
