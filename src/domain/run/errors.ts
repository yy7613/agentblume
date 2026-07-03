export class RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'RunNotFoundError';
  }
}
