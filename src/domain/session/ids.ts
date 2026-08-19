/**
 * ドメイン: Session 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** エージェントセッションの識別子。 */
export type SessionId = Flavor<string, 'SessionId'>;

/** セッション成果物の識別子。 */
export type SessionArtifactId = Flavor<string, 'SessionArtifactId'>;
