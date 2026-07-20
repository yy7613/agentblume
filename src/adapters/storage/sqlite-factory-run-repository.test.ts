import { describe, it } from 'vitest';
import { SqliteFactoryRunRepository } from './sqlite-factory-run-repository';
import { factoryRunRepositoryContract } from './factory-run-repository.contract';
describe('SqliteFactoryRunRepository', () => { it('共有契約を満たす', async () => { const repo = new SqliteFactoryRunRepository(); try { await factoryRunRepositoryContract(repo); } finally { repo.close(); } }); });
