export class FeedbackValidationError extends Error {
  readonly code = 'FEEDBACK_VALIDATION';
  constructor(message: string) { super(message); this.name = 'FeedbackValidationError'; }
}

