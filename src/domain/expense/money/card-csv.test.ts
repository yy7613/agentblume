import { describe, expect, it } from 'vitest';
import type { CardImportMapping, CardStatementProfile, ExpenseCard } from '../card';
import { ExpenseCardImportError } from '../errors';
import {
  CARD_STATEMENT_MAX_ROWS, cardHeaderSignature, detectCardProfile, parseCardStatement, readCardStatementTable, resolveCardColumns, suggestCardMapping,
} from './card-csv';

const cards: readonly ExpenseCard[] = [
  { id: 'card-sales', label: '営業用カード', last4: '1111', holderEmployeeId: 'emp-taro', enabled: true },
  { id: 'card-shared', label: '共用カード', last4: '2222', enabled: true },
  { id: 'card-old', label: '旧カード', last4: '3333', enabled: false },
];

const mapping: CardImportMapping = {
  columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額', cardLast4: 'カード番号下4桁', memo: '備考', postedOn: '計上日' },
  amountSign: 'charge-positive',
  skipLinesBefore: 0,
};

const csv = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const HEADER = '利用日,利用店名,利用金額,カード番号下4桁,備考,計上日';

function errorOf(work: () => unknown): ExpenseCardImportError {
  try {
    work();
  } catch (error) {
    if (error instanceof ExpenseCardImportError) return error;
    throw error;
  }
  throw new Error('expected ExpenseCardImportError');
}

describe('readCardStatementTable', () => {
  it('正常: BOM を落とし、前置きの行を飛ばして見出しとデータ行に分ける（データ 1 行目の行番号を返す）', () => {
    const table = readCardStatementTable(`﻿サンプルカード ご利用明細\r\n会員番号 ****\r\n${HEADER}\r\n2026/09/10,店,100,1111,,\r\n`, 2);
    expect(table.headers).toEqual(['利用日', '利用店名', '利用金額', 'カード番号下4桁', '備考', '計上日']);
    expect(table.rows).toHaveLength(1);
    expect(table.firstRowNumber).toBe(4);
  });

  it('境界: 前置きの行数がファイルの行数を超えれば見出しが無いとして断る', () => {
    expect(errorOf(() => readCardStatementTable('a,b\r\n', 5)).message).toContain('no header row');
  });

  it('例外: 引用符が閉じていない CSV は行番号付きで断る（前置きの行数を足した行番号）', () => {
    const error = errorOf(() => readCardStatementTable(`前置き\r\n${HEADER}\r\n"2026/09/10,店,100\r\n`, 1));
    expect(error.message).toContain('broken');
    expect(error.row).toBeGreaterThan(1);
  });

  it(`境界: データ行は ${CARD_STATEMENT_MAX_ROWS} 行まで`, () => {
    const rows = Array.from({ length: CARD_STATEMENT_MAX_ROWS + 1 }, (_, index) => `2026/09/10,店${index},100,1111,,`);
    expect(() => readCardStatementTable(csv([HEADER, ...rows.slice(0, CARD_STATEMENT_MAX_ROWS)]))).not.toThrow();
    expect(errorOf(() => readCardStatementTable(csv([HEADER, ...rows]))).message).toContain(`at most ${CARD_STATEMENT_MAX_ROWS}`);
  });
});

describe('suggestCardMapping / detectCardProfile / resolveCardColumns', () => {
  it('正常: よくある見出しから列の対応を推定し、完全一致が無ければ部分一致で必須の 3 項目を探す', () => {
    expect(suggestCardMapping(['ご利用日', 'ご利用店名', 'ご利用金額', 'カード番号下4桁', '備考'])).toEqual({ usedOn: 'ご利用日', merchant: 'ご利用店名', amount: 'ご利用金額', cardLast4: 'カード番号下4桁', memo: '備考' });
    expect(suggestCardMapping(['Date', 'Merchant', 'Amount'])).toEqual({ usedOn: 'Date', merchant: 'Merchant', amount: 'Amount' });
    expect(suggestCardMapping(['お取引日付', '加盟店名称', '利用金額(円)'])).toEqual({ usedOn: 'お取引日付', merchant: '加盟店名称', amount: '利用金額(円)' });
    expect(suggestCardMapping(['x', 'y'])).toEqual({});
  });

  it('正常: 見出しの署名は並びを問わず集合で一致させる（列が 1 つ多ければ別のプロファイル）', () => {
    const profile: CardStatementProfile = { id: 'p1', name: '汎用', headerSignature: ['利用日', '利用店名', '利用金額'], ...mapping };
    expect(detectCardProfile(['利用金額', '利用日', ' 利用店名 '], [profile])?.id).toBe('p1');
    expect(detectCardProfile(['利用日', '利用店名', '利用金額', '備考'], [profile])).toBeUndefined();
    expect(cardHeaderSignature(['﻿利用日', '', 'ＡＢＣ'])).toEqual(['利用日', 'ABC']);
  });

  it('正常: マッピングの列名は NFKC・空白・大文字小文字を無視して見出しに当て、見つからない項目を返す', () => {
    const { resolved, missing } = resolveCardColumns(['利用 日', 'MERCHANT', '利用金額'], { usedOn: '利用日', merchant: 'merchant', amount: '金額', memo: '備考' });
    expect(resolved).toEqual({ usedOn: '利用 日', merchant: 'MERCHANT' });
    expect(missing).toEqual(['amount', 'memo']);
  });
});

describe('parseCardStatement', () => {
  it('正常: 行を読み、下 4 桁でカードを決め、加盟店キー・重複キー・計上日・備考・期間を作る', () => {
    const result = parseCardStatement(csv([
      HEADER,
      '2026/09/10,サンプルマート 霞が関店,"3,200",1111,打合せ,2026/09/15',
      '2026/09/02,サンプル交通,1500,****-2222,,',
    ]), { mapping, cards });
    expect(result.rowCount).toBe(2);
    expect(result.skippedRows).toEqual([]);
    expect(result.periodFrom).toBe('2026-09-02');
    expect(result.periodTo).toBe('2026-09-10');
    expect(result.rows[0]).toMatchObject({ row: 2, cardId: 'card-sales', usedOn: '2026-09-10', postedOn: '2026-09-15', merchantRaw: 'サンプルマート 霞が関店', amount: 3200, memo: '打合せ' });
    expect(result.rows[0]?.merchantKey).toBe('サンプルマート霞が関店');
    expect(result.rows[0]?.dedupeKey).toBe('card-sales|2026-09-10|3200|サンプルマート霞が関店|0');
    expect(result.rows[1]).toMatchObject({ cardId: 'card-shared', amount: 1500 });
    expect(result.rows[1]?.memo).toBeUndefined();
    expect(result.rows[0]?.raw['利用店名']).toBe('サンプルマート 霞が関店');
  });

  it('境界: 同じファイルに同じ組の行が 2 件あれば n を 0 → 1 と数えて別の行にする', () => {
    const result = parseCardStatement(csv([HEADER, '2026/09/10,店,100,1111,,', '2026/09/10,店,100,1111,,']), { mapping, cards });
    expect(result.rows.map((row) => row.dedupeKey)).toEqual(['card-sales|2026-09-10|100|店|0', 'card-sales|2026-09-10|100|店|1']);
  });

  it('正常: 符号の設定 charge-negative は利用を正・返金を負に読み替える', () => {
    const result = parseCardStatement(csv([HEADER, '2026/09/10,店,-100,1111,,', '2026/09/11,返金,200,1111,,']), { mapping: { ...mapping, amountSign: 'charge-negative' }, cards });
    expect(result.rows.map((row) => row.amount)).toEqual([100, -200]);
  });

  it('異常: 読めない日付・金額、0 円、登録の無い下 4 桁の行は行番号と理由を残して飛ばす（無効なカードの下 4 桁は使える）', () => {
    const result = parseCardStatement(csv([
      HEADER, '9月10日,店,100,1111,,', '2026/09/10,店,abc,1111,,', '2026/09/10,店,0,1111,,', '2026/09/10,店,100,9999,,', '2026/09/10,旧,100,3333,,',
    ]), { mapping, cards });
    expect(result.skippedRows.map((row) => row.row)).toEqual([2, 3, 4, 5]);
    expect(result.skippedRows[0]?.reason).toContain('日付');
    expect(result.skippedRows[1]?.reason).toContain('数値');
    expect(result.skippedRows[2]?.reason).toContain('0 円');
    expect(result.skippedRows[3]?.reason).toContain('9999');
    expect(result.rows.map((row) => row.cardId)).toEqual(['card-old']);
  });

  it('正常: 取込全体のカードを指定すると下 4 桁の列より優先し、下 4 桁の列が無ければ有効なカードが 1 枚のときだけそのカード', () => {
    expect(parseCardStatement(csv([HEADER, '2026/09/10,店,100,1111,,']), { mapping, cards, cardId: 'card-shared' }).rows[0]?.cardId).toBe('card-shared');
    const noLast4: CardImportMapping = { ...mapping, columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額' } };
    expect(parseCardStatement(csv([HEADER, '2026/09/10,店,100,,,']), { mapping: noLast4, cards: [cards[0] as ExpenseCard] }).rows[0]?.cardId).toBe('card-sales');
    expect(errorOf(() => parseCardStatement(csv([HEADER, '2026/09/10,店,100,,,']), { mapping: noLast4, cards })).missingColumns).toEqual(['cardLast4']);
    expect(errorOf(() => parseCardStatement(csv([HEADER]), { mapping, cards, cardId: 'card-missing' })).message).toContain('not registered');
  });

  it('例外: マッピングの列が見出しに無ければ、足りない項目と推定した対応を付けて断る', () => {
    const error = errorOf(() => parseCardStatement(csv(['ご利用日,ご利用店名,ご利用金額', '2026/09/10,店,100']), { mapping, cards }));
    expect(error.missingColumns).toEqual(['usedOn', 'merchant', 'amount', 'postedOn', 'cardLast4', 'memo']);
    expect(error.suggestedMapping).toEqual({ usedOn: 'ご利用日', merchant: 'ご利用店名', amount: 'ご利用金額' });
    expect(error.row).toBe(1);
  });

  it('境界: 加盟店名は 200 文字で切り、データ行が 0 件なら期間を持たない', () => {
    const long = 'あ'.repeat(250);
    expect(parseCardStatement(csv([HEADER, `2026/09/10,${long},100,1111,,`]), { mapping, cards }).rows[0]?.merchantRaw).toHaveLength(200);
    const empty = parseCardStatement(csv([HEADER]), { mapping, cards });
    expect(empty.periodFrom).toBeUndefined();
    expect(empty.rows).toEqual([]);
  });
});
