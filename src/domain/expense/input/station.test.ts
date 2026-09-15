import { describe, expect, it } from 'vitest';
import { baseStationKey, buildStationAliasIndex, formatStations, stationKey } from './station';

describe('baseStationKey', () => {
  it('正常: NFKC・空白除去・末尾の「駅」除去・小文字化をする', () => {
    expect(baseStationKey(' 新宿 駅 ')).toBe('新宿');
    expect(baseStationKey('ＳＨＩＮＪＵＫＵ')).toBe('shinjuku');
    expect(baseStationKey('霞ケ関駅')).toBe('霞ケ関');
  });

  it('境界: 「駅」1 文字だけの名前は消さない。括弧の中身は消さない（別の駅のことがある）', () => {
    expect(baseStationKey('駅')).toBe('駅');
    expect(baseStationKey('新宿（JR）')).toBe('新宿(jr)');
    expect(baseStationKey('新宿（JR）')).not.toBe(baseStationKey('新宿'));
  });
});

describe('stationKey / buildStationAliasIndex', () => {
  it('正常: 別名を代表名のキーへ寄せる（代表名自身も当たる）', () => {
    const index = buildStationAliasIndex([{ name: '霞ケ関', aliases: ['霞が関', '霞ヶ関'] }]);
    expect(stationKey('霞が関駅', index)).toBe('霞ケ関');
    expect(stationKey('霞ヶ関', index)).toBe('霞ケ関');
    expect(stationKey('霞ケ関', index)).toBe('霞ケ関');
  });

  it('境界: 同じ別名を 2 つの代表名に書いたら先に書いた方。索引が無ければ素のキー', () => {
    const index = buildStationAliasIndex([{ name: 'A', aliases: ['x'] }, { name: 'B', aliases: ['x'] }]);
    expect(stationKey('x', index)).toBe('a');
    expect(stationKey('霞が関')).toBe('霞が関');
  });
});

describe('formatStations', () => {
  it('正常: 駅を「 > 」で連結する', () => {
    expect(formatStations(['中野', '新宿', '霞ケ関'])).toBe('中野 > 新宿 > 霞ケ関');
  });
});
