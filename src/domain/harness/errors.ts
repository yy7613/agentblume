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

/**
 * 利用者による cancel を表す abort 理由。時間予算超過とクライアント切断も同じ AbortController を
 * 止めるため、「誰が止めたか」を型で区別しないと worker は cancelled と failed を正しく分けられない。
 */
export class HarnessRunCancelledError extends HarnessRunError {
  constructor(message = 'Harness run cancelled by user') { super(message); this.name = 'HarnessRunCancelledError'; }
}
