/**
 * ドメイン: Validation(ペルソナ/シナリオ/サーベイ)識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** ペルソナの内部識別子。 */
export type PersonaId = Flavor<string, 'PersonaId'>;

/** シナリオの内部識別子。 */
export type ScenarioId = Flavor<string, 'ScenarioId'>;

/** シナリオ実行の識別子。 */
export type ScenarioRunId = Flavor<string, 'ScenarioRunId'>;

/** サーベイ定義の識別子。 */
export type SurveyId = Flavor<string, 'SurveyId'>;

/** サーベイ設問の識別子。 */
export type SurveyQuestionId = Flavor<string, 'SurveyQuestionId'>;
