/**
 * adapter層: `LoggerPort` の console 実装。
 *
 * `createApp` は Fastify（pino）より先に組み立てられるため、握り潰した障害の出力先として
 * 常に使えるのは標準出力しかない。行頭に `agentblume:` を付けて他のライブラリの出力と区別する。
 * 構造化情報は JSON 1個にまとめる（pino のログとgrepで揃えやすくするため）。
 */
import type { LogContext, LoggerPort } from '../../application/operations/logger';

type ConsoleSink = (message: string) => void;

export class ConsoleLogger implements LoggerPort {
  constructor(
    private readonly sinks: { readonly info: ConsoleSink; readonly warn: ConsoleSink; readonly error: ConsoleSink } = {
      info: (message) => { console.info(message); },
      warn: (message) => { console.warn(message); },
      error: (message) => { console.error(message); },
    },
  ) {}

  info(message: string, context?: LogContext): void { this.sinks.info(format('info', message, context)); }
  warn(message: string, context?: LogContext): void { this.sinks.warn(format('warn', message, context)); }
  error(message: string, context?: LogContext): void { this.sinks.error(format('error', message, context)); }
}

/** `agentblume [warn] message {"reason":"…"}`。context が空なら本文だけ。 */
function format(level: string, message: string, context?: LogContext): string {
  const head = `agentblume [${level}] ${message}`;
  if (context === undefined || Object.keys(context).length === 0) return head;
  try {
    return `${head} ${JSON.stringify(context)}`;
  } catch {
    // 循環参照など JSON 化できない context は落として本文だけ出す（ログのために throw しない）。
    return head;
  }
}
