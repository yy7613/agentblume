import { useCallback, useEffect, useState } from 'react';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpenseBlockingReasonDto, ExpenseClaimDto, ExpenseClaimSummaryDto } from '../api/expense-types';
import { ApiError } from '../api/tool-api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { formatYen } from '../journal/journal-model';
import type { OpenTarget } from '../navigation';
import { scope } from '../scope';
import { detailArray, isBlockingReason, reviewReasonsOf, summarizeBlocker, summarizeCheck, type BlockerSummary, type ExpenseTab } from './expense-model';
import { CheckReasonCard, EmptyStep, StatusChip, VerdictChip, copyText, messageOf, useExpenseSlotEnvironment } from './expense-shared';
import { ApprovalFlowPanel } from './expense-slots';

/** 承認を待っている状態（多段承認の途中の `in-approval` も、次の段の承認を待つ）。 */
const awaitingApproval = (status: string): boolean => status === 'checked' || status === 'in-approval';

/**
 * 承認タブ（docs/21 §7, §11, §20.5.1）。要確認の理由ごとの確認済み（根拠コメント必須）、差し戻し文言の編集とコピー、承認と押せない理由の一覧、承認取消。
 * 承認・差し戻しは人がここで押す（モデルの判断で起こさない）。承認できない理由は `approvalBlockers` と 409 の `blockingReasons` の両方から出す。
 * 承認の流れ（段・承認者・代理）は A の `ApprovalFlowPanel` が描き、ここは承認中の段の id を承認の本文に載せるだけ。
 */
export function ApproveTab({ api, claims, onClaimsChanged, selectedClaimId, onSelectClaim, onOpen, onTab }: {
  readonly api: ExpenseApi;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly onClaimsChanged: () => Promise<void> | void;
  readonly selectedClaimId: string | undefined;
  readonly onSelectClaim: (id: string | undefined) => void;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab: (tab: ExpenseTab) => void;
}) {
  const { text } = useI18n();
  const slot = useExpenseSlotEnvironment();
  const [claim, setClaim] = useState<ExpenseClaimDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [comment, setComment] = useState('');
  const [serverBlockers, setServerBlockers] = useState<readonly ExpenseBlockingReasonDto[]>([]);
  const [returnMessage, setReturnMessage] = useState<string>();
  const [copyState, setCopyState] = useState<'copied' | 'failed'>();
  const [unapproveNote, setUnapproveNote] = useState('');
  const [confirm, setConfirm] = useState<'return' | 'unapprove'>();

  const relevant = claims.filter((entry) => awaitingApproval(entry.status) || entry.status === 'returned' || entry.status === 'approved');
  const loadClaim = useCallback(async (id: string | undefined) => {
    if (id === undefined) { setClaim(undefined); return; }
    try { setClaim(await api.getClaim(scope, id)); }
    catch (cause: unknown) { setClaim(undefined); setError(messageOf(cause)); }
  }, [api]);
  useEffect(() => {
    setServerBlockers([]); setReturnMessage(undefined); setCopyState(undefined); setError(undefined); setFeedback(undefined); setComment(''); setUnapproveNote('');
    void loadClaim(selectedClaimId);
  }, [loadClaim, selectedClaimId]);

  const act = async (operation: () => Promise<ExpenseClaimDto>, done: string) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      setClaim(await operation());
      setServerBlockers([]);
      setFeedback(done);
      await onClaimsChanged();
    } catch (cause: unknown) {
      setError(messageOf(cause));
      if (cause instanceof ApiError && cause.code === 'EXPENSE_TRANSITION') setServerBlockers(detailArray(cause.details, 'blockingReasons', isBlockingReason));
    } finally {
      setBusy(false);
      setConfirm(undefined);
    }
  };

  const draftReturn = async () => {
    if (claim === undefined) return;
    setBusy(true);
    setError(undefined);
    try { setReturnMessage(await api.returnDraft(scope, claim.id)); setCopyState(undefined); }
    catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };

  const copy = async (value: string) => setCopyState(await copyText(value) ? 'copied' : 'failed');

  /** 承認できない理由のうち、画面の中で済む導線（段が進んだら読み直す・代理承認のコメント欄へ）。 */
  const runLocalAction = (action: NonNullable<BlockerSummary['localAction']>) => {
    if (action === 'reload') {
      setServerBlockers([]);
      void loadClaim(selectedClaimId);
      void onClaimsChanged();
    } else {
      document.getElementById('expense-approve-comment')?.focus();
    }
  };

  if (relevant.length === 0 && claim === undefined) {
    return <section className="workspace-card"><EmptyStep message={text('No claims are waiting for approval.', '承認待ちの申請はありません。')} actionLabel={text('Open Check', 'チェックを開く')} onAction={() => onTab('check')} /></section>;
  }

  const group = (label: string, entries: readonly ExpenseClaimSummaryDto[]) => entries.length === 0 ? null : <>
    <h3>{label}</h3>
    <ul className="expense-claim-list">{entries.map((entry) => <li key={entry.id}>
      <button type="button" className="expense-claim-row" aria-current={entry.id === selectedClaimId} onClick={() => onSelectClaim(entry.id)}>
        <strong>{entry.claimant.name}</strong>
        <span className="expense-claim-meta">{entry.period.from}〜{entry.period.to} · {formatYen(entry.totalAmount)}</span>
        <span className="expense-claim-meta"><StatusChip status={entry.status} /><VerdictChip verdict={entry.verdict} stale={entry.stale} />
          {awaitingApproval(entry.status) && text(`${Math.max(0, entry.reasonCounts.review - entry.reasonCounts.acknowledged)} to review · ${entry.reasonCounts.return} return`, `要確認の残り ${Math.max(0, entry.reasonCounts.review - entry.reasonCounts.acknowledged)} · 差し戻し ${entry.reasonCounts.return}`)}</span>
      </button>
    </li>)}</ul>
  </>;

  const reviews = claim === undefined ? [] : reviewReasonsOf(claim);
  const pending = reviews.filter((entry) => entry.acknowledged === undefined);
  const acknowledged = reviews.filter((entry) => entry.acknowledged !== undefined);
  const returns = claim === undefined ? [] : [...(claim.judgment?.claimReasons ?? []), ...(claim.judgment?.items.flatMap((item) => item.reasons) ?? [])].filter((reason) => reason.severity === 'return');
  const blockers = claim === undefined ? [] : [...claim.approvalBlockers, ...serverBlockers.filter((extra) => !claim.approvalBlockers.some((own) => own.code === extra.code && own.itemId === extra.itemId))];
  const noteKey = (code: string, itemId: string | undefined) => `${code}:${itemId ?? ''}`;
  const unapproveBlocked = claim !== undefined && (claim.journalLink !== undefined || claim.settlement !== undefined);

  return <div className="expense-layout">
    <section className="workspace-card" aria-labelledby="expense-approve-list-heading">
      <h2 id="expense-approve-list-heading">{text('Claims', '申請')}</h2>
      {group(text('Waiting for approval', '承認待ち'), relevant.filter((entry) => awaitingApproval(entry.status)))}
      {group(text('Returned', '差し戻し中'), relevant.filter((entry) => entry.status === 'returned'))}
      {group(text('Approved', '承認済み'), relevant.filter((entry) => entry.status === 'approved'))}
    </section>

    <div>
      {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
      {error !== undefined && <p className="api-error" role="alert">{error}</p>}
      {claim === undefined ? <p className="empty-state">{text('Choose a claim to review it.', '申請を選ぶと確認できます。')}</p>
        : <section className="workspace-card" aria-labelledby="expense-approve-detail-heading">
          <div className="expense-row-between">
            <h2 id="expense-approve-detail-heading">{claim.claimant.name} · {claim.period.from}〜{claim.period.to}</h2>
            <span className="expense-claim-meta"><StatusChip status={claim.status} /><VerdictChip verdict={claim.judgment?.verdict} stale={claim.stale} /></span>
          </div>
          <p className="expense-claim-meta">{claim.id} · <span className="expense-total">{formatYen(claim.totalAmount)}</span></p>
          <ApprovalFlowPanel transport={slot.transport} scope={slot.scope} onOpen={onOpen} claim={claim} onClaimChanged={setClaim} onClaimsChanged={onClaimsChanged} />

          {claim.status === 'draft' && <EmptyStep message={text('This claim has not been checked yet.', 'この申請はまだチェックしていません。')} actionLabel={text('Open Check', 'チェックを開く')} onAction={() => onTab('check')} />}

          {awaitingApproval(claim.status) && <>
            <h3>{text('Reasons to review', '要確認の理由')}</h3>
            {pending.length === 0 && <p className="empty-state">{text('No review reasons are left.', '未確認の要確認はありません。')}</p>}
            {pending.map(({ reason }) => {
              const key = noteKey(reason.code, reason.itemId);
              const note = notes[key] ?? '';
              const title = summarizeCheck(reason, text).title;
              return <CheckReasonCard key={key} reason={reason} claim={claim} onOpen={onOpen}>
                <label>{text('Why it is acceptable (required)', '確認の根拠コメント（必須）')}
                  <textarea aria-label={text(`Comment for ${title}`, `${title} の確認コメント`)} value={note} onChange={(event) => setNotes({ ...notes, [key]: event.target.value })} />
                </label>
                <button type="button" className="secondary" disabled={busy || note.trim() === ''} onClick={() => void act(() => api.acknowledge(scope, claim.id, { ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }), code: reason.code, note: note.trim() }), text('Marked as reviewed.', '確認済みにしました。'))}>{text('Mark as reviewed', '確認済みにする')}</button>
              </CheckReasonCard>;
            })}
            {acknowledged.length > 0 && <details><summary>{text(`Reviewed (${acknowledged.length})`, `確認済み（${acknowledged.length}）`)}</summary>
              <ul>{acknowledged.map(({ reason, acknowledged: ack }) => <li key={noteKey(reason.code, reason.itemId)}>{summarizeCheck(reason, text).title}: {ack?.note} ({ack?.by}, {ack?.at})</li>)}</ul>
            </details>}
            {returns.length > 0 && <>
              <h3>{text('Reasons to return', '差し戻しの理由')}</h3>
              <p className="empty-state">{text('These cannot be marked as reviewed. Return the claim so the claimant fixes them, or fix the items and check again.', 'これらは確認済みにできません。差し戻して申請者に直してもらうか、明細を直して再チェックしてください。')}</p>
              {returns.map((reason, index) => <CheckReasonCard key={`${reason.code}-${index}`} reason={reason} claim={claim} onOpen={onOpen} />)}
            </>}

            <h3>{text('Approve', '承認')}</h3>
            <label>{text('Comment (optional)', 'コメント（任意）')}<input id="expense-approve-comment" value={comment} onChange={(event) => setComment(event.target.value)} /></label>
            <div className="expense-actions">
              <button type="button" className="primary" disabled={busy || blockers.length > 0} onClick={() => {
                // 承認中は、画面を開いたときの段を送る（その間に段が進んでいたらサーバーが approval-step-changed で断る）。
                const stepId = claim.status === 'in-approval' ? claim.approvalFlow?.steps[claim.approvalFlow.currentIndex]?.stepId : undefined;
                void act(() => (stepId === undefined ? api.approve(scope, claim.id, comment.trim()) : api.approve(scope, claim.id, comment.trim(), stepId)), text('Approved.', '承認しました。'));
              }}>{text('Approve', '承認する')}</button>
            </div>
            {blockers.length > 0 && <div className="notice-card" role="note" aria-label={text('Why it cannot be approved', '承認できない理由')}>
              <strong>{text('Why it cannot be approved yet', '承認できない理由')}</strong>
              <ul>{blockers.map((blocker) => {
                const summary = summarizeBlocker(blocker, claim, text);
                return <li key={summary.key}>
                  <p>{summary.title}</p>
                  <p>{text('Next step', '次の一手')}: {summary.fix}</p>
                  {summary.target !== undefined && <button type="button" className="secondary" onClick={() => { if (summary.target !== undefined) onOpen(summary.target); }}>{summary.actionLabel}</button>}
                  {summary.localAction !== undefined && <button type="button" className="secondary" onClick={() => { if (summary.localAction !== undefined) runLocalAction(summary.localAction); }}>{summary.actionLabel}</button>}
                </li>;
              })}</ul>
            </div>}

            <h3>{text('Return to the claimant', '差し戻し')}</h3>
            {returnMessage === undefined
              ? <button type="button" className="secondary" disabled={busy} onClick={() => void draftReturn()}>{text('Draft the return message', '差し戻し文言を作る')}</button>
              : <>
                <label>{text('Message to the claimant (edit before sending)', '申請者への文言（送る前に編集できます）')}
                  <textarea className="expense-textarea" aria-label={text('Return message', '差し戻し文言')} value={returnMessage} onChange={(event) => setReturnMessage(event.target.value)} />
                </label>
                <div className="expense-actions">
                  <button type="button" className="secondary" onClick={() => void copy(returnMessage)}>{text('Copy the message', '文言をコピー')}</button>
                  <button type="button" className="secondary danger" disabled={busy || returnMessage.trim() === ''} onClick={() => setConfirm('return')}>{text('Return', '差し戻す')}</button>
                </div>
                {copyState === 'copied' && <InlineFeedback kind="success">{text('Copied. Paste it into your message to the claimant (this app does not send notifications).', 'コピーしました。申請者への連絡に貼り付けてください（この画面から通知は送りません）。')}</InlineFeedback>}
                {copyState === 'failed' && <InlineFeedback kind="error">{text('Could not copy automatically. Select the text above and copy it by hand.', '自動でコピーできませんでした。上の文言を選択して手でコピーしてください。')}</InlineFeedback>}
              </>}
          </>}

          {claim.status === 'returned' && claim.returnNote !== undefined && <>
            <h3>{text('Return message', '差し戻し文言')}</h3>
            <pre className="expense-pre">{claim.returnNote.message}</pre>
            <div className="expense-actions">
              <button type="button" className="secondary" onClick={() => void copy(claim.returnNote?.message ?? '')}>{text('Copy the message', '文言をコピー')}</button>
              <button type="button" className="secondary" onClick={() => onOpen({ internalId: claim.id, section: 'item:' })}>{text('Apply the fixes in Ingest', '取込で修正を反映する')}</button>
            </div>
            {copyState === 'copied' && <InlineFeedback kind="success">{text('Copied.', 'コピーしました。')}</InlineFeedback>}
            {copyState === 'failed' && <InlineFeedback kind="error">{text('Could not copy automatically. Select the text above and copy it by hand.', '自動でコピーできませんでした。上の文言を選択して手でコピーしてください。')}</InlineFeedback>}
            <p className="empty-state">{text('After the claimant sends corrections, edit the items in Ingest and check again.', '申請者から修正が届いたら、取込で明細を直してもう一度チェックしてください。')}</p>
          </>}

          {claim.status === 'approved' && <>
            <p>{text(`Approved by ${claim.approval?.displayName ?? claim.approval?.by ?? ''} at ${claim.approval?.at ?? ''}`, `${claim.approval?.displayName ?? claim.approval?.by ?? ''} が ${claim.approval?.at ?? ''} に承認`)}{claim.approval?.comment === undefined ? '' : ` · ${claim.approval.comment}`}</p>
            <h3>{text('Cancel the approval', '承認取消')}</h3>
            {unapproveBlocked
              ? <p className="notice-card">{text('This claim already has journal drafts or is settled, so the approval cannot be cancelled.', 'この申請は仕訳下書きを作成済みか精算済みのため、承認を取り消せません。')}</p>
              : <>
                <label>{text('Reason (required)', '理由（必須）')}<textarea aria-label={text('Reason for cancelling', '承認取消の理由')} value={unapproveNote} onChange={(event) => setUnapproveNote(event.target.value)} /></label>
                <button type="button" className="secondary danger" disabled={busy || unapproveNote.trim() === ''} onClick={() => setConfirm('unapprove')}>{text('Cancel the approval', '承認を取り消す')}</button>
              </>}
          </>}
        </section>}
    </div>

    <ConfirmDialog open={confirm !== undefined} danger busy={busy}
      title={confirm === 'return' ? text('Return this claim?', 'この申請を差し戻しますか？') : text('Cancel the approval?', '承認を取り消しますか？')}
      message={confirm === 'return'
        ? text('The claim becomes "returned" with this message. Send the copied message to the claimant yourself.', '申請は文言付きで「差し戻し中」になります。コピーした文言は申請者へ自分で伝えてください。')
        : text('The claim goes back to "checked" and can be edited or approved again.', '申請は「チェック済み」に戻り、編集や再承認ができるようになります。')}
      confirmLabel={confirm === 'return' ? text('Return', '差し戻す') : text('Cancel the approval', '取り消す')} cancelLabel={text('Keep', 'やめる')}
      onConfirm={() => {
        if (claim === undefined) return;
        if (confirm === 'return') void act(() => api.returnClaim(scope, claim.id, (returnMessage ?? '').trim()), text('Returned the claim.', '差し戻しました。'));
        else void act(() => api.unapprove(scope, claim.id, unapproveNote.trim()), text('Cancelled the approval.', '承認を取り消しました。'));
      }}
      onCancel={() => setConfirm(undefined)} />
  </div>;
}
