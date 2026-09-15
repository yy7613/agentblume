import { useEffect, useMemo, useState } from 'react';
import { expensePeopleApi } from '../../api/expense-people-api';
import type { ExpenseApprovalRoutePreviewDto, ExpenseApproverGroupDto, ExpenseDepartmentDto, ExpenseEmployeeDto } from '../../api/expense-people-types';
import type { ExpenseApprovalRouteDto, ExpenseApprovalSettingsDto, ExpenseApprovalStepDefDto, ExpenseApproverKindDto, ExpenseCategoryDto } from '../../api/expense-types';
import { useI18n } from '../../i18n';
import type { OpenTarget } from '../../navigation';
import { amountFromInput, type Translate } from '../expense-model';
import { messageOf } from '../expense-shared';
import type { ExpensePolicySectionSlotProps } from '../expense-slots';
import {
  APPROVAL_STEP_LIMIT, APPROVER_KINDS, approvalIssues, approvalOf, approverForKind, approverKindLabel, moveAt, newApprovalRoute, newApprovalStep, removeAt, replaceAt,
  routeIsUnconditional, unresolvedStepView,
} from './people-model';
import './people.css';

interface References {
  readonly departments: readonly ExpenseDepartmentDto[];
  readonly groups: readonly ExpenseApproverGroupDto[];
  readonly employees: readonly ExpenseEmployeeDto[];
}

/** 円の入力欄。読めない値は下書きに入れず、その場で直し方を出す。 */
function YenInput({ value, onChange, label }: { readonly value: number | undefined; readonly onChange: (next: number | undefined) => void; readonly label: string }) {
  const { text } = useI18n();
  const [raw, setRaw] = useState(value === undefined ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const parsed = amountFromInput(raw);
    if (!invalid && parsed !== value) setRaw(value === undefined ? '' : String(value));
    // raw は依存に入れない（打鍵ごとに値へ引き戻さないため）。
  }, [value]);
  return <>
    <input inputMode="numeric" aria-label={label} value={raw} onChange={(event) => {
      setRaw(event.target.value);
      const parsed = amountFromInput(event.target.value);
      const bad = parsed !== undefined && (Number.isNaN(parsed) || parsed < 0);
      setInvalid(bad);
      if (!bad) onChange(parsed);
    }} />
    {invalid && <small className="field-error">{text('Enter a whole number of yen (0 or more), or leave it empty.', '0 以上の整数（円）を入れるか、空欄にしてください')}</small>}
  </>;
}

function StepsEditor({ steps, onChange, prefix, refs, text }: {
  readonly steps: readonly ExpenseApprovalStepDefDto[];
  readonly onChange: (next: readonly ExpenseApprovalStepDefDto[]) => void;
  readonly prefix: string;
  readonly refs: References | undefined;
  readonly text: Translate;
}) {
  const update = (index: number, change: (step: ExpenseApprovalStepDefDto) => ExpenseApprovalStepDefDto) => {
    const current = steps[index];
    if (current !== undefined) onChange(replaceAt(steps, index, change(current)));
  };
  return <>
    <ol className="expense-people-steps">{steps.map((step, index) => {
      const label = text(`${prefix} step ${index + 1}`, `${prefix} の ${index + 1} 段目`);
      const approver = step.approver;
      return <li key={`${step.id}-${index}`} className="expense-people-step">
        <span className="expense-people-step-no">{index + 1}</span>
        <input aria-label={text(`${label} name`, `${label}の名前`)} value={step.name} onChange={(event) => update(index, (current) => ({ ...current, name: event.target.value }))} />
        <select aria-label={text(`${label} approver`, `${label}の承認者`)} value={approver.kind} onChange={(event) => update(index, (current) => ({ ...current, approver: approverForKind(event.target.value as ExpenseApproverKindDto, current.approver) }))}>
          {APPROVER_KINDS.map((kind) => <option key={kind} value={kind}>{approverKindLabel(kind, text)}</option>)}
        </select>
        {approver.kind === 'department-head' && (refs === undefined
          ? <input aria-label={text(`${label} department id`, `${label}の部門 id`)} placeholder={text("empty = claimant's department", "空欄 = 申請者の部門")} value={approver.departmentId ?? ''} onChange={(event) => update(index, (current) => ({ ...current, approver: event.target.value.trim() === '' ? { kind: 'department-head' } : { kind: 'department-head', departmentId: event.target.value.trim() } }))} />
          : <select aria-label={text(`${label} department`, `${label}の部門`)} value={approver.departmentId ?? ''} onChange={(event) => update(index, (current) => ({ ...current, approver: event.target.value === '' ? { kind: 'department-head' } : { kind: 'department-head', departmentId: event.target.value } }))}>
            <option value="">{text("The claimant's department", '申請者の部門')}</option>
            {refs.departments.map((department) => <option key={department.id} value={department.id}>{department.name || department.id}</option>)}
          </select>)}
        {approver.kind === 'employee' && (refs === undefined
          ? <input aria-label={text(`${label} employee id`, `${label}の従業員 id`)} value={approver.employeeId} onChange={(event) => update(index, (current) => ({ ...current, approver: { kind: 'employee', employeeId: event.target.value.trim() } }))} />
          : <select aria-label={text(`${label} employee`, `${label}の従業員`)} value={approver.employeeId} onChange={(event) => update(index, (current) => ({ ...current, approver: { kind: 'employee', employeeId: event.target.value } }))}>
            <option value="">{text('— choose —', '— 選ぶ —')}</option>
            {refs.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.code === undefined ? employee.name : `${employee.name} (${employee.code})`}</option>)}
          </select>)}
        {approver.kind === 'group' && (refs === undefined
          ? <input aria-label={text(`${label} group id`, `${label}のグループ id`)} value={approver.groupId} onChange={(event) => update(index, (current) => ({ ...current, approver: { kind: 'group', groupId: event.target.value.trim() } }))} />
          : <select aria-label={text(`${label} group`, `${label}の承認グループ`)} value={approver.groupId} onChange={(event) => update(index, (current) => ({ ...current, approver: { kind: 'group', groupId: event.target.value } }))}>
            <option value="">{text('— choose —', '— 選ぶ —')}</option>
            {refs.groups.map((group) => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}
          </select>)}
        <label><input type="checkbox" aria-label={text(`${label} skip when the approvers are the same as the previous step`, `${label}は前の段と同じ承認者なら飛ばす`)} checked={step.skipWhenSameAsPrevious} onChange={(event) => update(index, (current) => ({ ...current, skipWhenSameAsPrevious: event.target.checked }))} />{text('Skip if same as previous', '前の段と同じなら飛ばす')}</label>
        <button type="button" className="secondary" aria-label={text(`Move ${label} up`, `${label}を上へ`)} disabled={index === 0} onClick={() => onChange(moveAt(steps, index, -1))}>↑</button>
        <button type="button" className="secondary" aria-label={text(`Move ${label} down`, `${label}を下へ`)} disabled={index === steps.length - 1} onClick={() => onChange(moveAt(steps, index, 1))}>↓</button>
        <button type="button" className="secondary danger" aria-label={text(`Remove ${label}`, `${label}を削除`)} disabled={steps.length <= 1} onClick={() => onChange(removeAt(steps, index))}>{text('Remove', '削除')}</button>
      </li>;
    })}</ol>
    <button type="button" className="secondary" aria-label={text(`Add a step to ${prefix}`, `${prefix}に段を追加`)} disabled={steps.length >= APPROVAL_STEP_LIMIT} onClick={() => onChange([...steps, newApprovalStep(steps, text('Approve', '承認'))])}>
      {text(`Add a step (up to ${APPROVAL_STEP_LIMIT})`, `段を追加（${APPROVAL_STEP_LIMIT} つまで）`)}
    </button>
  </>;
}

function toggle(list: readonly string[], id: string, on: boolean): readonly string[] {
  return on ? (list.includes(id) ? list : [...list, id]) : list.filter((entry) => entry !== id);
}

/** 規程タブの「承認経路」節（docs/21 §20.2.6 / §20.10.1）。経路の表・段の編集・全体設定・経路の当たり方の試算。保存は規程タブの「規程を保存」。 */
export function ApprovalRoutesSection({ transport, scope, onOpen, draft, onChange, focus }: ExpensePolicySectionSlotProps) {
  const { text } = useI18n();
  const api = useMemo(() => expensePeopleApi(transport), [transport]);
  const approval = approvalOf(draft);
  const update = (next: ExpenseApprovalSettingsDto) => onChange({ ...draft, approval: next });
  const updateRoute = (index: number, change: (route: ExpenseApprovalRouteDto) => ExpenseApprovalRouteDto) => {
    const current = approval.routes[index];
    if (current !== undefined) update({ ...approval, routes: replaceAt(approval.routes, index, change(current)) });
  };

  const [refs, setRefs] = useState<References>();
  const [refsError, setRefsError] = useState<string>();
  useEffect(() => {
    let active = true;
    Promise.all([api.getOrganization(scope), api.listEmployees(scope, { limit: 1000 })])
      .then(([organization, employees]) => { if (active) setRefs({ departments: organization.organization.departments, groups: organization.organization.approverGroups, employees }); })
      .catch((cause: unknown) => { if (active) setRefsError(messageOf(cause)); });
    return () => { active = false; };
  }, [api, scope]);

  const [highlight, setHighlight] = useState<string>();
  useEffect(() => {
    if (focus === undefined || focus.section !== 'approval' || focus.id === '') return;
    const element = document.getElementById(`expense-people-route-${focus.id}`);
    setHighlight(element === null ? undefined : focus.id);
    element?.scrollIntoView?.({ block: 'center' });
  }, [focus?.seq]);

  // 試算
  const [subjectDepartment, setSubjectDepartment] = useState('');
  const [subjectClaimant, setSubjectClaimant] = useState('');
  const [subjectCategories, setSubjectCategories] = useState<readonly string[]>([]);
  const [subjectAmount, setSubjectAmount] = useState<number | undefined>();
  const [preview, setPreview] = useState<ExpenseApprovalRoutePreviewDto>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);

  const categories: readonly ExpenseCategoryDto[] = draft.categories.filter((category) => category.enabled);
  const categoryName = (id: string) => draft.categories.find((category) => category.id === id)?.name ?? id;
  const issues = approvalIssues(approval);

  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(undefined);
    try {
      setPreview(await api.previewApprovalRoute(scope, {
        approval, policyCategoryIds: draft.categories.map((category) => category.id),
        subject: {
          categoryIds: subjectCategories, totalAmount: subjectAmount ?? 0,
          ...(subjectDepartment === '' ? {} : { departmentId: subjectDepartment }), ...(subjectClaimant === '' ? {} : { claimantEmployeeId: subjectClaimant }),
        },
      }));
    } catch (cause: unknown) {
      setPreview(undefined);
      setPreviewError(messageOf(cause));
    } finally {
      setPreviewing(false);
    }
  };

  const open = (target: OpenTarget) => onOpen(target);
  const departmentsKnown = refs !== undefined && refs.departments.length > 0;

  const routeList = approval.routes.map((route, index) => {
    const label = text(`Route ${index + 1}`, `経路 ${index + 1}`);
    const unconditional = routeIsUnconditional(route);
    return <article key={`${route.id}-${index}`} id={`expense-people-route-${route.id}`} className={`expense-people-route${highlight === route.id ? ' expense-people-highlight' : ''}`} aria-label={route.name === '' ? label : route.name}>
      <div className="expense-people-route-head">
        <strong>{index + 1}</strong>
        <input aria-label={text(`${label} name`, `${label}の名前`)} value={route.name} onChange={(event) => updateRoute(index, (current) => ({ ...current, name: event.target.value }))} />
        <label><input type="checkbox" aria-label={text(`${label} enabled`, `${label}を有効にする`)} checked={route.enabled} onChange={(event) => updateRoute(index, (current) => ({ ...current, enabled: event.target.checked }))} />{text('Enabled', '有効')}</label>
        {unconditional && <span className="expense-people-chip expense-people-chip-none">{text('No conditions (matches every claim)', '条件なし（すべての申請に当たる）')}</span>}
        <button type="button" className="secondary" aria-label={text(`Move ${label} up`, `${label}を上へ`)} disabled={index === 0} onClick={() => update({ ...approval, routes: moveAt(approval.routes, index, -1) })}>↑</button>
        <button type="button" className="secondary" aria-label={text(`Move ${label} down`, `${label}を下へ`)} disabled={index === approval.routes.length - 1} onClick={() => update({ ...approval, routes: moveAt(approval.routes, index, 1) })}>↓</button>
        <button type="button" className="secondary danger" aria-label={text(`Remove ${label}`, `${label}を削除`)} onClick={() => update({ ...approval, routes: removeAt(approval.routes, index) })}>{text('Remove', '削除')}</button>
      </div>
      <div className="expense-people-when">
        <span>{text('Conditions (all must match; empty = any)', '条件（すべて満たすと当たる。空 = 問わない）')}</span>
        <div className="expense-checks" role="group" aria-label={text(`${label} categories`, `${label}の費目`)}>{categories.length === 0
          ? <span className="expense-people-muted">{text('No enabled categories.', '有効な費目がありません')}</span>
          : categories.map((category) => <label key={category.id}>
            <input type="checkbox" checked={route.when.categoryIds.includes(category.id)} onChange={(event) => updateRoute(index, (current) => ({ ...current, when: { ...current.when, categoryIds: toggle(current.when.categoryIds, category.id, event.target.checked) } }))} />{category.name || category.id}
          </label>)}</div>
        <label>{text('Claim total from (yen)', '申請の合計（円以上）')}
          <YenInput label={text(`${label} minimum claim total`, `${label}の最低金額`)} value={route.when.minClaimAmount} onChange={(next) => updateRoute(index, (current) => {
            const { minClaimAmount: _drop, ...rest } = current.when;
            return { ...current, when: next === undefined ? rest : { ...rest, minClaimAmount: next } };
          })} />
        </label>
        <div className="expense-checks" role="group" aria-label={text(`${label} departments`, `${label}の部門`)}>{departmentsKnown
          ? refs.departments.map((department) => <label key={department.id}>
            <input type="checkbox" checked={route.when.departmentIds.includes(department.id)} onChange={(event) => updateRoute(index, (current) => ({ ...current, when: { ...current.when, departmentIds: toggle(current.when.departmentIds, department.id, event.target.checked) } }))} />{department.name || department.id}
          </label>)
          : <span className="expense-people-muted">{text('Add departments in the organization to use them as a condition.', '組織に部門を登録すると条件に使えます')}{' '}
            <button type="button" className="screen-link" onClick={() => open({ internalId: '', section: 'organization' })}>{text('Open the organization', '組織を開く')}</button>
          </span>}
          {route.when.departmentIds.filter((id) => !(refs?.departments.some((department) => department.id === id) ?? false)).map((id) => <span key={id} className="expense-people-chip expense-people-chip-blocked">{text(`${id} (not in the organization)`, `${id}（組織に無い）`)}</span>)}
        </div>
      </div>
      <StepsEditor steps={route.steps} prefix={label} refs={refs} text={text} onChange={(steps) => updateRoute(index, (current) => ({ ...current, steps }))} />
    </article>;
  });

  const unresolvedContext = (stepId: string) => {
    const routeId = preview?.plan.routeId;
    const steps = routeId === undefined ? approval.defaultSteps : approval.routes.find((route) => route.id === routeId)?.steps ?? [];
    const spec = steps.find((step) => step.id === stepId)?.approver;
    return {
      ...(spec === undefined ? {} : { spec }), ...(routeId === undefined ? {} : { routeId }),
      ...(subjectClaimant === '' ? {} : { claimantEmployeeId: subjectClaimant }), ...(subjectDepartment === '' ? {} : { departmentId: subjectDepartment }),
    };
  };

  return <section className="workspace-card" aria-labelledby="expense-approval-routes-heading">
    <h2 id="expense-approval-routes-heading">{text('Approval routes', '承認経路')}</h2>
    <ul className="expense-people-guide">
      <li>{text('Routes are checked from the top; the first one whose conditions all match is used. A route without conditions can only be placed last.', '経路は上から見て、条件をすべて満たした最初の経路を使います。条件なしの経路は最後にだけ置けます')}</li>
      <li>{text('Approvers are fixed when the first step is approved. To change them, cancel the approval.', '承認者は 1 段目の承認時に確定します（変えるには承認取消）')}</li>
      <li>{text('When one person uses this workspace alone, every step can be approved as a proxy approval (a comment is required).', '単一ユーザーでの利用では、どの段も代理承認（コメント必須）で押せます')}</li>
    </ul>
    {refsError !== undefined && <p className="expense-people-muted">{text(`Could not load the organization and employees, so enter ids by hand (${refsError}).`, `組織と従業員を読めなかったため、id を手で入れてください（${refsError}）`)}</p>}

    {approval.routes.length === 0
      ? <p className="empty-state">{text('No routes. Every claim has one approval step (anyone who can approve).', '経路がありません。すべての申請が 1 段の承認（承認権限を持つ人なら誰でも）になります')}</p>
      : routeList}
    <div className="expense-actions">
      <button type="button" className="secondary" onClick={() => update({ ...approval, routes: [...approval.routes, newApprovalRoute(approval.routes, text('New route', '新しい経路'), text('Approve', '承認'))] })}>{text('Add a route', '経路を追加')}</button>
    </div>

    <h3>{text('Default steps (when no route matches)', '既定の段（どの経路にも当たらないとき）')}</h3>
    <StepsEditor steps={approval.defaultSteps} prefix={text('Default', '既定')} refs={refs} text={text} onChange={(defaultSteps) => update({ ...approval, defaultSteps })} />

    <h3>{text('Rules for all routes', '全体の設定')}</h3>
    <div className="expense-checks">
      <label><input type="checkbox" checked={approval.forbidClaimantApproval} onChange={(event) => update({ ...approval, forbidClaimantApproval: event.target.checked })} />{text('Forbid the claimant from approving their own claim', '申請者本人の承認を禁止する')}</label>
      <label><input type="checkbox" checked={approval.requireDistinctApprovers} onChange={(event) => update({ ...approval, requireDistinctApprovers: event.target.checked })} />{text('Forbid the same person from approving consecutive steps', '同じ人の連続承認を禁止する')}</label>
    </div>
    <label className="expense-people-toolbar">{text('Proxy approver group', '代理承認グループ')}
      {refs === undefined
        ? <input aria-label={text('Proxy approver group', '代理承認グループ')} value={approval.proxyGroupId ?? ''} onChange={(event) => {
          const { proxyGroupId: _drop, ...rest } = approval;
          update(event.target.value.trim() === '' ? rest : { ...rest, proxyGroupId: event.target.value.trim() });
        }} />
        : <select aria-label={text('Proxy approver group', '代理承認グループ')} value={approval.proxyGroupId ?? ''} onChange={(event) => {
          const { proxyGroupId: _drop, ...rest } = approval;
          update(event.target.value === '' ? rest : { ...rest, proxyGroupId: event.target.value });
        }}>
          <option value="">{text('— none —', '— なし —')}</option>
          {refs.groups.map((group) => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}
        </select>}
    </label>

    {issues.length > 0 && <div className="notice-card" role="note" aria-label={text('Check the approval routes', '承認経路の確認')}>
      <strong>{text('Check these before saving the policy', '規程を保存する前に確認してください')}</strong>
      <ul>{issues.map((issue) => <li key={`${issue.path}-${issue.message[0]}`}>{text(issue.message[0], issue.message[1])}</li>)}</ul>
    </div>}

    <div className="expense-people-preview">
      <h3>{text('Try which route applies', '経路の当たり方を試す')}</h3>
      <p className="expense-people-muted">{text('Uses the routes as edited above, even before you save the policy.', '保存していない下書きの経路で試せます')}</p>
      <div className="expense-people-toolbar">
        <label>{text('Claimant', '申請者')}
          <select aria-label={text('Claimant for the preview', '試算の申請者')} value={subjectClaimant} onChange={(event) => {
            setSubjectClaimant(event.target.value);
            const department = refs?.employees.find((employee) => employee.id === event.target.value)?.departmentId;
            if (department !== undefined && subjectDepartment === '') setSubjectDepartment(department);
          }}>
            <option value="">{text('— not chosen —', '— 選ばない —')}</option>
            {(refs?.employees ?? []).filter((employee) => employee.enabled).map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <label>{text('Department', '部門')}
          <select aria-label={text('Department for the preview', '試算の部門')} value={subjectDepartment} onChange={(event) => setSubjectDepartment(event.target.value)}>
            <option value="">{text('— not chosen —', '— 選ばない —')}</option>
            {(refs?.departments ?? []).map((department) => <option key={department.id} value={department.id}>{department.name || department.id}</option>)}
          </select>
        </label>
        <label>{text('Claim total (yen)', '申請の合計（円）')}
          <YenInput label={text('Claim total for the preview', '試算の合計金額')} value={subjectAmount} onChange={setSubjectAmount} />
        </label>
      </div>
      <div className="expense-checks" role="group" aria-label={text('Categories for the preview', '試算の費目')}>{categories.map((category) => <label key={category.id}>
        <input type="checkbox" checked={subjectCategories.includes(category.id)} onChange={(event) => setSubjectCategories(toggle(subjectCategories, category.id, event.target.checked))} />{category.name || category.id}
      </label>)}</div>
      <div className="expense-actions">
        <button type="button" className="secondary" disabled={previewing} onClick={() => void runPreview()}>{previewing ? text('Trying…', '試算中…') : text('Try the route', '試算する')}</button>
      </div>
      {previewError !== undefined && <div className="api-error" role="alert">
        <p>{previewError}</p>
        <p>{text('Next step: fix the route settings above (for example, move a route without conditions to the bottom), then try again.', '次の一手: 上の経路の設定を直してから（例: 条件なしの経路を一番下へ）、もう一度試してください')}</p>
      </div>}
      {preview !== undefined && <div aria-label={text('Preview result', '試算の結果')} role="region">
        <p><strong>{preview.plan.routeId === undefined
          ? text(`No route matched, so the default steps are used (${preview.plan.routeName})`, `どの経路にも当たらないため既定の段を使います（${preview.plan.routeName}）`)
          : text(`Route: ${preview.plan.routeName}`, `当たる経路: ${preview.plan.routeName}`)}</strong></p>
        <div className="table-wrap"><table className="expense-people-table">
          <thead><tr><th>#</th><th>{text('Step', '段')}</th><th>{text('Approvers', '承認者')}</th></tr></thead>
          <tbody>{preview.plan.steps.map((step, index) => {
            const unresolved = preview.plan.unresolved.some((entry) => entry.stepId === step.stepId);
            return <tr key={step.stepId}>
              <td>{index + 1}</td>
              <td>{step.name}{step.stepId === preview.firstStepId && <span className="expense-people-note">{text('First step to approve', '最初に承認する段')}</span>}</td>
              <td>{step.skipped ? text('Skipped (same approvers as the previous step)', '飛ばし（前の段と同じ承認者）')
                : step.approverKind === 'any-approver' ? text('Anyone who can approve', '承認権限を持つ人なら誰でも')
                  : unresolved ? text('Not decided', '決まりません')
                    : step.approvers.map((approver) => approver.name).join(text(', ', '、'))}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {preview.plan.unresolved.map((entry) => {
          const view = unresolvedStepView(entry, unresolvedContext(entry.stepId), text);
          return <div key={view.key} className="expense-people-unresolved">
            <p><strong>{text(`Step "${view.stepName}": the approver cannot be decided`, `段「${view.stepName}」の承認者が決まりません`)}</strong></p>
            <p>{text('Cause', '原因')}: {view.cause}</p>
            <p>{text('Next step', '次の一手')}: {view.fix}</p>
            <button type="button" className="secondary" onClick={() => open(view.target)}>{view.actionLabel}</button>
          </div>;
        })}
        {preview.plan.unresolved.length === 0 && subjectCategories.length > 0 && <p className="expense-people-muted">{text(`Categories used: ${subjectCategories.map(categoryName).join(', ')}`, `試した費目: ${subjectCategories.map(categoryName).join('、')}`)}</p>}
      </div>}
    </div>
  </section>;
}
