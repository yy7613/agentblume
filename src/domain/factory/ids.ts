/**
 * ドメイン: Agent Factory 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** ファクトリ実行の識別子。 */
export type FactoryRunId = Flavor<string, 'FactoryRunId'>;
