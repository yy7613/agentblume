import { useEffect, useState } from 'react';
import type { ExpenseApi } from '../api/expense-api';
import type { DraftExpenseJournalEntriesResultDto, ExpenseClaimSummaryDto, ExpenseJournalLinkProblemDto, ExpenseSettlementFormatDto, ExpenseSettlementResultDto } from '../api/expense-types';
import { ApiError } from '../api/tool-api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { formatYen, triggerDownload } from '../journal/journal-model';
import { useOpenInScreen, type OpenTarget } from '../navigation';
import { scope } from '../scope';
import { claimStatusLabel, detailArray, isJournalLinkProblem, isString, journalProblemLabel, journalProblemTarget, sumAmounts, type ExpenseTab } from './expense-model';
import { EmptyStep, ReasonCard, StatusChip, messageOf, useExpenseSlotEnvironment } from './expense-shared';
import { SettlePayoutPanel } from './expense-slots';

interface JournalOutcome {
  readonly claimId: string;
  readonly result?: DraftExpenseJournalEntriesResultDto;
  readonly problems?: readonly ExpenseJournalLinkProblemDto[];
  readonly createdEntryIds?: readonly string[];
  readonly error?: string;
}

/**
 * 精算出力タブ（docs/21 §8, §9, §11）。承認済みの一覧と合計、精算 CSV（振込用 / 明細）、「精算済みにする」、仕訳下書きの作成。
 * CSV を作っても状態は変えない（支払いが済んだかは作った瞬間には分からないため）。精算済みの印は人が確認ダイアログで押す。
 */
export function SettleTab({ api, claims, onClaimsChanged, onOpen, onTab }: {
  readonly api: ExpenseApi;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly onClaimsChanged: () => Promise<void> | void;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab: (tab: ExpenseTab) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const slot = useExpenseSlotEnvironment();
  const approved = claims.filter((claim) => claim.status === 'approved');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(approved.map((claim) => claim.id)));
  const [format, setFormat] = useState<ExpenseSettlementFormatDto>('payout');
  const [status, setStatus] = useState<'approved' | 'settled'>('approved');
  const [exported, setExported] = useState<ExpenseSettlementResultDto & { readonly downloaded: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [notApproved, setNotApproved] = useState<readonly { readonly id: string; readonly status: string }[]>([]);
  const [confirmSettle, setConfirmSettle] = useState(false);
  const [journal, setJournal] = useState<JournalOutcome>();

  // 一覧が変わったら、消えた申請の選択を外す（新しく承認されたものは選んだ状態にする）。
  const approvedKey = approved.map((claim) => claim.id).join(',');
  useEffect(() => { setSelected(new Set(approvedKey === '' ? [] : approvedKey.split(','))); }, [approvedKey]);

  const exportCsv = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.exportSettlement(scope, { format, status });
      setExported({ ...result, downloaded: triggerDownload(result.fileName, result.content) });
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const settle = async () => {
    setBusy(true);
    setError(undefined);
    setNotApproved([]);
    try {
      const settled = await api.settleClaims(scope, [...selected], exported?.fileName);
      setFeedback(text(`Marked ${settled.length} claims as settled.`, `${settled.length} 件を精算済みにしました。`));
      await onClaimsChanged();
    } catch (cause: unknown) {
      setError(messageOf(cause));
      if (cause instanceof ApiError) {
        const raw = cause.details?.['claims'];
        setNotApproved(Array.isArray(raw) ? raw.filter((entry): entry is { id: string; status: string } => typeof entry === 'object' && entry !== null && isString((entry as { id?: unknown }).id) && isString((entry as { status?: unknown }).status)) : []);
      }
    } finally {
      setBusy(false);
      setConfirmSettle(false);
    }
  };

  const draftJournal = async (claimId: string) => {
    setBusy(true);
    setJournal(undefined);
    try {
      const result = await api.createJournalDrafts(scope, claimId);
      setJournal({ claimId, result });
      await onClaimsChanged();
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.code === 'EXPENSE_JOURNAL_LINK') {
        setJournal({ claimId, problems: detailArray(cause.details, 'problems', isJournalLinkProblem), createdEntryIds: detailArray(cause.details, 'createdEntryIds', isString), error: messageOf(cause) });
        await onClaimsChanged();
      } else {
        setJournal({ claimId, error: messageOf(cause) });
      }
    } finally {
      setBusy(false);
    }
  };

  const openProblem = (problem: ExpenseJournalLinkProblemDto, claimId: string) => {
    const destination = journalProblemTarget(problem, claimId);
    if (destination.screen === 'Journal') openInScreen('Journal', destination.target);
    else onOpen(destination.target);
  };
  const openJournal = (entryIds: readonly string[]) => openInScreen('Journal', { internalId: entryIds[0] ?? '', section: 'entry' });
  const selectedClaims = approved.filter((claim) => selected.has(claim.id));

  return <div className="expense-settle">
    <section className="workspace-card" aria-labelledby="expense-settle-heading">
      <h2 id="expense-settle-heading">{text('Approved claims', '承認済みの申請')}</h2>
      {approved.length === 0
        ? <EmptyStep message={text('There are no approved claims.', '承認済みの申請はありません。')} actionLabel={text('Open Approve', '承認を開く')} onAction={() => onTab('approve')} />
        : <>
          <div className="table-wrap"><table>
            <thead><tr><th /><th>{text('Claimant', '申請者')}</th><th>{text('Period', '期間')}</th><th>{text('Items', '明細')}</th><th>{text('Amount', '金額')}</th><th>{text('Journal drafts', '仕訳下書き')}</th><th /></tr></thead>
            <tbody>{approved.map((claim) => <tr key={claim.id}>
              <td><input type="checkbox" aria-label={text(`Select ${claim.claimant.name}`, `${claim.claimant.name} を選ぶ`)} checked={selected.has(claim.id)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(claim.id); else next.delete(claim.id); setSelected(next); }} /></td>
              <td>{claim.claimant.name}</td><td>{claim.period.from}〜{claim.period.to}</td><td>{claim.itemCount}</td><td>{formatYen(claim.totalAmount)}</td>
              <td>{claim.journalLinked === 'complete' ? text('Created', '作成済み') : claim.journalLinked === 'partial' ? text('Partly created', '一部作成済み') : text('Not yet', '未作成')}</td>
              <td>{claim.journalLinked !== 'complete' && <button type="button" className="secondary" disabled={busy} onClick={() => void draftJournal(claim.id)}>{claim.journalLinked === 'partial' ? text('Continue creating', '続きを作成') : text('Create journal drafts', '仕訳下書きを作成')}</button>}</td>
            </tr>)}</tbody>
            <tfoot><tr><td /><td colSpan={3}>{text(`${selectedClaims.length} selected`, `${selectedClaims.length} 件を選択`)}</td><td className="expense-total">{formatYen(sumAmounts(selectedClaims))}</td><td colSpan={2} /></tr></tfoot>
          </table></div>
          <div className="expense-actions">
            <button type="button" className="primary" disabled={busy || selectedClaims.length === 0} onClick={() => setConfirmSettle(true)}>{text('Mark as settled', '精算済みにする')}</button>
          </div>
        </>}
      {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
      {notApproved.length > 0 && <div className="notice-card" role="alert">
        <strong>{text('Some claims are not approved', '承認済みでない申請が含まれています')}</strong>
        <ul>{notApproved.map((entry) => <li key={entry.id}>{entry.id}: {claimStatusLabel(entry.status, text)}</li>)}</ul>
        <p>{text('Next step: remove them from the selection, or approve them first.', '次の一手: 選択から外すか、先に承認してください。')}</p>
      </div>}

      {journal !== undefined && <div className="expense-journal-outcome">
        {journal.result !== undefined && <>
          <InlineFeedback kind="success">{text(`Created ${journal.result.entryIds.length} journal drafts.`, `${journal.result.entryIds.length} 件の仕訳下書きを作成しました。`)}</InlineFeedback>
          {journal.result.warnings.map((warning) => <p key={warning} className="notice-card">{warning}</p>)}
          <button type="button" className="secondary" onClick={() => openJournal(journal.result?.entryIds ?? [])}>{text('Confirm them in the journal screen', '仕訳画面で確定する')}</button>
        </>}
        {journal.problems !== undefined && <div role="alert" aria-label={text('Journal draft problems', '仕訳下書きの問題')}>
          <p className="api-error">{journal.error}</p>
          {journal.problems.map((problem, index) => <ReasonCard key={`${problem.code}-${index}`} severity="return"
            title={problem.itemId === undefined ? text('Claim', '申請全体') : text(`Item ${problem.itemId}`, `明細 ${problem.itemId}`)}
            cause={problem.message}
            fix={problem.fixTarget === 'journal-chart'
              ? text('Enable or add the account in the journal chart of accounts, or pick another account for the category in the policy.', '仕訳の科目マスタで科目を有効にするか追加する、または規程の費目で別の科目を選んでください。')
              : problem.fixTarget === 'item'
                ? text('Fix the date or amount of the item. Approved claims must have their approval cancelled before editing.', '明細の取引日・金額を直してください。承認済みの申請は承認を取り消してから編集します。')
                : text('Set the account and tax categories for the category in the policy, then create the drafts again.', '規程の費目で科目と税区分を設定してから、もう一度作成してください。')}
            actions={[{ label: journalProblemLabel(problem, text), onClick: () => openProblem(problem, journal.claimId) }]} />)}
          {(journal.createdEntryIds?.length ?? 0) > 0 && <div className="notice-card" role="note">
            <p>{text(`${journal.createdEntryIds?.length ?? 0} drafts were already created. After fixing the problems, continue from where it stopped.`, `${journal.createdEntryIds?.length ?? 0} 件は仕訳下書きを作成済みです。問題を直したら、止まったところから続きを作成してください。`)}</p>
            <div className="run-failure-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => void draftJournal(journal.claimId)}>{text('Continue creating', '続きを作成')}</button>
              <button type="button" className="secondary" onClick={() => openJournal(journal.createdEntryIds ?? [])}>{text('Confirm them in the journal screen', '仕訳画面で確定する')}</button>
            </div>
          </div>}
        </div>}
        {journal.problems === undefined && journal.error !== undefined && <p className="api-error" role="alert">{journal.error}</p>}
      </div>}
    </section>

    {/* 振込データ（全銀協）は B の部品。精算 CSV（MVP）と並べて置き、CSV の挙動は変えない。 */}
    <SettlePayoutPanel transport={slot.transport} scope={slot.scope} onOpen={onOpen} claims={claims} onClaimsChanged={onClaimsChanged} />

    <section className="workspace-card" aria-labelledby="expense-export-heading">
      <h2 id="expense-export-heading">{text('Settlement CSV', '精算 CSV')}</h2>
      <p className="empty-state">{text('Making the CSV does not change any claim. Mark claims as settled after you have paid them.', 'CSV を作っても申請の状態は変わりません。支払いが済んだら「精算済みにする」を押してください。')}</p>
      <div className="expense-form">
        <label>{text('Format', '形式')}
          <select value={format} onChange={(event) => setFormat(event.target.value as ExpenseSettlementFormatDto)}>
            <option value="payout">{text('Payout (total per claim)', '振込用（申請ごとの合計）')}</option>
            <option value="detail">{text('Detail (one row per item, for audit)', '明細（明細ごと・監査用）')}</option>
          </select>
        </label>
        <label>{text('Claims', '対象')}
          <select value={status} onChange={(event) => setStatus(event.target.value as 'approved' | 'settled')}>
            <option value="approved">{text('Approved', '承認済み')}</option>
            <option value="settled">{text('Settled', '精算済み')}</option>
          </select>
        </label>
      </div>
      <button type="button" className="primary" disabled={busy} onClick={() => void exportCsv()}>{text('Download CSV', 'CSV をダウンロード')}</button>
      {error !== undefined && <p className="api-error" role="alert">{error}</p>}
      {exported !== undefined && <>
        <InlineFeedback kind="info">{text(`${exported.fileName}: ${exported.claimCount} claims, ${exported.itemCount} items, ${formatYen(exported.totalAmount)}`, `${exported.fileName}: 申請 ${exported.claimCount} 件・明細 ${exported.itemCount} 件・${formatYen(exported.totalAmount)}`)}</InlineFeedback>
        {exported.warnings.length > 0 && <div className="notice-card" role="note">
          <strong>{text('Warnings', '警告')}</strong>
          <ul>{exported.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>}
        {!exported.downloaded && <label>{text('The download did not start. Copy the CSV below.', 'ダウンロードを開始できませんでした。下の CSV をコピーしてください。')}
          <textarea className="expense-textarea" readOnly aria-label={text('Settlement CSV content', '精算 CSV の内容')} value={exported.content} />
        </label>}
      </>}
    </section>

    <ConfirmDialog open={confirmSettle} busy={busy}
      title={text('Mark these claims as settled?', 'この申請を精算済みにしますか？')}
      message={<>
        <p>{text('Only do this after the reimbursement has been paid.', '立替分の支払いが済んでから押してください。')}</p>
        <ul>{selectedClaims.map((claim) => <li key={claim.id}><StatusChip status={claim.status} /> {claim.claimant.name} · {claim.period.from}〜{claim.period.to} · {formatYen(claim.totalAmount)}</li>)}</ul>
        <p className="expense-total">{text(`Total ${formatYen(sumAmounts(selectedClaims))}`, `合計 ${formatYen(sumAmounts(selectedClaims))}`)}</p>
      </>}
      confirmLabel={text('Mark as settled', '精算済みにする')} cancelLabel={text('Cancel', 'キャンセル')}
      onConfirm={() => void settle()} onCancel={() => setConfirmSettle(false)} />
  </div>;
}
