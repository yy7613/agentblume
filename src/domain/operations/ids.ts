/**
 * ドメイン: Operations 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** Run フィードバックレコードの識別子。 */
export type RunFeedbackId = Flavor<string, 'RunFeedbackId'>;
