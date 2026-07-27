/**
 * `SqliteUnitOfWork` のテスト。
 *
 * 接続が23本に分裂していた頃はリポジトリをまたぐトランザクションが原理的に書けず、
 * 「Tool→Skill→Agent の途中でクラッシュ → 孤児が残る」経路が塞げなかった。
 * ここでは共有接続の上で**複数リポジトリの書き込みが一括でコミット／巻き戻る**ことを固定する。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentSession } from '../../domain/session/agent-session';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite-database';
import { SqliteUnitOfWork } from './sqlite-unit-of-work';
import { SqliteAgentSessionRepository } from './sqlite-agent-session-repository';
import { SqliteDataSourceRepository } from './sqlite-data-source-repository';
import { SqliteWikiRepository } from './sqlite-wiki-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const page = (id: string) => createWikiPage({ id, tenant: scope, title: id, tags: [], body: 'body', sourceRuns: [], updatedAt: '2026-07-01T00:00:00.000Z' });
const session = (id: string) => createAgentSession({ id, scope, rootAgent: { internalId: 'a', version: '1.0.0' }, createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' });
const source = (id: string) => ({ id, tenant: scope, name: id, kind: 'file' as const, format: 'csv' as const, contentType: 'text/csv' as const, sizeBytes: 4, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' });

let directory: string;
let database: SqliteDatabase;
let unitOfWork: SqliteUnitOfWork;
let wikis: SqliteWikiRepository;
let sessions: SqliteAgentSessionRepository;
let sources: SqliteDataSourceRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agentblume-uow-'));
  database = openSqliteDatabase(join(directory, 'agentblume.db'));
  unitOfWork = new SqliteUnitOfWork(database);
  wikis = new SqliteWikiRepository(database);
  sessions = new SqliteAgentSessionRepository(database);
  sources = new SqliteDataSourceRepository(database);
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('SqliteUnitOfWork', () => {
  it('3つのリポジトリへの書き込みをまとめてコミットする', async () => {
    const result = await unitOfWork.withTransaction(async () => {
      await wikis.save(page('p1'));
      await sessions.save(session('s1'));
      await sources.save(source('d1'), 'a,b\n');
      return 'done';
    });

    expect(result).toBe('done');
    expect(await wikis.find(scope, 'p1')).not.toBeNull();
    expect(await sessions.find(scope, 's1')).not.toBeNull();
    expect(await sources.find(scope, 'd1')).not.toBeNull();
  });

  it('途中で失敗したら3つとも巻き戻る（孤児を残さない）', async () => {
    await expect(unitOfWork.withTransaction(async () => {
      await wikis.save(page('p1'));
      await sessions.save(session('s1'));
      await sources.save(source('d1'), 'a,b\n');
      throw new Error('crashed after the second write');
    })).rejects.toThrow('crashed after the second write');

    expect(await wikis.find(scope, 'p1')).toBeNull();
    expect(await sessions.find(scope, 's1')).toBeNull();
    expect(await sources.find(scope, 'd1')).toBeNull();
  });

  it('入れ子の withTransaction は同じ単位へ合流し、外側の失敗で内側も巻き戻る', async () => {
    await expect(unitOfWork.withTransaction(async () => {
      await wikis.save(page('outer'));
      await unitOfWork.withTransaction(async () => { await wikis.save(page('inner')); });
      throw new Error('outer failed');
    })).rejects.toThrow('outer failed');

    expect(await wikis.list(scope)).toEqual([]);
  });

  it('内側だけ失敗した場合は内側の書き込みだけが消える', async () => {
    await unitOfWork.withTransaction(async () => {
      await wikis.save(page('outer'));
      await expect(unitOfWork.withTransaction(async () => {
        await wikis.save(page('inner'));
        throw new Error('inner failed');
      })).rejects.toThrow('inner failed');
    });

    expect((await wikis.list(scope)).map((summary) => summary.id)).toEqual(['outer']);
  });

  it('同時に開始された複数のトランザクションは直列化される（BEGIN の入れ子で落ちない）', async () => {
    const order: string[] = [];
    const slow = unitOfWork.withTransaction(async () => {
      order.push('first:start');
      await new Promise((resolve) => setImmediate(resolve));
      await wikis.save(page('first'));
      order.push('first:end');
    });
    const fast = unitOfWork.withTransaction(async () => {
      order.push('second:start');
      await sessions.save(session('second'));
      order.push('second:end');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await wikis.find(scope, 'first')).not.toBeNull();
    expect(await sessions.find(scope, 'second')).not.toBeNull();
  });

  it('先行トランザクションが失敗しても後続は実行される', async () => {
    const failing = unitOfWork.withTransaction(async () => { throw new Error('first failed'); });
    const following = unitOfWork.withTransaction(async () => { await wikis.save(page('after')); return 'ok'; });

    await expect(failing).rejects.toThrow('first failed');
    await expect(following).resolves.toBe('ok');
    expect(await wikis.find(scope, 'after')).not.toBeNull();
  });

  it('リポジトリ内部の BEGIN（replaceAll / applyRetention）と入れ子にしても壊れない', async () => {
    await unitOfWork.withTransaction(async () => {
      await wikis.save(page('p1'));
      // SqliteDataSourceRepository は内部で database.transaction を使わないが、
      // 同じ接続に対する同期トランザクションが入れ子になっても SAVEPOINT で吸収される。
      database.transaction(() => {
        database.handle.prepare(`DELETE FROM wiki_pages WHERE id='p1'`).run();
      });
      await wikis.save(page('p2'));
    });

    expect((await wikis.list(scope)).map((summary) => summary.id)).toEqual(['p2']);
  });
});
