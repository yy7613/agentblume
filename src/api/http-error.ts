/**
 * api層: HTTP エラー応答の型と組み立て（葉モジュール）。
 *
 * `error-mapping.ts` と業務ごとの `<業務>-error-mapping.ts` の両方が使うので、循環しないよう分けて置く。
 */
import type { RunFailureToolRef } from '../domain/run/run';

/**
 * HTTP エラーレスポンス表現。
 * `tool` / `nodeId` はツール実行由来の失敗（ToolExecutionError）だけが持ち、
 * 利用者がどのToolのどのノードを直せばよいかをUIが示すために使う。
 * `rubric` は judge の tracePolicy と事例種別の矛盾（JudgeTraceUnavailableError）だけが持ち、
 * どのルーブリックを直せばよいかを UI が示すために使う。
 * `row` は仕訳 CSV 取込の失敗（JournalCsvImportError）だけが持ち、CSV の何行目を直せばよいかを示す
 * （1 始まり・ヘッダ行込みなので表計算ソフトの行番号と一致する）。
 * 業務が「直す場所」を示す別の項目を載せたいときは、ここを変えずに追加のキーとして載せてよい
 * （UI の `ApiError.details` がそのまま受け取る）。
 */
export interface HttpError {
  readonly status: number;
  readonly body: { error: { code: string; message: string; runId?: string; tool?: RunFailureToolRef; nodeId?: string; rubric?: { id: string; version: string }; row?: number; readonly [detail: string]: unknown } };
}

/** status と例外から HttpError を組み立てる（code は例外の code プロパティ）。 */
export function httpError(status: number, code: string, message: string): HttpError {
  return { status, body: { error: { code, message } } };
}
