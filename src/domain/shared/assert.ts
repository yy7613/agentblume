/**
 * ドメイン共有: 検証ヘルパー(ADR-0035)
 *
 * 各 BC のファクトリに重複していた検証(nonEmpty 等)の単一情報源。
 * メッセージは `${label} must be a non-empty string` 形式で、label に BC の前置詞
 * (`createAgent: name` 等)を含めて渡すことで既存メッセージとバイト単位で一致させる。
 */
import type { Flavor } from './brand';
import type { ErrorFactory } from './errors';
import { SharedValidationError } from './errors';

const defaultFail: ErrorFactory = (message) => new SharedValidationError(message);

/** 検証済みの http(s) URL(資格情報の埋め込みなし)。素の string から代入可(弱ブランド)。 */
export type HttpUrl = Flavor<string, 'HttpUrl'>;

export interface AssertNonEmptyOptions {
  /**
   * 空白のみの文字列を空とみなすか。既定 true。
   * tool BC の createTool は歴史的に trim しない(空白のみを許す)ため false を指定する。
   */
  readonly trim?: boolean;
}

/** 非空文字列でなければ `${label} must be a non-empty string` を fail で投げる。 */
export function assertNonEmpty(
  value: unknown,
  label: string,
  fail: ErrorFactory = defaultFail,
  options: AssertNonEmptyOptions = {},
): asserts value is string {
  const trim = options.trim ?? true;
  if (typeof value !== 'string' || (trim ? value.trim().length === 0 : value.length === 0)) {
    throw fail(`${label} must be a non-empty string`);
  }
}

export interface AssertHttpUrlOptions {
  /** trim 後の文字数上限。超過は `${label} must be at most ${max} characters`。 */
  readonly maxLength?: number;
}

/**
 * http(s) URL の共通不変条件を検証し、trim 済みの URL を返す。
 *
 * 課すのは「http(s) であること・資格情報を埋め込まないこと」のみ。宛先の到達範囲
 * (private/link-local の可否)は BC ごとのポリシーなので呼び出し側の責務とする。
 * URL は封緘対象外で DB・ログ・API 応答に平文で残るため資格情報を書かせない。
 * 同じ理由で credentials エラーのメッセージには URL を載せない。
 */
export function assertHttpUrl(
  value: unknown,
  label: string,
  fail: ErrorFactory = defaultFail,
  options: AssertHttpUrlOptions = {},
): HttpUrl {
  assertNonEmpty(value, label, fail);
  const raw = value.trim();
  if (options.maxLength !== undefined && raw.length > options.maxLength) {
    throw fail(`${label} must be at most ${options.maxLength} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail(`${label} must be a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail(`${label} must use http(s): ${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw fail(`${label} must not embed credentials (user:password@host)`);
  }
  return raw;
}
