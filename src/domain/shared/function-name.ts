/**
 * ドメイン共有: エージェントへ公開する function 名のドメインプリミティブ(ADR-0034 / v50 R6)
 *
 * OpenAI 互換の function calling API が許す形式(英数字・`_`・`-`、1〜64 文字)。同じ正規表現が
 * domain / application / api の 7 か所(`domain/tool/tool.ts`・`domain/agent/structured-output.ts`・
 * `domain/tool-template/template.ts`・`application/agent/tool-schema.ts`・
 * `application/tool/design-chat-agent-tool.ts`・`api/schemas.ts`、コメント参照のみの
 * `application/agent/mcp-tools.ts`)に散らばっていたので、ここへ 1 本化する。
 *
 * `Flavor`(弱ブランド)なので素の string から代入でき、既存コード・既存テストを変更せずに
 * 型定義の張り替えだけで導入できる(ADR-0034 決定3)。**エラー文は各所が持ち続ける**
 * (`isFunctionName` で判定し、投げる文言は呼び出し側の既存の文のまま) — UI の日本語訳
 * (`src/ui/api/error-messages.ts`)がその英文を照合キーにしているため、ここでメッセージを
 * 一元化すると訳が外れる。
 */
import type { Flavor } from './brand';
import type { ErrorFactory } from './errors';
import { SharedValidationError } from './errors';

const defaultFail: ErrorFactory = (message) => new SharedValidationError(message);

/** エージェントへ公開する function 名(素の string から代入可能な弱ブランド)。 */
export type FunctionName = Flavor<string, 'FunctionName'>;

/** 公開できる function 名の形式(英数字・`_`・`-`、1〜64 文字)。 */
export const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** function 名として公開できる形式かどうか(型ガード)。 */
export function isFunctionName(value: string): value is FunctionName {
  return FUNCTION_NAME_PATTERN.test(value);
}

/** function 名の形式でなければ `${label} must be a valid function name` を fail で投げる。 */
export function assertFunctionName(
  value: unknown,
  label: string,
  fail: ErrorFactory = defaultFail,
): asserts value is FunctionName {
  if (typeof value !== 'string' || !isFunctionName(value)) {
    throw fail(`${label} must be a valid function name`);
  }
}
