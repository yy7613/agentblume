export class AgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export class AgentValidationError extends AgentError {
  constructor(message: string) {
    super('AGENT_VALIDATION', message);
    this.name = 'AgentValidationError';
  }
}

export class AgentNotFoundError extends AgentError {
  constructor(message: string) {
    super('AGENT_NOT_FOUND', message);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentVersionConflictError extends AgentError {
  constructor(message: string) {
    super('AGENT_VERSION_CONFLICT', message);
    this.name = 'AgentVersionConflictError';
  }
}
