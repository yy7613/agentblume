export class SkillError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SkillError'; }
}
export class SkillValidationError extends SkillError {
  constructor(message: string) { super('SKILL_VALIDATION', message); this.name = 'SkillValidationError'; }
}
export class SkillNotFoundError extends SkillError {
  constructor(message: string) { super('SKILL_NOT_FOUND', message); this.name = 'SkillNotFoundError'; }
}
export class SkillVersionConflictError extends SkillError {
  constructor(message: string) { super('SKILL_VERSION_CONFLICT', message); this.name = 'SkillVersionConflictError'; }
}
