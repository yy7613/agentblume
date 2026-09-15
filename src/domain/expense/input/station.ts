/**
 * ドメイン: 駅名の比較キー（docs/21 §20.3.4。UC8。純関数）。
 *
 * 路線図を持たないので、駅は「利用者が書いた名前」を正規化して比べるだけにする。
 * NFKC → 空白除去 → 末尾の「駅」を除く → 小文字化 → 運賃マスタの別名（`stationAliases`）を代表名のキーへ寄せる。
 * 括弧の中身（「新宿（JR）」）は消さない（別の駅のことがあるため。揺れは利用者が別名で吸収する）。
 */
import type { StationAlias } from '../fare-table';

/** 別名 → 代表名のキー。 */
export type StationAliasIndex = ReadonlyMap<string, string>;

/** 別名を当てる前の素のキー。 */
export function baseStationKey(name: string): string {
  const compact = name.normalize('NFKC').replace(/\s+/gu, '');
  const withoutSuffix = compact.length > 1 && compact.endsWith('駅') ? compact.slice(0, -1) : compact;
  return withoutSuffix.toLowerCase();
}

/** 運賃マスタの別名から索引を作る（代表名自身も自分のキーに当てる）。 */
export function buildStationAliasIndex(aliases: readonly StationAlias[]): StationAliasIndex {
  const index = new Map<string, string>();
  for (const entry of aliases) {
    const representative = baseStationKey(entry.name);
    index.set(representative, representative);
    for (const alias of entry.aliases) {
      const key = baseStationKey(alias);
      // 同じ別名を 2 つの代表名に書いたら先に書いた方を採る（入力の順で決まり、黙って揺れない）。
      if (!index.has(key)) index.set(key, representative);
    }
  }
  return index;
}

export function stationKey(name: string, index: StationAliasIndex = new Map()): string {
  const key = baseStationKey(name);
  return index.get(key) ?? key;
}

/** 駅の並びを文言の形（`新宿 > 霞ケ関`）にする。 */
export function formatStations(stations: readonly string[]): string {
  return stations.join(' > ');
}
