/**
 * ドメイン: ノード集約（v1 実装契約 §9.7 / v15 実装契約 §2.7）
 *
 * v1 の 7 ノード（agent-input / json-source / csv-source / select / filter /
 * rename / cast）と v15 の 6 ノード（join / union / sort / distinct /
 * fill-null / replace）を register 済みの NodeRegistry を生成する。
 * 依存の向き: registry ← nodes（registry.ts は本ファイルを import しない）。
 */
import { NodeRegistry } from '../registry';
import { agentInputNode } from './agent-input';
import { jsonSourceNode } from './json-source';
import { csvSourceNode } from './csv-source';
import { selectNode } from './select';
import { filterNode } from './filter';
import { renameNode } from './rename';
import { castNode } from './cast';
import { joinNode } from './join';
import { unionNode } from './union';
import { sortNode } from './sort';
import { distinctNode } from './distinct';
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

export { jsonSourceNode } from './json-source';
export type { JsonSourceConfig } from './json-source';
export { csvSourceNode } from './csv-source';
export type { CsvSourceConfig } from './csv-source';
export { selectNode } from './select';
export type { SelectConfig } from './select';
export { filterNode } from './filter';
export type { FilterConfig, FilterOp } from './filter';
export { renameNode } from './rename';
export type { RenameConfig } from './rename';
export { castNode } from './cast';
export type { CastConfig } from './cast';
export { agentInputNode } from './agent-input';
export type { AgentInputConfig } from './agent-input';
export { joinNode } from './join';
export type { JoinConfig, JoinKey, JoinMode } from './join';
export { unionNode } from './union';
export type { UnionConfig } from './union';
export { sortNode } from './sort';
export type { SortConfig, SortKey } from './sort';
export { distinctNode } from './distinct';
export type { DistinctConfig } from './distinct';
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

/** v1 の 7 ノード + v15 の 6 ノードを登録済みの NodeRegistry を返す。 */
export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(agentInputNode);
  registry.register(jsonSourceNode);
  registry.register(csvSourceNode);
  registry.register(selectNode);
  registry.register(filterNode);
  registry.register(renameNode);
  registry.register(castNode);
  registry.register(joinNode);
  registry.register(unionNode);
  registry.register(sortNode);
  registry.register(distinctNode);
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
  return registry;
}
