import { useCallback, useEffect, useRef, useState } from 'react';
import { scopeQuery, type ApiTransport } from '../../api/business-api';
import type { ExpenseMoneyApi } from '../../api/expense-money-api';
import type {
  ExpenseCardDto, ExpenseCardImportDto, ExpenseCardMatchResultDto, ExpenseCardSettingsResultDto, ExpenseCardTransactionDto, ExpenseCardTransactionStatusDto,
} from '../../api/expense-money-types';
import type { ExpenseClaimDto, ExpenseClaimSummaryDto } from '../../api/expense-types';
import type { TenantScopeDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { formatYen } from '../../journal/journal-model';
import type { OpenTarget } from '../../navigation';
import { claimStatusLabel } from '../expense-model';
import { FieldError } from '../expense-shared';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import { CardStatementImport, cardColumnLabel } from './CardStatementImport';
import { MoneyErrorNotice, NoteForm, cardTransactionStatusLabel, readMoneyError, useMoneyApi, type MoneyErrorInfo } from './money-shared';

const TRANSACTION_STATUSES: readonly ExpenseCardTransactionStatusDto[] = ['unmatched', 'matched', 'excluded'];

/** 立替の明細と一致した利用（二重払いの疑い）を先頭へ。それ以外はサーバーの順を保つ。 */
export function sortTransactions(transactions: readonly ExpenseCardTransactionDto[]): readonly ExpenseCardTransactionDto[] {
  const rank = (transaction: ExpenseCardTransactionDto) => (transaction.match?.kind === 'reimbursement-item' ? 0 : 1);
  return [...transactions].sort((left, right) => rank(left) - rank(right));
}

/**
 * 台帳「カード明細」（docs/21 §20.10.1）。カードの設定・明細の取込・取込の一覧と削除・照合の実行・利用の一覧（手動の紐付け・対象外）。
 * カードが無い・明細が無いのは失敗ではないので赤くしない。取込の削除は、対象外の印と手動の紐付けも消えることを確認してから行う。
 */
export function CardsLedger({ transport, scope, onOpen, claims, onClaimsChanged, focus }: ExpenseLedgerSlotProps) {
  const { text } = useI18n();
  const api = useMoneyApi(transport);
  const [settings, setSettings] = useState<ExpenseCardSettingsResultDto>();
  const [settingsError, setSettingsError] = useState<MoneyErrorInfo>();
  const [imports, setImports] = useState<readonly ExpenseCardImportDto[]>();
  const [importsError, setImportsError] = useState<MoneyErrorInfo>();
  const [highlightImport, setHighlightImport] = useState<string>();
  const [deleting, setDeleting] = useState<ExpenseCardImportDto>();
  const [statusFilter, setStatusFilter] = useState<ExpenseCardTransactionStatusDto | ''>('');
  const [transactions, setTransactions] = useState<readonly ExpenseCardTransactionDto[]>();
  const [transactionsError, setTransactionsError] = useState<MoneyErrorInfo>();
  const [focusedId, setFocusedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<MoneyErrorInfo>();
  const [feedback, setFeedback] = useState<string>();
  const transactionsRef = useRef<HTMLElement>(null);
  const importsRef = useRef<HTMLElement>(null);

  const reloadSettings = useCallback(async () => {
    try { setSettings(await api.getCardSettings(scope)); setSettingsError(undefined); } catch (cause: unknown) { setSettingsError(readMoneyError(cause)); }
  }, [api, scope]);
  const reloadImports = useCallback(async () => {
    try { setImports(await api.listCardImports(scope)); setImportsError(undefined); } catch (cause: unknown) { setImportsError(readMoneyError(cause)); }
  }, [api, scope]);
  const reloadTransactions = useCallback(async () => {
    try {
      setTransactions(await api.listCardTransactions(scope, statusFilter === '' ? {} : { status: statusFilter }));
      setTransactionsError(undefined);
    } catch (cause: unknown) {
      setTransactionsError(readMoneyError(cause));
    }
  }, [api, scope, statusFilter]);

  useEffect(() => { void reloadSettings(); void reloadImports(); }, [reloadSettings, reloadImports]);
  useEffect(() => { void reloadTransactions(); }, [reloadTransactions]);

  // 導線 `card`（利用 id）は絞り込みを外してその行を強調、`cards` は未照合の一覧を開く。
  useEffect(() => {
    if (focus === undefined) return;
    if (focus.section === 'cards') {
      setStatusFilter('unmatched');
      setFocusedId(undefined);
      transactionsRef.current?.scrollIntoView?.({ block: 'start' });
    } else if (focus.section === 'card') {
      setStatusFilter('');
      setFocusedId(focus.id === '' ? undefined : focus.id);
      transactionsRef.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [focus]);

  const act = async (action: () => Promise<unknown>, success: string, claimsChange = true) => {
    setBusy(true);
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await action();
      setFeedback(success);
      await reloadTransactions();
      if (claimsChange) await onClaimsChanged();
      return true;
    } catch (cause: unknown) {
      setActionError(readMoneyError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deleteImport = async (target: ExpenseCardImportDto) => {
    setDeleting(undefined);
    const ok = await act(() => api.deleteCardImport(scope, target.id), text(`Deleted the import ${target.fileName}.`, `取込 ${target.fileName} を削除しました。`));
    if (ok) await reloadImports();
  };

  const showImport = (importId: string) => {
    setHighlightImport(importId);
    importsRef.current?.scrollIntoView?.({ block: 'start' });
  };

  const list = sortTransactions(transactions ?? []);
  const noImports = imports !== undefined && imports.length === 0;

  return <div className="expense-money">
    <CardSettingsPanel api={api} scope={scope} result={settings} error={settingsError} onOpen={onOpen} onSaved={(next) => setSettings(next)} />

    <CardStatementImport api={api} scope={scope} settings={settings?.settings} onOpen={onOpen} onShowImport={showImport}
      onImported={async () => { await Promise.all([reloadImports(), reloadTransactions(), reloadSettings()]); }} />

    <section className="workspace-card" aria-labelledby="expense-money-card-imports-heading" ref={importsRef}>
      <h2 id="expense-money-card-imports-heading">{text('Imported statements', '取込の履歴')}</h2>
      <MoneyErrorNotice error={importsError} onOpen={onOpen} />
      {noImports && <p className="empty-state">{text('Import a card statement CSV from the card company.', 'カード会社の明細 CSV を取り込みます')}</p>}
      {imports !== undefined && imports.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>{text('File', 'ファイル')}</th><th>{text('Period', '期間')}</th><th>{text('Imported', '取込')}</th><th>{text('Duplicates', '重複')}</th><th>{text('Skipped', '取り込めない行')}</th><th>{text('Imported at', '取込日時')}</th><th /></tr></thead>
        <tbody>{imports.map((entry) => <tr key={entry.id} className={entry.id === highlightImport ? 'expense-focused' : undefined}>
          <td>{entry.fileName}<br /><small>{entry.id}</small></td><td>{entry.periodFrom}〜{entry.periodTo}</td>
          <td className="expense-money-amount">{entry.importedCount}</td><td className="expense-money-amount">{entry.duplicateCount}</td><td className="expense-money-amount">{entry.skippedRows.length}</td>
          <td>{entry.createdAt.slice(0, 16).replace('T', ' ')}</td>
          <td><button type="button" className="secondary danger" disabled={busy} aria-label={text(`Delete the import ${entry.fileName}`, `取込 ${entry.fileName} を削除`)} onClick={() => setDeleting(entry)}>{text('Delete', '削除')}</button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <MatchPanel api={api} scope={scope} onOpen={onOpen} onMatched={async () => { await reloadTransactions(); await onClaimsChanged(); }} />

    <section className="workspace-card" aria-labelledby="expense-money-card-transactions-heading" ref={transactionsRef}>
      <h2 id="expense-money-card-transactions-heading">{text('Card transactions', 'カードの利用')}</h2>
      <div className="expense-money-toolbar">
        <label>{text('Status', '状態')}
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ExpenseCardTransactionStatusDto | '')}>
            <option value="">{text('All', 'すべて')}</option>
            {TRANSACTION_STATUSES.map((status) => <option key={status} value={status}>{cardTransactionStatusLabel(status, text)}</option>)}
          </select>
        </label>
      </div>
      <MoneyErrorNotice error={transactionsError} onOpen={onOpen} />
      {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
      <MoneyErrorNotice error={actionError} onOpen={onOpen} />
      {transactions !== undefined && list.length === 0 && (statusFilter === ''
        ? <p className="empty-state">{noImports ? text('Import a card statement CSV from the card company.', 'カード会社の明細 CSV を取り込みます') : text('There are no card transactions.', 'カードの利用はありません')}</p>
        : <div className="expense-empty">
          <p className="empty-state">{text('There are no card transactions in this status.', 'この状態のカードの利用はありません')}</p>
          <button type="button" className="secondary" onClick={() => setStatusFilter('')}>{text('Show all statuses', 'すべての状態を表示')}</button>
        </div>)}
      {list.length > 0 && <div className="table-wrap"><table aria-label={text('Card transactions', 'カードの利用')}>
        <thead><tr><th>{cardColumnLabel('usedOn', text)}</th><th>{text('Card', 'カード')}</th><th>{cardColumnLabel('merchant', text)}</th><th>{cardColumnLabel('amount', text)}</th><th>{text('Status', '状態')}</th><th>{text('Match', '照合')}</th><th /></tr></thead>
        <tbody>{list.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} focused={transaction.id === focusedId} busy={busy}
          transport={transport} scope={scope} claims={claims} onOpen={onOpen}
          onExclude={(reason) => act(() => api.excludeCardTransaction(scope, transaction.id, reason), text('Marked the transaction as excluded.', '対象外にしました。'), false)}
          onInclude={() => act(() => api.includeCardTransaction(scope, transaction.id), text('Removed the exclusion.', '対象外を取り消しました。'), false)}
          onLink={(target) => act(() => api.linkCardTransaction(scope, transaction.id, target), text('Linked the transaction to the item.', '明細に紐付けました。'))}
          onUnlink={() => act(() => api.unlinkCardTransaction(scope, transaction.id), text('Removed the link.', '紐付けを解除しました。'))} />)}</tbody>
      </table></div>}
    </section>

    <ConfirmDialog open={deleting !== undefined} danger busy={busy}
      title={text('Delete this import?', 'この取込を削除しますか？')}
      message={<>
        <p>{deleting?.fileName} · {deleting?.periodFrom}〜{deleting?.periodTo}</p>
        <p>{text('Its card transactions are deleted. Exclusion marks and manual links on them are also removed.', '取り込んだ利用を削除します。対象外の印・手動の紐付けも消えます。')}</p>
      </>}
      confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')}
      onConfirm={() => { if (deleting !== undefined) void deleteImport(deleting); }} onCancel={() => setDeleting(undefined)} />
  </div>;
}

/* ---------------------------------------------------------------------------
 * カードの設定
 * ------------------------------------------------------------------------- */

interface CardDraft { readonly id?: string; readonly label: string; readonly issuerName: string; readonly last4: string; readonly holderEmployeeId: string; readonly enabled: boolean }

function CardSettingsPanel({ api, scope, result, error, onOpen, onSaved }: {
  readonly api: ExpenseMoneyApi;
  readonly scope: TenantScopeDto;
  readonly result: ExpenseCardSettingsResultDto | undefined;
  readonly error: MoneyErrorInfo | undefined;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onSaved: (next: ExpenseCardSettingsResultDto) => void;
}) {
  const { text } = useI18n();
  const [draft, setDraft] = useState<CardDraft>();
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<MoneyErrorInfo>();
  const [feedback, setFeedback] = useState<string>();
  const cards = result?.settings.cards ?? [];
  const profiles = result?.settings.profiles ?? [];

  const save = async (nextCards: readonly ExpenseCardDto[], nextProfiles = profiles, message: string) => {
    setBusy(true);
    setSaveError(undefined);
    setFeedback(undefined);
    try {
      const settings = await api.saveCardSettings(scope, { cards: nextCards, profiles: nextProfiles });
      onSaved({ settings, saved: true });
      setDraft(undefined);
      setFeedback(message);
    } catch (cause: unknown) {
      setSaveError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (draft === undefined) return;
    const next: Record<string, string> = {};
    if (draft.label.trim() === '') next['label'] = text('Enter a label for the card.', 'カードの名前を入力してください。');
    if (!/^\d{4}$/u.test(draft.last4)) next['last4'] = text('Enter the last 4 digits of the card number.', 'カード番号の下 4 桁を数字で入力してください。');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const card: ExpenseCardDto = {
      id: draft.id ?? `card-${Date.now().toString(36)}`, label: draft.label.trim(), last4: draft.last4, enabled: draft.enabled,
      ...(draft.issuerName.trim() === '' ? {} : { issuerName: draft.issuerName.trim() }),
      ...(draft.holderEmployeeId.trim() === '' ? {} : { holderEmployeeId: draft.holderEmployeeId.trim() }),
    };
    const nextCards = draft.id === undefined ? [...cards, card] : cards.map((entry) => (entry.id === draft.id ? card : entry));
    void save(nextCards, profiles, text(`Saved the card ${card.label}.`, `カード ${card.label} を保存しました。`));
  };

  const startNew = () => { setErrors({}); setDraft({ label: '', issuerName: '', last4: '', holderEmployeeId: '', enabled: true }); };

  return <section className="workspace-card" aria-labelledby="expense-money-cards-heading">
    <div className="expense-row-between">
      <h2 id="expense-money-cards-heading">{text('Corporate cards', 'カード')}</h2>
      {cards.length > 0 && <button type="button" className="secondary" onClick={startNew}>{text('Add a card', 'カードを追加')}</button>}
    </div>
    <MoneyErrorNotice error={error} onOpen={onOpen} />
    {result !== undefined && cards.length === 0 && draft === undefined && <div className="expense-empty">
      <p className="empty-state">{text('No cards are registered.', 'カードが登録されていません')}</p>
      <button type="button" className="secondary" onClick={startNew}>{text('Add a card', 'カードを追加')}</button>
    </div>}
    {cards.length > 0 && <div className="table-wrap"><table>
      <thead><tr><th>{text('Label', '名前')}</th><th>{text('Issuer', '発行会社')}</th><th>{text('Last 4', '下 4 桁')}</th><th>{text('Holder', '保有者')}</th><th>{text('Enabled', '有効')}</th><th /></tr></thead>
      <tbody>{cards.map((card) => <tr key={card.id}>
        <td>{card.label}</td><td>{card.issuerName ?? '—'}</td><td>••{card.last4}</td><td>{card.holderEmployeeId ?? '—'}</td>
        <td>{card.enabled ? text('Yes', 'はい') : text('No', 'いいえ')}</td>
        <td><button type="button" className="secondary" aria-label={text(`Edit the card ${card.label}`, `カード ${card.label} を編集`)} onClick={() => { setErrors({}); setDraft({ id: card.id, label: card.label, issuerName: card.issuerName ?? '', last4: card.last4, holderEmployeeId: card.holderEmployeeId ?? '', enabled: card.enabled }); }}>{text('Edit', '編集')}</button></td>
      </tr>)}</tbody>
    </table></div>}
    {draft !== undefined && <form className="expense-money-inline-form" aria-label={draft.id === undefined ? text('Add a card', 'カードを追加') : text('Edit the card', 'カードを編集')} onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="expense-form">
        <label className="expense-required">{text('Label', '名前')}<input aria-label={text('Label', '名前')} value={draft.label} maxLength={100} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /><FieldError message={errors['label']} /></label>
        <label>{text('Issuer', '発行会社')}<input value={draft.issuerName} maxLength={100} onChange={(event) => setDraft({ ...draft, issuerName: event.target.value })} /></label>
        <label className="expense-required">{text('Last 4 digits', '下 4 桁')}<input aria-label={text('Last 4 digits', '下 4 桁')} inputMode="numeric" maxLength={4} value={draft.last4} onChange={(event) => setDraft({ ...draft, last4: event.target.value.trim() })} /><FieldError message={errors['last4']} /></label>
        <label>{text('Holder employee ID', '保有者の従業員 ID')}<input value={draft.holderEmployeeId} maxLength={64} onChange={(event) => setDraft({ ...draft, holderEmployeeId: event.target.value })} /></label>
        <label><span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> {text('Enabled', '有効')}</span></label>
      </div>
      <div className="expense-actions">
        <button type="submit" className="primary" disabled={busy}>{text('Save the card', 'カードを保存')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(undefined)}>{text('Cancel', 'キャンセル')}</button>
      </div>
    </form>}
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    <MoneyErrorNotice error={saveError} onOpen={onOpen} />

    {profiles.length > 0 && <>
      <h3>{text('Saved column mappings', '保存済みの列の対応')}</h3>
      <ul className="expense-money-reasons">{profiles.map((profile) => <li key={profile.id}>
        <span><strong>{profile.name}</strong> · {cardColumnLabel('usedOn', text)}: {profile.columns.usedOn} · {cardColumnLabel('merchant', text)}: {profile.columns.merchant} · {cardColumnLabel('amount', text)}: {profile.columns.amount}
          {' · '}{profile.amountSign === 'charge-positive' ? text('charges positive', '利用が正') : text('charges negative', '利用が負')}{profile.skipLinesBefore > 0 ? text(` · skip ${profile.skipLinesBefore} lines`, ` · 前置き ${profile.skipLinesBefore} 行`) : ''}</span>
        <span className="run-failure-actions"><button type="button" className="secondary" disabled={busy} aria-label={text(`Remove the mapping ${profile.name}`, `対応 ${profile.name} を削除`)}
          onClick={() => void save(cards, profiles.filter((entry) => entry.id !== profile.id), text(`Removed the mapping ${profile.name}.`, `対応 ${profile.name} を削除しました。`))}>{text('Remove', '削除')}</button></span>
      </li>)}</ul>
    </>}
  </section>;
}

/* ---------------------------------------------------------------------------
 * 照合
 * ------------------------------------------------------------------------- */

function MatchPanel({ api, scope, onOpen, onMatched }: {
  readonly api: ExpenseMoneyApi;
  readonly scope: TenantScopeDto;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onMatched: () => Promise<void>;
}) {
  const { text } = useI18n();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoneyErrorInfo>();
  const [result, setResult] = useState<ExpenseCardMatchResultDto>();
  const rangeInvalid = from !== '' && to !== '' && from > to;

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await api.matchCardTransactions(scope, { ...(from === '' ? {} : { from }), ...(to === '' ? {} : { to }) }));
      await onMatched();
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  return <section className="workspace-card" aria-labelledby="expense-money-card-match-heading">
    <h2 id="expense-money-card-match-heading">{text('Match with claims', '申請との照合')}</h2>
    <p className="empty-state">{text('Matches card transactions with company-paid and reimbursement items. Manual links and exclusions are kept.', 'カードの利用を会社払い・立替の明細と突き合わせます。手動の紐付けと対象外はそのまま残します。')}</p>
    <div className="expense-money-toolbar">
      <label>{text('From (optional)', '開始日（任意）')}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>{text('To (optional)', '終了日（任意）')}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="button" className="primary" disabled={busy || rangeInvalid} onClick={() => void run()}>{text('Run matching', '照合を実行')}</button>
    </div>
    <FieldError message={rangeInvalid ? text('The start date must not be after the end date.', '開始日は終了日より後にできません。') : undefined} />
    {result !== undefined && <InlineFeedback kind="info">{text(
      `Matched ${result.matched} (possible double payments: ${result.reimbursementMatches}), unmatched ${result.unmatched}, kept ${result.kept}.`,
      `照合 ${result.matched} 件（うち二重払いの疑い ${result.reimbursementMatches} 件）・未照合 ${result.unmatched} 件・そのまま ${result.kept} 件。`,
    )}</InlineFeedback>}
    <MoneyErrorNotice error={error} onOpen={onOpen} />
  </section>;
}

/* ---------------------------------------------------------------------------
 * 利用の行
 * ------------------------------------------------------------------------- */

function TransactionRow({ transaction, focused, busy, transport, scope, claims, onOpen, onExclude, onInclude, onLink, onUnlink }: {
  readonly transaction: ExpenseCardTransactionDto;
  readonly focused: boolean;
  readonly busy: boolean;
  readonly transport: ApiTransport;
  readonly scope: TenantScopeDto;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly onOpen: (target: OpenTarget) => void;
  readonly onExclude: (reason: string) => Promise<boolean>;
  readonly onInclude: () => Promise<boolean>;
  readonly onLink: (target: { readonly claimId: string; readonly itemId: string }) => Promise<boolean>;
  readonly onUnlink: () => Promise<boolean>;
}) {
  const { text } = useI18n();
  const [mode, setMode] = useState<'exclude' | 'link'>();
  const rowRef = useRef<HTMLTableRowElement>(null);
  const match = transaction.match;
  const suspect = match?.kind === 'reimbursement-item';

  useEffect(() => { if (focused) rowRef.current?.scrollIntoView?.({ block: 'center' }); }, [focused]);

  const className = [suspect ? 'expense-money-row-suspect' : '', focused ? 'expense-focused' : ''].filter((entry) => entry !== '').join(' ');
  return <>
    <tr ref={rowRef} className={className === '' ? undefined : className} aria-label={`${transaction.usedOn} ${transaction.merchantRaw}`}>
      <td>{transaction.usedOn}</td>
      <td>{transaction.cardLabel} ••{transaction.cardLast4}{transaction.holder === undefined ? '' : <><br /><small>{transaction.holder}</small></>}</td>
      <td>{transaction.merchantRaw}{transaction.memo === undefined ? '' : <><br /><small>{transaction.memo}</small></>}</td>
      <td className="expense-money-amount">{formatYen(transaction.amount)}</td>
      <td><span className="expense-money-chip">{cardTransactionStatusLabel(transaction.status, text)}</span></td>
      <td>
        {suspect && <><span className="expense-money-chip expense-money-chip-suspect">{text('Possible double payment', '二重払いの疑い')}</span><br />
          <small>{text('This charge matches an item claimed as a reimbursement. Check the claim so it is not paid twice.', '立替として申請された明細と一致しました。二重に支払わないよう申請を確かめてください。')}</small><br /></>}
        {match !== undefined && <small>
          {transaction.claimant ?? match.claimId}{transaction.claimStatus === undefined ? '' : ` · ${claimStatusLabel(transaction.claimStatus, text)}`}
          {' · '}{match.strength === 'strong' ? text('strong match', '強い一致') : text('weak match', '弱い一致')}{match.manual ? text(' · manual', ' · 手動') : ''}
        </small>}
        {transaction.exclusion !== undefined && <small>{text('Reason: ', '理由: ')}{transaction.exclusion.reason}</small>}
      </td>
      <td><div className="run-failure-actions">
        {transaction.status === 'unmatched' && <>
          <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === 'link' ? undefined : 'link')}>{text('Link manually', '手動で紐付け')}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === 'exclude' ? undefined : 'exclude')}>{text('Exclude', '対象外')}</button>
        </>}
        {transaction.status === 'excluded' && <button type="button" className="secondary" disabled={busy} onClick={() => void onInclude()}>{text('Include again', '対象外を取消')}</button>}
        {match !== undefined && <>
          <button type="button" className="secondary" onClick={() => onOpen({ internalId: match.claimId, section: `item:${match.itemId}` })}>{text('Open the claim item', '申請の明細を開く')}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void onUnlink()}>{text('Unlink', '紐付け解除')}</button>
        </>}
      </div></td>
    </tr>
    {mode !== undefined && <tr><td colSpan={7}>
      {mode === 'exclude' && <NoteForm label={text('Reason for excluding', '対象外の理由')} submitLabel={text('Exclude', '対象外にする')} maxLength={200} busy={busy}
        onCancel={() => setMode(undefined)} onSubmit={(reason) => void onExclude(reason).then((ok) => { if (ok) setMode(undefined); })} />}
      {mode === 'link' && <LinkForm transport={transport} scope={scope} claims={claims} busy={busy} onCancel={() => setMode(undefined)}
        onSubmit={(target) => void onLink(target).then((ok) => { if (ok) setMode(undefined); })} />}
    </td></tr>}
  </>;
}

/** 手動の紐付け: 申請を選ぶ → その申請の明細を選ぶ（明細を読めなければ id を入力）。 */
function LinkForm({ transport, scope, claims, busy, onSubmit, onCancel }: {
  readonly transport: ApiTransport;
  readonly scope: TenantScopeDto;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly busy: boolean;
  readonly onSubmit: (target: { readonly claimId: string; readonly itemId: string }) => void;
  readonly onCancel: () => void;
}) {
  const { text } = useI18n();
  const [claimId, setClaimId] = useState('');
  const [itemId, setItemId] = useState('');
  const [items, setItems] = useState<ExpenseClaimDto['items']>();
  const [itemsFailed, setItemsFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setItems(undefined);
    setItemsFailed(false);
    setItemId('');
    if (claimId.trim() === '') return;
    transport.request<{ claim: ExpenseClaimDto }>(`/expense/claims/${encodeURIComponent(claimId.trim())}?${scopeQuery(scope).toString()}`)
      .then((result) => { if (active) { setItems(result.claim.items); setItemId(result.claim.items[0]?.id ?? ''); } })
      .catch(() => { if (active) setItemsFailed(true); });
    return () => { active = false; };
  }, [transport, scope, claimId]);

  return <form className="expense-money-inline-form" aria-label={text('Link manually', '手動で紐付け')} onSubmit={(event) => { event.preventDefault(); if (claimId.trim() !== '' && itemId.trim() !== '') onSubmit({ claimId: claimId.trim(), itemId: itemId.trim() }); }}>
    <div className="expense-form">
      {claims.length > 0
        ? <label>{text('Claim', '申請')}
          <select value={claimId} onChange={(event) => setClaimId(event.target.value)}>
            <option value="">{text('— choose a claim —', '— 申請を選ぶ —')}</option>
            {claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.claimant.name} · {claim.period.from}〜{claim.period.to} · {formatYen(claim.totalAmount)}</option>)}
          </select>
        </label>
        : <label>{text('Claim ID', '申請 ID')}<input value={claimId} onChange={(event) => setClaimId(event.target.value)} /></label>}
      {items !== undefined && items.length > 0 && !itemsFailed
        ? <label>{text('Item', '明細')}
          <select value={itemId} onChange={(event) => setItemId(event.target.value)}>
            {items.map((item) => <option key={item.id} value={item.id}>{item.facts.transactionDate ?? '—'} · {item.facts.payeeName ?? '—'} · {formatYen(item.facts.amount)}</option>)}
          </select>
        </label>
        : <label>{text('Item ID', '明細 ID')}<input value={itemId} onChange={(event) => setItemId(event.target.value)} /></label>}
    </div>
    <div className="expense-actions">
      <button type="submit" className="primary" disabled={busy || claimId.trim() === '' || itemId.trim() === ''}>{text('Link', '紐付ける')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{text('Cancel', 'キャンセル')}</button>
    </div>
  </form>;
}
