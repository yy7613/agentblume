export class EvaluationDomainError extends Error {
  readonly code = 'EVALUATION_DOMAIN';

  constructor(message: string) {
    super(message);
    this.name = 'EvaluationDomainError';
  }
}
