import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  ExpensePayoutBatchDto, ExpensePayoutPreviewDto, ExpensePayoutProblemDto, ExpensePayoutSettingsResultDto, PayoutSourceAccountTypeDto, SaveExpensePayoutSettingsDto,
} from '../../api/expense-money-types';
import { ApiError } from '../../api/tool-api';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { decodeBase64, formatYen, triggerBlobDownload } from '../../journal/journal-model';
import type { OpenTarget } from '../../navigation';
import type { Translate } from '../expense-model';
import type { ExpenseSettlePayoutSlotProps } from '../expense-slots';
import { MoneyErrorNotice, NoteForm, readMoneyError, todayIso, useMoneyApi, type MoneyErrorInfo } from './money-shared';

function isPayoutProblem(value: unknown): value is ExpensePayoutProblemDto {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'code') === 'string' && typeof Reflect.get(value, 'message') === 'string';
}

/** 409 EXPENSE_PAYOUT_BLOCKED の本文から止める理由と警告を取り出す。 */
export function payoutBlockedDetails(cause: unknown): { readonly problems: readonly ExpensePayoutProblemDto[]; readonly warnings: readonly ExpensePayoutProblemDto[] } | undefined {
  if (!(cause instanceof ApiError) || cause.code !== 'EXPENSE_PAYOUT_BLOCKED') return undefined;
  const list = (key: string): readonly ExpensePayoutProblemDto[] => {
    const value = cause.details?.[key];
    return Array.isArray(value) ? value.filter(isPayoutProblem) : [];
  };
  return { problems: list('problems'), warnings: list('warnings') };
}

function batchStatusLabel(status: string, text: Translate): string {
  switch (status) {
    case 'exported': return text('Created (not transferred yet)', '作成済み（未確定）');
    case 'confirmed': return text('Confirmed', '確定済み');
    case 'cancelled': return text('Cancelled', '取消');
    default: return status;
  }
}

/** 点検の 1 件の導線（従業員の口座欄・申請者・承認・振込元の設定・振込日）。 */
export function problemAction(problem: ExpensePayoutProblemDto, text: Translate, actions: { readonly onOpen: (target: OpenTarget) => void; readonly openSettings: () => void; readonly focusDate: () => void }): { readonly label: string; readonly run: () => void } | undefined {
  switch (problem.fixTarget) {
    case 'employee-bank-account': return problem.employeeId === undefined ? undefined : { label: text('Open the bank account', '従業員の口座欄を開く'), run: () => actions.onOpen({ internalId: problem.employeeId as string, section: 'employee' }) };
    case 'employee-history': return problem.employeeId === undefined ? undefined : { label: text('Open the employee history', '従業員の履歴を開く'), run: () => actions.onOpen({ internalId: problem.employeeId as string, section: 'employee' }) };
    case 'claim-claimant': return problem.claimId === undefined ? undefined : { label: text('Choose the claimant', '申請者を選ぶ'), run: () => actions.onOpen({ internalId: problem.claimId as string, section: 'claimant' }) };
    case 'employee-links': return { label: text('Open link candidates', '紐付け候補を開く'), run: () => actions.onOpen({ internalId: '', section: 'employee' }) };
    case 'approve':
      if (problem.advanceId !== undefined) return { label: text('Open the advance', '仮払を開く'), run: () => actions.onOpen({ internalId: problem.advanceId as string, section: 'advance' }) };
      return problem.claimId === undefined ? undefined : { label: text('Open the claim', '申請を開く'), run: () => actions.onOpen({ internalId: problem.claimId as string, section: 'claim' }) };
    case 'payout-settings': return { label: text('Open the payout source settings', '振込元の設定を開く'), run: actions.openSettings };
    case 'transfer-date': return { label: text('Change the transfer date', '振込日を直す'), run: actions.focusDate };
    default: return undefined;
  }
}

interface SettingsDraft {
  bankCode: string; branchCode: string; bankNameKana: string; branchNameKana: string; accountType: PayoutSourceAccountTypeDto; accountNumber: string;
  requesterCode: string; requesterNameKana: string; includeBankNames: boolean; lineEnding: 'crlf' | 'none'; eofMark: boolean; charset: 'strict' | 'extended'; createPaymentEntry: boolean;
}

function draftOf(result: ExpensePayoutSettingsResultDto | undefined): SettingsDraft {
  const settings = result?.settings;
  return {
    bankCode: settings?.source?.bankCode ?? '', branchCode: settings?.source?.branchCode ?? '', bankNameKana: settings?.source?.bankNameKana ?? '', branchNameKana: settings?.source?.branchNameKana ?? '',
    accountType: settings?.source?.accountType ?? 'ordinary', accountNumber: '', requesterCode: settings?.requesterCode ?? '', requesterNameKana: settings?.requesterNameKana ?? '',
    includeBankNames: settings?.format.includeBankNames ?? false, lineEnding: settings?.format.lineEnding ?? 'crlf', eofMark: settings?.format.eofMark ?? false,
    charset: settings?.format.charset ?? 'strict', createPaymentEntry: settings?.journal.createPaymentEntry ?? false,
  };
}

/**
 * 精算出力タブの振込データ（全銀協。docs/21 §20.10.1）: 振込元の設定 → 振込日 → 事前点検（止める理由と確認必須の警告・変換後の名義）→
 * 作成（ダウンロード）→ 振込バッチの一覧（再ダウンロード・確定・取消）。口座番号は画面に出さない（末尾 4 桁だけ）。
 * 振込元が未設定なのは失敗ではないので赤くせず、設定を開く導線を出す。
 */
export function PayoutPanel({ transport, scope, onOpen, onClaimsChanged }: ExpenseSettlePayoutSlotProps) {
  const { text } = useI18n();
  const api = useMoneyApi(transport);
  const dateId = useId();
  const dateRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<ExpensePayoutSettingsResultDto>();
  const [draft, setDraft] = useState<SettingsDraft>(draftOf(undefined));
  const [editing, setEditing] = useState(false);
  const [changeNumber, setChangeNumber] = useState(false);
  const [batches, setBatches] = useState<readonly ExpensePayoutBatchDto[]>([]);
  const [transferDate, setTransferDate] = useState(todayIso());
  const [preview, setPreview] = useState<ExpensePayoutPreviewDto>();
  const [blocked, setBlocked] = useState<{ readonly problems: readonly ExpensePayoutProblemDto[]; readonly warnings: readonly ExpensePayoutProblemDto[] }>();
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [cancelling, setCancelling] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoneyErrorInfo>();
  const [feedback, setFeedback] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [nextSettings, nextBatches] = await Promise.all([api.getPayoutSettings(scope), api.listPayouts(scope)]);
      setSettings(nextSettings);
      setDraft(draftOf(nextSettings));
      setBatches(nextBatches);
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    }
  }, [api, scope]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try { await work(); } catch (cause: unknown) {
      const details = payoutBlockedDetails(cause);
      const info = readMoneyError(cause);
      // 振込の点検は「直す必要がある問題」「確認が必要な警告」の枠に出すので、失敗の表示には重ねない。
      if (details !== undefined) setBlocked(details);
      setError(details === undefined ? info : { ...info, problems: [] });
    } finally { setBusy(false); }
  };

  const configured = settings?.saved === true && settings.settings.source !== undefined && settings.settings.requesterCode !== undefined && settings.settings.requesterNameKana !== undefined;
  const openSettings = () => setEditing(true);
  const focusDate = () => dateRef.current?.focus();

  const saveSettings = () => run(async () => {
    const input: SaveExpensePayoutSettingsDto = {
      source: {
        bankCode: draft.bankCode.trim(), branchCode: draft.branchCode.trim(), accountType: draft.accountType,
        ...(draft.bankNameKana.trim() === '' ? {} : { bankNameKana: draft.bankNameKana.trim() }), ...(draft.branchNameKana.trim() === '' ? {} : { branchNameKana: draft.branchNameKana.trim() }),
        ...(draft.accountNumber.trim() === '' ? {} : { accountNumber: draft.accountNumber.trim() }),
      },
      requesterCode: draft.requesterCode.trim(), requesterNameKana: draft.requesterNameKana.trim(),
      format: { includeBankNames: draft.includeBankNames, lineEnding: draft.lineEnding, eofMark: draft.eofMark, charset: draft.charset },
      journal: { createPaymentEntry: draft.createPaymentEntry },
    };
    const saved = await api.savePayoutSettings(scope, input);
    const next = { settings: saved, saved: true };
    setSettings(next);
    setDraft(draftOf(next));
    setEditing(false);
    setChangeNumber(false);
    setFeedback(text('Saved the payout source settings.', '振込元の設定を保存しました。'));
  });

  const check = () => run(async () => {
    setBlocked(undefined);
    setAcknowledged(new Set());
    setPreview(await api.previewPayout(scope, { transferDate }));
  });

  const download = (fileName: string, base64: string): boolean => triggerBlobDownload(fileName, new Blob([decodeBase64(base64)], { type: 'text/plain' }));

  const create = () => run(async () => {
    const result = await api.createPayout(scope, { transferDate, acknowledgedWarnings: [...acknowledged] });
    const downloaded = download(result.file.fileName, result.file.contentBase64);
    setFeedback(downloaded
      ? text(`Created ${result.file.fileName}. Upload it to your bank, then press "Confirm" after the transfer.`, `${result.file.fileName} を作成しました。銀行にアップロードし、振込を終えたら「確定」を押してください。`)
      : text(`Created ${result.file.fileName}, but this browser could not download it. Use "Download again" in the list below.`, `${result.file.fileName} を作成しましたが、この環境ではダウンロードできませんでした。下の一覧の「再ダウンロード」を使ってください。`));
    setPreview(undefined);
    setBatches(await api.listPayouts(scope));
    await onClaimsChanged();
  });

  const redownload = (batch: ExpensePayoutBatchDto) => run(async () => {
    const file = await api.downloadPayoutFile(scope, batch.id);
    if (!download(file.fileName, file.contentBase64)) setFeedback(text('This browser could not download the file.', 'この環境ではダウンロードできませんでした。'));
  });

  const confirm = (batch: ExpensePayoutBatchDto) => run(async () => {
    const result = await api.confirmPayout(scope, batch.id);
    setFeedback([text(`Confirmed ${batch.fileName}. The claims are settled.`, `${batch.fileName} を確定しました。申請は精算済みになりました。`), ...result.warnings].join(' '));
    setBatches(await api.listPayouts(scope));
    await onClaimsChanged();
  });

  const cancel = (batch: ExpensePayoutBatchDto, note: string) => run(async () => {
    await api.cancelPayout(scope, batch.id, note);
    setCancelling(undefined);
    setFeedback(text(`Cancelled ${batch.fileName}. You can create the payout file again.`, `${batch.fileName} を取り消しました。振込データを作り直せます。`));
    setBatches(await api.listPayouts(scope));
    await onClaimsChanged();
  });

  const problems = blocked?.problems ?? preview?.problems ?? [];
  const warnings = blocked?.warnings ?? preview?.warnings ?? [];
  const warningCodes = [...new Set(warnings.map((warning) => warning.code))];
  const unconfirmed = warningCodes.filter((code) => !acknowledged.has(code));
  const canCreate = preview !== undefined && preview.lines.length > 0 && problems.length === 0 && unconfirmed.length === 0 && !busy;
  const source = settings?.settings.source;
  const field = (key: keyof SettingsDraft, label: string, extra: { readonly inputMode?: 'numeric' } = {}) => <label>{label}
    <input aria-label={label} value={String(draft[key])} inputMode={extra.inputMode} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
  </label>;

  return <section className="workspace-card expense-money-payout" aria-labelledby="expense-money-payout-heading">
    <h2 id="expense-money-payout-heading">{text('Bank transfer file (Zengin)', '振込データ（全銀協）')}</h2>

    {!configured && !editing && <div className="expense-empty">
      <p className="empty-state">{text('Set the payout source account to create transfer files.', '振込元の口座を設定すると作れます。')}</p>
      <button type="button" className="secondary" onClick={openSettings}>{text('Open the payout source settings', '振込元の設定を開く')}</button>
    </div>}
    {configured && !editing && source !== undefined && <p className="expense-money-payout-source">
      {text('Payout source', '振込元')}: {source.bankCode}-{source.branchCode} ****{source.accountNumberLast4} / {settings?.settings.requesterNameKana}{' '}
      <button type="button" className="secondary" onClick={openSettings}>{text('Edit the payout source', '振込元を編集')}</button>
    </p>}

    {editing && <form className="expense-money-inline-form" aria-label={text('Payout source settings', '振込元の設定')} onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}>
      <p className="expense-limit-hint">{text('Check your bank\'s upload specification and choose the options to match it.', '銀行のアップロード仕様を確認して選んでください。')}</p>
      <div className="expense-form">
        {field('bankCode', text('Bank code (4 digits)', '銀行コード（4 桁）'), { inputMode: 'numeric' })}
        {field('branchCode', text('Branch code (3 digits)', '支店コード（3 桁）'), { inputMode: 'numeric' })}
        <label>{text('Account type', '預金種目')}
          <select aria-label={text('Account type', '預金種目')} value={draft.accountType} onChange={(event) => setDraft({ ...draft, accountType: event.target.value as PayoutSourceAccountTypeDto })}>
            <option value="ordinary">{text('Ordinary', '普通')}</option>
            <option value="current">{text('Current', '当座')}</option>
            <option value="other">{text('Other', 'その他')}</option>
          </select>
        </label>
        {source === undefined || changeNumber
          ? field('accountNumber', text('Account number (up to 7 digits)', '口座番号（7 桁以内）'), { inputMode: 'numeric' })
          : <p>{text('Account number', '口座番号')}: ****{source.accountNumberLast4} <button type="button" className="secondary" onClick={() => setChangeNumber(true)}>{text('Change', '変更する')}</button></p>}
        {field('requesterCode', text('Requester code (10 digits from the bank)', '依頼人コード（銀行から通知された 10 桁）'), { inputMode: 'numeric' })}
        {field('requesterNameKana', text('Requester name (kana)', '依頼人名（カナ）'))}
        <label><span><input type="checkbox" checked={draft.includeBankNames} onChange={(event) => setDraft({ ...draft, includeBankNames: event.target.checked })} /> {text('Write bank and branch names', '銀行名・支店名を入れる')}</span></label>
        {draft.includeBankNames && field('bankNameKana', text('Bank name (kana)', '銀行名（カナ）'))}
        {draft.includeBankNames && field('branchNameKana', text('Branch name (kana)', '支店名（カナ）'))}
        <label>{text('Line ending', '改行')}
          <select aria-label={text('Line ending', '改行')} value={draft.lineEnding} onChange={(event) => setDraft({ ...draft, lineEnding: event.target.value as 'crlf' | 'none' })}>
            <option value="crlf">CR LF</option>
            <option value="none">{text('None', 'なし')}</option>
          </select>
        </label>
        <label>{text('Allowed characters', '使える文字')}
          <select aria-label={text('Allowed characters', '使える文字')} value={draft.charset} onChange={(event) => setDraft({ ...draft, charset: event.target.value as 'strict' | 'extended' })}>
            <option value="strict">{text('Strict (works at every bank)', '標準（どの銀行でも通る）')}</option>
            <option value="extended">{text('Extended symbols', '記号を広く許す')}</option>
          </select>
        </label>
        <label><span><input type="checkbox" checked={draft.eofMark} onChange={(event) => setDraft({ ...draft, eofMark: event.target.checked })} /> {text('Add an EOF mark', 'EOF を付ける')}</span></label>
        <label><span><input type="checkbox" checked={draft.createPaymentEntry} onChange={(event) => setDraft({ ...draft, createPaymentEntry: event.target.checked })} /> {text('Create a payment journal draft when confirmed', '確定時に支払の仕訳下書きを作る')}</span></label>
      </div>
      <div className="expense-actions">
        <button type="submit" className="primary" disabled={busy}>{text('Save the payout source', '振込元を保存')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(false); setChangeNumber(false); setDraft(draftOf(settings)); }}>{text('Cancel', 'キャンセル')}</button>
      </div>
    </form>}

    <div className="expense-actions">
      <label htmlFor={dateId}>{text('Transfer date', '振込日')}</label>
      <input id={dateId} ref={dateRef} type="date" value={transferDate} onChange={(event) => { setTransferDate(event.target.value); setPreview(undefined); setBlocked(undefined); }} />
      <button type="button" className="secondary" disabled={busy || transferDate === ''} onClick={() => void check()}>{text('Check before creating', '事前点検')}</button>
    </div>

    {preview !== undefined && preview.lines.length === 0 && problems.length === 0 && <p className="empty-state">{text('There is nothing to transfer: no approved claims or unpaid advances.', '振込の対象がありません（承認済みの申請・支払待ちの仮払がありません）。')}</p>}
    {preview !== undefined && preview.lines.length > 0 && <table className="expense-money-table" aria-label={text('Transfer lines', '振込の明細')}>
      <thead><tr><th>{text('Employee', '従業員')}</th><th>{text('Account name (converted)', '名義（変換後）')}</th><th>{text('Account', '口座')}</th><th>{text('Amount', '金額')}</th></tr></thead>
      <tbody>{preview.lines.map((line) => <tr key={line.employeeId}>
        <td>{line.name}</td><td>{line.holderKanaConverted}</td><td>{line.bank.bankCode}-{line.bank.branchCode} ****{line.bank.accountNumberLast4}</td><td>{formatYen(line.amount)}</td>
      </tr>)}</tbody>
      <tfoot><tr><td colSpan={3}>{text(`${preview.recordCount} transfers`, `${preview.recordCount} 件`)}</td><td>{formatYen(preview.totalAmount)}</td></tr></tfoot>
    </table>}

    {problems.length > 0 && <div className="notice-card" aria-label={text('Problems to fix', '直す必要がある問題')}>
      <strong>{text('Fix these before creating the file', '作成する前に直してください')}</strong>
      <ul className="expense-money-reasons">{problems.map((problem, index) => {
        const action = problemAction(problem, text, { onOpen, openSettings, focusDate });
        return <li key={`${problem.code}-${index}`}><span>{problem.message}</span>
          {action !== undefined && <span className="run-failure-actions"><button type="button" className="secondary" onClick={action.run}>{action.label}</button></span>}
        </li>;
      })}</ul>
    </div>}

    {warnings.length > 0 && <div className="expense-money-warnings" aria-label={text('Warnings to confirm', '確認が必要な警告')}>
      <strong>{text('Confirm each warning', '警告を確認してください')}</strong>
      <ul className="expense-money-reasons">{warnings.map((warning, index) => {
        const action = problemAction(warning, text, { onOpen, openSettings, focusDate });
        return <li key={`${warning.code}-${index}`}><span>{warning.message}</span>
          {action !== undefined && <span className="run-failure-actions"><button type="button" className="secondary" onClick={action.run}>{action.label}</button></span>}
        </li>;
      })}</ul>
      {warningCodes.map((code) => <label key={code}><input type="checkbox" checked={acknowledged.has(code)} onChange={(event) => {
        const next = new Set(acknowledged);
        if (event.target.checked) next.add(code); else next.delete(code);
        setAcknowledged(next);
      }} /> {text(`Confirmed: ${code}`, `確認しました: ${code}`)}</label>)}
    </div>}

    {preview !== undefined && <div className="expense-actions">
      <button type="button" className="primary" disabled={!canCreate} onClick={() => void create()}>{text('Create the transfer file', '振込データを作成')}</button>
    </div>}

    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    <MoneyErrorNotice error={error} onOpen={onOpen} />

    <h3>{text('Transfer files', '振込バッチ')}</h3>
    {batches.length === 0
      ? <p className="empty-state">{text('No transfer files have been created.', '振込データはまだありません。')}</p>
      : <ul className="expense-money-batches">{batches.map((batch) => <li key={batch.id}>
        <span>{batch.fileName} · {batch.transferDate} · {formatYen(batch.totalAmount)} · {text(`${batch.recordCount} transfers`, `${batch.recordCount} 件`)} · {batchStatusLabel(batch.status, text)}</span>
        <span className="expense-actions">
          {batch.status !== 'cancelled' && <button type="button" className="secondary" disabled={busy} onClick={() => void redownload(batch)}>{text('Download again', '再ダウンロード')}</button>}
          {batch.status === 'exported' && <button type="button" className="primary" disabled={busy} onClick={() => void confirm(batch)}>{text('Confirm', '確定')}</button>}
          {batch.status === 'exported' && cancelling !== batch.id && <button type="button" className="secondary" disabled={busy} onClick={() => setCancelling(batch.id)}>{text('Cancel the file', '取消')}</button>}
        </span>
        {cancelling === batch.id && <NoteForm label={text('Reason for cancelling', '取り消す理由')} submitLabel={text('Cancel this file', 'この振込データを取り消す')} busy={busy} danger onSubmit={(note) => void cancel(batch, note)} onCancel={() => setCancelling(undefined)} />}
      </li>)}</ul>}
  </section>;
}
