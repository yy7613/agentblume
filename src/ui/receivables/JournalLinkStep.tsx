import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalEntryDto } from '../api/types';
import type { InvoiceSummaryDto, ReceivablesSettingsDto } from '../api/receivables-types';
import type { ReceivablesApi } from '../api/receivables-api';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { scope } from '../scope';
import { formatYen, journalOrigin } from './receivables-model';
import { messageOf } from './receivables-shared';
import type { MatchingDto } from '../api/receivables-types';

/**
 * 仕訳連携ステップ（docs/22 §6 / §8）。発行・消込で作った下書き仕訳の一覧（出所タグで見分ける）と、
 * 確定済みのため変えられなかった仕訳の要対応一覧。仕訳の画面を開くボタンで直す場所へ連れて行く。
 */
export function JournalLinkStep({ api, client, invoices, settings, onOpenSettings }: {
  readonly api: ReceivablesApi; readonly client: ToolApiClient; readonly invoices: readonly InvoiceSummaryDto[]; readonly settings: ReceivablesSettingsDto | undefined;
  readonly onOpenSettings: () => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [entries, setEntries] = useState<readonly JournalEntryDto[]>();
  const [matchings, setMatchings] = useState<readonly MatchingDto[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => client.listJournalEntries(scope)).then((next) => { if (active) setEntries(next.filter((entry) => journalOrigin(entry.tags) !== undefined)); }).catch((cause: unknown) => { if (active) { setEntries([]); setError(messageOf(cause)); } });
    void api.listMatchings(scope).then((next) => { if (active) setMatchings(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, client]);

  const followUps = [
    ...invoices.filter((invoice) => invoice.journal.salesEntryKept === true && invoice.journal.salesEntryId !== undefined).map((invoice) => ({ key: `i-${invoice.id}`, entryId: invoice.journal.salesEntryId!, label: text(`Invoice ${invoice.number} (${invoice.status})`, `請求書 ${invoice.number}（${invoice.status}）`) })),
    ...matchings.filter((matching) => matching.journal.outcome === 'kept' && matching.journal.entryId !== undefined).map((matching) => ({ key: `m-${matching.id}`, entryId: matching.journal.entryId!, label: text(`Matching of ${formatYen(matching.transactionAmount)}`, `${formatYen(matching.transactionAmount)} の消込`) })),
  ];

  return <section className="receivables-step" aria-label={text('Journal link', '仕訳連携')}>
    {settings?.journal.enabled === false && <div className="notice-card" role="note"><p>{text('The journal link is disabled, so no draft entries are created.', '仕訳連携は無効です。下書きの仕訳は作られません。')}</p>
      <button type="button" className="secondary" onClick={onOpenSettings}>{text('Open Settings › Journal link', '設定 › 仕訳連携を開く')}</button></div>}
    {error !== undefined && <p className="field-error" role="alert">{error}</p>}
    {followUps.length > 0 && <div className="notice-card" role="status"><strong>{text('Needs attention in the Journal', '仕訳側で要対応')}</strong>
      <ul>{followUps.map((item) => <li key={item.key}>{item.label} — {text('the journal entry was already confirmed, so it was not changed.', '仕訳が確定済みのため変更していません。')}
        <button type="button" className="secondary" onClick={() => openInScreen('Journal', { internalId: item.entryId, section: 'entry' })}>{text('Open the journal entry', '仕訳を開く')}</button></li>)}</ul></div>}
    {entries !== undefined && entries.length === 0
      ? <p className="empty-state">{text('No draft journal entries yet. They are created when you issue an invoice or confirm a matching.', 'まだ仕訳の下書きはありません。発行または消込の確定で作られます。')}</p>
      : <table className="receivables-table" aria-label={text('Journal entries from invoicing', '請求・消込の仕訳')}><thead><tr><th>{text('Origin', '出所')}</th><th>{text('Date', '日付')}</th><th>{text('Debit', '借方')}</th><th>{text('Credit', '貸方')}</th><th>{text('Status', '状態')}</th><th /></tr></thead>
        <tbody>{(entries ?? []).map((entry) => {
          const origin = journalOrigin(entry.tags);
          return <tr key={entry.id}>
            <td>{origin?.kind === 'invoice' ? text('Issue', '発行') : text('Matching', '消込')}</td><td>{entry.date}</td>
            <td>{entry.lines.filter((line) => line.side === 'debit').map((line) => `${line.accountName} ${formatYen(line.amount)}`).join(', ')}</td>
            <td>{entry.lines.filter((line) => line.side === 'credit').map((line) => `${line.accountName} ${formatYen(line.amount)}`).join(', ')}</td>
            <td>{entry.status}</td>
            <td><button type="button" className="secondary" onClick={() => openInScreen('Journal', { internalId: entry.id, section: 'entry' })}>{text('Open', '仕訳を開く')}</button></td>
          </tr>;
        })}</tbody></table>}
  </section>;
}
