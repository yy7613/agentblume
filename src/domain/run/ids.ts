/**
 * ドメイン: Run 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** エージェント実行(Run)の識別子。childRunId もこの型で参照する。 */
export type RunId = Flavor<string, 'RunId'>;

/** LLM ツール呼び出しの識別子。 */
export type ToolCallId = Flavor<string, 'ToolCallId'>;

/**
 * ツール出力の出所(terminal)識別子。
 * 値は ETL グラフの終端ノード id、または実行時ソースの番兵値
 * ('runtime-harness' / 'mcp' / 'session-workspace')の異種混合であり、NodeId とは別概念。
 */
export type TerminalId = Flavor<string, 'TerminalId'>;
