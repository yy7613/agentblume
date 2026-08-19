/**
 * ドメイン: データソース本文の内容検証エラー（UX改善: 壊れたCSV/JSONの早期検出）。
 *
 * 壊れたファイル（バイナリ混入・null文字・パース不能など）が検証なしに登録され、
 * 後続のTool実行時に無関係なエラーとして表面化する問題を防ぐため、アップロード時点で検出する。
 */

/** データソースドメインの不変条件違反（保存済みレコードの構造不正など）。api で 400。 */
export class DataSourceDomainError extends Error {
  readonly code = 'DATA_SOURCE_DOMAIN';

  constructor(message: string) {
    super(message);
    this.name = 'DataSourceDomainError';
  }
}

/** アップロードされたfileデータソース本文が、宣言されたformatとして解釈できない場合のエラー。code は 'INVALID_FILE_CONTENT'。 */
export class InvalidFileContentError extends Error {
  readonly code = 'INVALID_FILE_CONTENT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidFileContentError';
  }
}
