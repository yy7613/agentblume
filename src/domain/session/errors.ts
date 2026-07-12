export class SessionDomainError extends Error {
  readonly code = 'SESSION_DOMAIN';
  constructor(message: string) { super(message); this.name = 'SessionDomainError'; }
}

export class AgentSessionNotFoundError extends Error {
  readonly code = 'SESSION_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'AgentSessionNotFoundError'; }
}

export class AgentSessionClosedError extends Error {
  readonly code = 'SESSION_CLOSED';
  constructor(message: string) { super(message); this.name = 'AgentSessionClosedError'; }
}

export class AgentSessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED';
  constructor(message: string) { super(message); this.name = 'AgentSessionExpiredError'; }
}

export class SessionArtifactNotFoundError extends Error {
  readonly code = 'ARTIFACT_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'SessionArtifactNotFoundError'; }
}

export class SessionQuotaExceededError extends Error {
  readonly code = 'SESSION_QUOTA_EXCEEDED';
  constructor(message: string) { super(message); this.name = 'SessionQuotaExceededError'; }
}
