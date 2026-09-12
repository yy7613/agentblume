import type { ExperimentModelSnapshot } from '../../domain/evaluation/experiment';

/**
 * judge スロットが「実際に判定へ使える状態か」。
 *
 * 指紋（ExperimentModelSnapshot）は観測情報で、未設定でも `{ provider: 'lm-studio-judge', model: '' }` のように
 * 形だけは揃って返ってくる。そのまま judge 指標つきの実験を起票すると、全事例が判定失敗
 * （さらに空の model で ExperimentCaseResult の不変条件まで踏む）で終わり、利用者は原因に辿り着けない。
 * ここで「設定されているか」を一箇所で決め、起票ガード・実行時の防御・UI の機能フラグが同じ判定を使う。
 */
export interface JudgeReadiness {
  readonly configured: boolean;
  readonly provider?: string;
  readonly model?: string;
}

/** 指紋が「解決できなかった／配線されていない」ことを表す印。実際のモデル名ではない。 */
const PLACEHOLDER_MARKERS: ReadonlySet<string> = new Set(['unconfigured-judge', 'unresolved']);

function blankOrPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || PLACEHOLDER_MARKERS.has(trimmed);
}

/** 指紋から judge の設定状態を判定する（純粋関数）。provider / model は設定済みのときだけ載せる。 */
export function judgeReadinessFromSnapshot(snapshot: ExperimentModelSnapshot | undefined): JudgeReadiness {
  if (snapshot === undefined || blankOrPlaceholder(snapshot.provider) || blankOrPlaceholder(snapshot.model)) return { configured: false };
  return { configured: true, provider: snapshot.provider, model: snapshot.model };
}
