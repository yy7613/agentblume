/**
 * ドメイン: シナリオ検証コンテキストのエラー型（v16 実装契約 §2.5）
 *
 * save系のバージョン衝突は既存の VersionConflictError（domain/tool/errors）を再利用する。
 */

/** 不変条件違反・アンケート回答検証失敗など。code は 'VALIDATION_DOMAIN'。 */
export class ValidationDomainError extends Error {
  readonly code = 'VALIDATION_DOMAIN';

  constructor(message: string) {
    super(message);
    this.name = 'ValidationDomainError';
  }
}

/** 指定 Persona（バージョン）が存在しない。code は 'PERSONA_NOT_FOUND'。 */
export class PersonaNotFoundError extends Error {
  readonly code = 'PERSONA_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'PersonaNotFoundError';
  }
}

/** 指定 Scenario（バージョン）が存在しない。code は 'SCENARIO_NOT_FOUND'。 */
export class ScenarioNotFoundError extends Error {
  readonly code = 'SCENARIO_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'ScenarioNotFoundError';
  }
}

/** 指定 ScenarioRun が存在しない。code は 'SCENARIO_RUN_NOT_FOUND'。 */
export class ScenarioRunNotFoundError extends Error {
  readonly code = 'SCENARIO_RUN_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'ScenarioRunNotFoundError';
  }
}
