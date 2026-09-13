import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AcceptJournalHearingResultDto, JournalCapabilitiesDto, JournalChartOfAccountsDto, JournalDocumentDto, JournalDocumentStatusDto, JournalDocumentSummaryDto, JournalEntryDto, JournalRuleDto, JudgeJournalDocumentsResultDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { HearingPanel } from './HearingPanel';
import type { TabFocus } from './JournalPage';
import { SKIPPED_KINDS, directionLabel, formatYen, kindLabel, paymentMethodLabel, summarizeJudgment, type JournalAction } from './journal-model';
import { CapabilityNotice, StatusChip, messageOf } from './journal-shared';

const STATUSES: readonly JournalDocumentStatusDto[] = ['extracted', 'undecided', 'decided', 'hearing', 'skipped', 'exported'];

/**
 * 判定タブ。文書一覧（状態フィルタ）→ 行の詳細（事実 + 判定結果）。
 * 判定結果は summarizeJudgment で「原因 → 次の一手 → 直す場所へのボタン」に組み替える。ボタンの遷移は onAction（JournalPage）に委ね、
 * `ask-if` の回答だけはここで完結する（facts.extra[questionId] に書いて保存 → 再判定）。
 */
export function JudgeTab({ client, chart, rules, capabilities, focus, onAction, reloadChart, reloadRules }: {
  readonly client: ToolApiClient; readonly chart: JournalChartOfAccountsDto | undefined; readonly rules: readonly JournalRuleDto[]; readonly capabilities: JournalCapabilitiesDto | undefined;
  readonly focus: TabFocus | undefined; readonly onAction: (action: JournalAction, document: JournalDocumentSummaryDto) => void;
  /** ヒアリングの登録で科目マスタ / ルールが増えるので、親の持つ一覧を読み直してもらう（省略可）。 */
  readonly reloadChart?: () => Promise<void>; readonly reloadRules?: () => Promise<void>;
}) {
  const { text } = useI18n();
  const [documents, setDocuments] = useState<readonly JournalDocumentSummaryDto[]>();
  const [listError, setListError] = useState<string>();
  const [status, setStatus] = useState<'' | JournalDocumentStatusDto>('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<JournalDocumentDto>();
  const [entry, setEntry] = useState<JournalEntryDto>();
  const [detailError, setDetailError] = useState<string>();
  const [judging, setJudging] = useState<'all' | string>();
  const [summary, setSummary] = useState<JudgeJournalDocumentsResultDto>();
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState<{ readonly questionId: string; readonly prompt: string; readonly value: string }>();
  const [pendingDelete, setPendingDelete] = useState<JournalDocumentSummaryDto>();
  const [deleting, setDeleting] = useState(false);
  const [hearingOpen, setHearingOpen] = useState(false);

  const reload = useCallback(async () => {
    try { setDocuments(await client.listJournalDocuments(scope, status === '' ? {} : { status })); setListError(undefined); }
    catch (cause: unknown) { setDocuments([]); setListError(messageOf(cause)); }
  }, [client, status]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (focus !== undefined) setSelectedId(focus.id); }, [focus]);

  // 選択した文書の全体（facts）と、確定済みなら仕訳。
  useEffect(() => {
    if (selectedId === undefined) { setDetail(undefined); setEntry(undefined); return; }
    let active = true;
    setDetailError(undefined);
    setAnswer(undefined);
    setHearingOpen(false);
    void client.getJournalDocument(selectedId, scope)
      .then(async (document) => {
        if (!active) return;
        setDetail(document);
        const entryId = document.entryId ?? (document.judgment?.stage === 'decided' ? document.judgment.entryId : undefined);
        if (entryId === undefined) { setEntry(undefined); return; }
        try {
          const entries = await client.listJournalEntries(scope, { documentId: document.id });
          if (active) setEntry(entries.find((item) => item.id === entryId) ?? entries[0]);
        } catch { if (active) setEntry(undefined); }
      })
      .catch((cause: unknown) => { if (active) { setDetail(undefined); setDetailError(messageOf(cause)); } });
    return () => { active = false; };
  }, [client, selectedId]);

  const ruleNames = useMemo(() => new Map(rules.map((rule) => [rule.id, rule.name])), [rules]);
  const selected = documents?.find((document) => document.id === selectedId);

  const judge = async (documentIds?: readonly string[]) => {
    setJudging(documentIds === undefined ? 'all' : documentIds[0] ?? 'all');
    setError(undefined);
    setSummary(undefined);
    try {
      const result = await client.judgeJournalDocuments(scope, documentIds === undefined ? {} : { documentIds });
      setSummary(result);
      await reload();
      // 選択中の文書は詳細を読み直す（判定結果が変わっている）。
      if (selectedId !== undefined && (documentIds === undefined || documentIds.includes(selectedId))) {
        const refreshed = await client.getJournalDocument(selectedId, scope);
        setDetail(refreshed);
        const entryId = refreshed.entryId ?? (refreshed.judgment?.stage === 'decided' ? refreshed.judgment.entryId : undefined);
        if (entryId === undefined) setEntry(undefined);
        else { try { const entries = await client.listJournalEntries(scope, { documentId: refreshed.id }); setEntry(entries.find((item) => item.id === entryId) ?? entries[0]); } catch { setEntry(undefined); } }
      }
    } catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setJudging(undefined); }
  };

  const submitAnswer = async () => {
    if (detail === undefined || answer === undefined) return;
    if (answer.value.trim() === '') { setError(text('Enter an answer first.', '先に回答を入力してください')); return; }
    setJudging(detail.id);
    setError(undefined);
    try {
      const { id, kind, source, facts, extraction } = detail;
      await client.saveJournalDocument(scope, { id, kind, source, extraction, facts: { ...facts, extra: { ...facts.extra, [answer.questionId]: answer.value.trim() } } });
      setAnswer(undefined);
      await judge([detail.id]);
    } catch (cause: unknown) { setError(messageOf(cause)); setJudging(undefined); }
  };

  const remove = async () => {
    if (pendingDelete === undefined) return;
    setDeleting(true);
    try {
      await client.deleteJournalDocument(pendingDelete.id, scope);
      if (selectedId === pendingDelete.id) setSelectedId(undefined);
      setPendingDelete(undefined);
      await reload();
    } catch (cause: unknown) { setError(messageOf(cause)); }
    finally { setDeleting(false); }
  };

  const act = (action: JournalAction, document: JournalDocumentSummaryDto) => {
    if (action.kind === 'answer') { setAnswer({ questionId: action.questionId, prompt: action.prompt, value: String(detail?.facts.extra?.[action.questionId] ?? '') }); return; }
    if (action.kind === 'hearing') { setHearingOpen(true); return; }
    onAction(action, document);
  };

  /** ヒアリングでルールが登録されたら、一覧・詳細・親の持つマスタ / ルールを読み直す。 */
  const afterHearingAccepted = async (result: AcceptJournalHearingResultDto) => {
    setEntry(result.entry);
    await reload();
    await reloadRules?.();
    await reloadChart?.();
    if (selectedId === undefined) return;
    try { setDetail(await client.getJournalDocument(selectedId, scope)); }
    catch { /* 一覧は更新済み。詳細の再取得失敗は結果を左右しない。 */ }
  };

  /** ヒアリングを閉じた（中止した）。行は未確定に戻っているので読み直す。 */
  const afterHearingClosed = async () => {
    setHearingOpen(false);
    await reload();
    if (selectedId === undefined) return;
    try { setDetail(await client.getJournalDocument(selectedId, scope)); }
    catch { /* 同上。 */ }
  };

  const pendingCount = documents?.filter((document) => document.status === 'extracted' || document.status === 'undecided').length ?? 0;
  const judgment = detail === undefined ? undefined : summarizeJudgment(detail.judgment, text, ruleNames);
  const accountName = (accountId: string, fallback: string) => chart?.accounts.find((account) => account.id === accountId)?.name ?? fallback;

  return <div className="journal-judge two-column-workspace">
    <section className="workspace-card" aria-labelledby="journal-documents-heading">
      <div className="journal-toolbar">
        <h2 id="journal-documents-heading">{text('Documents', '帳票')}</h2>
        <label>{text('Status', '状態')}<select aria-label={text('Status filter', '状態で絞り込む')} value={status} onChange={(event) => setStatus(event.target.value as '' | JournalDocumentStatusDto)}><option value="">{text('All', 'すべて')}</option>{STATUSES.map((item) => <option key={item} value={item}>{statusText(item, text)}</option>)}</select></label>
        <button type="button" className="primary" disabled={judging !== undefined || pendingCount === 0} onClick={() => void judge()}>{judging === 'all' ? text('Judging…', '判定中…') : text(`Judge pending (${pendingCount})`, `未判定を判定（${pendingCount}）`)}</button>
      </div>
      {listError !== undefined && <p className="api-error" role="alert">{listError} <button type="button" className="secondary" onClick={() => void reload()}>{text('Retry', '再試行')}</button></p>}
      {error !== undefined && <p className="api-error" role="alert">{error}</p>}
      {summary !== undefined && <InlineFeedback kind="info" onDismiss={() => setSummary(undefined)} autoHideMs={8000}>{text(`Judged ${summary.judged.length}: decided ${summary.decided}, undecided ${summary.undecided}, skipped ${summary.skipped}.`, `${summary.judged.length} 件を判定: 確定 ${summary.decided} / 未確定 ${summary.undecided} / 対象外 ${summary.skipped}`)}</InlineFeedback>}
      {documents === undefined ? <p className="empty-state">{text('Loading…', '読み込み中…')}</p>
        : documents.length === 0 ? <p className="empty-state">{text('No documents yet. Import a CSV or enter facts in the Ingest tab.', '帳票がまだありません。「取込」タブで CSV を取り込むか事実を入力してください。')}</p>
          : <div className="table-wrap"><table className="journal-table" aria-label={text('Document list', '帳票一覧')}>
            <thead><tr><th>{text('Date', '日付')}</th><th>{text('Kind', '種別')}</th><th>{text('Issuer / description', '発行者 / 摘要')}</th><th>{text('Amount', '金額')}</th><th>{text('Dir.', '方向')}</th><th>{text('Status', '状態')}</th><th>{text('Judge', '判定')}</th></tr></thead>
            <tbody>{documents.map((document) => <tr key={document.id} className={document.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(document.id)}>
              <td>{document.transactionDate ?? '—'}</td>
              <td>{kindLabel(document.kind, text)}</td>
              <td><button type="button" className="screen-link" onClick={(event) => { event.stopPropagation(); setSelectedId(document.id); }}>{document.issuerName ?? document.description ?? document.fileName ?? document.id}</button></td>
              <td className="journal-amount">{formatYen(document.grandTotal)}</td>
              <td>{directionLabel(document.direction, text)}</td>
              <td><StatusChip status={document.status} /></td>
              <td>{SKIPPED_KINDS.includes(document.kind) ? <small className="empty-state">{text('not journalized', '仕訳しない')}</small> : <button type="button" className="secondary" disabled={judging !== undefined} onClick={(event) => { event.stopPropagation(); void judge([document.id]); }}>{judging === document.id ? '…' : text('Judge', '判定')}</button>}</td>
            </tr>)}</tbody>
          </table></div>}
    </section>

    <section className="workspace-card journal-detail" aria-labelledby="journal-detail-heading">
      <h2 id="journal-detail-heading">{text('Detail', '詳細')}</h2>
      {detailError !== undefined && <p className="api-error" role="alert">{detailError}</p>}
      {selected === undefined || detail === undefined ? <p className="empty-state">{text('Select a document to see its facts and judgment.', '帳票を選ぶと事実と判定結果が出ます。')}</p> : <>
        <div className="journal-toolbar">
          <StatusChip status={detail.status} />
          <span>{kindLabel(detail.kind, text)} · {detail.source.type}{detail.source.fileName === undefined ? '' : ` · ${detail.source.fileName}`}</span>
          <button type="button" className="secondary" onClick={() => onAction({ kind: 'edit-facts' }, selected)}>{text('Edit facts', '項目を編集')}</button>
          <button type="button" className="secondary danger" onClick={() => setPendingDelete(selected)}>{text('Delete', '削除')}</button>
        </div>
        <dl className="journal-facts">
          <dt>{text('Date', '取引日')}</dt><dd>{detail.facts.transactionDate ?? detail.facts.issueDate ?? '—'}</dd>
          <dt>{text('Direction', '方向')}</dt><dd>{directionLabel(detail.facts.direction, text)}</dd>
          <dt>{text('Issuer', '発行者')}</dt><dd>{detail.facts.issuerName ?? '—'}</dd>
          <dt>{text('Description', '摘要')}</dt><dd>{detail.facts.description ?? '—'}{detail.facts.counterpartyHint === undefined ? '' : ` (${detail.facts.counterpartyHint})`}</dd>
          <dt>{text('Total', '合計')}</dt><dd>{formatYen(detail.facts.grandTotal)}</dd>
          <dt>{text('Payment', '支払方法')}</dt><dd>{detail.facts.paymentMethod === undefined ? '—' : paymentMethodLabel(detail.facts.paymentMethod, text)}{detail.facts.accountHint === undefined ? '' : ` · ${detail.facts.accountHint}`}</dd>
          <dt>{text('Registration no.', '登録番号')}</dt><dd>{detail.facts.registrationNumber ?? '—'}</dd>
          {detail.facts.extra !== undefined && Object.keys(detail.facts.extra).length > 0 && <><dt>{text('Extra', '追加項目')}</dt><dd><code>{JSON.stringify(detail.facts.extra)}</code></dd></>}
        </dl>
        {detail.extraction.warnings.length > 0 && <ul className="journal-warnings">{detail.extraction.warnings.map((warning) => <li key={warning} className="notice-card">{warning}</li>)}</ul>}

        <h3>{text('Judgment', '判定')}</h3>
        {judgment !== undefined && judgment.cards.map((card, index) => <article key={`${card.code}-${index}`} className={`journal-reason journal-reason-${judgment.stage}`} role={judgment.stage === 'undecided' ? 'alert' : 'status'}>
          <p><strong>{text('Cause', '原因')}:</strong> {card.cause}</p>
          <p><strong>{text('Next step', '次の一手')}:</strong> {card.nextStep}</p>
          {card.actions.length > 0 && <div className="run-failure-actions">
            {card.actions.map((action, actionIndex) => {
              const hearingBlocked = action.target.kind === 'hearing' && capabilities?.hearing.enabled !== true;
              return <button key={actionIndex} type="button" className="secondary" disabled={hearingBlocked} title={hearingBlocked ? text('Hearing is not available on this server', 'このサーバーではヒアリングを使えません') : undefined} onClick={() => act(action.target, selected)}>{action.label}</button>;
            })}
          </div>}
          {card.actions.some((action) => action.target.kind === 'hearing') && <CapabilityNotice capabilities={capabilities} feature="hearing" />}
        </article>)}

        {hearingOpen && <HearingPanel
          client={client}
          chart={chart}
          documentId={detail.id}
          hearingId={detail.hearingId}
          onEditRule={(rule) => { setHearingOpen(false); onAction({ kind: 'edit-rule-draft', rule }, selected); }}
          onAccepted={(result) => { void afterHearingAccepted(result); }}
          onClosed={() => { void afterHearingClosed(); }}
          onOpenEntry={(entryId) => onAction({ kind: 'open-entry', entryId }, selected)}
          onManualRule={() => { setHearingOpen(false); onAction({ kind: 'new-rule' }, selected); }}
        />}

        {answer !== undefined && <form className="journal-answer" onSubmit={(event) => { event.preventDefault(); void submitAnswer(); }}>
          <label>{answer.prompt}<input aria-label={text('Answer', '回答')} value={answer.value} onChange={(event) => setAnswer({ ...answer, value: event.target.value })} /></label>
          <small className="empty-state">{text(`Stored as extra.${answer.questionId}`, `extra.${answer.questionId} に保存されます`)}</small>
          <div className="run-failure-actions"><button type="submit" className="primary" disabled={judging !== undefined}>{text('Save answer and judge again', '回答を保存して再判定')}</button><button type="button" className="secondary" onClick={() => setAnswer(undefined)}>{text('Cancel', 'キャンセル')}</button></div>
        </form>}

        {entry !== undefined && <>
          <h3>{text('Entry lines', '仕訳行')} <small className="empty-state">({entry.status})</small></h3>
          <div className="table-wrap"><table className="journal-table" aria-label={text('Entry lines', '仕訳行')}>
            <thead><tr><th>{text('Side', '貸借')}</th><th>{text('Account', '科目')}</th><th>{text('Tax', '税区分')}</th><th>{text('Amount', '金額')}</th></tr></thead>
            <tbody>{entry.lines.map((line, index) => <tr key={index}><td>{line.side === 'debit' ? text('Debit', '借方') : text('Credit', '貸方')}</td><td>{accountName(line.accountId, line.accountName)}</td><td>{line.taxCode}</td><td className="journal-amount">{formatYen(line.amount)}</td></tr>)}</tbody>
          </table></div>
          <p className="empty-state">{entry.description} · {entry.invoiceStatus}</p>
          <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => onAction({ kind: 'open-entry', entryId: entry.id }, selected)}>{text('Open in Export tab', '出力タブで開く')}</button></div>
        </>}
      </>}
    </section>
    <ConfirmDialog open={pendingDelete !== undefined} danger busy={deleting} title={text('Delete this document?', 'この帳票を削除しますか？')}
      message={pendingDelete === undefined ? '' : text(`"${pendingDelete.issuerName ?? pendingDelete.description ?? pendingDelete.id}" and its judgment will be removed. Entries already created stay.`, `「${pendingDelete.issuerName ?? pendingDelete.description ?? pendingDelete.id}」と判定結果を削除します。作成済みの仕訳は残ります。`)}
      confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} onConfirm={() => void remove()} onCancel={() => setPendingDelete(undefined)} />
  </div>;
}

function statusText(status: JournalDocumentStatusDto, text: (en: string, ja: string) => string): string {
  switch (status) {
    case 'extracted': return text('Not judged', '未判定');
    case 'decided': return text('Decided', '確定');
    case 'undecided': return text('Undecided', '未確定');
    case 'hearing': return text('Hearing', 'ヒアリング中');
    case 'skipped': return text('Skipped', '対象外');
    default: return text('Exported', '出力済');
  }
}
