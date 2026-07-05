import { describe, expect, it } from 'vitest';
import { ValidationDomainError } from './errors';
import { buildSurveySchema, DEFAULT_SURVEY, normalizeSurveyQuestions, validateSurveyAnswers, type SurveyQuestion } from './survey';

const questions: readonly SurveyQuestion[] = [
  { id: 'achieved', textJa: '達成?', textEn: 'Achieved?', kind: 'boolean' },
  { id: 'satisfaction', textJa: '満足度', textEn: 'Satisfaction', kind: 'scale' },
  { id: 'impressions', textJa: '感想', textEn: 'Impressions', kind: 'text' },
];

describe('DEFAULT_SURVEY', () => {
  it('docs/11 §5 の8問（q8 は id=impressions の text）', () => {
    expect(DEFAULT_SURVEY).toHaveLength(8);
    expect(DEFAULT_SURVEY.at(-1)).toMatchObject({ id: 'impressions', kind: 'text' });
    expect(DEFAULT_SURVEY.filter((question) => question.kind === 'scale')).toHaveLength(4);
    expect(DEFAULT_SURVEY[0]).toMatchObject({ id: 'q1', kind: 'boolean' });
    expect(() => normalizeSurveyQuestions(DEFAULT_SURVEY)).not.toThrow();
  });
});

describe('normalizeSurveyQuestions', () => {
  it('scale の既定 min/max（1/5）を補完する', () => {
    const normalized = normalizeSurveyQuestions(questions);
    expect(normalized[1]).toMatchObject({ kind: 'scale', min: 1, max: 5 });
    expect(normalized[0]).not.toHaveProperty('min');
  });

  it('不変条件違反は ValidationDomainError', () => {
    expect(() => normalizeSurveyQuestions([])).toThrow(ValidationDomainError);
    expect(() => normalizeSurveyQuestions([{ ...questions[0]!, id: '' }])).toThrow(ValidationDomainError);
    expect(() => normalizeSurveyQuestions([{ ...questions[0]!, textJa: '' }])).toThrow(ValidationDomainError);
    expect(() => normalizeSurveyQuestions([{ ...questions[0]!, textEn: ' ' }])).toThrow(ValidationDomainError);
    expect(() => normalizeSurveyQuestions([{ ...questions[0]!, kind: 'emoji' as SurveyQuestion['kind'] }])).toThrow(ValidationDomainError);
    expect(() => normalizeSurveyQuestions([questions[0]!, questions[0]!])).toThrow(/duplicate/);
    expect(() => normalizeSurveyQuestions([{ ...questions[0]!, min: 1 }])).toThrow(/only allowed for scale/);
    expect(() => normalizeSurveyQuestions([{ ...questions[1]!, min: 1.5 }])).toThrow(/integers/);
    expect(() => normalizeSurveyQuestions([{ ...questions[1]!, min: 5, max: 5 }])).toThrow(/less than max/);
  });
});

describe('buildSurveySchema', () => {
  it('scale→integer / boolean→boolean / text→string、全問 required・additionalProperties:false', () => {
    const schema = buildSurveySchema(questions);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['achieved', 'satisfaction', 'impressions']);
    expect(schema.properties['achieved']?.type).toBe('boolean');
    expect(schema.properties['satisfaction']?.type).toBe('integer');
    expect(schema.properties['satisfaction']?.description).toContain('1..5');
    expect(schema.properties['impressions']?.type).toBe('string');
  });
});

describe('validateSurveyAnswers', () => {
  const answers = { achieved: true, satisfaction: 4, impressions: '良かった' };

  it('型・範囲を検証し設問順の SurveyAnswer 配列を返す', () => {
    expect(validateSurveyAnswers(questions, { impressions: '良かった', achieved: true, satisfaction: 4 })).toEqual([
      { questionId: 'achieved', value: true },
      { questionId: 'satisfaction', value: 4 },
      { questionId: 'impressions', value: '良かった' },
    ]);
  });

  it('違反は ValidationDomainError', () => {
    expect(() => validateSurveyAnswers(questions, null)).toThrow(ValidationDomainError);
    expect(() => validateSurveyAnswers(questions, [answers])).toThrow(ValidationDomainError);
    expect(() => validateSurveyAnswers(questions, { ...answers, extra: 1 })).toThrow(/unknown question id/);
    expect(() => validateSurveyAnswers(questions, { achieved: true, satisfaction: 4 })).toThrow(/missing question/);
    expect(() => validateSurveyAnswers(questions, { ...answers, achieved: 'yes' })).toThrow(/must be a boolean/);
    expect(() => validateSurveyAnswers(questions, { ...answers, satisfaction: 4.5 })).toThrow(/must be an integer/);
    expect(() => validateSurveyAnswers(questions, { ...answers, satisfaction: 6 })).toThrow(/between 1 and 5/);
    expect(() => validateSurveyAnswers(questions, { ...answers, satisfaction: 0 })).toThrow(/between 1 and 5/);
    expect(() => validateSurveyAnswers(questions, { ...answers, impressions: 5 })).toThrow(/must be a string/);
  });
});
