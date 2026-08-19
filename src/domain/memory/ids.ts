/**
 * ドメイン: Memory(LLM Wiki)識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** Wiki スペースの識別子。他BCの wikiId 参照フィールドもこの型。 */
export type WikiSpaceId = Flavor<string, 'WikiSpaceId'>;

/** Wiki ページの識別子。 */
export type WikiPageId = Flavor<string, 'WikiPageId'>;

/** メモリ提案の識別子。 */
export type MemoryProposalId = Flavor<string, 'MemoryProposalId'>;
