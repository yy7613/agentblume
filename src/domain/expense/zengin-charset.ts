/**
 * ドメイン: 全銀協形式の文字の変換（docs/21 §20.6.3。純関数・完成品）。
 *
 * 全銀協の総合振込は Shift_JIS の**半角だけ**（JIS X 0201 の範囲）で書く。ASCII 0x20〜0x7E と半角カナ U+FF61〜U+FF9F →
 * 0xA1〜0xDF の対応表だけで足りるので、外部ライブラリは使わない。
 *
 * **書式の変換だけを行い、判断が要る文字は変換しないで `invalid` に返す**（中点をピリオドにするかスペースにするかは
 * 銀行に登録した名義を知る人が決める。黙って置き換えると名義照合で組戻しになる。ADR-0043 §6）。
 *
 * A（従業員の名義カナの保存時の検証）と B（振込データの組み立て）が同じ規則を使うので、骨格がここ 1 か所に置く。
 *
 * `converted` は「人が見て確かめるべき書式の変換」（小書き → 並字・長音 → ハイフン・英小文字 → 大文字・`ｦ` → `ｵ`）が
 * 起きたかどうか。全角 → 半角・ひらがな → カタカナは入力の揺れにすぎないので数えない（数えると全員に警告が出る）。
 */
import { ExpenseDomainError } from './errors';

export const ZENGIN_CHARSETS = ['strict', 'extended'] as const;
/** `strict` = 調べた全銀行で通る最も狭い組み合わせ（既定）。`extended` = 記号を許す銀行向け。 */
export type ZenginCharset = (typeof ZENGIN_CHARSETS)[number];

/** 受取人名（データレコード 51-80）。 */
export const ZENGIN_HOLDER_NAME_MAX_BYTES = 30;
/** 依頼人名（ヘッダー 15-54）。 */
export const ZENGIN_REQUESTER_NAME_MAX_BYTES = 40;
/** 銀行名・支店名（15 桁）。 */
export const ZENGIN_BANK_NAME_MAX_BYTES = 15;

export interface ZenginTextResult {
  /** 変換後の文字列（1 文字 = 1 バイト。`invalid` の文字はそのまま残す）。 */
  readonly text: string;
  /** 人が確かめるべき書式の変換が起きたか（冒頭のコメント）。 */
  readonly converted: boolean;
  /** 変換できない文字と、入力の何文字目か（0 始まり、コードポイント単位）。 */
  readonly invalid: readonly { readonly char: string; readonly index: number }[];
}

const FULL_KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
const HALF_KANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ';
const VOICED_FULL = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボ';
const VOICED_BASE = 'カキクケコサシスセソタチツテトハヒフヘホ';
const SEMI_VOICED_FULL = 'パピプペポ';
const SEMI_VOICED_BASE = 'ハヒフヘホ';
/** 小書き → 並字（全角・半角）。許容文字に小書きが無いため。 */
const SMALL_FULL = 'ァィゥェォッャュョヮヵヶ';
const SMALL_FULL_BASE = 'アイウエオツヤユヨワカケ';
const SMALL_HALF = 'ｧｨｩｪｫｯｬｭｮ';
const SMALL_HALF_BASE = 'ｱｲｳｴｵﾂﾔﾕﾖ';

interface Mapping { readonly out: string; readonly converted: boolean }

function buildTable(): ReadonlyMap<string, Mapping> {
  const table = new Map<string, Mapping>();
  const width = (from: string, out: string) => table.set(from, { out, converted: false });
  const format = (from: string, out: string) => table.set(from, { out, converted: true });
  [...FULL_KANA].forEach((char, index) => width(char, HALF_KANA[index] as string));
  [...VOICED_FULL].forEach((char, index) => width(char, `${table.get(VOICED_BASE[index] as string)?.out}ﾞ`));
  [...SEMI_VOICED_FULL].forEach((char, index) => width(char, `${table.get(SEMI_VOICED_BASE[index] as string)?.out}ﾟ`));
  width('ヴ', 'ｳﾞ');
  [...SMALL_FULL].forEach((char, index) => format(char, table.get(SMALL_FULL_BASE[index] as string)?.out as string));
  [...SMALL_HALF].forEach((char, index) => format(char, SMALL_HALF_BASE[index] as string));
  for (const long of ['ー', 'ｰ']) format(long, '-');
  for (const hyphen of ['－', '‐', '−']) width(hyphen, '-');
  for (const mark of ['゛', '゙']) width(mark, 'ﾞ');
  for (const mark of ['゜', '゚']) width(mark, 'ﾟ');
  width('　', ' ');
  width('（', '(');
  width('）', ')');
  width('．', '.');
  width('／', '/');
  width('，', ',');
  width('￥', '¥');
  width('「', '｢');
  width('」', '｣');
  for (let code = 0xff10; code <= 0xff19; code += 1) width(String.fromCodePoint(code), String.fromCodePoint(code - 0xff10 + 0x30));
  for (let code = 0xff21; code <= 0xff3a; code += 1) width(String.fromCodePoint(code), String.fromCodePoint(code - 0xff21 + 0x41));
  for (let code = 0xff41; code <= 0xff5a; code += 1) format(String.fromCodePoint(code), String.fromCodePoint(code - 0xff41 + 0x41));
  for (let code = 0x61; code <= 0x7a; code += 1) format(String.fromCodePoint(code), String.fromCodePoint(code - 0x20));
  return table;
}

const TABLE = buildTable();

/** strict で使える 1 文字（半角カナ ｱ〜ﾝ・濁点・半濁点・数字・英大文字・`( ) - .`・スペース）。 */
function allowedStrict(char: string): boolean {
  const code = char.codePointAt(0) as number;
  if (code >= 0xff71 && code <= 0xff9f) return true;
  return /^[0-9A-Z ()\-.]$/u.test(char);
}

/** extended は strict に `ｦ` `/` `,` `¥` `｢` `｣` を足す（許す銀行向け）。 */
function allowedExtended(char: string): boolean {
  return allowedStrict(char) || ['ｦ', '/', ',', '¥', '｢', '｣'].includes(char);
}

/** ひらがな → カタカナ（ぁ U+3041〜ゖ U+3096 は +0x60 でカタカナ）。 */
function toKatakana(char: string): string {
  const code = char.codePointAt(0) as number;
  return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : char;
}

/** 書式の変換（§20.6.3 の表）。判断が要る文字は変換せず `invalid` に積む。 */
export function toZenginText(text: string, charset: ZenginCharset = 'strict'): ZenginTextResult {
  const allowed = charset === 'extended' ? allowedExtended : allowedStrict;
  let out = '';
  let converted = false;
  const invalid: { char: string; index: number }[] = [];
  [...text].forEach((raw, index) => {
    const char = toKatakana(raw);
    const mapped = TABLE.get(char);
    let next = mapped?.out ?? char;
    if (mapped?.converted === true) converted = true;
    // ｦ は並べる銀行と除く銀行があるので、strict では並字の ｵ に寄せる（書式の変換として警告に出す）。
    if (next === 'ｦ' && charset === 'strict') { next = 'ｵ'; converted = true; }
    if ([...next].every(allowed)) { out += next; return; }
    invalid.push({ char: raw, index });
    out += raw;
  });
  return { text: out, converted, invalid };
}

/** 変換後の文字列のバイト数（全銀の文字は 1 文字 1 バイト。濁点・半濁点も 1 バイトとして数える）。 */
export function zenginByteLength(convertedText: string): number {
  return [...convertedText].length;
}

export interface ZenginNameCheck extends ZenginTextResult {
  readonly bytes: number;
  readonly maxBytes: number;
  readonly tooLong: boolean;
}

/** 名義・依頼人名・銀行名の検査（変換 → 禁止文字 → バイト数）。 */
export function checkZenginName(text: string, maxBytes: number, charset: ZenginCharset = 'strict'): ZenginNameCheck {
  const result = toZenginText(text.trim(), charset);
  const bytes = zenginByteLength(result.text);
  return { ...result, bytes, maxBytes, tooLong: bytes > maxBytes };
}

/**
 * 変換済みの文字列を Shift_JIS（JIS X 0201）のバイト列にする。表に無い文字は実装の誤り（点検を通さずに組んだ）なので投げる。
 * `¥` は JIS X 0201 の 0x5C。
 */
export function encodeZenginText(text: string): Uint8Array {
  const chars = [...text];
  const bytes = new Uint8Array(chars.length);
  chars.forEach((char, index) => {
    const code = char.codePointAt(0) as number;
    if (char === '¥') bytes[index] = 0x5c;
    else if (code >= 0x20 && code <= 0x7e && char !== '\\') bytes[index] = code;
    else if (code >= 0xff61 && code <= 0xff9f) bytes[index] = code - 0xff61 + 0xa1;
    else throw new ExpenseDomainError(`encodeZenginText: the character "${char}" at ${index} cannot be written in a Zengin file (convert and check the text first)`);
  });
  return bytes;
}
