/**
 * ドメイン: 銀行明細の重複取込を見分けるキー（docs/22 §5.4）。純関数。
 *
 * 期間が重なる明細を取り込み直しても、同じ行は同じキーになり一意索引で弾かれる。
 * 同じ日に同じ相手から同額が 2 回入る正当なケースは、**同じファイル内の出現順**（occurrence）で区別する。
 * ハッシュ（sha256）は I/O ではないが domain は node の組込みに依存しないので、application が掛ける。
 */

export interface FingerprintFields {
  readonly accountKey: string;
  readonly date: string;
  readonly amount: number;
  readonly payerNameNorm: string;
  readonly balance?: number;
}

/** 出現順を数える単位（occurrence を除いた部分）。 */
export function fingerprintBase(fields: FingerprintFields): string {
  return [fields.accountKey, fields.date, String(fields.amount), fields.payerNameNorm, fields.balance === undefined ? '' : String(fields.balance)].join('|');
}

/**
 * 1 ファイルの行ごとにハッシュ前の文字列を作る（出現順は 0 始まり）。
 * `forced` はその行を「重複でも取り込む」と利用者が選んだ回数（既存の指紋と重ならない値を探すため）。
 */
export function fingerprintSources(rows: readonly FingerprintFields[]): readonly string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = fingerprintBase(row);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}|${occurrence}`;
  });
}

/** 重複でも取り込む行の指紋の元（既存と重ならない `attempt` を呼び出し側が探す）。 */
export function forcedFingerprintSource(source: string, attempt: number): string {
  return `${source}|forced:${attempt}`;
}

/** ハッシュ値（16 進）の先頭 32 桁を指紋にする。 */
export const FINGERPRINT_LENGTH = 32;
