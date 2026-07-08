/**
 * ドメイン: Scenario（検証パターン）（v16 実装契約 §2.3 / docs/11 §3）
 *
 * 再現性のため対象Agent・Persona は SemVer 固定で参照する。
 */
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import { nonEmpty, validateMetadata, type ValidationMetadata } from './metadata';
import { normalizeSurveyQuestions, type SurveyQuestion } from './survey';

export const MAX_USER_TURNS_LIMIT = 8;

export type ScenarioMetadata = ValidationMetadata;

export interface ScenarioTargetRef {
  readonly agentId: string;
  readonly version: SemVer;
}

export interface ScenarioPersonaRef {
  readonly personaId: string;
  readonly version: SemVer;
}

export interface ScenarioPseudoUserRef {
  readonly agentId: string;
  readonly version: SemVer;
}

export interface Scenario {
  readonly metadata: ScenarioMetadata;
  /** 検証対象Agent（バージョン固定）。 */
  readonly target: ScenarioTargetRef;
  /** 疑似ユーザーPersona（バージョン固定）。v18: deprecated、pseudoUser を推奨。persona と排他。 */
  readonly persona?: ScenarioPersonaRef;
  /** 疑似ユーザーAgent（kind==='pseudo-user'・バージョン固定）。persona と排他（v18）。 */
  readonly pseudoUser?: ScenarioPseudoUserRef;
  /** 疑似ユーザーが達成したいこと。非空。 */
  readonly goal: string;
  /** 状況設定。 */
  readonly context?: string;
  /** ユーザーターン上限（整数 1..8）。LLM同士の無限対話の防止。 */
  readonly maxUserTurns: number;
  /** 期待する Tool 公開名（適合率算出用）。指定時は非空・重複なし。 */
  readonly expectedTools?: readonly string[];
  /** アンケート設問（1問以上・id一意）。 */
  readonly survey: readonly SurveyQuestion[];
}

export type CreateScenarioProps = Scenario;

export function createScenario(props: CreateScenarioProps): Scenario {
  const metadata = validateMetadata(props.metadata, 'createScenario');
  nonEmpty(props.target?.agentId, 'createScenario: target.agentId');
  if (!(props.target.version instanceof SemVer)) {
    throw new ValidationDomainError('createScenario: target.version must be a SemVer instance');
  }
  // 疑似ユーザーは persona か pseudoUser のどちらか一方を必須とする（排他）。
  const persona = props.persona;
  const pseudoUser = props.pseudoUser;
  if ((persona === undefined) === (pseudoUser === undefined)) {
    throw new ValidationDomainError('createScenario: exactly one of persona or pseudoUser must be specified');
  }
  if (persona !== undefined) {
    nonEmpty(persona.personaId, 'createScenario: persona.personaId');
    if (!(persona.version instanceof SemVer)) {
      throw new ValidationDomainError('createScenario: persona.version must be a SemVer instance');
    }
  }
  if (pseudoUser !== undefined) {
    nonEmpty(pseudoUser.agentId, 'createScenario: pseudoUser.agentId');
    if (!(pseudoUser.version instanceof SemVer)) {
      throw new ValidationDomainError('createScenario: pseudoUser.version must be a SemVer instance');
    }
  }
  nonEmpty(props.goal, 'createScenario: goal');
  if (props.context !== undefined && typeof props.context !== 'string') {
    throw new ValidationDomainError('createScenario: context must be a string');
  }
  if (!Number.isInteger(props.maxUserTurns) || props.maxUserTurns < 1 || props.maxUserTurns > MAX_USER_TURNS_LIMIT) {
    throw new ValidationDomainError(`createScenario: maxUserTurns must be an integer between 1 and ${MAX_USER_TURNS_LIMIT}`);
  }
  let expectedTools: readonly string[] | undefined;
  if (props.expectedTools !== undefined) {
    if (!Array.isArray(props.expectedTools) || props.expectedTools.length === 0) {
      throw new ValidationDomainError('createScenario: expectedTools must be a non-empty array when specified');
    }
    const seen = new Set<string>();
    expectedTools = props.expectedTools.map((name, index) => {
      nonEmpty(name, `createScenario: expectedTools.${index}`);
      if (seen.has(name)) throw new ValidationDomainError(`createScenario: duplicate expected tool: ${name}`);
      seen.add(name);
      return name;
    });
  }
  return {
    metadata,
    target: { agentId: props.target.agentId, version: props.target.version },
    ...(persona !== undefined ? { persona: { personaId: persona.personaId, version: persona.version } } : {}),
    ...(pseudoUser !== undefined ? { pseudoUser: { agentId: pseudoUser.agentId, version: pseudoUser.version } } : {}),
    goal: props.goal,
    ...(props.context !== undefined ? { context: props.context } : {}),
    maxUserTurns: props.maxUserTurns,
    ...(expectedTools !== undefined ? { expectedTools } : {}),
    survey: normalizeSurveyQuestions(props.survey),
  };
}
