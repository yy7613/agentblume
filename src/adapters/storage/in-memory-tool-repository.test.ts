/**
 * InMemoryToolRepository のテスト（v2 実装契約 §13）— 共有契約スイートを適用。
 */
import { InMemoryToolRepository } from './in-memory-tool-repository';
import { toolRepositoryContract } from './tool-repository.contract';

toolRepositoryContract('InMemory', () => new InMemoryToolRepository());
