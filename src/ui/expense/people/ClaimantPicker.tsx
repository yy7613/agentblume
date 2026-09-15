import { useEffect, useMemo, useState } from 'react';
import { expensePeopleApi } from '../../api/expense-people-api';
import type { ExpenseEmployeeDto } from '../../api/expense-people-types';
import { useI18n } from '../../i18n';
import { messageOf } from '../expense-shared';
import type { ExpenseClaimantFieldSlotProps } from '../expense-slots';
import { claimDraftWithEmployee, filterEmployees } from './people-model';
import './people.css';

const SUGGESTION_LIMIT = 8;

/**
 * 申請の作成・編集で従業員を検索して選ぶ欄（docs/21 §20.10.1）。氏名の入力欄の隣に出る。
 * マスタが空なら従来の氏名入力のまま使えることを先に言い、読めなくても入力を妨げない（小さく出すだけ）。
 */
export function ClaimantPicker({ transport, scope, onOpen, draft, onChange, inputId }: ExpenseClaimantFieldSlotProps) {
  const { text } = useI18n();
  const api = useMemo(() => expensePeopleApi(transport), [transport]);
  const [employees, setEmployees] = useState<readonly ExpenseEmployeeDto[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    api.listEmployees(scope, { enabled: true, limit: 1000 })
      .then((next) => { if (active) { setEmployees(next); setError(undefined); } })
      .catch((cause: unknown) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; };
  }, [api, scope]);

  if (error !== undefined) {
    return <small className="expense-wide expense-people-muted">{text(`Could not load the employee master, so enter the claimant by hand (${error}).`, `従業員マスタを読めなかったため、申請者は手で入力してください（${error}）`)}</small>;
  }
  if (draft.employeeId !== '') {
    const linked = employees?.find((employee) => employee.id === draft.employeeId);
    const name = linked?.name ?? draft.name;
    const code = linked?.code ?? draft.employeeCode;
    const label = code === '' ? name : `${name} · ${code}`;
    return <div className="expense-wide expense-people-claimant" role="group" aria-label={text('Employee master', '従業員マスタ')}>
      <span>{text(`Linked to the employee master (${label})`, `従業員マスタに紐付いています（${label}）`)}</span>
      <div className="expense-actions">
        <button type="button" className="secondary" onClick={() => { onChange({ ...draft, employeeId: '' }); document.getElementById(inputId)?.focus(); }}>{text('Unlink', '紐付けを外す')}</button>
      </div>
    </div>;
  }
  if (employees === undefined) return null;
  if (employees.length === 0) {
    return <div className="expense-wide expense-people-claimant">
      <span className="expense-people-muted">{text('Use the employee master to enable approval routes and payout files.', '従業員マスタを使うと承認経路・振込データが使えます')}</span>
      <div className="expense-actions">
        <button type="button" className="secondary" onClick={() => onOpen({ internalId: '', section: 'employee' })}>{text('Open the employee master', '従業員マスタを開く')}</button>
      </div>
    </div>;
  }

  const search = query.trim() !== '' ? query : draft.name;
  const matches = search.trim() === '' ? [] : filterEmployees(employees, { query: search, departmentId: '', enabled: 'enabled' }).slice(0, SUGGESTION_LIMIT);
  return <div className="expense-wide expense-people-claimant" role="group" aria-label={text('Employee master', '従業員マスタ')}>
    <label>{text('Choose from the employee master', '従業員マスタから選ぶ')}
      <input type="search" aria-label={text('Search the employee master', '従業員マスタを検索')} placeholder={text('Name, kana, or employee code', '氏名・カナ・社員番号')} value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
    {matches.length > 0 && <ul>{matches.map((employee) => <li key={employee.id}>
      <button type="button" className="secondary" aria-label={text(`Choose ${employee.name}`, `${employee.name} を選ぶ`)}
        onClick={() => { onChange(claimDraftWithEmployee(draft, employee)); setQuery(''); }}>
        {[employee.name, employee.code, employee.departmentName].filter((part) => part !== undefined && part !== '').join(' · ')}
      </button>
    </li>)}</ul>}
    {search.trim() !== '' && matches.length === 0 && <span className="expense-people-muted">{text('No employee matches. You can keep the name as typed.', '一致する従業員がいません。入力した氏名のままでも保存できます')}</span>}
    <span className="expense-people-note">{text('When you choose an employee, the server fills in the name, employee code, and department from the master on save.', '従業員を選ぶと、保存時にサーバーが氏名・社員番号・部門を従業員マスタの値で埋めます')}</span>
  </div>;
}
