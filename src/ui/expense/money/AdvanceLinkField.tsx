import { useEffect, useState } from 'react';
import type { ExpenseAdvanceDto } from '../../api/expense-money-types';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { formatYen } from '../../journal/journal-model';
import type { ExpenseClaimAdvanceFieldSlotProps } from '../expense-slots';
import { MoneyErrorNotice, readMoneyError, useMoneyApi, type MoneyErrorInfo } from './money-shared';

function advanceSummary(advance: ExpenseAdvanceDto): string {
  return `${advance.purpose} · ${formatYen(advance.amount)}${advance.payment === undefined ? '' : ` · ${advance.payment.paidOn}`}`;
}

/**
 * 申請の「仮払の紐付け」（docs/21 §20.10.1）。申請者の支払済みの仮払から選んで紐付ける / 外す。
 * 紐付けを変えると判定の前提が変わり、申請は下書きに戻る（再チェックが要る）。候補が無いことは失敗ではないので赤くしない。
 */
export function AdvanceLinkField({ transport, scope, onOpen, claim, editable, onClaimChanged, focused }: ExpenseClaimAdvanceFieldSlotProps) {
  const { text } = useI18n();
  const api = useMoneyApi(transport);
  const employeeId = claim.claimant.employeeId;
  const [candidates, setCandidates] = useState<readonly ExpenseAdvanceDto[]>();
  const [linked, setLinked] = useState<ExpenseAdvanceDto>();
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoneyErrorInfo>();
  const [feedback, setFeedback] = useState<string>();

  useEffect(() => {
    let active = true;
    if (employeeId === undefined || !editable) { setCandidates([]); return; }
    setCandidates(undefined);
    api.listAdvances(scope, { status: 'paid', employeeId })
      .then((next) => { if (active) { setCandidates(next); setChoice(next[0]?.id ?? ''); } })
      .catch((cause: unknown) => { if (active) { setCandidates([]); setError(readMoneyError(cause)); } });
    return () => { active = false; };
  }, [api, scope, employeeId, editable]);

  useEffect(() => {
    let active = true;
    if (claim.advanceId === undefined) { setLinked(undefined); return; }
    const advanceId = claim.advanceId;
    api.getAdvance(scope, advanceId)
      .then((detail) => { if (active) setLinked(detail.advance); })
      .catch(() => { if (active) setLinked(undefined); });
    return () => { active = false; };
  }, [api, scope, claim.advanceId]);

  const link = async (advanceId: string | null) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const next = await api.linkClaimAdvance(scope, claim.id, advanceId);
      setFeedback(advanceId === null
        ? text('Removed the advance. Run the check again.', '仮払の紐付けを外しました。もう一度チェックしてください。')
        : text('Linked the advance. Run the check again.', '仮払を紐付けました。もう一度チェックしてください。'));
      onClaimChanged(next);
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const openLedger = () => onOpen({ internalId: '', section: 'advance' });
  const heading = text('Advance link', '仮払の紐付け');

  return <div className={`expense-money-link-field${focused ? ' expense-money-link-focused expense-focused' : ''}`} role="group" aria-label={heading}>
    <strong>{heading}</strong>
    {claim.advanceId !== undefined
      ? <div className="expense-actions">
        <span>{text('Linked:', '紐付け中:')} <span className="expense-money-link-summary">{linked === undefined ? claim.advanceId : advanceSummary(linked)}</span></span>
        {linked !== undefined && <button type="button" className="screen-link" onClick={() => onOpen({ internalId: linked.id, section: 'advance' })}>{text('Open the advance', '仮払を開く')}</button>}
        {editable && <button type="button" className="secondary" disabled={busy} onClick={() => void link(null)}>{text('Remove', '外す')}</button>}
      </div>
      : employeeId === undefined
        ? <p className="empty-state">{text('Choose the claimant from the employee master to link an advance.', '申請者を従業員マスタから選ぶと仮払を紐付けられます')}</p>
        : !editable
          ? <p className="empty-state">{text('No advance is linked.', '仮払は紐付いていません。')}</p>
          : candidates === undefined
            ? <p className="empty-state" role="status">{text('Loading paid advances…', '支払済みの仮払を読み込み中…')}</p>
            : candidates.length === 0
              ? <div className="expense-empty">
                <p className="empty-state">{text('This claimant has no paid advances.', 'この申請者の支払済みの仮払はありません')}</p>
                <button type="button" className="secondary" onClick={openLedger}>{text('Open the advance ledger', '仮払台帳を開く')}</button>
              </div>
              : <div className="expense-actions">
                <label>{text('Paid advance', '支払済みの仮払')}{' '}
                  <select value={choice} onChange={(event) => setChoice(event.target.value)}>
                    {candidates.map((advance) => <option key={advance.id} value={advance.id}>{advanceSummary(advance)}</option>)}
                  </select>
                </label>
                <button type="button" className="primary" disabled={busy || choice === ''} onClick={() => void link(choice)}>{text('Link', '紐付ける')}</button>
              </div>}
    {editable && (claim.advanceId !== undefined || (candidates?.length ?? 0) > 0) && <small className="expense-limit-hint">{text('Linking or removing an advance returns the claim to draft, so run the check again afterwards.', '紐付けを変えると申請は下書きに戻るので、後でもう一度チェックしてください。')}</small>}
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    <MoneyErrorNotice error={error} onOpen={onOpen} />
  </div>;
}
