/**
 * ドメイン: 取込テキストの正規化（純関数）。
 *
 * 銀行明細の摘要・OCR 結果・手入力の揺れを吸収し、ルール照合（`conditions.ts`）が同じ形の
 * 文字列を見られるようにする。数字列は**除去しない**（金額・番号がルール条件になり得る）。
 */

/** 半角カタカナ → 全角カタカナ（NFKC が濁点・半濁点の合成まで面倒を見る）。 */
function toFullWidthKatakana(text: string): string {
  // NFKC は半角カナを全角へ写し、続く半角濁点 (ﾞ/ﾟ) を結合文字に変えるので、NFC で合成する。
  return text.normalize('NFKC').normalize('NFC');
}

/**
 * 法人略号（銀行摘要の `ｶ)` `(ｶ` `ｶﾌﾞ)` や `(株)` `㈱` `有)` `㈲` など）を落とす。
 * 全角化した後に評価するので、半角の `ｶ)` は `カ)` として現れる。
 */
const CORPORATE_ABBREVIATIONS: readonly RegExp[] = [
  /[（(]?(?:カブ|ユウ|カ|ユ|ザイ|シャ|ドウ|ガク|イ|フ|シ|ホ|ダイ|ダ|ノ|エイ|ソ|ニ|ゲン|ヒ|ケン|イリョウ|シャダン|ザイダン|ユウゲン|カブシキ|ゴウシ|ゴウメイ|ゴウドウ)[)）]/gu,
  /[（(](?:カブ|ユウ|カ|ユ|ザイ|シャ|ドウ|ガク|イ|フ|シ|ホ|ダイ|ダ|ノ|エイ|ソ|ニ|ゲン|ヒ|ケン|イリョウ|シャダン|ザイダン|ユウゲン|カブシキ|ゴウシ|ゴウメイ|ゴウドウ)(?=\s|$)/gu,
  /[（(](?:株|有|合|資|名|同|医|財|社|学|一社|一財|公社|公財|特非|宗|福|独|地独|農|漁|協|信|労|信組|信金|相|生|損|税|弁|司|行|士|監|特)[)）]/gu,
  // 片側だけの略号（`有)スズキ` / `サトウ(株`）。語頭 / 語末に限る。
  /(?:^|(?<=\s))(?:株|有|合|資|名|同|医|財|社|学)[)）]|[（(](?:株|有|合|資|名|同|医|財|社|学)(?=\s|$)/gu,
  /[㈱㈲㈳㈴㈵㈶㈷㈸㈹㈺㈻㈼㈽㈾㈿㉀㉁㉂㉃]/gu,
  /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|医療法人|社会福祉法人|学校法人|宗教法人/gu,
];

/**
 * 摘要の正規化: NFKC、半角カナ→全角、法人略号の除去、連続空白の圧縮、trim。
 * 空・非文字列は空文字。
 */
export function normalizeDescription(text: string | undefined | null): string {
  if (typeof text !== 'string') return '';
  let value = toFullWidthKatakana(text);
  for (const pattern of CORPORATE_ABBREVIATIONS) value = value.replace(pattern, ' ');
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * 登録番号の正規化: 全角→半角、`T-1234…` / `T 1234…` / 小文字 `t` → `T` + 13 桁。
 * 形が合わなければ undefined（呼び出し側が「未取得」として扱う）。
 */
export function normalizeRegistrationNumber(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string') return undefined;
  const compact = text.normalize('NFKC').replace(/[\s\-‐‑‒–—―ー－]/gu, '').toUpperCase();
  return /^T\d{13}$/u.test(compact) ? compact : undefined;
}

/** 和暦の元号 → 元年の西暦 − 1（`年数 + offset` が西暦）。 */
const ERA_OFFSETS: Readonly<Record<string, number>> = { 令和: 2018, R: 2018, 平成: 1988, H: 1988, 昭和: 1925, S: 1925 };

function toIsoDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 日本の帳票・明細に現れる日付表記を `YYYY-MM-DD` へ。
 * `2026/9/13`, `2026-09-13`, `2026.9.13`, `20260913`, `2026年9月13日`, `R8.9.13`, `R08/09/13`,
 * `令和8年9月13日`, `H31.4.30`, `26/09/13`（2 桁年は 2000 年代）。解釈できなければ undefined。
 */
export function parseJapaneseDate(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string') return undefined;
  const value = text.normalize('NFKC').trim().replace(/\s+/gu, '');
  if (value.length === 0) return undefined;

  const era = /^(令和|平成|昭和|[RHS])\s*(元|\d{1,2})[年./-](\d{1,2})[月./-](\d{1,2})日?$/u.exec(value);
  if (era !== null) {
    const offset = ERA_OFFSETS[era[1]!];
    if (offset === undefined) return undefined;
    const eraYear = era[2] === '元' ? 1 : Number(era[2]);
    return toIsoDate(eraYear + offset, Number(era[3]), Number(era[4]));
  }

  const western = /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/u.exec(value);
  if (western !== null) return toIsoDate(Number(western[1]), Number(western[2]), Number(western[3]));

  const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (compact !== null) return toIsoDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  const twoDigit = /^(\d{2})[/.-](\d{1,2})[/.-](\d{1,2})$/u.exec(value);
  if (twoDigit !== null) return toIsoDate(2000 + Number(twoDigit[1]), Number(twoDigit[2]), Number(twoDigit[3]));

  return undefined;
}

/**
 * 金額表記を整数（円）へ。`¥1,234`, `1,234円`, `1 234`, 全角数字、負号は `-` / `△` / `▲` / `(1,234)`。
 * 小数（`1,234.00`）は小数点以下が 0 のときだけ受ける。解釈できなければ undefined。
 */
export function parseAmount(text: string | number | undefined | null): number | undefined {
  if (typeof text === 'number') return Number.isInteger(text) ? text : undefined;
  if (typeof text !== 'string') return undefined;
  let value = text.normalize('NFKC').trim();
  if (value.length === 0) return undefined;
  let negative = false;
  if (/^\(.*\)$/u.test(value)) { negative = true; value = value.slice(1, -1); }
  value = value.replace(/[¥￥$,\s円]/gu, '');
  if (/^[-−△▲]/u.test(value)) { negative = !negative; value = value.slice(1); }
  else if (/^\+/u.test(value)) value = value.slice(1);
  if (value.endsWith('-')) { negative = !negative; value = value.slice(0, -1); }
  const match = /^(\d+)(?:\.(\d+))?$/u.test(value);
  if (!match) return undefined;
  const [whole, fraction] = value.split('.');
  if (fraction !== undefined && /[1-9]/u.test(fraction)) return undefined;
  const amount = Number(whole);
  if (!Number.isSafeInteger(amount)) return undefined;
  return negative ? -amount : amount;
}

/**
 * 正規化済み摘要から相手先を切り出す（best-effort）。
 * `振込 ヤマダタロウ` → `ヤマダタロウ`、`口座振替 トウキョウデンリョク` → `トウキョウデンリョク`、
 * 先頭語が種別語（振込・振替・引落・カード など）ならその次の語、そうでなければ先頭語。
 */
export function counterpartyFromDescription(descriptionNorm: string | undefined | null): string | undefined {
  if (typeof descriptionNorm !== 'string') return undefined;
  const words = descriptionNorm.trim().split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  // 種別語は漢字でもカナでも現れる（半角カナは NFKC で全角カナ）。ゆうちょの「自動払込み」も種別語。
  const KIND_WORDS = /^(振込|振替|口座振替|引落|引き落とし|自動引落|自動払込み|自動払込|自動振替|カード|クレジット|ＡＴＭ|ATM|入金|出金|送金|給与|給料|振込手数料|デビット|Ｖデビット|Vデビット|ペイジー|Pay-easy|手数料|フリコミ|フリカエ|コウザフリカエ|ジドウハライコミ|ヒキオトシ|ヒキダシ|アズケイレ|テスウリョウ|ソウキン|キュウヨ|キユウヨ|ニュウキン|シュッキン)$/u;
  const remaining = words.filter((word) => !KIND_WORDS.test(word) && !/^\d+$/u.test(word));
  const candidate = remaining[0];
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
}
