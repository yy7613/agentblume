/**
 * ドメイン: アンケート設問と回答検証（v16 実装契約 §2.2 / docs/11 §5）
 *
 * - scale のみ min/max（既定 1/5、min<max）。
 * - buildSurveySchema は構造化出力用 JSON Schema（scale→integer, boolean→boolean, text→string、全問required）。
 * - validateSurveyAnswers は型・範囲を検証し、違反は ValidationDomainError。
 */
import { ValidationDomainError } from './errors';
import { nonEmpty } from './metadata';

export const SURVEY_QUESTION_KINDS = ['scale', 'boolean', 'text'] as const;
export type SurveyQuestionKind = (typeof SURVEY_QUESTION_KINDS)[number];

export interface SurveyQuestion {
  readonly id: string;
  readonly textJa: string;
  readonly textEn: string;
  readonly kind: SurveyQuestionKind;
  /** scale のみ。既定 1。 */
  readonly min?: number;
  /** scale のみ。既定 5。 */
  readonly max?: number;
}

export interface SurveyAnswer {
  readonly questionId: string;
  readonly value: number | boolean | string;
}

/** 構造化出力用の JSON Schema（ModelProviderPort の responseFormat.schema と構造互換）。 */
export interface SurveyJsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { readonly type: 'integer' | 'boolean' | 'string'; readonly description: string }>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** 既定テンプレート（docs/11 §5 の8問。q8 は id 'impressions' で感想として独立保持）。 */
export const DEFAULT_SURVEY: readonly SurveyQuestion[] = [
  { id: 'q1', textJa: '目的を達成できましたか', textEn: 'Did you achieve your goal?', kind: 'boolean' },
  { id: 'q2', textJa: '総合満足度', textEn: 'Overall satisfaction', kind: 'scale', min: 1, max: 5 },
  { id: 'q3', textJa: '回答のわかりやすさ', textEn: 'Clarity of the responses', kind: 'scale', min: 1, max: 5 },
  { id: 'q4', textJa: '手間の少なさ（少ないほど高評価）', textEn: 'Low effort required (less effort scores higher)', kind: 'scale', min: 1, max: 5 },
  { id: 'q5', textJa: '回答をどの程度信頼できましたか', textEn: 'How much did you trust the responses?', kind: 'scale', min: 1, max: 5 },
  { id: 'q6', textJa: '良かった点', textEn: 'What went well?', kind: 'text' },
  { id: 'q7', textJa: '不満・困った点', textEn: 'What was frustrating or unclear?', kind: 'text' },
  { id: 'impressions', textJa: '感想（自由記述）', textEn: 'Overall impressions (free text)', kind: 'text' },
];

/** 設問集合の不変条件を検証し、scale の既定 min/max を補完した正規化コピーを返す。 */
export function normalizeSurveyQuestions(questions: readonly SurveyQuestion[]): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationDomainError('survey requires at least one question');
  }
  const seen = new Set<string>();
  return questions.map((question, index) => {
    nonEmpty(question?.id, `survey.${index}.id`);
    nonEmpty(question.textJa, `survey.${index}.textJa`);
    nonEmpty(question.textEn, `survey.${index}.textEn`);
    if (!(SURVEY_QUESTION_KINDS as readonly string[]).includes(question.kind)) {
      throw new ValidationDomainError(`survey.${index}: invalid kind: ${String(question.kind)}`);
    }
    if (seen.has(question.id)) throw new ValidationDomainError(`survey: duplicate question id: ${question.id}`);
    seen.add(question.id);
    if (question.kind !== 'scale') {
      if (question.min !== undefined || question.max !== undefined) {
        throw new ValidationDomainError(`survey.${index}: min/max are only allowed for scale questions`);
      }
      return { id: question.id, textJa: question.textJa, textEn: question.textEn, kind: question.kind };
    }
    const min = question.min ?? 1;
    const max = question.max ?? 5;
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new ValidationDomainError(`survey.${index}: min/max must be integers`);
    }
    if (min >= max) throw new ValidationDomainError(`survey.${index}: min must be less than max`);
    return { id: question.id, textJa: question.textJa, textEn: question.textEn, kind: question.kind, min, max };
  });
}

/** 設問集合から構造化出力用 JSON Schema を決定的に構築する。 */
export function buildSurveySchema(questions: readonly SurveyQuestion[]): SurveyJsonSchema {
  const normalized = normalizeSurveyQuestions(questions);
  return {
    type: 'object',
    properties: Object.fromEntries(normalized.map((question) => [question.id, {
      type: question.kind === 'scale' ? 'integer' as const : question.kind === 'boolean' ? 'boolean' as const : 'string' as const,
      description: question.kind === 'scale'
        ? `${question.textJa} / ${question.textEn} (integer ${question.min}..${question.max})`
        : `${question.textJa} / ${question.textEn}`,
    }])),
    required: normalized.map((question) => question.id),
    additionalProperties: false,
  };
}

/** 回答オブジェクトを設問に対して検証し、設問順の SurveyAnswer 配列を返す。 */
export function validateSurveyAnswers(questions: readonly SurveyQuestion[], answers: unknown): SurveyAnswer[] {
  const normalized = normalizeSurveyQuestions(questions);
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new ValidationDomainError('survey answers must be a JSON object');
  }
  const record = answers as Record<string, unknown>;
  const ids = new Set(normalized.map((question) => question.id));
  for (const key of Object.keys(record)) {
    if (!ids.has(key)) throw new ValidationDomainError(`survey answers contain unknown question id '${key}'`);
  }
  return normalized.map((question) => {
    const value = record[question.id];
    if (value === undefined) throw new ValidationDomainError(`survey answers missing question '${question.id}'`);
    if (question.kind === 'scale') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ValidationDomainError(`survey answer '${question.id}' must be an integer`);
      }
      const min = question.min ?? 1;
      const max = question.max ?? 5;
      if (value < min || value > max) {
        throw new ValidationDomainError(`survey answer '${question.id}' must be between ${min} and ${max}`);
      }
      return { questionId: question.id, value };
    }
    if (question.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new ValidationDomainError(`survey answer '${question.id}' must be a boolean`);
      return { questionId: question.id, value };
    }
    if (typeof value !== 'string') throw new ValidationDomainError(`survey answer '${question.id}' must be a string`);
    return { questionId: question.id, value };
  });
}
