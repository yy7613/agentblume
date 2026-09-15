import { describe, expect, it, vi } from 'vitest';
import { AT, playbookFixture, scope } from '../../adapters/storage/contract-repository.fixtures';
import { InMemoryContractPlaybookRepository } from '../../adapters/storage/in-memory-contract-repositories';
import { ContractDomainError, ContractPlaybookNotFoundError } from '../../domain/contract/errors';
import { DEFAULT_TEMPLATE_ID, PLAYBOOK_TEMPLATES } from '../../domain/contract/playbook-templates';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { sequentialIds } from './contract.fixtures';
import {
  ContractPlaybookResolver, CreatePlaybookFromTemplateUseCase, DeleteContractPlaybookUseCase, GetContractPlaybookUseCase,
  ListContractPlaybooksUseCase, ListPlaybookTemplatesUseCase, SaveContractPlaybookUseCase, UNSAVED_DEFAULT_PLAYBOOK_ID, type SavePlaybookInput,
} from './manage-playbooks';

const NOW = new Date('2026-09-15T01:00:00.000Z');
const LATER = new Date('2026-09-16T01:00:00.000Z');

function inputFrom(id: string | undefined, overrides: Partial<SavePlaybookInput> = {}): SavePlaybookInput {
  const base = playbookFixture('template');
  return {
    scope, ...(id === undefined ? {} : { id }), name: '自社の基準', isDefault: false, ourRole: base.ourRole, ourCompanyNames: ['株式会社サンプル商事'],
    topics: base.topics, criteria: base.criteria, legal: base.legal, stampDuty: base.stampDuty, extraction: base.extraction, ...overrides,
  };
}

function setup() {
  const playbooks = new InMemoryContractPlaybookRepository();
  const unitOfWork = new NoopUnitOfWork();
  const transaction = vi.spyOn(unitOfWork, 'withTransaction');
  let now = NOW;
  const clock = () => now;
  const ids = sequentialIds('pb');
  return {
    playbooks, transaction, setNow: (date: Date) => { now = date; },
    resolver: new ContractPlaybookResolver(playbooks, clock),
    list: new ListContractPlaybooksUseCase(playbooks, clock),
    save: new SaveContractPlaybookUseCase(playbooks, unitOfWork, clock, ids),
    fromTemplate: new CreatePlaybookFromTemplateUseCase(playbooks, unitOfWork, clock, ids),
    remove: new DeleteContractPlaybookUseCase(playbooks),
  };
}

describe('ListContractPlaybooksUseCase', () => {
  it('境界: 0 件なら既定テンプレートを未保存のまま返し、何も保存しない（開いただけでデータを作らない）', async () => {
    const { list, playbooks } = setup();
    const result = await list.execute(scope);
    expect(result.unsaved).toBe(true);
    expect(result.playbooks).toEqual([expect.objectContaining({ id: UNSAVED_DEFAULT_PLAYBOOK_ID, isDefault: true, templateId: DEFAULT_TEMPLATE_ID, updatedAt: NOW.toISOString() })]);
    expect(await playbooks.list(scope)).toEqual([]);
  });

  it('正常: 保存済みがあれば要約の一覧（未保存の既定は混ぜない）', async () => {
    const { list, playbooks } = setup();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true }));
    const result = await list.execute(scope);
    expect(result).toEqual({ playbooks: [expect.objectContaining({ id: 'pb-1', topicCount: 8, criterionCount: 9 })], unsaved: false });
    expect(result.playbooks[0]).not.toHaveProperty('topics');
  });
});

describe('ContractPlaybookResolver / GetContractPlaybookUseCase', () => {
  it('正常: 指定なしは 既定 → 最初の 1 件 → 未保存の既定テンプレート の順', async () => {
    const { resolver, playbooks } = setup();
    const unsaved = await resolver.resolve(scope);
    expect(unsaved).toMatchObject({ unsaved: true, playbook: { id: UNSAVED_DEFAULT_PLAYBOOK_ID, isDefault: true } });

    // 既定が無ければ作成の古い順の最初。
    await playbooks.save(playbookFixture('pb-late', { createdAt: '2026-09-14T00:00:00.000Z' }));
    await playbooks.save(playbookFixture('pb-early', { createdAt: '2026-09-13T00:00:00.000Z' }));
    expect((await resolver.resolve(scope)).playbook.id).toBe('pb-early');

    await playbooks.save(playbookFixture('pb-late', { isDefault: true, createdAt: '2026-09-14T00:00:00.000Z' }));
    expect(await resolver.resolve(scope)).toMatchObject({ unsaved: false, playbook: { id: 'pb-late' } });
    // 未保存の既定の id を指定したときも「指定なし」と同じ規則。
    expect((await resolver.resolve(scope, UNSAVED_DEFAULT_PLAYBOOK_ID)).playbook.id).toBe('pb-late');
  });

  it('正常 / 異常: id 指定はそれを返し、無ければ 404（既定へ黙って落とさない）', async () => {
    const { resolver, playbooks } = setup();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true }));
    await playbooks.save(playbookFixture('pb-2'));
    const get = new GetContractPlaybookUseCase(resolver);
    expect(await get.execute(scope, 'pb-2')).toMatchObject({ unsaved: false, playbook: { id: 'pb-2' } });
    await expect(get.execute(scope, 'missing')).rejects.toThrow(ContractPlaybookNotFoundError);
    await expect(resolver.resolve({ tenantId: 'other', workspaceId: 'workspace' }, 'pb-1')).rejects.toThrow('contract playbook not found: pb-1');
  });
});

describe('SaveContractPlaybookUseCase', () => {
  it('正常: 新規は id と作成時刻を振り、最初の 1 件は isDefault: false でも既定にする（既定が 0 件にならない）', async () => {
    const { save, transaction } = setup();
    const saved = await save.execute(inputFrom(undefined, { templateId: 'outsourcing-client' }));
    expect(saved).toMatchObject({ id: 'pb-1', name: '自社の基準', isDefault: true, templateId: 'outsourcing-client', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('正常: 既定は 1 つ。isDefault: true の保存は他の既定を外し（updatedAt も進める）、false の保存は他の既定を残す', async () => {
    const { save, playbooks, setNow } = setup();
    await save.execute(inputFrom(undefined));
    setNow(LATER);
    const second = await save.execute(inputFrom(undefined, { name: '二つ目', isDefault: false }));
    expect(second.isDefault).toBe(false);
    expect((await playbooks.findById(scope, 'pb-1'))?.isDefault).toBe(true);

    const promoted = await save.execute(inputFrom('pb-2', { name: '二つ目', isDefault: true }));
    expect(promoted.isDefault).toBe(true);
    expect(await playbooks.findById(scope, 'pb-1')).toMatchObject({ isDefault: false, updatedAt: LATER.toISOString() });
    expect((await playbooks.list(scope)).filter((playbook) => playbook.isDefault).map((playbook) => playbook.id)).toEqual(['pb-2']);

    // 唯一の既定を外そうとしても、既定が無くなるので既定のまま保存する。
    const kept = await save.execute(inputFrom('pb-2', { name: '二つ目', isDefault: false }));
    expect(kept.isDefault).toBe(true);
  });

  it('正常: 更新は id・作成時刻・テンプレート id を保ち、更新時刻だけを進める', async () => {
    const { save, playbooks, setNow } = setup();
    await playbooks.save(playbookFixture('pb-9', { isDefault: true, createdAt: AT, updatedAt: AT }));
    setNow(LATER);
    const updated = await save.execute(inputFrom('pb-9', { name: '改名', isDefault: true }));
    expect(updated).toMatchObject({ id: 'pb-9', name: '改名', templateId: 'outsourcing-client', createdAt: AT, updatedAt: LATER.toISOString() });
    expect(await playbooks.findById(scope, 'pb-9')).toEqual(updated);
  });

  it('正常: 未保存の既定テンプレートの id で保存すると新しい id で作る', async () => {
    const { save } = setup();
    expect((await save.execute(inputFrom(UNSAVED_DEFAULT_PLAYBOOK_ID))).id).toBe('pb-1');
  });

  it('異常: 存在しない id の更新は 404、不変条件違反は 400（何も保存しない）', async () => {
    const { save, playbooks } = setup();
    await expect(save.execute(inputFrom('missing'))).rejects.toThrow(ContractPlaybookNotFoundError);
    await expect(save.execute(inputFrom(undefined, { topics: [] }))).rejects.toThrow(ContractDomainError);
    await expect(save.execute(inputFrom(undefined, { extraction: { scanAllArticles: false, chunkMaxChars: 999 } }))).rejects.toThrow('extraction.chunkMaxChars');
    expect(await playbooks.list(scope)).toEqual([]);
  });
});

describe('DeleteContractPlaybookUseCase', () => {
  it('正常 / 異常: 消せたら何も返さず、無ければ 404', async () => {
    const { remove, playbooks } = setup();
    await playbooks.save(playbookFixture('pb-1'));
    await expect(remove.execute(scope, 'pb-1')).resolves.toBeUndefined();
    expect(await playbooks.findById(scope, 'pb-1')).toBeNull();
    await expect(remove.execute(scope, 'pb-1')).rejects.toThrow(ContractPlaybookNotFoundError);
  });
});

describe('テンプレート', () => {
  it('ListPlaybookTemplatesUseCase: 同梱テンプレートの要約（トピック数・基準数）', () => {
    const templates = new ListPlaybookTemplatesUseCase().execute();
    expect(templates.map((template) => template.id)).toEqual(PLAYBOOK_TEMPLATES.map((template) => template.id));
    expect(templates[0]).toEqual({ id: 'outsourcing-client', name: '業務委託（発注者側）', description: expect.any(String), ourRole: 'client', topicCount: 8, criterionCount: 9 });
    expect(templates[1]).toMatchObject({ id: 'nda-mutual', ourRole: 'mutual', topicCount: 6, criterionCount: 4 });
  });

  it('CreatePlaybookFromTemplateUseCase: 名前・自社名を上書きして保存し、空の名前はテンプレート名', async () => {
    const { fromTemplate, playbooks } = setup();
    const first = await fromTemplate.execute({ scope, templateId: 'nda-mutual', name: 'NDA 用', ourCompanyNames: ['株式会社サンプル商事'] });
    // 最初の 1 件なので isDefault 省略でも既定になる。
    expect(first).toMatchObject({ id: 'pb-1', name: 'NDA 用', isDefault: true, ourRole: 'mutual', ourCompanyNames: ['株式会社サンプル商事'], templateId: 'nda-mutual' });
    const second = await fromTemplate.execute({ scope, templateId: 'outsourcing-client', name: '   ' });
    expect(second).toMatchObject({ id: 'pb-2', name: '業務委託（発注者側）', isDefault: false, ourCompanyNames: [] });
    const third = await fromTemplate.execute({ scope, templateId: 'outsourcing-client', isDefault: true });
    expect(third.isDefault).toBe(true);
    expect((await playbooks.findById(scope, 'pb-1'))?.isDefault).toBe(false);
  });

  it('異常: 未知のテンプレートは使えるテンプレートを列挙して 400', async () => {
    const { fromTemplate, playbooks } = setup();
    await expect(fromTemplate.execute({ scope, templateId: 'vendor' })).rejects.toThrow(ContractDomainError);
    await expect(fromTemplate.execute({ scope, templateId: 'vendor' })).rejects.toThrow('available: outsourcing-client, nda-mutual');
    expect(await playbooks.list(scope)).toEqual([]);
  });
});
