export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export class HarnessValidationError extends HarnessError {
  constructor(message: string) { super('HARNESS_VALIDATION', message); this.name = 'HarnessValidationError'; }
}

export class HarnessNotFoundError extends HarnessError {
  constructor(message: string) { super('HARNESS_NOT_FOUND', message); this.name = 'HarnessNotFoundError'; }
}

export class HarnessVersionConflictError extends HarnessError {
  constructor(message: string) { super('HARNESS_VERSION_CONFLICT', message); this.name = 'HarnessVersionConflictError'; }
}

export class HarnessRunNotFoundError extends HarnessError {
  constructor(message: string) { super('HARNESS_RUN_NOT_FOUND', message); this.name = 'HarnessRunNotFoundError'; }
}

export class HarnessRunError extends HarnessError {
  constructor(message: string) { super('HARNESS_RUN', message); this.name = 'HarnessRunError'; }
}
