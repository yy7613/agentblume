/**
 * ドメイン: モデル設定のエラー。
 *
 * ドメインは「保存できる形か」だけを保証する。実際の疎通失敗（エンドポイント到達不能・認証拒否）は
 * adapter/application の関心であり、ここには含めない。
 */

/** モデル設定の不変条件違反（入力不正）。api で 400。 */
export class ModelSettingsValidationError extends Error {
  readonly code = 'MODEL_SETTINGS_VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'ModelSettingsValidationError';
  }
}
