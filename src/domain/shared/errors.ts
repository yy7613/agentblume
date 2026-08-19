/**
 * ドメイン共有: 検証エラー(ADR-0035)
 *
 * shared の検証ヘルパーは既定でこのエラーを投げるが、各 BC は `ErrorFactory` を注入して
 * 自 BC のエラー型(AgentValidationError 等)とメッセージ前置詞を維持できる。
 * 既存のエラーメッセージは UI の日本語化(src/ui/api/error-messages.ts)とテストの契約であり、
 * shared への委譲でバイト単位の互換を保つことが目的。
 */

/** 検証失敗メッセージから BC 固有のエラーを生成するファクトリ。 */
export type ErrorFactory = (message: string) => Error;

/** shared 検証ヘルパーの既定エラー。`code` で機械判別する(tool/errors.ts の ToolError と同形)。 */
export class SharedValidationError extends Error {
  readonly code: string = 'DOMAIN_VALIDATION';

  constructor(message: string) {
    super(message);
    this.name = 'SharedValidationError';
  }
}
