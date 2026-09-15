import { describe, expect, it } from 'vitest';
import { ExpenseCsvImportError } from '../errors';
import type { FareRoute } from '../fare-table';
import { FARE_CSV_COLUMNS, fareTableToCsv, parseFareCsv } from './fare-csv';

const HEADER = FARE_CSV_COLUMNS.join(',');
const routes: readonly FareRoute[] = [
  { id: 'fare-nakano-kasumigaseki', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ic', fare: 300, bidirectional: true },
  { id: 'fare-ticket', stations: ['中野', '霞ケ関'], fareType: 'ticket', fare: 1200, bidirectional: false, validFrom: '2026-04-01', validTo: '2027-03-31', note: '運賃は架空, 改定前' },
];

function errorOf(content: string): ExpenseCsvImportError {
  try {
    parseFareCsv(content);
  } catch (error) {
    if (error instanceof ExpenseCsvImportError) return error;
    throw error;
  }
  throw new Error('expected an ExpenseCsvImportError');
}

describe('fareTableToCsv / parseFareCsv', () => {
  it('正常: UTF-8 BOM・CRLF・駅は「 > 」区切りで書き、読み戻すと同じ経路になる', () => {
    const csv = fareTableToCsv(routes);
    expect(csv.startsWith(`﻿${HEADER}\r\n`)).toBe(true);
    expect(csv).toContain('fare-nakano-kasumigaseki,中野 > 新宿 > 霞ケ関,ic,300,true,,,\r\n');
    expect(parseFareCsv(csv)).toEqual(routes);
  });

  it('正常: 空欄の既定（id は行番号から採番・券種 IC・双方向）と、表記の揺れ（切符・片道・1,200円・＞）を受ける', () => {
    const parsed = parseFareCsv(`${HEADER}\n,中野＞霞ケ関,切符,"1,200円",片道,,,\nfare-3,新宿 > 渋谷,,160,,,,\n,新宿>渋谷,IC,170,はい,,,\n`);
    expect(parsed).toEqual([
      { id: 'fare-2', stations: ['中野', '霞ケ関'], fareType: 'ticket', fare: 1200, bidirectional: false },
      { id: 'fare-3', stations: ['新宿', '渋谷'], fareType: 'ic', fare: 160, bidirectional: true },
      { id: 'fare-4', stations: ['新宿', '渋谷'], fareType: 'ic', fare: 170, bidirectional: true },
    ]);
  });

  it('境界: 採番した id が明示の id と重なれば枝番を付ける。列の並びは自由で、無い任意の列は空扱い', () => {
    const parsed = parseFareCsv('fare,stations,id\n100,A > B,fare-3\n200,C > D,\n');
    expect(parsed.map((route) => route.id)).toEqual(['fare-3', 'fare-3-2']);
  });

  it('異常: 空のファイルと必須の列（stations / fare）の欠落は 1 行目のエラー', () => {
    expect(errorOf('')).toMatchObject({ row: 1, message: expect.stringContaining('empty') });
    expect(errorOf('id,stations\nx,A > B\n')).toMatchObject({ row: 1, message: expect.stringContaining('missing columns: fare') });
  });

  it.each([
    ['券種', ',A > B,bus,100,,,,', 'fare_type'],
    ['双方向', ',A > B,ic,100,maybe,,,', 'bidirectional'],
    ['運賃', ',A > B,ic,abc,,,,', 'fare must be an integer'],
    ['駅が 1 つ', ',A,ic,100,,,,', 'stations'],
    ['運賃の範囲', ',A > B,ic,0,,,,', 'fare must be an integer between'],
    ['日付', ',A > B,ic,100,,2026/04/01,,', 'validFrom'],
  ])('異常: %s の誤りは行番号付き', (_label, line, message) => {
    const error = errorOf(`${HEADER}\n${line}\n`);
    expect(error.row).toBe(2);
    expect(error.message).toContain(message);
  });

  it('異常: 同じ id の 2 行目は行番号付き。閉じていない引用符も取込エラーにする', () => {
    expect(errorOf(`${HEADER}\nx,A > B,ic,100,,,,\nx,C > D,ic,100,,,,\n`)).toMatchObject({ row: 3, message: expect.stringContaining('duplicate id x') });
    expect(errorOf(`${HEADER}\n"x,A > B,ic,100`)).toBeInstanceOf(ExpenseCsvImportError);
  });

  it('境界: 2,000 経路を超える CSV は断る', () => {
    const lines = Array.from({ length: 2001 }, (_, index) => `,A${index} > B,ic,100,,,,`).join('\n');
    expect(errorOf(`${HEADER}\n${lines}\n`).message).toContain('at most 2000');
  });
});
