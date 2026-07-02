/**
 * ドメイン: 状態合成（v1 実装契約 §6）
 */
import type { SchemaState } from '../data/types';

/** rank: confirmed=0, inferred=1, partial=2, unknown=3, mismatch=4 */
const RANK: Readonly<Record<SchemaState, number>> = {
  confirmed: 0,
  inferred: 1,
  partial: 2,
  unknown: 3,
  mismatch: 4,
};

/** SchemaState の順序値（confirmed < inferred < partial < unknown < mismatch）。 */
export function stateRank(s: SchemaState): number {
  return RANK[s];
}

/**
 * 状態群を「最悪（最大rank）」で畳む。空 → `'confirmed'`。
 * Engine が「上流 final state 群 + 当ノード局所 state」を畳むのに用いる。
 */
export function combineStates(states: readonly SchemaState[]): SchemaState {
  let worst: SchemaState = 'confirmed';
  for (const s of states) {
    if (stateRank(s) > stateRank(worst)) worst = s;
  }
  return worst;
}
