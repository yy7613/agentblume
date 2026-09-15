import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { expensePeopleApi, type ExpensePeopleApi } from '../../api/expense-people-api';
import type {
  ConfirmExpenseEmployeeLinksResultDto, ExpenseApproverGroupDto, ExpenseCsvFileDto, ExpenseDepartmentDto, ExpenseEmployeeDto, ExpenseEmployeeLinkDto,
  ExpenseOrganizationDto, ImportExpenseEmployeesResultDto,
} from '../../api/expense-people-types';
import type { ExpenseBankAccountTypeDto } from '../../api/expense-people-types';
import { ApiError } from '../../api/tool-api';
import type { TenantScopeDto } from '../../api/types';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { decodeCsvText, triggerDownload } from '../../journal/journal-model';
import { claimStatusLabel, type Message } from '../expense-model';
import { messageOf } from '../expense-shared';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import {
  EMPLOYEE_COMMUTER_PASS_LIMIT, accountTypeLabel, cleanDigits, conflictClaimIds, defaultLinkSelection, emptyEmployeeForm, employeeFieldElementId, employeeFieldOf,
  employeeFormFrom, employeeInputFromForm, employeeSaveProblem, filterEmployees, historyTypeLabel, linkMatchLabel, maskedAccountNumber, newApproverGroup,
  newCommuterPass, newDepartment, organizationIssues, payoutMarkOf, removeAt, replaceAt, withText, yuchoToZengin,
  type EmployeeFilter, type EmployeeFormDraft, type EmployeeFormField, type EmployeeSaveProblem, type YuchoResult,
} from './people-model';
import './people.css';

const SAMPLE_PATH = 'samples/expense/employees.csv';

/** 描いた後に、その id の要素へスクロールしてフォーカスする（入力欄でなければ中の最初の入力欄）。 */
function focusElement(id: string): void {
  const element = document.getElementById(id);
  if (element === null) return;
  element.scrollIntoView?.({ block: 'center' });
  const target = element.matches('input, select, textarea, button') ? element : element.querySelector<HTMLElement>('input, select, textarea, button') ?? element;
  target.focus();
}

interface EditRequest {
  readonly key: number;
  readonly employee: ExpenseEmployeeDto | undefined;
  /** 開いた直後にフォーカスする要素の id。 */
  readonly focusId?: string;
  /** 口座番号の入力欄を開いた状態で始める（開封できない口座の入れ直し）。 */
  readonly revealAccountNumber?: boolean;
}

/* ---------------------------------------------------------------------------
 * 従業員フォーム
 * ------------------------------------------------------------------------- */

function EmployeeForm({ api, scope, request, employees, departments, onSaved, onClose, onOpenEmployee }: {
  readonly api: ExpensePeopleApi;
  readonly scope: TenantScopeDto;
  readonly request: EditRequest;
  readonly employees: readonly ExpenseEmployeeDto[];
  readonly departments: readonly ExpenseDepartmentDto[];
  readonly onSaved: (employee: ExpenseEmployeeDto) => void;
  readonly onClose: () => void;
  readonly onOpenEmployee: (id: string) => void;
}) {
  const { text } = useI18n();
  const [employee, setEmployee] = useState(request.employee);
  const [form, setForm] = useState<EmployeeFormDraft>(() => {
    const initial = request.employee === undefined ? emptyEmployeeForm() : employeeFormFrom(request.employee);
    return request.revealAccountNumber === true ? { ...initial, bank: { ...initial.bank, present: true, changeNumber: true } } : initial;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [problem, setProblem] = useState<EmployeeSaveProblem>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [strippedFrom, setStrippedFrom] = useState<string>();
  const [yuchoOpen, setYuchoOpen] = useState(false);
  const [yucho, setYucho] = useState({ symbol: '', number: '' });
  const [yuchoResult, setYuchoResult] = useState<YuchoResult>();
  const [pendingFocus, setPendingFocus] = useState<{ readonly id: string; readonly seq: number } | undefined>(request.focusId === undefined ? undefined : { id: request.focusId, seq: 0 });

  useEffect(() => { if (pendingFocus !== undefined) focusElement(pendingFocus.id); }, [pendingFocus]);
  const focusField = (field: EmployeeFormField) => setPendingFocus((current) => ({ id: employeeFieldElementId(field), seq: (current?.seq ?? 0) + 1 }));

  const isNew = employee === undefined;
  const checked = employeeInputFromForm(form, { isNew });
  const clientError = (field: EmployeeFormField): Message | undefined => (showErrors ? checked.errors[field] : undefined);
  const setBank = (change: Partial<EmployeeFormDraft['bank']>) => setForm((current) => ({ ...current, bank: { ...current.bank, ...change } }));

  const save = async () => {
    setShowErrors(true);
    setError(undefined);
    setFeedback(undefined);
    if (checked.input === undefined) {
      const first = Object.keys(checked.errors)[0] as EmployeeFormField | undefined;
      if (first !== undefined) focusField(first);
      return;
    }
    setSaving(true);
    try {
      const saved = employee === undefined ? await api.createEmployee(scope, checked.input) : await api.updateEmployee(scope, employee.id, checked.input);
      setEmployee(saved);
      setForm(employeeFormFrom(saved));
      setShowErrors(false);
      setProblem(undefined);
      setStrippedFrom(undefined);
      setFeedback(text(`Saved ${saved.name}. Check the transfer file check below.`, `${saved.name} さんを保存しました。下の振込データの点検を確認してください`));
      onSaved(saved);
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.code === 'EXPENSE_DOMAIN') {
        const next = employeeSaveProblem(cause.details, messageOf(cause), text);
        setProblem(next);
        if (next.field === 'accountNumber') setBank({ present: true, changeNumber: true });
        if (next.field !== undefined) focusField(next.field);
      } else {
        setProblem(undefined);
        setError(messageOf(cause));
      }
    } finally {
      setSaving(false);
    }
  };

  /** 欄の下に出す: 画面での誤り、または保存の 400 の原因・直し方。 */
  const issue = (field: EmployeeFormField): ReactNode => {
    const local = clientError(field);
    if (problem !== undefined && problem.field === field) {
      return <div className="expense-people-problem" role="alert">
        <p><strong>{text('Cause', '原因')}:</strong> {problem.cause}</p>
        <p><strong>{text('Next step', '次の一手')}:</strong> {problem.fix}</p>
        {problem.conflictEmployeeId !== undefined && problem.conflictEmployeeId !== employee?.id && <button type="button" className="secondary" onClick={() => onOpenEmployee(problem.conflictEmployeeId ?? '')}>{text('Open that employee', 'その従業員を開く')}</button>}
      </div>;
    }
    return local === undefined ? null : <small className="field-error" role="alert">{text(local[0], local[1])}</small>;
  };

  const managers = employees.filter((candidate) => candidate.id !== employee?.id && (candidate.enabled || candidate.id === form.managerEmployeeId));
  const knownDepartment = form.departmentId === '' || departments.some((department) => department.id === form.departmentId);
  const bank = form.bank;
  const readiness = employee?.payoutReadiness;

  return <section id="expense-people-employee-form" className="workspace-card expense-people-form" aria-labelledby="expense-people-employee-form-heading">
    <div className="expense-row-between">
      <h2 id="expense-people-employee-form-heading">{isNew ? text('Add an employee', '従業員を追加') : text(`Edit ${employee.name}`, `${employee.name} さんを編集`)}</h2>
      <button type="button" className="secondary" onClick={onClose}>{text('Close', '閉じる')}</button>
    </div>
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
    {problem !== undefined && problem.field === undefined && <div className="expense-people-problem" role="alert">
      <p><strong>{text('Cause', '原因')}:</strong> {problem.cause}</p><p><strong>{text('Next step', '次の一手')}:</strong> {problem.fix}</p>
    </div>}

    <div className="expense-form">
      {isNew && <label>{text('Id (empty = automatic)', 'id（空欄 = 自動）')}
        <input id="expense-people-employee-id" aria-label={text('Id (empty = automatic)', 'id（空欄 = 自動）')} value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} />{issue('id')}
      </label>}
      <label>{text('Employee code', '社員番号')}
        <input id="expense-people-employee-code" aria-label={text('Employee code', '社員番号')} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />{issue('code')}
      </label>
      <label>{text('Name', '氏名')}
        <input id="expense-people-employee-name" aria-label={text('Name', '氏名')} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />{issue('name')}
      </label>
      <label>{text('Name (kana)', 'カナ')}
        <input id="expense-people-employee-name-kana" aria-label={text('Name (kana)', 'カナ')} value={form.nameKana} onChange={(event) => setForm({ ...form, nameKana: event.target.value })} />{issue('nameKana')}
      </label>
      <label>{text('Department', '部門')}
        <select id="expense-people-employee-department" aria-label={text('Department', '部門')} value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
          <option value="">{text('— none —', '— なし —')}</option>
          {!knownDepartment && <option value={form.departmentId}>{text(`${form.departmentId} (not in the organization)`, `${form.departmentId}（組織に無い）`)}</option>}
          {departments.map((department) => <option key={department.id} value={department.id}>{department.name || department.id}{department.enabled ? '' : text(' (disabled)', '（無効）')}</option>)}
        </select>
        {departments.length === 0 && <span className="expense-people-note">{text('Add departments in the organization section below to choose one.', '下の組織の節で部門を追加すると選べます')}{' '}
          <button type="button" className="screen-link" onClick={() => focusElement('expense-people-organization')}>{text('Go to the organization', '組織の節へ')}</button></span>}
        {issue('departmentId')}
      </label>
      <label>{text('Manager', '上長')}
        <select id="expense-people-employee-manager" aria-label={text('Manager', '上長')} value={form.managerEmployeeId} onChange={(event) => setForm({ ...form, managerEmployeeId: event.target.value })}>
          <option value="">{text('— none —', '— なし —')}</option>
          {managers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.code === undefined ? candidate.name : `${candidate.name} (${candidate.code})`}</option>)}
        </select>{issue('managerEmployeeId')}
      </label>
      <label>{text('Login IDs (one per line, up to 5)', 'ログイン ID（1 行に 1 つ・最大 5）')}
        <textarea id="expense-people-employee-login-subjects" aria-label={text('Login IDs', 'ログイン ID')} rows={2} value={form.loginSubjects} onChange={(event) => setForm({ ...form, loginSubjects: event.target.value })} />
        <span className="expense-people-note">{text('Used to tell whether the signed-in person is a designated approver.', 'ログインした人が指定の承認者かの判定に使います')}</span>
        {issue('loginSubjects')}
      </label>
      <label><span><input id="expense-people-employee-enabled" type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> {text('Enabled', '有効')}</span>
        <span className="expense-people-note">{text('Employees are never deleted; turn this off when they leave.', '削除はせず、退職・異動で使わなくなったら外します')}</span>
      </label>
      <label className="expense-wide">{text('Note', 'メモ')}
        <input id="expense-people-employee-note" aria-label={text('Note', 'メモ')} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />{issue('note')}
      </label>

      <fieldset id="expense-people-bank" className="expense-wide" tabIndex={-1}>
        <legend>{text('Bank account for reimbursement', '振込口座')}</legend>
        <label><span><input type="checkbox" aria-label={text('Register a bank account', '口座を登録する')} checked={bank.present} onChange={(event) => setBank({ present: event.target.checked })} /> {text('Register a bank account', '口座を登録する')}</span></label>
        {!bank.present && form.hadBankAccount && <p className="expense-people-muted">{text('Saving removes the registered bank account.', '保存すると登録済みの口座を外します')}</p>}
        {bank.present && <div className="expense-form">
          <label>{text('Bank code', '銀行コード')}
            <input id="expense-people-bank-code" aria-label={text('Bank code', '銀行コード')} inputMode="numeric" value={bank.bankCode} onChange={(event) => setBank({ bankCode: cleanDigits(event.target.value).value })} />{issue('bankCode')}
          </label>
          <label>{text('Bank name (kana, optional)', '銀行名カナ（任意）')}
            <input id="expense-people-bank-name-kana" aria-label={text('Bank name (kana)', '銀行名カナ')} value={bank.bankNameKana} onChange={(event) => setBank({ bankNameKana: event.target.value })} />{issue('bankNameKana')}
          </label>
          <label>{text('Branch code', '支店番号')}
            <input id="expense-people-branch-code" aria-label={text('Branch code', '支店番号')} inputMode="numeric" value={bank.branchCode} onChange={(event) => setBank({ branchCode: cleanDigits(event.target.value).value })} />{issue('branchCode')}
          </label>
          <label>{text('Branch name (kana, optional)', '支店名カナ（任意）')}
            <input id="expense-people-branch-name-kana" aria-label={text('Branch name (kana)', '支店名カナ')} value={bank.branchNameKana} onChange={(event) => setBank({ branchNameKana: event.target.value })} />{issue('branchNameKana')}
          </label>
          <label>{text('Account type', '預金種目')}
            <select id="expense-people-account-type" aria-label={text('Account type', '預金種目')} value={bank.accountType} onChange={(event) => setBank({ accountType: event.target.value as ExpenseBankAccountTypeDto })}>
              {(['ordinary', 'current', 'savings', 'other'] as const).map((type) => <option key={type} value={type}>{accountTypeLabel(type, text)}</option>)}
            </select>{issue('accountType')}
          </label>
          <div>
            {bank.last4 !== undefined && !bank.changeNumber
              ? <span>{text('Account number', '口座番号')}: <code>{maskedAccountNumber(bank.last4)}</code>{' '}
                <button type="button" className="secondary" aria-label={text('Change the account number', '口座番号を変更する')} onClick={() => { setBank({ changeNumber: true }); focusField('accountNumber'); }}>{text('Change', '変更する')}</button></span>
              : <label>{text('Account number', '口座番号')}
                <input id="expense-people-account-number" aria-label={text('Account number', '口座番号')} inputMode="numeric" autoComplete="off" value={bank.accountNumber} onChange={(event) => {
                  const cleaned = cleanDigits(event.target.value);
                  if (cleaned.removed) setStrippedFrom(event.target.value);
                  setBank({ accountNumber: cleaned.value });
                }} />
                {strippedFrom !== undefined && <span className="expense-people-note" role="status">{text(`Removed hyphens and spaces (you entered "${strippedFrom}"). The value saved is ${bank.accountNumber}.`, `ハイフン・空白を外しました（入力: 「${strippedFrom}」）。保存する値は ${bank.accountNumber} です`)}</span>}
                {bank.last4 !== undefined && <button type="button" className="screen-link" onClick={() => { setBank({ changeNumber: false, accountNumber: '' }); setStrippedFrom(undefined); }}>{text('Keep the current number', '変更をやめる（今の番号を保つ）')}</button>}
                {issue('accountNumber')}
              </label>}
          </div>
          <label>{text('Account holder (kana)', '口座名義（カナ）')}
            <input id="expense-people-holder-kana" aria-label={text('Account holder (kana)', '口座名義（カナ）')} value={bank.holderKana} onChange={(event) => setBank({ holderKana: event.target.value })} />
            <span className="expense-people-note">{text('Full-width kana is fine. It is converted to half-width on save; over 30 bytes or with middle dots or kanji it cannot be saved (never cut).', '全角カナで入れて構いません。保存時に半角へ変換し、30 バイトを超える・中点や漢字を含むときは保存できません（切り詰めません）')}</span>
            {issue('holderKana')}
          </label>
          <div className="expense-wide">
            <button type="button" className="secondary" aria-expanded={yuchoOpen} onClick={() => setYuchoOpen(!yuchoOpen)}>{text('Convert from a Japan Post Bank symbol and number', 'ゆうちょ銀行の記号・番号から入れる')}</button>
            {yuchoOpen && <div className="expense-people-yucho">
              <div className="expense-people-toolbar">
                <label>{text('Symbol (5 digits)', '記号（5 桁）')}<input aria-label={text('Symbol (5 digits)', '記号（5 桁）')} inputMode="numeric" value={yucho.symbol} onChange={(event) => setYucho({ ...yucho, symbol: event.target.value })} /></label>
                <label>{text('Number', '番号')}<input aria-label={text('Number', '番号')} inputMode="numeric" value={yucho.number} onChange={(event) => setYucho({ ...yucho, number: event.target.value })} /></label>
                <button type="button" className="secondary" onClick={() => setYuchoResult(yuchoToZengin(yucho.symbol, yucho.number))}>{text('Convert', '変換する')}</button>
              </div>
              {yuchoResult !== undefined && !yuchoResult.ok && <small className="field-error" role="alert">{text(yuchoResult.message[0], yuchoResult.message[1])}</small>}
              {yuchoResult?.ok === true && <>
                <dl aria-label={text('Converted values', '変換結果')}>
                  <dt>{text('Bank code', '銀行コード')}</dt><dd>{yuchoResult.bankCode}</dd>
                  <dt>{text('Branch code', '支店番号')}</dt><dd>{yuchoResult.branchCode}</dd>
                  <dt>{text('Account type', '預金種目')}</dt><dd>{accountTypeLabel(yuchoResult.accountType, text)}</dd>
                  <dt>{text('Account number', '口座番号')}</dt><dd>{yuchoResult.accountNumber}</dd>
                </dl>
                <button type="button" className="secondary" onClick={() => {
                  setBank({ present: true, bankCode: yuchoResult.bankCode, branchCode: yuchoResult.branchCode, accountType: yuchoResult.accountType, accountNumber: yuchoResult.accountNumber, changeNumber: true });
                  setStrippedFrom(undefined);
                  setFeedback(text('Filled in the converted values. Save to apply them.', '変換結果を入れました。保存すると反映されます'));
                }}>{text('Use these values', 'この値で入れる')}</button>
              </>}
            </div>}
          </div>
        </div>}
      </fieldset>

      <fieldset id="expense-people-commuter" className="expense-wide" tabIndex={-1}>
        <legend>{text(`Commuter passes (up to ${EMPLOYEE_COMMUTER_PASS_LIMIT})`, `通勤定期（最大 ${EMPLOYEE_COMMUTER_PASS_LIMIT}）`)}</legend>
        {form.passes.length === 0 && <p className="empty-state">{text('No commuter passes. Add one to deduct the pass section from transport expenses.', '通勤定期はありません。登録すると交通費から定期区間を控除できます')}</p>}
        <div className="expense-people-passes">{form.passes.map((pass, index) => {
          const change = (next: Partial<typeof pass>) => setForm((current) => ({ ...current, passes: replaceAt(current.passes, index, { ...pass, ...next }) }));
          const label = text(`Pass ${index + 1}`, `定期 ${index + 1}`);
          return <div key={`${pass.id}-${index}`} className="expense-people-pass">
            <label>{text(`${label}: stations (separate with ">" or one per line)`, `${label}の駅（「>」区切りか 1 行 1 駅）`)}
              <textarea aria-label={text(`${label} stations`, `${label}の駅`)} rows={2} value={pass.stations} onChange={(event) => change({ stations: event.target.value })} />
            </label>
            <label>{text('Valid from', '開始日')}<input type="date" aria-label={text(`${label} valid from`, `${label}の開始日`)} value={pass.validFrom} onChange={(event) => change({ validFrom: event.target.value })} /></label>
            <label>{text('Valid to', '有効期限')}<input type="date" aria-label={text(`${label} valid to`, `${label}の有効期限`)} value={pass.validTo} onChange={(event) => change({ validTo: event.target.value })} /></label>
            <label>{text('Note', 'メモ')}<input aria-label={text(`${label} note`, `${label}のメモ`)} value={pass.note} onChange={(event) => change({ note: event.target.value })} /></label>
            <button type="button" className="secondary danger" aria-label={text(`Remove ${label}`, `${label}を削除`)} onClick={() => setForm((current) => ({ ...current, passes: removeAt(current.passes, index) }))}>{text('Remove', '削除')}</button>
          </div>;
        })}</div>
        <button type="button" className="secondary" disabled={form.passes.length >= EMPLOYEE_COMMUTER_PASS_LIMIT} onClick={() => setForm((current) => ({ ...current, passes: [...current.passes, newCommuterPass(current.passes)] }))}>{text('Add a commuter pass', '通勤定期を追加')}</button>
        {issue('commuterPasses')}
      </fieldset>
    </div>

    <div className="expense-actions">
      <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save the employee', '従業員を保存')}</button>
    </div>

    {employee !== undefined && readiness !== undefined && <div className="expense-people-readiness" aria-label={text('Transfer file check', '振込データの点検')} role="region">
      <strong>{text('Transfer file check', '振込データの点検')}</strong>
      {employee.bankAccount === undefined
        ? <p className="expense-people-muted">{text('No bank account, so this employee cannot be included in transfer files. Register an account when you need it.', '口座がないため振込データには入りません。使うときに口座を登録してください')}</p>
        : <>
          {readiness.holderKanaConverted !== undefined && <p>{text('Holder name in the transfer file', '振込データでの名義')}: <code>{readiness.holderKanaConverted}</code>{readiness.holderKanaBytes === undefined ? '' : text(` (${readiness.holderKanaBytes} bytes)`, `（${readiness.holderKanaBytes} バイト）`)}</p>}
          {readiness.problems.length === 0 && readiness.warnings.length === 0 && <p>{text('Ready for transfer files.', '振込データに使えます')}</p>}
          {readiness.problems.length > 0 && <><p>{text('Cannot be used in transfer files until fixed:', '直すまで振込データに使えません:')}</p>
            <ul>{readiness.problems.map((entry, index) => {
              const field = employeeFieldOf(entry.field);
              return <li key={`${entry.code}-${index}`}>{entry.message}{field !== undefined && <> <button type="button" className="screen-link" onClick={() => { if (field === 'accountNumber') setBank({ changeNumber: true }); focusField(field); }}>{text('Go to the field', 'その欄へ')}</button></>}</li>;
            })}</ul></>}
          {readiness.warnings.length > 0 && <><p>{text('Check before transferring:', '振込の前に確認してください:')}</p>
            <ul>{readiness.warnings.map((entry, index) => <li key={`${entry.code}-${index}`}>{entry.message}</li>)}</ul></>}
        </>}
    </div>}

    {employee !== undefined && employee.history.length > 0 && <details>
      <summary>{text(`History (${employee.history.length})`, `履歴（${employee.history.length}）`)}</summary>
      <ul>{employee.history.map((entry, index) => <li key={`${entry.at}-${index}`}>{historyTypeLabel(entry.type, text)} · {entry.by} · {entry.at}{entry.note === undefined ? '' : ` · ${entry.note}`}</li>)}</ul>
    </details>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * 組織
 * ------------------------------------------------------------------------- */

function OrganizationEditor({ api, scope, organization, saved, loadError, employees, highlight, onSaved }: {
  readonly api: ExpensePeopleApi;
  readonly scope: TenantScopeDto;
  readonly organization: ExpenseOrganizationDto | undefined;
  readonly saved: boolean;
  readonly loadError: string | undefined;
  readonly employees: readonly ExpenseEmployeeDto[];
  readonly highlight: string | undefined;
  readonly onSaved: (organization: ExpenseOrganizationDto) => void;
}) {
  const { text } = useI18n();
  const [departments, setDepartments] = useState<readonly ExpenseDepartmentDto[]>(organization?.departments ?? []);
  const [groups, setGroups] = useState<readonly ExpenseApproverGroupDto[]>(organization?.approverGroups ?? []);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  useEffect(() => {
    setDepartments(organization?.departments ?? []);
    setGroups(organization?.approverGroups ?? []);
    setDirty(false);
  }, [organization]);

  const issues = organizationIssues(departments, groups);
  const changeDepartments = (next: readonly ExpenseDepartmentDto[]) => { setDepartments(next); setDirty(true); setFeedback(undefined); };
  const changeGroups = (next: readonly ExpenseApproverGroupDto[]) => { setGroups(next); setDirty(true); setFeedback(undefined); };
  const updateDepartment = (index: number, change: (department: ExpenseDepartmentDto) => ExpenseDepartmentDto) => {
    const current = departments[index];
    if (current !== undefined) changeDepartments(replaceAt(departments, index, change(current)));
  };
  const updateGroup = (index: number, change: (group: ExpenseApproverGroupDto) => ExpenseApproverGroupDto) => {
    const current = groups[index];
    if (current !== undefined) changeGroups(replaceAt(groups, index, change(current)));
  };
  const rowClass = (id: string) => (highlight === id ? 'expense-people-highlight' : '');

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await api.saveOrganization(scope, { departments, approverGroups: groups });
      onSaved(next);
      setFeedback(text('Saved the organization.', '組織を保存しました'));
    } catch (cause: unknown) {
      const field = cause instanceof ApiError && typeof cause.details?.['field'] === 'string' ? cause.details['field'] : undefined;
      setError(field === undefined ? messageOf(cause) : text(`${messageOf(cause)} (field: ${field})`, `${messageOf(cause)}（欄: ${field}）`));
    } finally {
      setSaving(false);
    }
  };

  return <section id="expense-people-organization" className="workspace-card" tabIndex={-1} aria-labelledby="expense-people-organization-heading">
    <h2 id="expense-people-organization-heading">{text('Organization', '組織')}</h2>
    <p className="expense-people-muted">{text('Departments are used for department-head approval, route conditions, and the journal department dimension. Approver groups are used for group approval steps and proxy approval.', '部門は部門長の承認・経路の条件・仕訳の部門の補助軸に、承認グループは段の承認者と代理承認に使います')}</p>
    {loadError !== undefined && <p className="api-error" role="alert">{text(`Could not load the organization: ${loadError}`, `組織を読めませんでした: ${loadError}`)}</p>}
    {!saved && loadError === undefined && <p className="empty-state">{text('The organization has not been saved yet. Add departments when you need them.', '組織はまだ保存していません。必要になったら部門を追加します')}</p>}

    <h3>{text('Departments', '部門')}</h3>
    {departments.length === 0 ? <p className="empty-state">{text('No departments.', '部門はありません')}</p>
      : <div className="table-wrap"><table className="expense-people-table">
        <thead><tr>
          <th>id</th><th>{text('Name', '名前')}</th><th>{text('Parent', '親')}</th><th>{text('Head', '部門長')}</th><th>{text('Journal dimension value id', '仕訳の補助軸の値 id')}</th><th>{text('Enabled', '有効')}</th><th />
        </tr></thead>
        <tbody>{departments.map((department, index) => {
          const label = department.name === '' ? text(`department ${index + 1}`, `部門 ${index + 1}`) : department.name;
          return <tr key={`department-${index}`} id={`expense-people-department-${department.id}`} className={rowClass(`department:${department.id}`)}>
            <td><input aria-label={text(`Id of ${label}`, `${label}の id`)} value={department.id} onChange={(event) => updateDepartment(index, (current) => ({ ...current, id: event.target.value.trim() }))} /></td>
            <td><input aria-label={text(`Name of department ${index + 1}`, `部門 ${index + 1} の名前`)} value={department.name} onChange={(event) => updateDepartment(index, (current) => ({ ...current, name: event.target.value }))} /></td>
            <td><select aria-label={text(`Parent of ${label}`, `${label}の親`)} value={department.parentId ?? ''} onChange={(event) => updateDepartment(index, (current) => withText(current, 'parentId', event.target.value))}>
              <option value="">{text('— none —', '— なし —')}</option>
              {departments.filter((other, at) => at !== index && other.id !== '').map((other) => <option key={other.id} value={other.id}>{other.name || other.id}</option>)}
            </select></td>
            <td><select aria-label={text(`Head of ${label}`, `${label}の部門長`)} value={department.headEmployeeId ?? ''} onChange={(event) => updateDepartment(index, (current) => withText(current, 'headEmployeeId', event.target.value))}>
              <option value="">{text('— none (use the parent) —', '— なし（親の部門長） —')}</option>
              {employees.filter((employee) => employee.enabled || employee.id === department.headEmployeeId).map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select></td>
            <td><input aria-label={text(`Journal dimension value id of ${label}`, `${label}の仕訳の補助軸の値 id`)} value={department.journalDimensionValueId ?? ''} onChange={(event) => updateDepartment(index, (current) => withText(current, 'journalDimensionValueId', event.target.value))} /></td>
            <td><input type="checkbox" aria-label={text(`${label} enabled`, `${label}を有効にする`)} checked={department.enabled} onChange={(event) => updateDepartment(index, (current) => ({ ...current, enabled: event.target.checked }))} /></td>
            <td><button type="button" className="secondary danger" aria-label={text(`Remove ${label}`, `${label}を削除`)} onClick={() => changeDepartments(removeAt(departments, index))}>{text('Remove', '削除')}</button></td>
          </tr>;
        })}</tbody>
      </table></div>}
    <div className="expense-actions"><button type="button" className="secondary" onClick={() => changeDepartments([...departments, newDepartment(departments)])}>{text('Add a department', '部門を追加')}</button></div>

    <h3>{text('Approver groups', '承認グループ')}</h3>
    {groups.length === 0 ? <p className="empty-state">{text('No approver groups.', '承認グループはありません')}</p>
      : <div className="table-wrap"><table className="expense-people-table">
        <thead><tr><th>id</th><th>{text('Name', '名前')}</th><th>{text('Members', 'メンバー')}</th><th>{text('Enabled', '有効')}</th><th /></tr></thead>
        <tbody>{groups.map((group, index) => {
          const label = group.name === '' ? text(`group ${index + 1}`, `グループ ${index + 1}`) : group.name;
          return <tr key={`group-${index}`} id={`expense-people-group-${group.id}`} className={rowClass(`group:${group.id}`)}>
            <td><input aria-label={text(`Id of ${label}`, `${label}の id`)} value={group.id} onChange={(event) => updateGroup(index, (current) => ({ ...current, id: event.target.value.trim() }))} /></td>
            <td><input aria-label={text(`Name of group ${index + 1}`, `グループ ${index + 1} の名前`)} value={group.name} onChange={(event) => updateGroup(index, (current) => ({ ...current, name: event.target.value }))} /></td>
            <td><div className="expense-people-members" role="group" aria-label={text(`Members of ${label}`, `${label}のメンバー`)}>
              {employees.length === 0 ? <span className="expense-people-muted">{text('Add employees first.', '先に従業員を登録してください')}</span>
                : employees.filter((employee) => employee.enabled || group.memberEmployeeIds.includes(employee.id)).map((employee) => <label key={employee.id}>
                  <input type="checkbox" checked={group.memberEmployeeIds.includes(employee.id)} onChange={(event) => updateGroup(index, (current) => ({ ...current, memberEmployeeIds: event.target.checked ? [...current.memberEmployeeIds, employee.id] : current.memberEmployeeIds.filter((id) => id !== employee.id) }))} />{employee.name}
                </label>)}
            </div></td>
            <td><input type="checkbox" aria-label={text(`${label} enabled`, `${label}を有効にする`)} checked={group.enabled} onChange={(event) => updateGroup(index, (current) => ({ ...current, enabled: event.target.checked }))} /></td>
            <td><button type="button" className="secondary danger" aria-label={text(`Remove ${label}`, `${label}を削除`)} onClick={() => changeGroups(removeAt(groups, index))}>{text('Remove', '削除')}</button></td>
          </tr>;
        })}</tbody>
      </table></div>}
    <div className="expense-actions"><button type="button" className="secondary" onClick={() => changeGroups([...groups, newApproverGroup(groups)])}>{text('Add an approver group', '承認グループを追加')}</button></div>

    {issues.length > 0 && <div className="notice-card" role="note" aria-label={text('Fix before saving the organization', '組織を保存する前に直す箇所')}>
      <ul>{issues.map((entry) => <li key={`${entry.path}-${entry.message[0]}`}>{text(entry.message[0], entry.message[1])}</li>)}</ul>
    </div>}
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
    <div className="expense-actions">
      <button type="button" className="primary" disabled={saving || issues.length > 0 || (!dirty && saved)} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save the organization', '組織を保存')}</button>
      {dirty && <span className="expense-people-muted">{text('You have unsaved changes.', '保存していない変更があります')}</span>}
    </div>
  </section>;
}

/* ---------------------------------------------------------------------------
 * CSV 取込 / 出力
 * ------------------------------------------------------------------------- */

type ExportFailure = { readonly kind: 'forbidden' } | { readonly kind: 'unsealable'; readonly employeeId: string; readonly message: string } | { readonly kind: 'other'; readonly message: string };

function EmployeesCsvPanel({ api, scope, onImported, onReenterAccount }: {
  readonly api: ExpensePeopleApi;
  readonly scope: TenantScopeDto;
  readonly onImported: () => Promise<void>;
  readonly onReenterAccount: (employeeId: string) => void;
}) {
  const { text } = useI18n();
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportExpenseEmployeesResultDto>();
  const [importError, setImportError] = useState<{ readonly message: string; readonly row?: number; readonly missingColumns: readonly string[] }>();
  const [exported, setExported] = useState<ExpenseCsvFileDto & { readonly downloaded: boolean }>();
  const [exportFailure, setExportFailure] = useState<ExportFailure>();

  const runImport = async (content: string) => {
    setBusy(true);
    setResult(undefined);
    setImportError(undefined);
    try {
      setResult(await api.importEmployeesCsv(scope, content));
      await onImported();
    } catch (cause: unknown) {
      const details = cause instanceof ApiError ? cause.details : undefined;
      const row = cause instanceof ApiError ? cause.row ?? (typeof details?.['row'] === 'number' ? details['row'] : undefined) : undefined;
      const missing = Array.isArray(details?.['missingColumns']) ? details['missingColumns'].filter((column): column is string => typeof column === 'string') : [];
      setImportError({ message: messageOf(cause), ...(row === undefined ? {} : { row }), missingColumns: missing });
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (file === undefined) return;
    const { content } = decodeCsvText(new Uint8Array(await file.arrayBuffer()));
    await runImport(content);
  };

  const runExport = async (withBankAccounts: boolean) => {
    setExportFailure(undefined);
    setExported(undefined);
    try {
      const file = await api.exportEmployeesCsv(scope, withBankAccounts);
      setExported({ ...file, downloaded: triggerDownload(file.fileName, file.content) });
    } catch (cause: unknown) {
      // 開封できなかった従業員はサーバーが details.employeeId で示す（重なりの conflictEmployeeId とは別の意味）。
      const conflict = cause instanceof ApiError && typeof cause.details?.['employeeId'] === 'string' ? cause.details['employeeId'] : undefined;
      if (cause instanceof ApiError && cause.status === 403) setExportFailure({ kind: 'forbidden' });
      else if (cause instanceof ApiError && cause.code === 'EXPENSE_DOMAIN' && conflict !== undefined) setExportFailure({ kind: 'unsealable', employeeId: conflict, message: messageOf(cause) });
      else setExportFailure({ kind: 'other', message: messageOf(cause) });
    }
  };

  return <section id="expense-people-csv" className="workspace-card" aria-labelledby="expense-people-csv-heading">
    <h2 id="expense-people-csv-heading">{text('Employee CSV', '従業員 CSV')}</h2>
    <p className="expense-people-muted">{text(`Sample: ${SAMPLE_PATH}. Rows are matched by employee code (or id); employees not in the CSV are left unchanged, and an empty account number keeps the registered one.`, `見本: ${SAMPLE_PATH}。社員番号（無ければ id）で突き合わせて登録・更新し、CSV に無い従業員は変えません。口座番号の列が空なら登録済みの口座を保ちます`)}</p>
    <div className="expense-actions">
      <label className="secondary">{text('Import a CSV file', 'CSV ファイルを取り込む')}
        <input type="file" accept=".csv,text/csv" aria-label={text('Employee CSV file', '従業員 CSV ファイル')} disabled={busy} onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
    </div>
    <label>{text('Or paste the CSV', 'または CSV を貼り付け')}
      <textarea className="expense-textarea" aria-label={text('Pasted employee CSV', '貼り付けた従業員 CSV')} value={pasted} onChange={(event) => setPasted(event.target.value)} />
    </label>
    <div className="expense-actions">
      <button type="button" className="secondary" disabled={busy || pasted.trim() === ''} onClick={() => void runImport(pasted)}>{text('Import the pasted CSV', '貼り付けた CSV を取り込む')}</button>
    </div>
    {result !== undefined && <div className="expense-people-readiness" role="status" aria-label={text('Import result', '取込結果')}>
      <p>{text(`Created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}.`, `登録 ${result.created} 件・更新 ${result.updated} 件・変更なし ${result.unchanged} 件`)}</p>
      {result.skippedRows.length > 0 && <><p>{text(`Skipped ${result.skippedRows.length} rows (fix them in the CSV and import again):`, `${result.skippedRows.length} 行を飛ばしました（CSV を直してもう一度取り込んでください）:`)}</p>
        <ul>{result.skippedRows.map((entry) => <li key={entry.row}>{text(`Row ${entry.row}: ${entry.reason}`, `${entry.row} 行目: ${entry.reason}`)}</li>)}</ul></>}
      {result.warnings.length > 0 && <ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
    </div>}
    {importError !== undefined && <div className="api-error" role="alert">
      <p>{importError.row === undefined
        ? text('The CSV could not be imported.', 'CSV を取り込めませんでした')
        : text(`Row ${importError.row} of the CSV could not be imported. Fix that row and import again.`, `CSV の ${importError.row} 行目を取り込めませんでした。その行を直してもう一度取り込んでください`)}</p>
      {importError.missingColumns.length > 0 && <p>{text(`Missing columns: ${importError.missingColumns.join(', ')}. Compare the header with ${SAMPLE_PATH}.`, `足りない列: ${importError.missingColumns.join('、')}。見出しを ${SAMPLE_PATH} と見比べてください`)}</p>}
      <p>{importError.message}</p>
    </div>}

    <h3>{text('Export', '出力')}</h3>
    <div className="expense-actions">
      <button type="button" className="secondary" onClick={() => void runExport(false)}>{text('Export employees CSV', '従業員 CSV を出力')}</button>
      <button type="button" className="secondary" onClick={() => void runExport(true)}>{text('Export with account numbers (approvers only)', '口座番号つきで出力（承認権限）')}</button>
    </div>
    {exported !== undefined && (exported.downloaded
      ? <InlineFeedback kind="success">{text(`Exported ${exported.fileName}.`, `${exported.fileName} を出力しました`)}</InlineFeedback>
      : <label>{text('The download did not start. Copy the CSV below.', 'ダウンロードを開始できませんでした。下の CSV をコピーしてください')}
        <textarea className="expense-textarea" readOnly aria-label={text('Exported employee CSV', '出力した従業員 CSV')} value={exported.content} />
      </label>)}
    {exportFailure?.kind === 'forbidden' && <div className="notice-card" role="alert">
      <strong>{text('Approval permission is required', '承認権限が必要です')}</strong>
      <p>{text('Only people who can approve claims can export account numbers. Ask an approver to export it, or export without account numbers.', '口座番号つきの CSV は承認権限を持つ人だけが出力できます。承認権限を持つ人に出力を頼むか、口座番号なしで出力してください')}</p>
    </div>}
    {exportFailure?.kind === 'unsealable' && <div className="notice-card" role="alert">
      <strong>{text('An account number could not be opened', '口座番号を開封できませんでした')}</strong>
      <p>{text('The key file may have changed since the number was saved. Enter the account number of that employee again.', '保存した後に鍵ファイルが変わった可能性があります。その従業員の口座番号を入れ直してください')}</p>
      <p>{exportFailure.message}</p>
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => onReenterAccount(exportFailure.employeeId)}>{text("Re-enter the account number in that employee's account", 'その従業員の口座欄で口座番号を入れ直す')}</button>
      </div>
    </div>}
    {exportFailure?.kind === 'other' && <p className="api-error" role="alert">{exportFailure.message}</p>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * 紐付け候補
 * ------------------------------------------------------------------------- */

function EmployeeLinksPanel({ api, scope, onClaimsChanged }: {
  readonly api: ExpensePeopleApi;
  readonly scope: TenantScopeDto;
  readonly onClaimsChanged: () => Promise<void> | void;
}) {
  const { text } = useI18n();
  const [links, setLinks] = useState<readonly ExpenseEmployeeLinkDto[]>();
  const [loadError, setLoadError] = useState<string>();
  const [choice, setChoice] = useState<Readonly<Record<string, string>>>({});
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConfirmExpenseEmployeeLinksResultDto>();
  const [conflict, setConflict] = useState<readonly string[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const next = await api.listEmployeeLinks(scope);
      setLinks(next);
      setLoadError(undefined);
      const defaults = defaultLinkSelection(next);
      setChecked(new Set(Object.keys(defaults)));
      setChoice(Object.fromEntries(next.flatMap((link) => (link.candidates[0] === undefined ? [] : [[link.claimId, link.candidates[0].id] as const]))));
    } catch (cause: unknown) {
      setLoadError(messageOf(cause));
    }
  }, [api, scope]);
  useEffect(() => { void load(); }, [load]);

  const selected = (links ?? []).filter((link) => checked.has(link.claimId) && (choice[link.claimId] ?? '') !== '');
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    setConflict(undefined);
    setResult(undefined);
    try {
      setResult(await api.confirmEmployeeLinks(scope, selected.map((link) => ({ claimId: link.claimId, employeeId: choice[link.claimId] ?? '' }))));
      await onClaimsChanged();
      await load();
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.code === 'EXPENSE_TRANSITION') setConflict(conflictClaimIds(cause.details));
      else setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const claimLabel = (claimId: string) => {
    const link = links?.find((entry) => entry.claimId === claimId);
    return link === undefined ? claimId : `${link.claimant.name} (${claimId})`;
  };

  return <section id="expense-people-links" className="workspace-card" aria-labelledby="expense-people-links-heading">
    <h2 id="expense-people-links-heading">{text('Link claims to employees', '申請と従業員の紐付け')}</h2>
    <p className="expense-people-muted">{text('Claims whose claimant is not linked to the employee master. Candidates with a matching employee code or a unique name are checked in advance; nothing is written until you press the button.', '申請者が従業員マスタに紐付いていない申請です。社員番号の一致・同名が 1 人だけの候補は最初からチェックしてあります。ボタンを押すまで書き込みません')}</p>
    {loadError !== undefined && <p className="api-error" role="alert">{text(`Could not load the link candidates: ${loadError}`, `紐付け候補を読めませんでした: ${loadError}`)}</p>}
    {links !== undefined && links.length === 0 && <p className="empty-state">{text('Every claim is linked to an employee.', '紐付けが要る申請はありません')}</p>}
    {links !== undefined && links.length > 0 && <div className="table-wrap"><table className="expense-people-table expense-people-links">
      <thead><tr><th>{text('Link', '紐付ける')}</th><th>{text('Claimant', '申請者')}</th><th>{text('Status', '状態')}</th><th>{text('Match', '一致')}</th><th>{text('Employee', '従業員')}</th></tr></thead>
      <tbody>{links.map((link) => {
        const claimant = link.claimant;
        return <tr key={link.claimId}>
          <td><input type="checkbox" aria-label={text(`Link ${claimant.name} (${link.claimId})`, `${claimant.name}（${link.claimId}）を紐付ける`)} disabled={link.candidates.length === 0} checked={checked.has(link.claimId)} onChange={(event) => {
            const next = new Set(checked);
            if (event.target.checked) next.add(link.claimId); else next.delete(link.claimId);
            setChecked(next);
          }} /></td>
          <td>{claimant.name}{claimant.employeeCode === undefined ? '' : ` · ${claimant.employeeCode}`}{claimant.department === undefined ? '' : ` · ${claimant.department}`}<span className="expense-people-note">{link.claimId}</span></td>
          <td>{claimStatusLabel(link.status, text)}</td>
          <td>{linkMatchLabel(link.match, text)}</td>
          <td>{link.candidates.length === 0
            ? <span className="expense-people-muted">{text('No candidate. Register the employee first.', '候補がいません。先に従業員を登録してください')}</span>
            : <select aria-label={text(`Employee for ${claimant.name} (${link.claimId})`, `${claimant.name}（${link.claimId}）の従業員`)} value={choice[link.claimId] ?? ''} onChange={(event) => { setChoice({ ...choice, [link.claimId]: event.target.value }); setChecked(new Set(checked).add(link.claimId)); }}>
              {link.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{[candidate.name, candidate.code, candidate.department].filter((part) => part !== undefined && part !== '').join(' · ')}</option>)}
            </select>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
    {links !== undefined && links.length > 0 && <div className="expense-actions">
      <button type="button" className="primary" disabled={busy || selected.length === 0} onClick={() => void confirm()}>{text(`Link the ${selected.length} selected claims`, `選んだ ${selected.length} 件を紐付ける`)}</button>
    </div>}
    {result !== undefined && <InlineFeedback kind="success">
      {text(`Linked ${result.linked} claims.`, `${result.linked} 件を紐付けました。`)}
      {result.movedToDraft > 0 && text(` ${result.movedToDraft} checked or returned claims went back to draft; check them again.`, `うち ${result.movedToDraft} 件はチェック済み・差し戻しから下書きに戻りました。もう一度チェックしてください。`)}
      {result.skipped.length > 0 && text(` Skipped ${result.skipped.length} claims that were already linked.`, `${result.skipped.length} 件は紐付け済みだったので飛ばしました。`)}
    </InlineFeedback>}
    {conflict !== undefined && <div className="notice-card" role="alert">
      <strong>{text('Claims in approval cannot be linked (nothing was saved)', '承認中の申請は紐付けを変えられません（何も保存していません）')}</strong>
      <p>{conflict.length === 0 ? text('Some selected claims are in approval.', '選んだ申請に承認中のものがあります') : conflict.map(claimLabel).join(text(', ', '、'))}</p>
      <p>{text('Next step: uncheck the claims in approval and link again, or finish (or cancel) their approval first.', '次の一手: 承認中の申請のチェックを外してもう一度紐付けるか、先にその承認を終える（取り消す）してください')}</p>
      {conflict.length > 0 && <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => { const next = new Set(checked); for (const id of conflict) next.delete(id); setChecked(next); setConflict(undefined); }}>{text('Uncheck the claims in approval', '承認中の申請のチェックを外す')}</button>
      </div>}
    </div>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * 台帳
 * ------------------------------------------------------------------------- */

/** 台帳「従業員・組織」（docs/21 §20.2.5 / §20.10.1）。従業員の一覧と編集・組織・CSV 取込 / 出力・紐付け候補。空状態は赤くしない。 */
export function EmployeesLedger({ transport, scope, onClaimsChanged, focus }: ExpenseLedgerSlotProps) {
  const { text } = useI18n();
  const api = useMemo(() => expensePeopleApi(transport), [transport]);
  const [employees, setEmployees] = useState<readonly ExpenseEmployeeDto[]>();
  const [loadError, setLoadError] = useState<string>();
  const [organization, setOrganization] = useState<{ readonly organization: ExpenseOrganizationDto; readonly saved: boolean }>();
  const [organizationError, setOrganizationError] = useState<string>();
  const [filter, setFilter] = useState<EmployeeFilter>({ query: '', departmentId: '', enabled: 'all' });
  const [editing, setEditing] = useState<EditRequest>();
  const [highlight, setHighlight] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const reloadEmployees = useCallback(async () => {
    try { setEmployees(await api.listEmployees(scope, { limit: 1000 })); setLoadError(undefined); }
    catch (cause: unknown) { setLoadError(messageOf(cause)); setEmployees((current) => current ?? []); }
  }, [api, scope]);
  const reloadOrganization = useCallback(async () => {
    try { setOrganization(await api.getOrganization(scope)); setOrganizationError(undefined); }
    catch (cause: unknown) { setOrganizationError(messageOf(cause)); }
  }, [api, scope]);
  useEffect(() => { void reloadEmployees(); void reloadOrganization(); }, [reloadEmployees, reloadOrganization]);

  const edit = (employee: ExpenseEmployeeDto | undefined, options: { readonly focusId?: string; readonly revealAccountNumber?: boolean } = {}) => {
    setNotice(undefined);
    setEditing((current) => ({ key: (current?.key ?? 0) + 1, employee, ...options, focusId: options.focusId ?? 'expense-people-employee-form' }));
  };
  const openEmployeeById = async (id: string, options: { readonly focusId?: string; readonly revealAccountNumber?: boolean } = {}) => {
    const found = employees?.find((employee) => employee.id === id);
    if (found !== undefined) { edit(found, options); return; }
    try { edit(await api.getEmployee(scope, id), options); }
    catch (cause: unknown) { setNotice(text(`Could not open the employee ${id}: ${messageOf(cause)}`, `従業員 ${id} を開けませんでした: ${messageOf(cause)}`)); }
  };

  // 導線（振込の点検・承認者が決まらない理由・定期区間）で開かれたら、その従業員の口座欄・定期欄、または組織の行へ。
  // 同じ依頼（seq）は 1 回だけ扱う（組織の読み込み完了で再実行されても、開いたフォームを開き直さない）。
  const handledSeq = useRef<number>(undefined);
  useEffect(() => {
    if (focus === undefined || employees === undefined || handledSeq.current === focus.seq) return;
    if (focus.section === 'organization') {
      if (organization === undefined && organizationError === undefined) return;
      handledSeq.current = focus.seq;
      // 行の有無は読み込んだ組織のデータで決める（組織の編集欄は下書きを 1 描画遅れて並べるので、DOM を先に見ると空振りする）。
      const loaded = organization?.organization;
      const row = focus.id === '' || loaded === undefined ? undefined
        : loaded.departments.some((department) => department.id === focus.id) ? `department:${focus.id}`
          : loaded.approverGroups.some((group) => group.id === focus.id) ? `group:${focus.id}` : undefined;
      setHighlight(row);
      const target = row === undefined ? 'expense-people-organization' : row.startsWith('department:') ? `expense-people-department-${focus.id}` : `expense-people-group-${focus.id}`;
      setTimeout(() => focusElement(target), 0);
      return;
    }
    if (focus.id === '') { focusElement('expense-people-employees'); return; }
    void openEmployeeById(focus.id, { focusId: focus.section === 'employee-commuter' ? 'expense-people-commuter' : 'expense-people-bank' });
    // focus.seq の変化（と一覧・組織の読み込み完了）だけで動かす。
  }, [focus?.seq, employees === undefined, organization === undefined && organizationError === undefined]);

  const upsert = (saved: ExpenseEmployeeDto) => setEmployees((current) => {
    const list = current ?? [];
    return list.some((employee) => employee.id === saved.id) ? list.map((employee) => (employee.id === saved.id ? saved : employee)) : [...list, saved];
  });

  const departments = organization?.organization.departments ?? [];
  const visible = filterEmployees(employees ?? [], filter);
  const payoutChip = (employee: ExpenseEmployeeDto) => {
    const mark = payoutMarkOf(employee);
    if (mark === 'ready') return <span className="expense-people-chip expense-people-chip-ready">{text('Ready for transfer', '振込可')}</span>;
    if (mark === 'no-account') return <span className="expense-people-chip expense-people-chip-none">{text('No account', '口座なし')}</span>;
    return <span className="expense-people-chip expense-people-chip-blocked" title={employee.payoutReadiness.problems[0]?.message}>{text('Not usable for transfer', '振込データに使えない')}</span>;
  };

  return <div className="expense-people-ledger">
    <section id="expense-people-employees" className="workspace-card" tabIndex={-1} aria-labelledby="expense-ledger-employeesledger-heading">
      <div className="expense-row-between">
        <h2 id="expense-ledger-employeesledger-heading">{text('Employees & organization', '従業員・組織')}</h2>
        <button type="button" className="secondary" onClick={() => edit(undefined)}>{text('Add an employee', '従業員を追加')}</button>
      </div>
      <p className="expense-people-secret">{text('Account numbers are sealed with the key file (the same key as the model settings) before they are saved. To restore from a database backup, you also need the key file.', '口座番号は鍵ファイル（モデル設定と同じ鍵）で封緘して保存しています。DB のバックアップから戻すには鍵ファイルも必要です')}</p>
      {notice !== undefined && <p className="api-error" role="alert">{notice}</p>}
      {loadError !== undefined && <div className="api-error" role="alert">
        <p>{text(`Could not load the employees: ${loadError}`, `従業員を読めませんでした: ${loadError}`)}</p>
        <button type="button" className="secondary" onClick={() => void reloadEmployees()}>{text('Retry', '再試行')}</button>
      </div>}
      {employees === undefined && loadError === undefined && <p className="empty-state" role="status">{text('Loading the employees…', '従業員を読み込み中…')}</p>}
      {employees !== undefined && employees.length === 0 && loadError === undefined && <div className="expense-empty">
        <p className="empty-state">{text('No employees yet. Import them with a CSV or add them one by one.', '従業員がいません。CSV で一括登録するか 1 人ずつ追加します')}</p>
        <p className="empty-state">{text(`A sample CSV is at ${SAMPLE_PATH}.`, `見本の CSV: ${SAMPLE_PATH}`)}</p>
        <div className="expense-actions">
          <button type="button" className="secondary" onClick={() => focusElement('expense-people-csv')}>{text('Import a CSV', 'CSV で一括登録')}</button>
        </div>
      </div>}
      {employees !== undefined && employees.length > 0 && <>
        <div className="expense-people-toolbar">
          <label>{text('Search', '検索')}<input type="search" aria-label={text('Search by name, kana, or employee code', '氏名・カナ・社員番号で検索')} value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} /></label>
          <label>{text('Department', '部門')}<select aria-label={text('Department filter', '部門で絞り込み')} value={filter.departmentId} onChange={(event) => setFilter({ ...filter, departmentId: event.target.value })}>
            <option value="">{text('All departments', 'すべての部門')}</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.name || department.id}</option>)}
          </select></label>
          <label>{text('Status', '状態')}<select aria-label={text('Status filter', '有効・無効で絞り込み')} value={filter.enabled} onChange={(event) => setFilter({ ...filter, enabled: event.target.value as EmployeeFilter['enabled'] })}>
            <option value="all">{text('All', 'すべて')}</option><option value="enabled">{text('Enabled', '有効')}</option><option value="disabled">{text('Disabled', '無効')}</option>
          </select></label>
        </div>
        {visible.length === 0 ? <p className="empty-state">{text('No employees match the filters.', '条件に合う従業員はいません')}</p>
          : <div className="table-wrap"><table className="expense-people-table">
            <thead><tr>
              <th>{text('Code', '社員番号')}</th><th>{text('Name', '氏名')}</th><th>{text('Department', '部門')}</th><th>{text('Manager', '上長')}</th>
              <th>{text('Bank account', '口座')}</th><th>{text('Status', '状態')}</th><th />
            </tr></thead>
            <tbody>{visible.map((employee) => <tr key={employee.id}>
              <td>{employee.code ?? '—'}</td>
              <td>{employee.name}{employee.nameKana === undefined ? '' : <span className="expense-people-note">{employee.nameKana}</span>}</td>
              <td>{employee.departmentName ?? employee.departmentId ?? '—'}</td>
              <td>{employee.managerName ?? '—'}</td>
              <td>{employee.bankAccount === undefined ? null : <code>{maskedAccountNumber(employee.bankAccount.accountNumberLast4)}</code>} {payoutChip(employee)}</td>
              <td>{employee.enabled ? text('Enabled', '有効') : text('Disabled', '無効')}</td>
              <td><button type="button" className="secondary" aria-label={text(`Edit ${employee.name}`, `${employee.name} さんを編集`)} onClick={() => edit(employee)}>{text('Edit', '編集')}</button></td>
            </tr>)}</tbody>
          </table></div>}
      </>}
    </section>

    {editing !== undefined && <EmployeeForm key={editing.key} api={api} scope={scope} request={editing} employees={employees ?? []} departments={departments}
      onSaved={upsert} onClose={() => setEditing(undefined)} onOpenEmployee={(id) => void openEmployeeById(id)} />}

    <OrganizationEditor api={api} scope={scope} organization={organization?.organization} saved={organization?.saved ?? false} loadError={organizationError}
      employees={employees ?? []} highlight={highlight} onSaved={(next) => setOrganization({ organization: next, saved: true })} />

    <EmployeesCsvPanel api={api} scope={scope} onImported={reloadEmployees}
      onReenterAccount={(id) => void openEmployeeById(id, { focusId: 'expense-people-account-number', revealAccountNumber: true })} />

    {employees !== undefined && employees.length > 0 && <EmployeeLinksPanel api={api} scope={scope} onClaimsChanged={onClaimsChanged} />}
  </div>;
}
