/**
 * ドメイン: Skill 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** Skill の内部識別子(非空文字列)。 */
export type SkillId = Flavor<string, 'SkillId'>;
