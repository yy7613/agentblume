/**
 * ドメイン: Agent 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** Agent の内部識別子(非空文字列)。 */
export type AgentId = Flavor<string, 'AgentId'>;
