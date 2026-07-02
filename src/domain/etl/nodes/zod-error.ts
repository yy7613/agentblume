/**
 * ドメイン: ノード共通の Zod エラー整形ヘルパー。
 *
 * `ZodError.message` は issue 配列の JSON 文字列。ConfigError には人間可読な
 * 「path: message」形式に平坦化して埋め込む（元の情報は保持）。
 */
import type { ZodError } from 'zod';

/** ZodError を "path: message; ..." 形式の1行文字列に整形する。 */
export function zodMessage(error: ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  return parts.join('; ');
}
