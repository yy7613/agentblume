/**
 * ドメイン: ETL グラフ識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** グラフノードの識別子。エッジの from/to もこの型で参照する。 */
export type NodeId = Flavor<string, 'NodeId'>;
