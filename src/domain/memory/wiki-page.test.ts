import { describe, expect, it } from 'vitest';
import { MemoryDomainError } from './errors';
import { createWikiPage, reviseWikiPage, summarizeWikiPage, type WikiPage } from './wiki-page';

const scope = { tenantId: 'local', workspaceId: 'default' };

function page(): WikiPage {
  return createWikiPage({ id: 'p1', tenant: scope, title: 'Cohort SQL', tags: [' sql ', 'sql', 'analytics', ' '], body: 'Use age filter.', sourceRuns: ['run-1', 'run-1'], updatedAt: '2026-07-08T00:00:00.000Z' });
}

describe('createWikiPage', () => {
  it('version=1 で作成し、タグ・sourceRuns を trim・重複排除する', () => {
    const p = page();
    expect(p.version).toBe(1);
    expect(p.tags).toEqual(['sql', 'analytics']);
    expect(p.sourceRuns).toEqual(['run-1']);
  });

  it('title/body/id 空は MemoryDomainError', () => {
    expect(() => createWikiPage({ id: '', tenant: scope, title: 't', body: 'b', updatedAt: 'x' })).toThrow(MemoryDomainError);
    expect(() => createWikiPage({ id: 'p', tenant: scope, title: '  ', body: 'b', updatedAt: 'x' })).toThrow(MemoryDomainError);
    expect(() => createWikiPage({ id: 'p', tenant: scope, title: 't', body: '', updatedAt: 'x' })).toThrow(/body/);
  });

  it('tenant 欠落は MemoryDomainError', () => {
    expect(() => createWikiPage({ id: 'p', tenant: { tenantId: '', workspaceId: 'w' }, title: 't', body: 'b', updatedAt: 'x' })).toThrow(/tenantId/);
  });
});

describe('reviseWikiPage', () => {
  it('version+1、指定フィールドのみ更新、sourceRun 追記', () => {
    const revised = reviseWikiPage(page(), { body: 'Use age>=18.', addSourceRun: 'run-2', updatedAt: '2026-07-09T00:00:00.000Z' });
    expect(revised.version).toBe(2);
    expect(revised.body).toBe('Use age>=18.');
    expect(revised.title).toBe('Cohort SQL');
    expect(revised.sourceRuns).toEqual(['run-1', 'run-2']);
    expect(revised.updatedAt).toBe('2026-07-09T00:00:00.000Z');
  });

  it('tags 差し替えと空 addSourceRun の無視', () => {
    const revised = reviseWikiPage(page(), { tags: ['x', 'x', 'y'], addSourceRun: '  ', updatedAt: 't2' });
    expect(revised.tags).toEqual(['x', 'y']);
    expect(revised.sourceRuns).toEqual(['run-1']);
  });

  it('空 title/body への改訂は拒否', () => {
    expect(() => reviseWikiPage(page(), { title: '   ', updatedAt: 't' })).toThrow(MemoryDomainError);
  });
});

describe('summarizeWikiPage', () => {
  it('要約は id/title/tags/version/updatedAt を含む', () => {
    expect(summarizeWikiPage(page())).toEqual({ id: 'p1', title: 'Cohort SQL', tags: ['sql', 'analytics'], version: 1, updatedAt: '2026-07-08T00:00:00.000Z' });
  });
});
