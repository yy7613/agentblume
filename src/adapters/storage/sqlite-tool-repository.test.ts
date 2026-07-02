/**
 * SqliteToolRepository のテスト（v2 実装契約 §14）— 共有契約スイートを適用。
 * 毎テスト新規 ':memory:' で開き、テスト後に close する。
 */
import { SqliteToolRepository } from './sqlite-tool-repository';
import { toolRepositoryContract } from './tool-repository.contract';

toolRepositoryContract('Sqlite', () => new SqliteToolRepository(':memory:'), {
  afterEach: (repo) => (repo as SqliteToolRepository).close(),
});
