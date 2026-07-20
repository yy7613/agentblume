export class FactoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FactoryError';
  }
}

export class FactoryValidationError extends FactoryError {
  constructor(message: string) { super('FACTORY_VALIDATION', message); this.name = 'FactoryValidationError'; }
}

export class FactoryNotFoundError extends FactoryError {
  constructor(message: string) { super('FACTORY_NOT_FOUND', message); this.name = 'FactoryNotFoundError'; }
}
