/**
 * ドメイン: 経費専用の追加読取を下書きへ反映する（docs/21 §20.3.6 / ADR-0043 §10。UC7。純関数）。
 *
 * モデルには**印字どおりの文字列**だけを書き写させ、数値化・日付化・桁数の判定・支払先キーの比較はここ（コード）で行う
 * （12B 級の vision モデルに正規化をさせない）。値は**空欄だけ**を候補として埋め、既に値がある欄は変えない。
 * 自動で直さない代わりに、印（`extraction.flags`）と食い違い（`disagreements`）で人に見せる。
 *
 * 下書きの事実は仕訳の読取（`ExtractJournalDocumentUseCase`）の結果そのものなので、「仕訳の読取」の値は下書きから取る。
 */
import { normalizeRegistrationNumber, parseJapaneseDate } from '../../journal/normalize';
import type { ItemExtraction } from '../claim';
import type { DetailDisagreementField, ExpenseDetailRead, ExtractionFlag } from '../detail-read';
import { payeeKeyOf } from '../duplicates';
import { digitCount, ROUTE_MAX_STATIONS, ROUTE_STATION_NAME_MAX, type Attendees, type ReceiptFacts, type ReceiptRoute } from '../receipt-facts';

/** 読取で発行者が申請者・作成者になり、支払先が空になる帳票種別（receipt-drafts.ts と同じ）。 */
const REPORT_KINDS: ReadonlySet<string> = new Set(['expense_report', 'slip_transfer', 'slip_cash_in', 'slip_cash_out']);
/** 人が確認するまで残す印（再読取で作り直さない）。 */
const HUMAN_CONFIRMATION_FLAGS: ReadonlySet<ExtractionFlag> = new Set(['attendees-read', 'purpose-read', 'route-read', 'payee-read']);
const PAYEE_MAX = 200;
const ATTENDEE_NAME_MAX = 100;
const ATTENDEE_NAMES_MAX = 50;
const ATTENDEE_COUNT_MAX = 999;

export interface DetailMergeDraft {
  readonly facts: ReceiptFacts;
  readonly extraction: Pick<ItemExtraction, 'documentKind' | 'rejectedRegistrationNumber' | 'flags'>;
}

export interface DetailMergeOptions {
  /** 費目に区間の設定があるか（あるときだけ区間の空欄を埋める）。 */
  readonly routeWanted: boolean;
}

export interface DetailDisagreement {
  readonly field: DetailDisagreementField;
  readonly journalValue: string | null;
  readonly detailValue: string | null;
}

export interface DetailMergeResult {
  readonly facts: ReceiptFacts;
  readonly flags: readonly ExtractionFlag[];
  readonly disagreements: readonly DetailDisagreement[];
  /** 読取の結果の注意（取込の結果に出す。明細の `extraction.warnings` には積まない = 印と同じことを二重に言わない）。 */
  readonly warnings: readonly string[];
  /** 仕訳が落とした登録番号を追加読取が読んだときの生の文字列（下書きに無ければ写す）。 */
  readonly rejectedRegistrationNumber?: string;
  /** 目的の手がかり（埋めない。画面が候補チップとして見せる）。 */
  readonly purposeClues: readonly string[];
}

function trimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function registrationKey(text: string): string {
  return text.normalize('NFKC').replace(/[\s\-‐‑‒–—―ー－]/gu, '').toUpperCase();
}

/** 人数の文字列（「4名」「４人」）→ 1〜999 の整数。 */
export function parseAttendeeCount(text: string | null | undefined): number | undefined {
  const value = trimmed(text);
  if (value === undefined) return undefined;
  const match = /\d+/u.exec(value.normalize('NFKC'));
  if (match === null) return undefined;
  const count = Number(match[0]);
  return Number.isInteger(count) && count >= 1 && count <= ATTENDEE_COUNT_MAX ? count : undefined;
}

function routeFromRead(read: ExpenseDetailRead['route']): ReceiptRoute | undefined {
  const from = trimmed(read.from);
  const to = trimmed(read.to);
  if (from === undefined || to === undefined) return undefined;
  const stations = [from, ...read.via.map((via) => trimmed(via)).filter((via): via is string => via !== undefined), to];
  if (stations.length > ROUTE_MAX_STATIONS || stations.some((station) => station.length > ROUTE_STATION_NAME_MAX)) return undefined;
  return { stations, trips: 1, ...(read.fareType === null ? {} : { fareType: read.fareType }) };
}

export function mergeExpenseDetail(draft: DetailMergeDraft, read: ExpenseDetailRead, options: DetailMergeOptions): DetailMergeResult {
  const { facts, extraction } = draft;
  const flags = new Set<ExtractionFlag>((extraction.flags ?? []).filter((flag) => HUMAN_CONFIRMATION_FLAGS.has(flag)));
  const disagreements: DetailDisagreement[] = [];
  const warnings: string[] = [];
  let next: ReceiptFacts = facts;
  let rejectedRegistrationNumber: string | undefined;

  // 登録番号: 仕訳が落としたなら**埋めない**（桁の誤読の実測があるので人に選ばせる）。値が 2 つあって違えば食い違い。
  const registrationText = trimmed(read.registrationNumberText);
  if (registrationText !== undefined) {
    const normalized = normalizeRegistrationNumber(registrationText);
    if (facts.registrationNumber === undefined) {
      flags.add('registration-number-rejected');
      if (extraction.rejectedRegistrationNumber === undefined) rejectedRegistrationNumber = registrationText;
      warnings.push(normalized === undefined
        ? `追加の読取の登録番号「${registrationText}」は T + 数字 13 桁の形ではありません（数字 ${digitCount(registrationText)} 桁）。領収書を見て入力してください`
        : `追加の読取で登録番号「${normalized}」を読みましたが、桁の誤読があり得るため自動では入れていません。領収書と見比べて入力してください`);
    }
    const journalValue = facts.registrationNumber ?? extraction.rejectedRegistrationNumber;
    if (journalValue !== undefined && registrationKey(journalValue) !== registrationKey(normalized ?? registrationText)) {
      disagreements.push({ field: 'registrationNumber', journalValue, detailValue: registrationText });
    }
  }

  // 取引日 / 発行日: 埋めない。仕訳の取引日 = 発行日 で、追加読取に利用日の印字が無ければ発行日で代用した値。
  const transactionText = trimmed(read.transactionDateText);
  if (facts.transactionDate !== undefined && facts.transactionDate === facts.issueDate && transactionText === undefined) flags.add('transaction-date-substituted');
  const compareDate = (field: 'transactionDate' | 'issueDate', label: string, journal: string | undefined, text: string | undefined): void => {
    if (text === undefined) return;
    const parsed = parseJapaneseDate(text);
    if (parsed === undefined) {
      warnings.push(`追加の読取の${label}「${text}」を日付として解釈できませんでした`);
      return;
    }
    const shown = text === parsed ? parsed : `${text}（${parsed}）`;
    if (journal === undefined) warnings.push(`追加の読取では${label}が「${shown}」でした。自動では入れていません`);
    else if (journal !== parsed) disagreements.push({ field, journalValue: journal, detailValue: shown });
  };
  compareDate('transactionDate', '取引日', facts.transactionDate, transactionText);
  compareDate('issueDate', '発行日', facts.issueDate, trimmed(read.issueDateText));

  // 支払先: 精算書・伝票で空のときだけ埋める。両方あってキーが違えば食い違い（店名の略し方の差 = 一方が他方を含む は食い違いにしない）。
  const payeeText = trimmed(read.payeeNameText)?.slice(0, PAYEE_MAX);
  const isReport = extraction.documentKind !== undefined && REPORT_KINDS.has(extraction.documentKind);
  if (facts.payeeName === undefined || facts.payeeName.trim() === '') {
    if (isReport) {
      flags.add('payee-from-report');
      if (payeeText !== undefined) {
        next = { ...next, payeeName: payeeText };
        flags.add('payee-read');
      }
    }
  } else if (payeeText !== undefined) {
    const journalKey = payeeKeyOf(facts.payeeName);
    const detailKey = payeeKeyOf(payeeText);
    if (journalKey !== undefined && detailKey !== undefined && !journalKey.includes(detailKey) && !detailKey.includes(journalKey)) {
      disagreements.push({ field: 'payeeName', journalValue: facts.payeeName, detailValue: payeeText });
    }
  }

  // 参加人数 / 氏名: 空なら埋める。
  const count = parseAttendeeCount(read.attendees.countText);
  const names = read.attendees.names.map((name) => trimmed(name)).filter((name): name is string => name !== undefined).map((name) => name.slice(0, ATTENDEE_NAME_MAX)).slice(0, ATTENDEE_NAMES_MAX);
  let attendees: Attendees | undefined = facts.attendees;
  let attendeesFilled = false;
  if (count !== undefined && attendees?.count === undefined) {
    attendees = { ...attendees, count };
    attendeesFilled = true;
  }
  if (names.length > 0 && (attendees?.names ?? []).length === 0) {
    attendees = { ...attendees, names };
    attendeesFilled = true;
  }
  if (attendeesFilled && attendees !== undefined) {
    next = { ...next, attendees };
    flags.add('attendees-read');
  }

  // 区間: 費目に区間の設定があって空なら埋める。
  if (options.routeWanted && facts.route === undefined) {
    const route = routeFromRead(read.route);
    if (route !== undefined) {
      next = { ...next, route };
      flags.add('route-read');
    }
  }

  if (disagreements.length > 0) flags.add('reads-disagree');
  const purposeClues = [...new Set(read.purposeClues.map((clue) => trimmed(clue)).filter((clue): clue is string => clue !== undefined))];
  return {
    facts: next,
    flags: [...flags],
    disagreements,
    warnings,
    ...(rejectedRegistrationNumber === undefined ? {} : { rejectedRegistrationNumber }),
    purposeClues,
  };
}
