/**
 * ドメイン: ノード集約（v1 実装契約 §9.7 / v15 実装契約 §2.7）
 *
 * v1 の 7 ノード（agent-input / json-source / csv-source / select / filter /
 * rename / cast）と v15 の 6 ノード（join / union / sort / distinct /
 * fill-null / replace）、および出力・分析系ノード（group-by / limit を含む）を
 * register 済みの NodeRegistry を生成する。
 * 業務（仕訳・経費精算…）のノードは `<業務>-nodes.ts` の `register<業務>Nodes` が登録する（ADR-0039）。
 * 依存の向き: registry ← nodes（registry.ts は本ファイルを import しない）。
 */
import { NodeRegistry } from '../registry';
import { agentInputNode } from './agent-input';
import { currentDatetimeNode } from './current-datetime';
import { registerJournalNodes } from './journal-nodes';
import { registerExpenseNodes } from './expense-nodes';
import { registerReceivablesNodes } from './receivables-nodes';
import { registerContractNodes } from './contract-nodes';
import { jsonSourceNode } from './json-source';
import { csvSourceNode } from './csv-source';
import { selectNode } from './select';
import { filterNode } from './filter';
import { renameNode } from './rename';
import { castNode } from './cast';
import { calculateNode } from './calculate';
import { joinNode } from './join';
import { unionNode } from './union';
import { sortNode } from './sort';
import { limitNode } from './limit';
import { distinctNode } from './distinct';
import { groupByNode } from './group-by';
import { fillNullNode } from './fill-null';
import { replaceNode } from './replace';
import { agentOutputNode } from './agent-output';
import { workspaceOutputNode } from './workspace-output';
import { graphOutputNode } from './graph-output';
import { summaryStatisticsNode } from './summary-statistics';
import { correlationAnalysisNode } from './correlation-analysis';
import { timeSeriesAnalysisNode } from './time-series-analysis';
import { outlierFilterNode } from './outlier-filter';
import { chartOutputNode } from './chart-output';
import { aiJudgeNode } from './ai-judge';

export { jsonSourceNode } from './json-source';
export type { JsonSourceConfig } from './json-source';
export { csvSourceNode } from './csv-source';
export type { CsvSourceConfig } from './csv-source';
export { selectNode } from './select';
export type { SelectConfig } from './select';
export { filterNode } from './filter';
export type { FilterCombine, FilterCondition, FilterConditionsConfig, FilterConfig, FilterOp } from './filter';
export { renameNode } from './rename';
export type { RenameConfig } from './rename';
export { castNode } from './cast';
export type { CastConfig } from './cast';
export { calculateNode, CALCULATE_TYPE } from './calculate';
export type { CalculateConfig } from './calculate';
export {
  CALCULATE_FUNCTIONS,
  CALCULATE_CONSTANTS,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_TOKENS,
  parseExpression,
  evaluateExpression,
} from './calculate-expression';
export type { CalculateFunction, CalculateFunctionGroup, CalculateFailureReason, EvaluationOutcome } from './calculate-expression';
export { evaluateExpressionDetailed } from './calculate-expression';
export { EXPRESSION_ERROR_CODES, nameDistance, suggestName } from './calculate-expression';
export type { ExpressionErrorCode } from './calculate-expression';
export { EXPRESSION_DIAGNOSTIC_CODES, EXPRESSION_DIAGNOSTIC_CATEGORIES, diagnosticCategory, validateExpression, previewExpression } from './calculate-diagnostics';
export type {
  ExpressionDiagnostic,
  ExpressionDiagnosticCode,
  ExpressionDiagnosticCategory,
  ExpressionPreview,
  ExpressionPreviewDiagnosis,
  ExpressionPreviewOptions,
  ExpressionPreviewRow,
  ExpressionValidation,
} from './calculate-diagnostics';
export { agentInputNode } from './agent-input';
export type { AgentInputConfig } from './agent-input';
export { journalAttachmentSourceNode } from './journal-attachment';
export type { JournalAttachmentSourceConfig, JournalAttachmentColumn } from './journal-attachment';
export { JOURNAL_ATTACHMENT_COLUMNS, JOURNAL_ATTACHMENT_SCHEMA } from './journal-attachment';
export { journalDraftEntrySourceNode } from './journal-draft-entry';
export type { JournalDraftEntrySourceConfig, JournalDraftEntryColumn } from './journal-draft-entry';
export { JOURNAL_DRAFT_ENTRY_COLUMNS, JOURNAL_DRAFT_ENTRY_SCHEMA } from './journal-draft-entry';
export { journalEntriesSourceNode } from './journal-entries-source';
export type { JournalEntriesSourceConfig, JournalEntriesStatus, JournalEntriesColumn } from './journal-entries-source';
export { JOURNAL_ENTRIES_COLUMNS, JOURNAL_ENTRIES_SCHEMA, JOURNAL_ENTRIES_STATUSES } from './journal-entries-source';
export { currentDatetimeNode } from './current-datetime';
export type { CurrentDatetimeConfig } from './current-datetime';
export { joinNode } from './join';
export type { JoinConfig, JoinKey, JoinMode } from './join';
export { unionNode } from './union';
export type { UnionConfig } from './union';
export { sortNode } from './sort';
export type { SortConfig, SortKey } from './sort';
export { limitNode } from './limit';
export type { LimitConfig } from './limit';
export { distinctNode } from './distinct';
export type { DistinctConfig } from './distinct';
export { groupByNode } from './group-by';
export type { GroupByAggregate, GroupByConfig, GroupByOp } from './group-by';
export { GROUP_BY_OPS } from './group-by';
export { fillNullNode } from './fill-null';
export type { FillNullConfig, FillRule, FillStrategy } from './fill-null';
export { replaceNode } from './replace';
export type { ReplaceConfig, ReplaceRule } from './replace';
export { agentOutputNode } from './agent-output';
export type { AgentOutputConfig, AgentOutputFormat, AgentOutputShape } from './agent-output';
export { workspaceOutputNode } from './workspace-output';
export type { WorkspaceArtifactKind, WorkspaceOutputConfig, LegacyGraphWorkspaceOutputConfig, CompatibleWorkspaceOutputConfig } from './workspace-output';
export { graphOutputNode } from './graph-output';
export type { GraphArtifactMapping, EdgeListGraphArtifactMapping, CorrelationNetworkGraphArtifactMapping, GraphOutputConfig } from './graph-output';
export { summaryStatisticsNode } from './summary-statistics';
export type { SummaryStatisticsConfig, SummaryMetric } from './summary-statistics';
export { correlationAnalysisNode } from './correlation-analysis';
export type { CorrelationAnalysisConfig } from './correlation-analysis';
export { timeSeriesAnalysisNode } from './time-series-analysis';
export type { TimeSeriesAnalysisConfig } from './time-series-analysis';
export { outlierFilterNode } from './outlier-filter';
export type { OutlierFilterConfig } from './outlier-filter';
export { chartOutputNode } from './chart-output';
export type { ChartOutputConfig, ChartType } from './chart-output';
export { aiJudgeNode, AI_JUDGE_TYPE, AI_JUDGE_UNCLEAR, AI_JUDGE_YES_NO_VALUES, AI_JUDGE_MAX_ITEMS, AI_JUDGE_DEFAULT_MAX_ITEMS, AI_JUDGE_MAX_CATEGORIES, aiJudgeAllowedValues, aiJudgeColumns, aiJudgeItemKey, aiJudgeItemValues, aiJudgeIssues, aiJudgeMode } from './ai-judge';
export type { AiJudgeAction, AiJudgeCategory, AiJudgeConfig, AiJudgeMode, AiJudgeResolved, AiJudgeVerdict } from './ai-judge';

/** v1 の 7 ノード + v15 の 6 ノードを登録済みの NodeRegistry を返す。 */
export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(agentInputNode);
  registry.register(currentDatetimeNode);
  // 業務のノードは業務ごとの登録関数が持つ（ADR-0039）。仕訳は従来の登録位置のまま呼ぶ。
  registerJournalNodes(registry);
  registry.register(jsonSourceNode);
  registry.register(csvSourceNode);
  registry.register(selectNode);
  registry.register(filterNode);
  registry.register(aiJudgeNode);
  registry.register(renameNode);
  registry.register(castNode);
  registry.register(calculateNode);
  registry.register(joinNode);
  registry.register(unionNode);
  registry.register(sortNode);
  registry.register(limitNode);
  registry.register(distinctNode);
  registry.register(groupByNode);
  registry.register(fillNullNode);
  registry.register(replaceNode);
  registry.register(agentOutputNode);
  registry.register(workspaceOutputNode);
  registry.register(graphOutputNode);
  registry.register(summaryStatisticsNode);
  registry.register(correlationAnalysisNode);
  registry.register(timeSeriesAnalysisNode);
  registry.register(outlierFilterNode);
  registry.register(chartOutputNode);
  registerExpenseNodes(registry);
  registerReceivablesNodes(registry);
  registerContractNodes(registry);
  return registry;
}
