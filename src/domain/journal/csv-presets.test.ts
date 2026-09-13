import { describe, expect, it } from 'vitest';
import { csvValue, parseCsv, rowToRecord, stripBom, toCsv } from './csv';
import { detectPreset, JOURNAL_CSV_PRESETS, normalizeHeader, paymentMethodFromDescription, rowToDocument, rowToDocumentWithMapping } from './csv-presets';
import { JournalCsvImportError } from './errors';

describe('parseCsv / toCsv', () => {
  it('正常: 引用符内のカンマ・改行・"" を扱い、CRLF / LF の両方を受け、BOM を落とす', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
    expect(stripBom('﻿x')).toBe('x');
    expect(stripBom('x')).toBe('x');
  });

  it('境界: 空行は捨てる。末尾の改行なし', () => {
    expect(parseCsv('a,b\n\n , \nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('異常: 閉じていない引用符は JournalCsvImportError（行番号つき）', () => {
    expect(() => parseCsv('a,b\n"open,c')).toThrow(JournalCsvImportError);
    try { parseCsv('a,b\n"open,c'); } catch (error) { expect((error as JournalCsvImportError).row).toBe(2); }
  });

  it('正常: csvValue はカンマ・引用符・改行を含むときだけ引用し、toCsv は CRLF 区切り（末尾も）', () => {
    expect(csvValue('plain')).toBe('plain');
    expect(csvValue('a,b')).toBe('"a,b"');
    expect(csvValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvValue(undefined)).toBe('');
    expect(csvValue(12)).toBe('12');
    expect(toCsv([['a', 1], ['b', null]])).toBe('a,1\r\nb,\r\n');
    expect(rowToRecord(['x', 'y'], ['1'])).toEqual({ x: '1', y: '' });
  });
});

describe('detectPreset', () => {
  it('正常: 各プリセットの署名（BOM・空白・全角括弧の揺れを吸収、順序は問わない）', () => {
    expect(detectPreset(['﻿日付', '摘要', '出金', '入金', '残高'])).toBe('generic');
    expect(detectPreset(['日付', '摘要', '出金', '入金'])).toBe('generic');
    expect(detectPreset(['取引日', '入出金（円）', '残高（円）', '入出金先内容'])).toBe('rakuten-bank');
    expect(detectPreset(['日付', '摘要', '摘要内容', '支払い金額', '預かり金額', '差引残高', 'メモ', '未資金化区分', '入払区分'])).toBe('mufg');
    expect(detectPreset(['お取引日', 'お引出し', 'お預入れ', 'お取り扱い内容', '残高', 'メモ', 'ラベル'])).toBe('smbc');
    expect(detectPreset(['日付', '入出金明細ID', '詳細1', '詳細2', '払出し金額', '預入れ金額', '貸付金額', '返済金額', '残高', '取扱店', '取扱店名', 'メモ'])).toBe('yucho');
    expect(detectPreset(['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '支払手数料', '支払総額', '9月支払金額', '10月繰越残高'])).toBe('rakuten-card');
    expect(detectPreset(['利用店名・商品名', '利用日', '利用者', '支払方法', '利用金額', '支払手数料', '支払総額'])).toBe('rakuten-card');
  });

  it('境界: 未知の列構成・空は undefined。一覧は 6 件で DTO の形', () => {
    expect(detectPreset(['date', 'amount'])).toBeUndefined();
    expect(detectPreset([])).toBeUndefined();
    expect(JOURNAL_CSV_PRESETS.map((preset) => preset.id)).toEqual(['generic', 'rakuten-bank', 'mufg', 'smbc', 'yucho', 'rakuten-card']);
    expect(JOURNAL_CSV_PRESETS[0]).toEqual({ id: 'generic', name: '汎用（日付,摘要,出金,入金,残高）', description: expect.any(String), headerSignature: ['日付', '摘要', '出金', '入金', '残高'], kind: 'generic' });
    expect(normalizeHeader(' 入出金（円） ')).toBe('入出金(円)');
  });
});

describe('rowToDocument', () => {
  const fromCsv = (presetId: Parameters<typeof rowToDocument>[0], content: string) => {
    const [headers, ...rows] = parseCsv(content);
    return rows.map((row, index) => rowToDocument(presetId, rowToRecord(headers!, row), { accountHint: '口座A', fileName: 'x.csv' }, index + 2));
  };

  it('generic: 出金 / 入金から direction と grandTotal、摘要から相手先と支払手段、残高は extra', () => {
    const docs = fromCsv('generic', '日付,摘要,出金,入金,残高\r\n2026/9/1,"振込 ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ",,"110,000","1,000,000"\r\n2026/9/2,ｶｰﾄﾞ ﾗｸﾃﾝ,5500,,994500\r\nR8.9.3,ATM 引出,10000,,984500\r\n');
    expect(docs).toHaveLength(3);
    expect(docs[0]).toEqual({
      kind: 'bank_statement',
      source: { type: 'csv-row', fileName: 'x.csv', row: { 日付: '2026/9/1', 摘要: '振込 ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ', 出金: '', 入金: '110,000', 残高: '1,000,000' }, preset: 'generic' },
      facts: { direction: 'in', transactionDate: '2026-09-01', grandTotal: 110000, paymentMethod: 'bank_transfer', accountHint: '口座A', description: '振込 ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ', descriptionNorm: '振込 ヤマダショウジ', counterpartyHint: 'ヤマダショウジ', extra: { balance: 1000000 } },
      extraction: { method: 'csv-preset', warnings: [] },
    });
    expect(docs[1]?.facts).toMatchObject({ direction: 'out', grandTotal: 5500, paymentMethod: 'credit_card', descriptionNorm: 'カード ラクテン', counterpartyHint: 'ラクテン' });
    expect(docs[2]?.facts).toMatchObject({ direction: 'out', transactionDate: '2026-09-03', grandTotal: 10000, paymentMethod: 'cash' });
  });

  it('rakuten-bank: 符号付き 1 列（負 = 出金）', () => {
    const docs = fromCsv('rakuten-bank', '取引日,入出金(円),残高(円),入出金先内容\n20260901,-3300,96700,"口座振替 ﾄｳｷｮｳﾃﾞﾝﾘｮｸ"\n20260902,50000,146700,振込 ｻﾄｳ ﾀﾛｳ\n20260903,-1200,145500,"ﾃﾞﾋﾞｯﾄ ｽﾀｰﾊﾞｯｸｽ, ｼﾌﾞﾔ"\n');
    expect(docs.map((doc) => [doc.facts.direction, doc.facts.grandTotal, doc.facts.paymentMethod, doc.facts.counterpartyHint])).toEqual([
      ['out', 3300, 'direct_debit', 'トウキョウデンリョク'], ['in', 50000, 'bank_transfer', 'サトウ'], ['out', 1200, 'unknown', 'スターバックス,'],
    ]);
  });

  it('mufg: 摘要 + 摘要内容を結合、支払い / 預かり列', () => {
    const docs = fromCsv('mufg', '日付,摘要,摘要内容,支払い金額,預かり金額,差引残高,メモ,未資金化区分,入払区分\n2026/9/1,振込,ｶ)ｽｽﾞｷ,,"220,000","1,220,000",,,入金\n2026/9/2,カード,ﾗｸﾃﾝｶ-ﾄﾞ,"33,000",,"1,187,000",,,支払\n2026/9/3,手数料,,330,,"1,186,670",,,支払\n');
    expect(docs.map((doc) => [doc.facts.direction, doc.facts.grandTotal, doc.facts.descriptionNorm])).toEqual([['in', 220000, '振込 スズキ'], ['out', 33000, 'カード ラクテンカ-ド'], ['out', 330, '手数料']]);
  });

  it('smbc / yucho: それぞれの列名で読める', () => {
    const smbc = fromCsv('smbc', 'お取引日,お引出し,お預入れ,お取り扱い内容,残高,メモ,ラベル\n2026/9/1,"12,100",,"ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ (ｶ",100000,,\n2026/9/2,,"5,000",振込 ﾀﾅｶ,105000,,\n2026/9/3,880,,ﾃｽｳﾘｮｳ,104120,,\n');
    expect(smbc.map((doc) => [doc.facts.direction, doc.facts.grandTotal, doc.facts.descriptionNorm])).toEqual([['out', 12100, 'ミツイスミトモカ-ド'], ['in', 5000, '振込 タナカ'], ['out', 880, 'テスウリョウ']]);
    const yucho = fromCsv('yucho', '日付,入出金明細ID,詳細1,詳細2,払出し金額,預入れ金額,貸付金額,返済金額,残高,取扱店,取扱店名,メモ\n2026/09/01,1,振込,ｶ)ｱｵｲ,,"40,000",,,140000,,,\n2026/09/02,2,ｵｰﾄ,ﾎｹﾝﾘｮｳ,"8,000",,,,132000,,,\n2026/09/03,3,ATM,,"20,000",,,,112000,001,東京中央,\n');
    expect(yucho.map((doc) => [doc.facts.direction, doc.facts.grandTotal, doc.facts.descriptionNorm, doc.facts.paymentMethod])).toEqual([['in', 40000, '振込 アオイ', 'bank_transfer'], ['out', 8000, 'オート ホケンリョウ', 'unknown'], ['out', 20000, 'ATM', 'cash']]);
  });

  it('rakuten-card: 全行が支出・credit_card・card_statement。追加列は row に残る', () => {
    const docs = fromCsv('rakuten-card', '利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額,9月支払金額\n2026/08/30,"AMAZON.CO.JP",本人,1回払い,4980,0,4980,4980\n2026/08/31,ｽﾀｰﾊﾞｯｸｽ ｼﾌﾞﾔ,本人,1回払い,660,0,660,660\n2026/09/01,"ヨドバシ, 新宿",家族,1回払い,"12,800",0,"12,800","12,800"\n');
    expect(docs.every((doc) => doc.kind === 'card_statement' && doc.facts.direction === 'out' && doc.facts.paymentMethod === 'credit_card')).toBe(true);
    expect(docs.map((doc) => doc.facts.grandTotal)).toEqual([4980, 660, 12800]);
    expect(docs[0]?.source.row?.['9月支払金額']).toBe('4980');
    expect(docs[2]?.facts.descriptionNorm).toBe('ヨドバシ, 新宿');
  });

  it('異常: 日付が読めない・金額が無い・金額が 0 は行番号つきの JournalCsvImportError。未知のプリセット', () => {
    expect(() => rowToDocument('generic', { 日付: 'いつか', 摘要: 'x', 出金: '1', 入金: '' }, {}, 5)).toThrow(/CSV row 5: date is missing or unreadable/u);
    expect(() => rowToDocument('generic', { 日付: '2026/9/1', 摘要: 'x', 出金: '', 入金: '' }, {}, 6)).toThrow(/CSV row 6: amount is missing or unreadable/u);
    expect(() => rowToDocument('generic', { 日付: '2026/9/1', 摘要: 'x', 出金: '0', 入金: '' }, {}, 7)).toThrow(/CSV row 7: amount must be positive/u);
    try { rowToDocument('generic', { 日付: 'x', 摘要: 'x', 出金: '1', 入金: '' }, {}, 5); } catch (error) { expect((error as JournalCsvImportError).row).toBe(5); }
    expect(() => rowToDocument('nope' as 'generic', {}, {})).toThrow(/unknown CSV preset: nope/u);
  });

  it('境界: accountHint の空白だけは付けない。両側に金額がある行は大きい側', () => {
    const doc = rowToDocument('generic', { 日付: '2026/9/1', 摘要: 'x', 出金: '300', 入金: '100' }, { accountHint: ' ' });
    expect(doc.facts.accountHint).toBeUndefined();
    expect(doc.facts).toMatchObject({ direction: 'out', grandTotal: 200 });
  });
});

describe('rowToDocumentWithMapping', () => {
  it('正常: 出金 / 入金列、または符号付き amount 列で読む', () => {
    const two = rowToDocumentWithMapping({ date: 'Date', description: 'Memo', withdrawal: 'Out', deposit: 'In', balance: 'Bal', detail: 'Detail' }, { Date: '2026-09-01', Memo: '振込', Detail: 'ｻﾄｳ', Out: '', In: '1,000', Bal: '5,000' }, { fileName: 'u.csv' }, 2);
    expect(two).toMatchObject({ kind: 'bank_statement', source: { type: 'csv-row', fileName: 'u.csv' }, facts: { direction: 'in', grandTotal: 1000, descriptionNorm: '振込 サトウ', counterpartyHint: 'サトウ', extra: { balance: 5000 } } });
    expect(two.source.preset).toBeUndefined();
    const signed = rowToDocumentWithMapping({ date: 'd', description: 'm', amount: 'a' }, { d: '2026/9/1', m: 'x', a: '-500' });
    expect(signed.facts).toMatchObject({ direction: 'out', grandTotal: 500 });
  });

  it('異常: 金額列の指定が無い', () => {
    expect(() => rowToDocumentWithMapping({ date: 'd', description: 'm' }, { d: '2026/9/1', m: 'x' })).toThrow(/column mapping needs amount or withdrawal \/ deposit columns/u);
  });
});

describe('paymentMethodFromDescription', () => {
  it('正常: 摘要の語から推定する（ATM → cash、口座振替 → direct_debit、カード → credit_card、振込 → bank_transfer、PayPay → qr、Suica → e_money）', () => {
    expect(paymentMethodFromDescription('ATM 引出')).toBe('cash');
    expect(paymentMethodFromDescription('口座振替 東京電力')).toBe('direct_debit');
    expect(paymentMethodFromDescription('楽天カード')).toBe('credit_card');
    expect(paymentMethodFromDescription('振込 サトウ')).toBe('bank_transfer');
    expect(paymentMethodFromDescription('PayPay チャージ')).toBe('qr');
    expect(paymentMethodFromDescription('Suica')).toBe('e_money');
    expect(paymentMethodFromDescription('利息')).toBe('unknown');
  });
});

describe('paymentMethodFromDescription（カナ表記の銀行摘要）', () => {
  it('正常: 半角カナの フリコミ / コウザフリカエ を振込・口座振替として判定する', () => {
    expect(paymentMethodFromDescription('ﾌﾘｺﾐ ｶ)ｻﾝﾌﾟﾙｼｮｳｼﾞ')).toBe('bank_transfer');
    expect(paymentMethodFromDescription('ｺｳｻﾞﾌﾘｶｴ ﾄｳｷｮｳﾃﾞﾝﾘｮｸ')).toBe('direct_debit');
  });

  it('正常: ゆうちょの「自動払込み」は口座振替として判定する', () => {
    expect(paymentMethodFromDescription('自動払込み トウキョウデンリョク')).toBe('direct_debit');
  });

  it('境界: ATM の引き出しは現金、カード利用はクレジットカード', () => {
    expect(paymentMethodFromDescription('ATM ﾋｷﾀﾞｼ ｶｽﾐｶﾞｾｷｼﾃﾝ')).toBe('cash');
    expect(paymentMethodFromDescription('ｶｰﾄﾞ ﾗｸﾃﾝｶｰﾄﾞ')).toBe('credit_card');
  });

  it('異常: 種別が読み取れない摘要は unknown', () => {
    expect(paymentMethodFromDescription('ﾃｽｳﾘｮｳ')).toBe('unknown');
    expect(paymentMethodFromDescription('')).toBe('unknown');
  });
});
