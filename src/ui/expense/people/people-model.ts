/**
 * 系統 A（人と承認: docs/21 §20.2.5 / §20.2.6 / §20.5.1 / §20.10.1）の画面の純関数。
 *
 * 従業員フォームの下書き ⇔ 保存本文、口座番号の書式の整理（ハイフン・空白を外して見せる）、ゆうちょの記号番号の変換、
 * 保存の 400（`details.field`）→ 欄と平易な原因・直し方、承認経路の下書きの編集と点検、決まらない段の導線、紐付け候補の既定の選択を持つ。
 * サーバーの内部レイヤは import しない（UI は HTTP の DTO だけを知る）。
 */
import type {
  ExpenseApprovalFlowDto, ExpenseApprovalPlanDto, ExpenseApprovalRouteDto, ExpenseApprovalSettingsDto, ExpenseApprovalStepDefDto, ExpenseApproverKindDto,
  ExpenseApproverSpecDto,
} from '../../api/expense-types';
import type {
  ExpenseApprovalFlowViewDto, ExpenseApproverGroupDto, ExpenseBankAccountTypeDto, ExpenseDepartmentDto, ExpenseEmployeeDto, ExpenseEmployeeHistoryTypeDto,
  ExpenseEmployeeLinkDto, ExpenseEmployeeLinkMatchDto, SaveExpenseEmployeeDto,
} from '../../api/expense-people-types';
import type { OpenTarget } from '../../navigation';
import { approvalCauseText, type ClaimFormDraft, type Message, type Translate } from '../expense-model';

/* ---------------------------------------------------------------------------
 * 小さな道具
 * ------------------------------------------------------------------------- */

export function replaceAt<T>(list: readonly T[], index: number, value: T): readonly T[] {
  return list.map((entry, at) => (at === index ? value : entry));
}

export function removeAt<T>(list: readonly T[], index: number): readonly T[] {
  return list.filter((_, at) => at !== index);
}

/** 並びの入れ替え（範囲外へは動かさない）。 */
export function moveAt<T>(list: readonly T[], index: number, delta: -1 | 1): readonly T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(index, 1) as [T];
  next.splice(target, 0, moved);
  return next;
}

/** 空文字ならキーごと消す（保存本文に空の任意項目を送らない）。 */
export function withText<T extends object>(object: T, key: string, value: string): T {
  const next = { ...object } as Record<string, unknown>;
  const trimmed = value.trim();
  if (trimmed === '') delete next[key];
  else next[key] = trimmed;
  return next as T;
}

/** `prefix-N` の形で、既存と重ならない id。 */
export function nextId(prefix: string, existing: readonly string[]): string {
  let n = existing.length + 1;
  while (existing.includes(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/* ---------------------------------------------------------------------------
 * 口座番号・ゆうちょ
 * ------------------------------------------------------------------------- */

const SEPARATORS = /[\s　\-‐‑‒–—―−ー－]/g;

/** 全角数字を半角にする（書式の整理だけ。数字以外はそのまま残す）。 */
function halfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

export interface DigitsCleanup {
  /** ハイフン・空白を外し、全角数字を半角にした値。 */
  readonly value: string;
  /** 外した文字があったか（画面は「外した」と見せる）。 */
  readonly removed: boolean;
}

/** 口座番号・記号・番号・コードの入力から、ハイフンと空白を外す。 */
export function cleanDigits(raw: string): DigitsCleanup {
  const normalized = halfWidthDigits(raw);
  const value = normalized.replace(SEPARATORS, '');
  return { value, removed: value !== normalized };
}

export type YuchoResult =
  | { readonly ok: true; readonly bankCode: '9900'; readonly branchCode: string; readonly accountType: ExpenseBankAccountTypeDto; readonly accountNumber: string }
  | { readonly ok: false; readonly field: 'symbol' | 'number'; readonly message: Message };

/**
 * ゆうちょ銀行の記号 5 桁 + 番号 → 全銀の銀行コード・支店番号・預金種目・口座番号（§20.2.5）。
 * 記号が 1 始まり: 支店 = 記号の 2〜3 桁目 + 8、口座番号 = 番号（末尾 1）の末尾の 1 を除いた値を前ゼロ 7 桁、普通。
 * 記号が 0 始まり: 支店 = 記号の 2〜3 桁目 + 9、口座番号 = 番号を前ゼロ 7 桁、当座。
 */
export function yuchoToZengin(symbolRaw: string, numberRaw: string): YuchoResult {
  const symbol = cleanDigits(symbolRaw).value;
  const number = cleanDigits(numberRaw).value;
  if (!/^[01]\d{4}$/.test(symbol)) {
    return { ok: false, field: 'symbol', message: ['The symbol must be 5 digits starting with 1 (ordinary) or 0 (current). Copy it from the passbook.', '記号は 1（通常貯金）か 0（振替口座）で始まる 5 桁です。通帳の記号を写してください'] };
  }
  const branchBase = symbol.slice(1, 3);
  if (symbol.startsWith('1')) {
    if (!/^\d{2,8}$/.test(number) || !number.endsWith('1')) {
      return { ok: false, field: 'number', message: ['For a symbol starting with 1, the number is up to 8 digits and ends with 1. Copy it from the passbook.', '記号が 1 で始まる口座の番号は 8 桁以内で末尾が 1 です。通帳の番号を写してください'] };
    }
    return { ok: true, bankCode: '9900', branchCode: `${branchBase}8`, accountType: 'ordinary', accountNumber: number.slice(0, -1).padStart(7, '0') };
  }
  if (!/^\d{1,7}$/.test(number)) {
    return { ok: false, field: 'number', message: ['For a symbol starting with 0, the number is 1 to 7 digits. Copy it from the passbook or the transfer slip.', '記号が 0 で始まる口座の番号は 1〜7 桁です。通帳か払込票の番号を写してください'] };
  }
  return { ok: true, bankCode: '9900', branchCode: `${branchBase}9`, accountType: 'current', accountNumber: number.padStart(7, '0') };
}

export function accountTypeLabel(type: ExpenseBankAccountTypeDto, text: Translate): string {
  switch (type) {
    case 'ordinary': return text('Ordinary', '普通');
    case 'current': return text('Current', '当座');
    case 'savings': return text('Savings', '貯蓄');
    default: return text('Other', 'その他');
  }
}

/** 伏せ字（末尾 4 桁だけを見せる）。 */
export function maskedAccountNumber(last4: string): string {
  return `***${last4}`;
}

/* ---------------------------------------------------------------------------
 * 従業員フォーム
 * ------------------------------------------------------------------------- */

export interface CommuterPassDraft {
  readonly id: string;
  /** 駅を「>」区切りか 1 行 1 駅で。 */
  readonly stations: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly note: string;
}

export interface BankAccountDraft {
  /** 口座を持つか（false で保存すると、既存の口座を外す）。 */
  readonly present: boolean;
  readonly bankCode: string;
  readonly bankNameKana: string;
  readonly branchCode: string;
  readonly branchNameKana: string;
  readonly accountType: ExpenseBankAccountTypeDto;
  readonly holderKana: string;
  /** 平文の口座番号（「変更する」を押したか、新しい口座のときだけ使う）。 */
  readonly accountNumber: string;
  /** 「変更する」を押した。 */
  readonly changeNumber: boolean;
  /** 保存済みの口座番号の末尾 4 桁（無ければ新しい口座）。 */
  readonly last4?: string;
}

export interface EmployeeFormDraft {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameKana: string;
  readonly departmentId: string;
  readonly managerEmployeeId: string;
  /** 1 行 1 つ。 */
  readonly loginSubjects: string;
  readonly enabled: boolean;
  readonly note: string;
  readonly bank: BankAccountDraft;
  readonly passes: readonly CommuterPassDraft[];
  /** 保存済みの従業員が口座を持っていたか（外したら `bankAccount: null` を送る）。 */
  readonly hadBankAccount: boolean;
}

export type EmployeeFormField =
  | 'id' | 'code' | 'name' | 'nameKana' | 'departmentId' | 'managerEmployeeId' | 'loginSubjects' | 'note' | 'enabled'
  | 'bankCode' | 'bankNameKana' | 'branchCode' | 'branchNameKana' | 'accountType' | 'accountNumber' | 'holderKana' | 'commuterPasses';

export const EMPLOYEE_LOGIN_SUBJECT_LIMIT = 5;
export const EMPLOYEE_COMMUTER_PASS_LIMIT = 3;

const EMPTY_BANK: BankAccountDraft = { present: false, bankCode: '', bankNameKana: '', branchCode: '', branchNameKana: '', accountType: 'ordinary', holderKana: '', accountNumber: '', changeNumber: false };

export function emptyEmployeeForm(): EmployeeFormDraft {
  return { id: '', code: '', name: '', nameKana: '', departmentId: '', managerEmployeeId: '', loginSubjects: '', enabled: true, note: '', bank: EMPTY_BANK, passes: [], hadBankAccount: false };
}

export function formatStations(stations: readonly string[]): string {
  return stations.join(' > ');
}

/** 駅の並びの入力 → 駅の配列（「>」「＞」か改行で区切る。空は捨てる）。 */
export function parseStations(raw: string): readonly string[] {
  return raw.split(/[>＞\r\n]+/).map((station) => station.trim()).filter((station) => station !== '');
}

export function splitLines(raw: string): readonly string[] {
  return raw.split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line !== '');
}

export function employeeFormFrom(employee: ExpenseEmployeeDto): EmployeeFormDraft {
  const account = employee.bankAccount;
  return {
    id: employee.id, code: employee.code ?? '', name: employee.name, nameKana: employee.nameKana ?? '', departmentId: employee.departmentId ?? '',
    managerEmployeeId: employee.managerEmployeeId ?? '', loginSubjects: employee.loginSubjects.join('\n'), enabled: employee.enabled, note: employee.note ?? '',
    bank: account === undefined ? EMPTY_BANK : {
      present: true, bankCode: account.bankCode, bankNameKana: account.bankNameKana ?? '', branchCode: account.branchCode, branchNameKana: account.branchNameKana ?? '',
      accountType: account.accountType, holderKana: account.holderKana, accountNumber: '', changeNumber: false, last4: account.accountNumberLast4,
    },
    passes: employee.commuterPasses.map((pass) => ({ id: pass.id, stations: formatStations(pass.stations), validFrom: pass.validFrom ?? '', validTo: pass.validTo ?? '', note: pass.note ?? '' })),
    hadBankAccount: account !== undefined,
  };
}

export function newCommuterPass(passes: readonly CommuterPassDraft[]): CommuterPassDraft {
  return { id: nextId('pass', passes.map((pass) => pass.id)), stations: '', validFrom: '', validTo: '', note: '' };
}

/** 口座番号を送るか（新しい口座か「変更する」を押したときだけ。省略 = 既存を保つ）。 */
export function sendsAccountNumber(bank: BankAccountDraft): boolean {
  return bank.present && (bank.last4 === undefined || bank.changeNumber);
}

export interface EmployeeInputResult {
  readonly input?: SaveExpenseEmployeeDto;
  readonly errors: Readonly<Partial<Record<EmployeeFormField, Message>>>;
}

/** フォーム → 保存本文。画面で分かる誤り（必須・桁・件数）は送る前に止める。書式の変換（名義カナ）はサーバーが行う。 */
export function employeeInputFromForm(form: EmployeeFormDraft, options: { readonly isNew: boolean }): EmployeeInputResult {
  const errors: Partial<Record<EmployeeFormField, Message>> = {};
  if (form.name.trim() === '') errors.name = ['Enter the name.', '氏名を入れてください'];
  if (options.isNew && form.id.trim() !== '' && !/^[a-z0-9_.-]{1,64}$/.test(form.id.trim())) errors.id = ['Use up to 64 lowercase letters, digits, "_", ".", or "-" for the id, or leave it empty.', 'id は英小文字・数字・「_ . -」の 64 字以内にするか、空欄にしてください'];
  const loginSubjects = splitLines(form.loginSubjects);
  if (loginSubjects.length > EMPLOYEE_LOGIN_SUBJECT_LIMIT) errors.loginSubjects = [`Up to ${EMPLOYEE_LOGIN_SUBJECT_LIMIT} login IDs. Remove ${loginSubjects.length - EMPLOYEE_LOGIN_SUBJECT_LIMIT}.`, `ログイン ID は ${EMPLOYEE_LOGIN_SUBJECT_LIMIT} 件までです。${loginSubjects.length - EMPLOYEE_LOGIN_SUBJECT_LIMIT} 件減らしてください`];
  if (form.managerEmployeeId !== '' && form.managerEmployeeId === form.id) errors.managerEmployeeId = ['An employee cannot be their own manager. Choose someone else.', '自分自身は上長にできません。別の人を選んでください'];

  const passes = form.passes.map((pass) => ({ pass, stations: parseStations(pass.stations) }));
  if (passes.length > EMPLOYEE_COMMUTER_PASS_LIMIT) errors.commuterPasses = [`Up to ${EMPLOYEE_COMMUTER_PASS_LIMIT} commuter passes.`, `通勤定期は ${EMPLOYEE_COMMUTER_PASS_LIMIT} 件までです`];
  else if (passes.some(({ stations }) => stations.length < 2)) errors.commuterPasses = ['Enter at least two stations for each commuter pass (for example: Shinjuku > Tokyo).', '通勤定期の駅は 2 つ以上入れてください（例: 新宿 > 東京）'];
  else if (passes.some(({ pass }) => pass.validFrom !== '' && pass.validTo !== '' && pass.validFrom > pass.validTo)) errors.commuterPasses = ['The "valid from" date is after the "valid to" date. Swap them.', '有効期間の開始が終了より後です。入れ替えてください'];

  const bank = form.bank;
  let accountNumber: string | undefined;
  if (bank.present) {
    if (!/^\d{4}$/.test(bank.bankCode)) errors.bankCode = ['The bank code is 4 digits (for Japan Post Bank, use the converter below).', '銀行コードは 4 桁の数字です（ゆうちょ銀行は下の変換を使ってください）'];
    if (!/^\d{3}$/.test(bank.branchCode)) errors.branchCode = ['The branch code is 3 digits.', '支店番号は 3 桁の数字です'];
    if (bank.holderKana.trim() === '') errors.holderKana = ['Enter the account holder name in kana as printed on the passbook.', '口座名義をカナで入れてください（通帳の表記のとおり）'];
    if (sendsAccountNumber(bank)) {
      if (!/^\d{1,7}$/.test(bank.accountNumber)) errors.accountNumber = ['The account number is 1 to 7 digits.', '口座番号は 1〜7 桁の数字です'];
      else accountNumber = bank.accountNumber;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };

  let input: SaveExpenseEmployeeDto = {
    name: form.name.trim(), loginSubjects, enabled: form.enabled,
    commuterPasses: passes.map(({ pass, stations }) => withText(withText(withText({ id: pass.id, stations }, 'validFrom', pass.validFrom), 'validTo', pass.validTo), 'note', pass.note)),
  };
  if (options.isNew) input = withText(input, 'id', form.id);
  input = withText(withText(withText(withText(withText(input, 'code', form.code), 'nameKana', form.nameKana), 'departmentId', form.departmentId), 'managerEmployeeId', form.managerEmployeeId), 'note', form.note);
  if (bank.present) {
    const account = withText(withText({ bankCode: bank.bankCode, branchCode: bank.branchCode, accountType: bank.accountType, holderKana: bank.holderKana.trim() }, 'bankNameKana', bank.bankNameKana), 'branchNameKana', bank.branchNameKana);
    input = { ...input, bankAccount: accountNumber === undefined ? account : { ...account, accountNumber } };
  } else if (form.hadBankAccount) {
    input = { ...input, bankAccount: null };
  }
  return { input, errors };
}

/* ---------------------------------------------------------------------------
 * 保存の 400 → 欄・原因・直し方
 * ------------------------------------------------------------------------- */

export interface HolderKanaConversion {
  readonly text: string;
  readonly bytes: number;
  readonly invalid: readonly { readonly char: string; readonly index: number }[];
}

export function isHolderKanaConversion(value: unknown): value is HolderKanaConversion {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['text'] === 'string' && typeof record['bytes'] === 'number' && Array.isArray(record['invalid'])
    && record['invalid'].every((entry) => typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>)['char'] === 'string' && typeof (entry as Record<string, unknown>)['index'] === 'number');
}

export const HOLDER_KANA_BYTE_LIMIT = 30;

export interface EmployeeSaveProblem {
  readonly field: EmployeeFormField | undefined;
  readonly cause: string;
  readonly fix: string;
  readonly conflictEmployeeId?: string;
  readonly converted?: HolderKanaConversion;
}

const SERVER_FIELDS: Readonly<Record<string, EmployeeFormField>> = {
  id: 'id', code: 'code', name: 'name', nameKana: 'nameKana', departmentId: 'departmentId', managerEmployeeId: 'managerEmployeeId', loginSubjects: 'loginSubjects', note: 'note', enabled: 'enabled',
  bankAccount: 'bankCode', 'bankAccount.bankCode': 'bankCode', 'bankAccount.bankNameKana': 'bankNameKana', 'bankAccount.branchCode': 'branchCode', 'bankAccount.branchNameKana': 'branchNameKana',
  'bankAccount.accountType': 'accountType', 'bankAccount.accountNumber': 'accountNumber', 'bankAccount.holderKana': 'holderKana', commuterPasses: 'commuterPasses',
};

/** サーバーの欄のパス（`bankAccount.holderKana`・`commuterPasses.0.stations` など）→ フォームの欄。 */
export function employeeFieldOf(serverField: string | undefined): EmployeeFormField | undefined {
  if (serverField === undefined || serverField === '') return undefined;
  const exact = SERVER_FIELDS[serverField];
  if (exact !== undefined) return exact;
  const head = serverField.split(/[.[]/)[0] ?? '';
  if (head === 'commuterPasses') return 'commuterPasses';
  if (head === 'loginSubjects') return 'loginSubjects';
  if (head === 'bankAccount') return 'bankCode';
  return SERVER_FIELDS[head];
}

/** フォームの欄 → 入力欄の DOM id（フォーカスの行き先）。 */
export function employeeFieldElementId(field: EmployeeFormField): string {
  switch (field) {
    case 'nameKana': return 'expense-people-employee-name-kana';
    case 'departmentId': return 'expense-people-employee-department';
    case 'managerEmployeeId': return 'expense-people-employee-manager';
    case 'loginSubjects': return 'expense-people-employee-login-subjects';
    case 'bankCode': return 'expense-people-bank-code';
    case 'bankNameKana': return 'expense-people-bank-name-kana';
    case 'branchCode': return 'expense-people-branch-code';
    case 'branchNameKana': return 'expense-people-branch-name-kana';
    case 'accountType': return 'expense-people-account-type';
    case 'accountNumber': return 'expense-people-account-number';
    case 'holderKana': return 'expense-people-holder-kana';
    case 'commuterPasses': return 'expense-people-commuter';
    default: return `expense-people-employee-${field}`;
  }
}

function holderKanaCause(converted: HolderKanaConversion | undefined, text: Translate): { readonly cause: string; readonly fix: string } {
  if (converted === undefined) {
    return { cause: text('The account holder name cannot be used in bank transfer files.', '口座名義は振込データに使えない形です'), fix: text('Enter it in katakana as printed on the passbook.', '通帳の表記のとおりカタカナで入れ直してください') };
  }
  const invalid = converted.invalid.map((entry) => `「${entry.char}」(${entry.index + 1})`).join(' ');
  const parts: string[] = [];
  const fixes: string[] = [];
  if (converted.invalid.length > 0) {
    parts.push(text(`It contains characters that cannot be used in transfer files: ${invalid}`, `振込データに使えない文字があります: ${invalid}`));
    fixes.push(text('Replace middle dots with spaces and kanji with katakana', '中点は空白に、漢字はカタカナに置き換えてください'));
  }
  if (converted.bytes > HOLDER_KANA_BYTE_LIMIT) {
    parts.push(text(`After conversion it is ${converted.bytes} bytes, over the ${HOLDER_KANA_BYTE_LIMIT}-byte limit (a voiced mark counts as 1 byte)`, `変換後が ${converted.bytes} バイトで、上限の ${HOLDER_KANA_BYTE_LIMIT} バイトを超えています（濁点も 1 バイト）`));
    fixes.push(text('Shorten it the way your bank abbreviates names (for example, drop the legal-entity part); it is never cut automatically', '銀行の略し方に合わせて短くしてください（例: 法人格を略語にする）。自動では切り詰めません'));
  }
  if (parts.length === 0) parts.push(text('The account holder name cannot be used in transfer files.', '口座名義は振込データに使えない形です'));
  if (fixes.length === 0) fixes.push(text('Enter it in katakana as printed on the passbook', '通帳の表記のとおりカタカナで入れ直してください'));
  return { cause: `${parts.join(text('. ', '。'))}${text(`. Converted: ${converted.text}`, `。変換後: ${converted.text}`)}`, fix: `${fixes.join(text('. ', '。'))}${text('.', '')}` };
}

/** 従業員の保存の 400（`EXPENSE_DOMAIN` の details）→ 直す欄と、平易な原因・直し方（サーバーの英語の文言に頼らない）。 */
export function employeeSaveProblem(details: Readonly<Record<string, unknown>> | undefined, fallback: string, text: Translate): EmployeeSaveProblem {
  const serverField = typeof details?.['field'] === 'string' ? details['field'] : undefined;
  const field = employeeFieldOf(serverField);
  // 一意違反の相手（conflictEmployeeId）が無ければ、問題の従業員そのもの（employeeId。上長の循環の相手など）を開く導線にする。
  const referenced = typeof details?.['conflictEmployeeId'] === 'string' && details['conflictEmployeeId'] !== '' ? details['conflictEmployeeId'] : details?.['employeeId'];
  const conflictEmployeeId = typeof referenced === 'string' && referenced !== '' ? referenced : undefined;
  const converted = isHolderKanaConversion(details?.['converted']) ? details['converted'] : undefined;
  const extra = { ...(conflictEmployeeId === undefined ? {} : { conflictEmployeeId }), ...(converted === undefined ? {} : { converted }) };
  switch (field) {
    case 'holderKana': return { field, ...holderKanaCause(converted, text), ...extra };
    case 'code': return conflictEmployeeId === undefined
      ? { field, cause: text('The employee code is not in a usable form.', '社員番号の形が使えません'), fix: text('Use up to 20 characters.', '20 字以内にしてください'), ...extra }
      : { field, cause: text('Another employee (including disabled ones) already uses this employee code.', 'この社員番号は別の従業員（無効を含む）が使っています'), fix: text('Use a different code, or edit the other employee.', '別の番号にするか、その従業員を編集してください'), ...extra };
    case 'loginSubjects': return conflictEmployeeId === undefined
      ? { field, cause: text('A login ID is not in a usable form.', 'ログイン ID の形が使えません'), fix: text(`Use up to ${EMPLOYEE_LOGIN_SUBJECT_LIMIT} IDs, one per line, each up to 200 characters.`, `1 行に 1 つ、${EMPLOYEE_LOGIN_SUBJECT_LIMIT} 件まで・各 200 字以内にしてください`), ...extra }
      : { field, cause: text('Another employee already uses this login ID.', 'このログイン ID は別の従業員が使っています'), fix: text('Remove it here, or remove it from the other employee first.', 'ここから外すか、先にその従業員から外してください'), ...extra };
    case 'managerEmployeeId': return { field, cause: text('This manager cannot be set (the employee themselves, or a chain of managers that comes back to them).', 'この上長は設定できません（本人か、上長をたどると本人に戻ります）'), fix: text('Choose another manager.', '別の上長を選んでください'), ...extra };
    case 'departmentId': return { field, cause: text('The department is not in the organization.', '部門が組織にありません'), fix: text('Choose a department from the organization, or add it in the organization section below.', '組織から部門を選ぶか、下の組織の節で部門を追加してください'), ...extra };
    case 'accountNumber': return { field, cause: text('The account number is not in a usable form.', '口座番号の形が使えません'), fix: text('Enter 1 to 7 digits without hyphens.', 'ハイフンなしの 1〜7 桁で入れてください'), ...extra };
    case 'bankCode': case 'branchCode': case 'accountType': return { field, cause: text('The bank code, branch code, or account type is not in a usable form.', '銀行コード・支店番号・預金種目の形が使えません'), fix: text('Use a 4-digit bank code and a 3-digit branch code (Japan Post Bank: use the converter).', '銀行コードは 4 桁、支店番号は 3 桁で入れてください（ゆうちょ銀行は変換を使います）'), ...extra };
    case 'bankNameKana': case 'branchNameKana': return { field, cause: text('The bank or branch name in kana is too long for transfer files.', '銀行名・支店名のカナが振込データに入りません'), fix: text('Use up to 15 half-width kana bytes.', '半角換算で 15 バイト以内にしてください'), ...extra };
    case 'commuterPasses': return { field, cause: text('A commuter pass is not in a usable form.', '通勤定期の形が使えません'), fix: text(`Use up to ${EMPLOYEE_COMMUTER_PASS_LIMIT} passes, each with 2 to 30 stations in route order.`, `${EMPLOYEE_COMMUTER_PASS_LIMIT} 件まで・駅は経路順に 2〜30 にしてください`), ...extra };
    case 'name': return { field, cause: text('The name is empty or too long.', '氏名が空か長すぎます'), fix: text('Enter 1 to 100 characters.', '1〜100 字で入れてください'), ...extra };
    case 'nameKana': return { field, cause: text('The name in kana is not in a usable form.', 'カナの形が使えません'), fix: text('Enter it in full-width katakana.', '全角カタカナで入れてください'), ...extra };
    case 'id': return { field, cause: conflictEmployeeId === undefined ? text('The id is not in a usable form.', 'id の形が使えません') : text('Another employee already uses this id.', 'この id は別の従業員が使っています'), fix: text('Leave it empty to assign one automatically.', '空欄にすると自動で付けます'), ...extra };
    default: return { field, cause: fallback, fix: text('Check the highlighted values and save again.', '入力内容を確認して、もう一度保存してください'), ...extra };
  }
}

/* ---------------------------------------------------------------------------
 * 一覧
 * ------------------------------------------------------------------------- */

export interface EmployeeFilter {
  readonly query: string;
  readonly departmentId: string;
  readonly enabled: 'all' | 'enabled' | 'disabled';
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 氏名・カナ・社員番号の部分一致 + 部門 + 有効 / 無効。 */
export function filterEmployees(employees: readonly ExpenseEmployeeDto[], filter: EmployeeFilter): readonly ExpenseEmployeeDto[] {
  const query = normalizeSearch(filter.query);
  return employees.filter((employee) => {
    if (filter.enabled === 'enabled' && !employee.enabled) return false;
    if (filter.enabled === 'disabled' && employee.enabled) return false;
    if (filter.departmentId !== '' && employee.departmentId !== filter.departmentId) return false;
    if (query === '') return true;
    return [employee.name, employee.nameKana ?? '', employee.code ?? ''].some((value) => normalizeSearch(value).includes(query));
  });
}

export type PayoutMark = 'ready' | 'blocked' | 'no-account';

/** 振込データに使えるか（一覧の印）。 */
export function payoutMarkOf(employee: Pick<ExpenseEmployeeDto, 'bankAccount' | 'payoutReadiness'>): PayoutMark {
  if (employee.bankAccount === undefined) return 'no-account';
  return employee.payoutReadiness.problems.length > 0 ? 'blocked' : 'ready';
}

export function historyTypeLabel(type: ExpenseEmployeeHistoryTypeDto, text: Translate): string {
  switch (type) {
    case 'created': return text('Created', '登録');
    case 'edited': return text('Edited', '編集');
    case 'bank-account-changed': return text('Bank account changed', '口座の変更');
    case 'disabled': return text('Disabled', '無効化');
    default: return text('Enabled', '有効化');
  }
}

/* ---------------------------------------------------------------------------
 * 組織
 * ------------------------------------------------------------------------- */

export function newDepartment(departments: readonly ExpenseDepartmentDto[]): ExpenseDepartmentDto {
  return { id: nextId('dept', departments.map((department) => department.id)), name: '', enabled: true };
}

export function newApproverGroup(groups: readonly ExpenseApproverGroupDto[]): ExpenseApproverGroupDto {
  return { id: nextId('group', groups.map((group) => group.id)), name: '', memberEmployeeIds: [], enabled: true };
}

export interface OrganizationIssue { readonly path: string; readonly message: Message }

/** 保存の前に画面で分かる誤り（空の id・名前、重複 id、自分を親にする）。循環や部門長の存在はサーバーが見る。 */
export function organizationIssues(departments: readonly ExpenseDepartmentDto[], groups: readonly ExpenseApproverGroupDto[]): readonly OrganizationIssue[] {
  const issues: OrganizationIssue[] = [];
  const check = (kind: 'departments' | 'approverGroups', rows: readonly { readonly id: string; readonly name: string }[]) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const label: Message = kind === 'departments' ? [`Department ${index + 1}`, `部門 ${index + 1} 行目`] : [`Approver group ${index + 1}`, `承認グループ ${index + 1} 行目`];
      if (row.id.trim() === '') issues.push({ path: `${kind}.${index}.id`, message: [`${label[0]}: enter an id.`, `${label[1]}: id を入れてください`] });
      else if (seen.has(row.id)) issues.push({ path: `${kind}.${index}.id`, message: [`${label[0]}: the id "${row.id}" is used twice.`, `${label[1]}: id「${row.id}」が重複しています`] });
      seen.add(row.id);
      if (row.name.trim() === '') issues.push({ path: `${kind}.${index}.name`, message: [`${label[0]}: enter a name.`, `${label[1]}: 名前を入れてください`] });
    });
  };
  check('departments', departments);
  check('approverGroups', groups);
  departments.forEach((department, index) => {
    if (department.parentId !== undefined && department.parentId === department.id) issues.push({ path: `departments.${index}.parentId`, message: [`Department ${index + 1}: a department cannot be its own parent.`, `部門 ${index + 1} 行目: 自分自身は親にできません`] });
  });
  return issues;
}

/* ---------------------------------------------------------------------------
 * 紐付け候補
 * ------------------------------------------------------------------------- */

/** 既定の選択: 社員番号の一致・同名が 1 人だけのときは、その候補にチェックを入れておく（押すまで書き込まない）。 */
export function defaultLinkSelection(links: readonly ExpenseEmployeeLinkDto[]): Readonly<Record<string, string>> {
  const selection: Record<string, string> = {};
  for (const link of links) {
    const first = link.candidates[0];
    if ((link.match === 'exact-code' || link.match === 'unique-name') && first !== undefined) selection[link.claimId] = first.id;
  }
  return selection;
}

export function linkMatchLabel(match: ExpenseEmployeeLinkMatchDto, text: Translate): string {
  switch (match) {
    case 'exact-code': return text('Employee code matches', '社員番号が一致');
    case 'unique-name': return text('Only one employee with this name', '同じ名前が 1 人だけ');
    case 'ambiguous': return text('Several candidates: choose one', '候補が複数: 選んでください');
    default: return text('No candidate', '候補なし');
  }
}

/** 409 の `details.claims`（承認中の申請）→ 申請 id の一覧（文字列でも `{ claimId }` / `{ id }` でも読む）。 */
export function conflictClaimIds(details: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const value = details?.['claims'];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry];
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>;
      const id = record['claimId'] ?? record['id'];
      return typeof id === 'string' ? [id] : [];
    }
    return [];
  });
}

/* ---------------------------------------------------------------------------
 * 申請者欄
 * ------------------------------------------------------------------------- */

/** 従業員を選ぶ → 申請の下書き（紐付けと、サーバーが埋める写しの先取り）。 */
export function claimDraftWithEmployee(draft: ClaimFormDraft, employee: Pick<ExpenseEmployeeDto, 'id' | 'name' | 'code' | 'departmentName'>): ClaimFormDraft {
  return { ...draft, employeeId: employee.id, name: employee.name, employeeCode: employee.code ?? '', department: employee.departmentName ?? '' };
}

/* ---------------------------------------------------------------------------
 * 承認経路の下書き
 * ------------------------------------------------------------------------- */

export const APPROVAL_STEP_LIMIT = 5;

/** 規程の `approval` が省略されていたときの既定（MVP と同じ 1 段の承認）。 */
export const DEFAULT_APPROVAL_SETTINGS: ExpenseApprovalSettingsDto = {
  routes: [],
  defaultSteps: [{ id: 'approve', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }],
  forbidClaimantApproval: true,
  requireDistinctApprovers: false,
};

export function approvalOf(draft: { readonly approval?: ExpenseApprovalSettingsDto }): ExpenseApprovalSettingsDto {
  return draft.approval ?? DEFAULT_APPROVAL_SETTINGS;
}

export const APPROVER_KINDS: readonly ExpenseApproverKindDto[] = ['claimant-manager', 'department-head', 'employee', 'group', 'any-approver'];

export function approverKindLabel(kind: ExpenseApproverKindDto, text: Translate): string {
  switch (kind) {
    case 'claimant-manager': return text("Claimant's manager", '申請者の上長');
    case 'department-head': return text('Department head', '部門長');
    case 'employee': return text('A specific employee', '指定の従業員');
    case 'group': return text('Approver group', '承認グループ');
    default: return text('Anyone who can approve', '承認権限を持つ人なら誰でも');
  }
}

/** 承認者の種類を変える（同じ種類なら今の指定を保つ）。 */
export function approverForKind(kind: ExpenseApproverKindDto, previous: ExpenseApproverSpecDto): ExpenseApproverSpecDto {
  if (kind === previous.kind) return previous;
  switch (kind) {
    case 'department-head': return { kind };
    case 'employee': return { kind, employeeId: '' };
    case 'group': return { kind, groupId: '' };
    default: return { kind };
  }
}

export function newApprovalStep(steps: readonly ExpenseApprovalStepDefDto[], name: string): ExpenseApprovalStepDefDto {
  return { id: nextId('step', steps.map((step) => step.id)), name, approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false };
}

export function newApprovalRoute(routes: readonly ExpenseApprovalRouteDto[], name: string, stepName: string): ExpenseApprovalRouteDto {
  return { id: nextId('route', routes.map((route) => route.id)), name, enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [newApprovalStep([], stepName)] };
}

export function routeIsUnconditional(route: Pick<ExpenseApprovalRouteDto, 'when'>): boolean {
  return route.when.categoryIds.length === 0 && route.when.departmentIds.length === 0 && route.when.minClaimAmount === undefined;
}

export interface ApprovalIssue { readonly path: string; readonly message: Message }

function stepIssues(steps: readonly ExpenseApprovalStepDefDto[], path: string, label: Message): ApprovalIssue[] {
  const issues: ApprovalIssue[] = [];
  if (steps.length === 0) issues.push({ path, message: [`${label[0]}: add at least one step.`, `${label[1]}: 段を 1 つ以上足してください`] });
  if (steps.length > APPROVAL_STEP_LIMIT) issues.push({ path, message: [`${label[0]}: up to ${APPROVAL_STEP_LIMIT} steps.`, `${label[1]}: 段は ${APPROVAL_STEP_LIMIT} つまでです`] });
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    const at = `${path}.${index}`;
    const name: Message = [`${label[0]} step ${index + 1}`, `${label[1]} の ${index + 1} 段目`];
    if (step.name.trim() === '' || step.name.length > 40) issues.push({ path: `${at}.name`, message: [`${name[0]}: give it a name of 1 to 40 characters.`, `${name[1]}: 名前を 1〜40 字で入れてください`] });
    if (seen.has(step.id)) issues.push({ path: `${at}.id`, message: [`${name[0]}: the step id "${step.id}" is used twice.`, `${name[1]}: 段の id「${step.id}」が重複しています`] });
    seen.add(step.id);
    if (step.approver.kind === 'employee' && step.approver.employeeId === '') issues.push({ path: `${at}.approver`, message: [`${name[0]}: choose the employee.`, `${name[1]}: 従業員を選んでください`] });
    if (step.approver.kind === 'group' && step.approver.groupId === '') issues.push({ path: `${at}.approver`, message: [`${name[0]}: choose the approver group.`, `${name[1]}: 承認グループを選んでください`] });
  });
  return issues;
}

/** 下書きの承認設定の点検（保存の前の案内。最終の検証はサーバー）。 */
export function approvalIssues(approval: ExpenseApprovalSettingsDto): readonly ApprovalIssue[] {
  const issues: ApprovalIssue[] = [];
  const ids = new Set<string>();
  approval.routes.forEach((route, index) => {
    const label: Message = [`Route "${route.name || route.id}"`, `経路「${route.name || route.id}」`];
    if (route.name.trim() === '') issues.push({ path: `routes.${index}.name`, message: [`Route ${index + 1}: enter a name.`, `${index + 1} 番目の経路: 名前を入れてください`] });
    if (ids.has(route.id)) issues.push({ path: `routes.${index}.id`, message: [`${label[0]}: the id "${route.id}" is used twice.`, `${label[1]}: id「${route.id}」が重複しています`] });
    ids.add(route.id);
    if (route.enabled && routeIsUnconditional(route) && approval.routes.slice(index + 1).some((later) => later.enabled)) {
      issues.push({ path: `routes.${index}.when`, message: [`${label[0]} has no conditions, so the routes below it are never used. Move it to the bottom or add a condition.`, `${label[1]}は条件がないため、下の経路が使われません。一番下へ動かすか、条件を足してください`] });
    }
    issues.push(...stepIssues(route.steps, `routes.${index}.steps`, label));
  });
  issues.push(...stepIssues(approval.defaultSteps, 'defaultSteps', ['Default steps', '既定の段']));
  return issues;
}

/* ---------------------------------------------------------------------------
 * 決まらない段・承認の流れの表示
 * ------------------------------------------------------------------------- */

export interface UnresolvedStepView {
  readonly key: string;
  readonly stepName: string;
  readonly cause: string;
  readonly fix: string;
  readonly target: OpenTarget;
  readonly actionLabel: string;
}

function stringOf(params: Readonly<Record<string, string | null>>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 決まらない段 1 件 → 原因・直し方・直す場所を開くボタン。上長系・申請者の紐付け・指定の従業員は従業員、部門長・グループは組織、
 * 本人しかいないは承認経路へ。id は応答の params を優先し、無ければ段の指定と試算の入力から補う。
 */
export function unresolvedStepView(
  entry: ExpenseApprovalPlanDto['unresolved'][number],
  context: { readonly spec?: ExpenseApproverSpecDto; readonly claimantEmployeeId?: string; readonly departmentId?: string; readonly routeId?: string },
  text: Translate,
): UnresolvedStepView {
  const { causeText, causeFix } = approvalCauseText({ ...entry.params, cause: entry.cause }, text);
  const params = entry.params;
  const base = { key: `${entry.stepId}:${entry.cause}`, stepName: entry.stepName, cause: causeText, fix: causeFix };
  const employee = (id: string | undefined, label: string) => ({ ...base, target: { internalId: id ?? '', section: 'employee' }, actionLabel: label });
  switch (entry.cause) {
    case 'manager-missing': case 'claimant-unlinked':
      return employee(stringOf(params, 'employeeId') ?? stringOf(params, 'claimantEmployeeId') ?? context.claimantEmployeeId, text('Open the employee', '従業員を開く'));
    case 'manager-disabled':
      return employee(stringOf(params, 'managerEmployeeId') ?? stringOf(params, 'employeeId') ?? context.claimantEmployeeId, text('Open the employee', '従業員を開く'));
    case 'employee-disabled':
      return employee(stringOf(params, 'employeeId') ?? (context.spec?.kind === 'employee' ? context.spec.employeeId : undefined), text('Open the employee', '従業員を開く'));
    case 'department-head-missing': {
      const id = stringOf(params, 'departmentId') ?? (context.spec?.kind === 'department-head' ? context.spec.departmentId : undefined) ?? context.departmentId;
      return { ...base, target: { internalId: id ?? '', section: 'organization' }, actionLabel: text('Open the organization', '組織を開く') };
    }
    case 'group-empty': {
      const id = stringOf(params, 'groupId') ?? (context.spec?.kind === 'group' ? context.spec.groupId : undefined);
      return { ...base, target: { internalId: id ?? '', section: 'organization' }, actionLabel: text('Open the organization', '組織を開く') };
    }
    default:
      return { ...base, target: { internalId: context.routeId ?? '', section: 'approval' }, actionLabel: text('Open the approval routes', '承認経路を開く') };
  }
}

export type FlowStepState = 'approved' | 'pending' | 'skipped' | 'planned';

export function flowStepStateLabel(state: FlowStepState, text: Translate): string {
  switch (state) {
    case 'approved': return text('Approved', '済み');
    case 'pending': return text('Waiting', '待ち');
    case 'skipped': return text('Skipped', '飛ばし');
    default: return text('Planned', '予定');
  }
}

export interface FlowStepRow {
  readonly stepId: string;
  readonly name: string;
  readonly approverKind: ExpenseApproverKindDto;
  readonly approvers: readonly { readonly employeeId: string; readonly name: string }[];
  readonly state: FlowStepState;
  readonly current: boolean;
  readonly unresolved: boolean;
  readonly decision?: ExpenseApprovalFlowDto['steps'][number]['decision'];
}

/** 承認の流れの表の行（保存済みの流れがあればそれ、無ければ予定）。 */
export function flowStepRows(view: Pick<ExpenseApprovalFlowViewDto, 'plan' | 'flow' | 'current'>): readonly FlowStepRow[] {
  const unresolved = new Set(view.plan.unresolved.map((entry) => entry.stepId));
  if (view.flow !== undefined) {
    const flow = view.flow;
    return flow.steps.map((step, index) => ({
      stepId: step.stepId, name: step.name, approverKind: step.approverKind, approvers: step.approvers, state: step.status,
      current: view.current === undefined ? index === flow.currentIndex && step.status === 'pending' : view.current.stepId === step.stepId,
      unresolved: unresolved.has(step.stepId), ...(step.decision === undefined ? {} : { decision: step.decision }),
    }));
  }
  return view.plan.steps.map((step) => ({
    stepId: step.stepId, name: step.name, approverKind: step.approverKind, approvers: step.approvers, state: step.skipped ? 'skipped' : 'planned',
    current: view.current?.stepId === step.stepId, unresolved: unresolved.has(step.stepId),
  }));
}

/** MVP と同じ 1 段（経路なし・承認権限を持つ誰でも）で、まだ誰も承認していない流れ（表示を最小にする）。 */
export function isMinimalFlow(view: Pick<ExpenseApprovalFlowViewDto, 'plan' | 'flow' | 'proxy'>): boolean {
  const steps = view.flow?.steps ?? view.plan.steps;
  const only = steps[0];
  return view.plan.routeId === undefined && steps.length === 1 && only !== undefined && only.approverKind === 'any-approver'
    && !(view.flow?.steps.some((step) => step.status === 'approved') ?? false) && !view.proxy && view.plan.unresolved.length === 0;
}
