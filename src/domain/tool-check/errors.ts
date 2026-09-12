/**
 * ドメイン: ツール検証（Tool Check）のエラー型。
 *
 * 検証ケースの不変条件違反と、存在しないケースの参照だけを持つ。
 * ツール自体の実行失敗（引数不正・ノードエラー）はエラーではなく**検証結果**
 * （`status: 'error'`）として表現するので、ここには含めない。
 */

/** 検証ケースの不変条件違反（入力不正）。api で 400。 */
export class ToolCheckValidationError extends Error {
  readonly code = 'TOOL_CHECK_VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'ToolCheckValidationError';
  }
}

/** 指定 id の検証ケースが見つからない。api で 404。 */
export class ToolCheckNotFoundError extends Error {
  readonly code = 'TOOL_CHECK_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ToolCheckNotFoundError';
  }
}
