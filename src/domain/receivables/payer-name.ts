/**
 * ドメイン: 振込名義の正規化（docs/22 §4.2 / ADR-0041 決定 2）。純関数。
 *
 * 銀行の振込依頼人名は半角カナ・小書き無し・法人略語（`ｶ)` `ﾄﾞ)`）・30 桁前後の切り詰めが入る。
 * 取引先マスタの名前・カナ・別名と比べるときは、**摘要側とマスタ側の両方に同じ関数を通す**。
 * 漢字 → カナの推測はしない（辞書を持たない）。漢字の社名は kana か別名が無い限り一致しない。
 *
 * 仕訳の `normalizeDescription`（NFKC・半角カナ→全角・法人略号の除去）を土台にする。ただし全銀の略語
 * （`シヤ)` `トクヒ)` など）は仕訳の略号表より先に落とす。仕訳の表は `ヒ)` のような短い略号を
 * 位置を問わず落とすので、先に通すと `トクヒ)` が `トク` だけ残ってしまうため。
 */
import { normalizeDescription } from '../journal/normalize';

/**
 * 全銀の振込依頼人名で使う法人略語（仕訳の略号表に無いもの。小書きは並字に直した後の形）。
 * 法定の略語体系なのでコードの定数に持つ（設定にしない）。長い語から当てる。
 */
export const ZENGIN_CORPORATE_ABBREVIATIONS: readonly string[] = [
  'トクヒ', 'シユウ', 'ザイ', 'シヤ', 'ガク', 'フク', 'ドク', 'メ', 'シ', 'ド', 'イ', 'ソ', 'カ', 'ユ',
];

const ABBREVIATION_ALTERNATION = ZENGIN_CORPORATE_ABBREVIATIONS.join('|');
/** 前置 `カ)ヤマダ`（語頭か空白・開き括弧の直後）。 */
const PREFIX_FORM = new RegExp(`(^|[\\s(（])(?:${ABBREVIATION_ALTERNATION})[)）]`, 'gu');
/** 後置 `ヤマダ(カ` と中置 `ヤマダ(カ)ショウジ`（開き括弧つき。括弧の無い `ヤマダカ` は削らない）。 */
const SUFFIX_FORM = new RegExp(`[(（](?:${ABBREVIATION_ALTERNATION})(?=[\\s)）]|$)`, 'gu');

const SMALL_KANA: Readonly<Record<string, string>> = {
  ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ',
};

/** 振込の種別語（摘要の先頭に付く）。NFKC 後の形で見る。末尾の番号（`振込１`）も種別語の一部とみなす。 */
const KIND_WORD = /^(?:振込|振込入金|振込み|振替|入金|テレ|IB|ネット|フリコミ|フリコミニユウキン|フリコミニュウキン|ニユウキン|ニュウキン|フリカエ|カード)\d*$/u;

function hiraganaToKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

/**
 * 摘要から振込依頼人名を切り出す（§4.2 規則 1）。先頭の種別語を落とし、6 桁以上の数字列（振込依頼人コード）を除く。
 * 5 桁以下の数字は名前の一部かもしれないので残す。名義が独立した列の銀行ではこの関数を使わない。
 */
export function payerNameFromDescription(description: string | undefined | null): string {
  if (typeof description !== 'string') return '';
  const words = description.normalize('NFKC').replace(/\d{6,}/gu, ' ').split(/\s+/u).filter((word) => word.length > 0);
  while (words.length > 0 && KIND_WORD.test(words[0]!)) words.shift();
  return words.join(' ');
}

/** 照合用の正規化（§4.2 規則 2〜7）。空・非文字列は空文字。 */
export function normalizePayerName(text: string | undefined | null): string {
  if (typeof text !== 'string') return '';
  let value = hiraganaToKatakana(text.normalize('NFKC').normalize('NFC'));
  value = value.replace(/[ァィゥェォッャュョヮヵヶ]/gu, (char) => SMALL_KANA[char] ?? char);
  value = value.replace(PREFIX_FORM, '$1 ').replace(SUFFIX_FORM, ' ');
  value = normalizeDescription(value);
  // normalizeDescription が NFC で合成し直すので、小書きの並字化はもう一度かける（`シャ)` 以外の経路で残った小書き）。
  value = value.replace(/[ァィゥェォッャュョヮヵヶ]/gu, (char) => SMALL_KANA[char] ?? char);
  value = value.replace(/[ー－―‐\-−]/gu, 'ー');
  value = value.replace(/[\s・、。，,.．()（）「」『』[\]［］/／]/gu, '');
  return value.toUpperCase();
}
