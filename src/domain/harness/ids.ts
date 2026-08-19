/**
 * ドメイン: Harness 識別子(ADR-0034)
 *
 * SlotId はトポロジ定義(coordinator/participant/from/to 等)で多用され、
 * RunId 等との取り違えリスクが最も高いため Flavor 化の最優先対象(計画 M1)。
 */
import type { Flavor } from '../shared/brand';

/** AgentHarness の内部識別子(非空文字列)。 */
export type HarnessId = Flavor<string, 'HarnessId'>;

/** ハーネス内スロットの識別子。 */
export type SlotId = Flavor<string, 'SlotId'>;

/** ハーネス実行の識別子。 */
export type HarnessRunId = Flavor<string, 'HarnessRunId'>;
