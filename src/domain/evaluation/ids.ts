/**
 * ドメイン: Evaluation(データセット/実験/品質ゲート)識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** 評価データセットの内部識別子。 */
export type DatasetId = Flavor<string, 'DatasetId'>;

/** 評価ケースの識別子。 */
export type EvaluationCaseId = Flavor<string, 'EvaluationCaseId'>;

/** 評価者プロファイルの内部識別子。 */
export type EvaluatorProfileId = Flavor<string, 'EvaluatorProfileId'>;

/** メトリクスの識別子。 */
export type MetricId = Flavor<string, 'MetricId'>;

/** Judge ルーブリックの内部識別子。 */
export type JudgeRubricId = Flavor<string, 'JudgeRubricId'>;

/** 実験の識別子。 */
export type ExperimentId = Flavor<string, 'ExperimentId'>;

/** ゲートポリシーの内部識別子。 */
export type GatePolicyId = Flavor<string, 'GatePolicyId'>;

/** ゲート判定レポートの識別子。 */
export type GateReportId = Flavor<string, 'GateReportId'>;

/** ゲートルールの識別子。 */
export type GateRuleId = Flavor<string, 'GateRuleId'>;

/** 昇格リクエストの識別子。 */
export type PromotionRequestId = Flavor<string, 'PromotionRequestId'>;
