import { useCallback, useEffect, useState } from 'react';
import type { ExpenseApi } from '../api/expense-api';
import type { CheckExpenseClaimsResultDto, ExpenseClaimDto, ExpenseClaimSummaryDto, ExpensePolicyDto } from '../api/expense-types';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { formatYen } from '../journal/journal-model';
import type { OpenTarget } from '../navigation';
import { scope } from '../scope';
import { itemLabel, type ExpenseTab } from './expense-model';
import { CheckReasonCard, EmptyStep, ReceiptViewer, SearchKeys, StatusChip, VerdictChip, messageOf, type ExpenseFocusRequest } from './expense-shared';

/**
 * チェックタブ（docs/21 §3, §11）。未チェックをまとめてチェックし、申請ごとに判定チップ、明細ごとに理由カード（原因 → 次の一手 → 導線）、
 * 電帳法の検索要件 3 点、領収書ビューアを出す。判定は保存された結果を見るだけで、LLM は関与しない。
 */
export function CheckTab({ api, policy, claims, onClaimsChanged, selectedClaimId, onSelectClaim, focus, onOpen, onTab }: {
  readonly api: ExpenseApi;
  readonly policy: ExpensePolicyDto | undefined;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly onClaimsChanged: () => Promise<void> | void;
  readonly selectedClaimId: string | undefined;
  readonly onSelectClaim: (id: string | undefined) => void;
  readonly focus: ExpenseFocusRequest | undefined;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab: (tab: ExpenseTab) => void;
}) {
  const { text } = useI18n();
  const [claim, setClaim] = useState<ExpenseClaimDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<CheckExpenseClaimsResultDto>();
  const [receiptItemId, setReceiptItemId] = useState<string>();

  const loadClaim = useCallback(async (id: string | undefined) => {
    if (id === undefined) { setClaim(undefined); return; }
    try { setClaim(await api.getClaim(scope, id)); }
    catch (cause: unknown) { setClaim(undefined); setError(messageOf(cause)); }
  }, [api]);

  useEffect(() => { setReceiptItemId(undefined); void loadClaim(selectedClaimId); }, [loadClaim, selectedClaimId]);
  useEffect(() => { if (focus?.section === 'receipt' && focus.itemId !== undefined) setReceiptItemId(focus.itemId); }, [focus?.seq, focus?.section, focus?.itemId]);

  const run = async (claimIds?: readonly string[]) => {
    setBusy(true);
    setError(undefined);
    try {
      setSummary(await api.checkClaims(scope, claimIds));
      await onClaimsChanged();
      await loadClaim(selectedClaimId);
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  if (claims.length === 0) {
    return <section className="workspace-card"><EmptyStep message={text('There are no claims to check.', 'チェックする申請がありません。')} actionLabel={text('Open Ingest', '申請取込を開く')} onAction={() => onTab('ingest')} /></section>;
  }

  const categoryName = (id: string | undefined) => policy?.categories.find((category) => category.id === id)?.name ?? id;
  const frozen = claim !== undefined && (claim.status === 'approved' || claim.status === 'settled');

  return <div className="expense-layout">
    <section className="workspace-card" aria-labelledby="expense-check-list-heading">
      <div className="expense-row-between">
        <h2 id="expense-check-list-heading">{text('Claims', '申請')}</h2>
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? text('Checking…', 'チェック中…') : text('Check unchecked claims', '未チェックをチェック')}</button>
      </div>
      {summary !== undefined && <InlineFeedback kind="info">{text(
        `Checked ${summary.checked}: ${summary.pass} pass, ${summary.needsReview} need review, ${summary.returned} return (${summary.skipped} skipped).`,
        `${summary.checked} 件をチェック: 通過 ${summary.pass} / 要確認 ${summary.needsReview} / 差し戻し ${summary.returned}（対象外 ${summary.skipped}）`,
      )}</InlineFeedback>}
      <ul className="expense-claim-list">{claims.map((entry) => <li key={entry.id}>
        <button type="button" className="expense-claim-row" aria-current={entry.id === selectedClaimId} onClick={() => onSelectClaim(entry.id)}>
          <strong>{entry.claimant.name}</strong>
          <span className="expense-claim-meta">{entry.period.from}〜{entry.period.to} · {formatYen(entry.totalAmount)}</span>
          <span className="expense-claim-meta"><StatusChip status={entry.status} /><VerdictChip verdict={entry.verdict} stale={entry.stale} /></span>
          {entry.stale && <span className="expense-claim-meta">{text('The policy or items changed. Check again.', '規程か明細が変わりました。再チェックが必要です')}</span>}
        </button>
      </li>)}</ul>
    </section>

    <div>
      {error !== undefined && <p className="api-error" role="alert">{error}</p>}
      {claim === undefined
        ? <p className="empty-state">{text('Choose a claim to see its reasons.', '申請を選ぶと理由を表示します。')}</p>
        : <section className="workspace-card" aria-labelledby="expense-check-detail-heading">
          <div className="expense-row-between">
            <h2 id="expense-check-detail-heading">{claim.claimant.name} · {claim.period.from}〜{claim.period.to}</h2>
            <span className="expense-claim-meta"><StatusChip status={claim.status} /><VerdictChip verdict={claim.judgment?.verdict} stale={claim.stale} /></span>
          </div>
          <p className="expense-claim-meta">{claim.id} · <span className="expense-total">{formatYen(claim.totalAmount)}</span>{claim.judgment !== undefined ? ` · ${text('checked at', 'チェック日時')} ${claim.judgment.checkedAt}` : ''}</p>
          <div className="expense-actions">
            <button type="button" className="secondary" disabled={busy || frozen} onClick={() => void run([claim.id])}>{text('Check this claim', 'この申請をチェック')}</button>
            <button type="button" className="secondary" onClick={() => onTab('approve')}>{text('Go to Approve', '承認へ進む')}</button>
          </div>
          {frozen && <p className="empty-state">{text('Approved and settled claims are not checked again.', '承認済み・精算済みの申請は再チェックしません。')}</p>}
          {claim.judgment === undefined && <div className="notice-card" role="note">
            <strong>{text('Not checked yet', 'まだチェックしていません')}</strong>
            <p>{text('Press "Check this claim" to see whether it passes the policy.', '「この申請をチェック」を押すと、規程に照らした判定が出ます。')}</p>
          </div>}
          {claim.stale && claim.judgment !== undefined && <div className="notice-card" role="note">
            <strong>{text('The policy or items changed. Check again.', '規程か明細が変わりました。再チェックが必要です')}</strong>
            <p>{text('The reasons below are from the previous check and may be out of date. It cannot be approved until it is checked again.', '下の理由は前回のチェックのもので、古い可能性があります。再チェックするまで承認できません。')}</p>
          </div>}
          <p className="empty-state">{text('The e-bookkeeping marks only confirm the search keys (date, amount, payee). Authenticity requirements and retention are not managed here.', '電帳法の表示は検索要件（日付・金額・取引先）が揃っているかの確認だけです。真実性の要件や保存期間の管理はしていません。')}</p>

          {claim.judgment?.claimReasons.map((reason, index) => <CheckReasonCard key={`${reason.code}-${index}`} reason={reason} claim={claim} onOpen={onOpen} />)}

          {claim.items.map((item, index) => {
            const itemCheck = claim.judgment?.items.find((entry) => entry.itemId === item.id);
            const label = itemLabel(item, index, text);
            return <article key={item.id} className="expense-item-card" aria-label={label}>
              <div className="expense-row-between">
                <h4>{index + 1}. {label}</h4>
                {itemCheck !== undefined && <VerdictChip verdict={itemCheck.verdict} stale={claim.stale} />}
              </div>
              <p className="expense-claim-meta">
                {item.facts.transactionDate ?? '—'} · {item.facts.payeeName ?? '—'} · {formatYen(item.facts.amount)} · {categoryName(item.categoryId) ?? item.categoryText ?? text('no category', '費目なし')}
              </p>
              <p className="expense-claim-meta"><SearchKeys facts={item.facts} />
                {item.hasReceipt && <button type="button" className="secondary" onClick={() => setReceiptItemId(item.id)}>{text('View the receipt', '領収書を見る')}</button>}
              </p>
              {itemCheck?.reasons.map((reason, reasonIndex) => <CheckReasonCard key={`${reason.code}-${reasonIndex}`} reason={reason} claim={claim} onOpen={onOpen} />)}
              {itemCheck !== undefined && itemCheck.reasons.length === 0 && <p className="empty-state">{text('No findings for this item.', 'この明細に指摘はありません。')}</p>}
              {receiptItemId === item.id && <ReceiptViewer api={api} claimId={claim.id} itemId={item.id} onClose={() => setReceiptItemId(undefined)} />}
            </article>;
          })}
        </section>}
    </div>
  </div>;
}
