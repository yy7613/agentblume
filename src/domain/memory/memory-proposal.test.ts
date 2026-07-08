import { describe, expect, it } from 'vitest';
import { MemoryDomainError } from './errors';
import { createMemoryProposal, decideProposal, type MemoryProposalTarget } from './memory-proposal';
import { deserializeMemoryProposal, serializeMemoryProposal } from './serialization';

const scope = { tenantId: 'local', workspaceId: 'default' };
const wikiTarget: MemoryProposalTarget = { kind: 'wiki', pageId: 'p1', isNewPage: true, title: 'T', tags: [' a ', 'a', 'b'], body: 'B' };
const skillTarget: MemoryProposalTarget = { kind: 'skill', skillId: 'analysis', instructions: 'Refined steps.' };

describe('createMemoryProposal', () => {
  it('draft で作成し wiki target のタグを正規化する', () => {
    const p = createMemoryProposal({ id: 'm1', tenant: scope, target: wikiTarget, summary: 'note cohort', sourceRun: 'run-1', createdAt: 't' });
    expect(p.state).toBe('draft');
    expect(p.sourceRun).toBe('run-1');
    expect(p.target.kind === 'wiki' && p.target.tags).toEqual(['a', 'b']);
  });

  it('skill target を保持する', () => {
    const p = createMemoryProposal({ id: 'm2', tenant: scope, target: skillTarget, summary: 's', createdAt: 't' });
    expect(p.target).toMatchObject({ kind: 'skill', skillId: 'analysis', instructions: 'Refined steps.' });
    expect(p.sourceRun).toBeUndefined();
  });

  it('必須欠落・target 内容欠落は MemoryDomainError', () => {
    expect(() => createMemoryProposal({ id: '', tenant: scope, target: wikiTarget, summary: 's', createdAt: 't' })).toThrow(MemoryDomainError);
    expect(() => createMemoryProposal({ id: 'm', tenant: scope, target: { ...wikiTarget, body: '' }, summary: 's', createdAt: 't' })).toThrow(/body/);
    expect(() => createMemoryProposal({ id: 'm', tenant: scope, target: { kind: 'skill', skillId: 'x', instructions: '' }, summary: 's', createdAt: 't' })).toThrow(/instructions/);
    expect(() => createMemoryProposal({ id: 'm', tenant: scope, target: wikiTarget, summary: '  ', createdAt: 't' })).toThrow(/summary/);
  });
});

describe('decideProposal', () => {
  it('draft を approved/rejected へ遷移', () => {
    const p = createMemoryProposal({ id: 'm', tenant: scope, target: wikiTarget, summary: 's', createdAt: 't' });
    expect(decideProposal(p, 'approved').state).toBe('approved');
    expect(decideProposal(p, 'rejected').state).toBe('rejected');
  });

  it('決定済みの再決定は拒否', () => {
    const p = decideProposal(createMemoryProposal({ id: 'm', tenant: scope, target: wikiTarget, summary: 's', createdAt: 't' }), 'approved');
    expect(() => decideProposal(p, 'rejected')).toThrow(MemoryDomainError);
  });
});

describe('memory-proposal serialization', () => {
  it('往復で等価', () => {
    const p = createMemoryProposal({ id: 'm', tenant: scope, target: skillTarget, summary: 's', sourceRun: 'r', createdAt: 't' });
    expect(deserializeMemoryProposal(serializeMemoryProposal(p))).toEqual(p);
  });
});
