import { useEffect, useMemo, useState } from 'react';
import { expenseApi } from '../../api/expense-api';
import { expensePeopleApi } from '../../api/expense-people-api';
import type { ExpenseApprovalFlowViewDto } from '../../api/expense-people-types';
import { useI18n } from '../../i18n';
import { messageOf } from '../expense-shared';
import type { ExpenseApprovalFlowSlotProps } from '../expense-slots';
import { flowStepRows, flowStepStateLabel, isMinimalFlow, type FlowStepRow } from './people-model';
import './people.css';

/**
 * 承認タブの詳細の承認の流れ（docs/21 §20.2.6 / §20.10.1）: 経路名・段・承認者・状態・誰がいつ・代理の印と、あなたの承認待ちの件数。
 * 承認できない理由の一覧は ApproveTab が描くので、ここでは重ねて出さない。MVP の 1 段で未承認なら件数の 1 行だけにする。
 */
export function ApprovalFlowPanel({ transport, scope, claim }: ExpenseApprovalFlowSlotProps) {
  const { text } = useI18n();
  const peopleApi = useMemo(() => expensePeopleApi(transport), [transport]);
  const claimsApi = useMemo(() => expenseApi(transport), [transport]);
  const [view, setView] = useState<ExpenseApprovalFlowViewDto>();
  const [error, setError] = useState<string>();
  const [awaiting, setAwaiting] = useState<number>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(undefined);
    peopleApi.approvalFlow(scope, claim.id)
      .then((next) => { if (active) setView(next); })
      .catch((cause: unknown) => { if (active) { setView(undefined); setError(messageOf(cause)); } });
    return () => { active = false; };
  }, [peopleApi, scope, claim.id, claim.updatedAt, claim.status, reload]);

  useEffect(() => {
    let active = true;
    claimsApi.listClaims(scope, { awaiting: 'me' })
      .then((claims) => { if (active) setAwaiting(claims.length); })
      // 件数は案内なので、読めなければ出さない（承認の操作は妨げない）。
      .catch(() => { if (active) setAwaiting(undefined); });
    return () => { active = false; };
  }, [claimsApi, scope, claim.updatedAt, claim.status]);

  const awaitingLine = awaiting === undefined ? null : <p className="expense-people-muted">{awaiting === 0
    ? text('No claims are waiting for your approval.', 'あなたの承認待ちはありません')
    : text(`${awaiting} claims are waiting for your approval.`, `あなたの承認待ち ${awaiting} 件`)}</p>;

  if (error !== undefined) {
    return <div className="expense-people-flow">
      <p className="expense-people-muted">{text(`Could not load the approval flow: ${error}`, `承認の流れを読めませんでした: ${error}`)}{' '}
        <button type="button" className="screen-link" onClick={() => setReload((value) => value + 1)}>{text('Retry loading the approval flow', '承認の流れを読み直す')}</button>
      </p>
      {awaitingLine}
    </div>;
  }
  if (view === undefined || isMinimalFlow(view)) return awaitingLine;

  const rows = flowStepRows(view);
  const routeName = view.flow?.routeName ?? view.plan.routeName;
  const approverText = (row: FlowStepRow) => {
    if (row.approverKind === 'any-approver') return text('Anyone who can approve', '承認権限を持つ人なら誰でも');
    if (row.approvers.length > 0) return row.approvers.map((approver) => approver.name).join(text(', ', '、'));
    return row.unresolved ? text('Not decided (see the reasons next to the Approve button)', '決まっていません（承認ボタンの横の理由を見てください）') : '—';
  };

  return <section className="expense-people-flow" aria-label={text('Approval flow', '承認の流れ')}>
    <h3>{text(`Approval flow: ${routeName}`, `承認の流れ: ${routeName}`)}</h3>
    <div className="table-wrap"><table className="expense-people-table">
      <thead><tr>
        <th>#</th><th>{text('Step', '段')}</th><th>{text('Approvers', '承認者')}</th><th>{text('Status', '状態')}</th><th>{text('Decision', '誰がいつ')}</th>
      </tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.stepId} className={row.current ? 'expense-people-current' : ''} aria-current={row.current ? 'step' : undefined}>
        <td>{index + 1}</td>
        <td>{row.name}{row.current && <span className="expense-people-note">{text('Current step', '現在の段')}</span>}</td>
        <td>{approverText(row)}</td>
        <td>{flowStepStateLabel(row.state, text)}</td>
        <td>{row.decision === undefined ? '—' : <>
          {row.decision.displayName ?? row.decision.by} · {row.decision.at}
          {row.decision.proxy && <> <span className="expense-people-chip expense-people-chip-proxy">{text('Proxy', '代理')}</span></>}
          {row.decision.comment !== undefined && row.decision.comment !== '' && <span className="expense-people-note">{row.decision.comment}</span>}
        </>}</td>
      </tr>)}</tbody>
    </table></div>
    {view.proxy && <div className="notice-card" role="note" aria-label={text('Proxy approval', '代理承認')}>
      <strong>{text('This will be a proxy approval', '代理承認になります')}</strong>
      <p>{text('Write in the approval comment whom you approve for and why.', '承認のコメント欄に誰の代わりに・なぜ承認するかを書いてください')}</p>
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => document.getElementById('expense-approve-comment')?.focus()}>{text('Go to the approval comment', '承認のコメント欄へ')}</button>
      </div>
    </div>}
    <p className="expense-people-note">{text('Approvers are fixed when the first step is approved. To change them, cancel the approval.', '承認者は 1 段目の承認時に確定した写しです。変えるには承認を取り消します')}</p>
    {awaitingLine}
  </section>;
}
