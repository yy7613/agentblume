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

/**
 * 実行の**中断**を表す例外。利用者の cancel / worker の shutdown（AbortSignal）、または保存済みの記録が
 * 別経路で確定済みだった（compare-and-set 失敗）ときに、進行中の処理を打ち切るために投げる。
 *
 * `FactoryValidationError`（入力・不変条件違反 → Run は failed）とは区別する: `RunFactoryUseCase` の
 * catch はこれを「failed に落とさず、cancelled として確定する / 既に確定済みなら何もしない」へ振り分ける。
 */
export class FactoryAbortedError extends FactoryError {
  constructor(message: string) { super('FACTORY_ABORTED', message); this.name = 'FactoryAbortedError'; }
}
