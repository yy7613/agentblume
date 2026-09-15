import { useEffect, useMemo, useState } from 'react';
import type { ContractApi } from '../api/contract-api';
import type { ContractCapabilitiesDto, ContractDocumentDto, HumanDecisionDto, ReviewEnvelopeDto, TopicResultDto, VerdictDto } from '../api/contract-types';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { scope } from '../scope';
import { evidenceRanges, verdictLabel } from './contract-model';
import type { ReasonAction } from './contract-reasons';
import { ApiFailure, Field, isAbort, LegalNotice, ReasonCard, VerdictChip } from './contract-shared';
import { ContractTextView } from './ContractTextView';

/**
 * レビュー（docs/23 §7.1）。条文と判定の並列表示、理由の 3 点セット、推奨文案（コピー）、AI の回答、人の判断。
 * 判定を決めるのは審査基準との照合で、法的な判断ではない（固定文言を必ず出す）。
 */
export function ReviewStep({ api, capabilities, document, review, onReview, onDocumentChanged, onAction }: {
  readonly api: ContractApi;
  readonly capabilities: ContractCapabilitiesDto;
  readonly document: ContractDocumentDto;
  readonly review?: ReviewEnvelopeDto;
  readonly onReview: (review: ReviewEnvelopeDto) => void;
  readonly onDocumentChanged: () => void;
  readonly onAction: (action: ReasonAction) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [focus, setFocus] = useState<{ readonly topicId: string; readonly seq: number }>();
  const [drafts, setDrafts] = useState<Readonly<Record<string, { readonly decision?: HumanDecisionDto; readonly note?: string }>>>({});
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [aborter, setAborter] = useState<AbortController>();
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsedSeconds(aborter !== undefined);

  useEffect(() => { setDrafts({}); }, [review?.review.id]);

  const ranges = useMemo(() => evidenceRanges(document.clauses), [document.clauses]);
  const blocked = document.status === 'imported' || document.status === 'extracted';
  const current = review?.review;
  const finalized = current?.status === 'finalized';

  async function run(): Promise<void> {
    const controller = new AbortController();
    setAborter(controller); setError(undefined); setNotice(undefined);
    try { onReview(await api.runReview(scope, document.id, document.extraction?.playbookId, controller.signal)); onDocumentChanged(); }
    catch (cause) { if (isAbort(cause)) setNotice(text('Review stopped. Nothing was saved.', 'レビューを中断しました。何も保存していません。')); else setError(cause); }
    finally { setAborter(undefined); }
  }

  async function saveDecisions(): Promise<void> {
    if (current === undefined) return;
    const decisions = Object.entries(drafts).map(([topicId, entry]) => ({ topicId, ...(entry.decision === undefined ? {} : { decision: entry.decision }), ...(entry.note === undefined ? {} : { note: entry.note }) }));
    if (decisions.length === 0) return;
    setBusy(true); setError(undefined);
    try { onReview(await api.saveDecisions(scope, current.id, decisions)); setDrafts({}); setNotice(text('Decisions saved.', '判断を保存しました。')); }
    catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  async function finalize(): Promise<void> {
    if (current === undefined) return;
    setBusy(true); setError(undefined);
    try {
      if (Object.keys(drafts).length > 0) await saveDecisions();
      onReview(await api.finalizeReview(scope, current.id)); onDocumentChanged();
      setNotice(text('Review finalized. Register the contract once it is signed.', '判定を確定しました。締結したら締結登録へ進んでください。'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  const handleAction = (action: ReasonAction, result: TopicResultDto) => {
    if (action.kind === 'copy-recommended') { void navigator.clipboard?.writeText(result.recommendedTexts.join('\n')); setNotice(text('Copied the suggested wording.', '修正文案をコピーしました。')); return; }
    if (action.kind === 'rerun-review') { void run(); return; }
    if (action.kind === 'settings') { openInScreen('Settings', { internalId: 'main', section: 'model-slot' }); return; }
    if (action.kind === 'step' && action.step === 'review') { setFocus({ topicId: result.topicId, seq: Date.now() }); return; }
    onAction(action);
  };

  if (blocked) return <section className="contract-step contract-review"><p className="empty-state">{text('Confirm the clauses first.', '先に条項を確認して確定してください。')}</p><button type="button" className="secondary" onClick={() => onAction({ kind: 'step', step: 'clauses', label: '' })}>{text('Open the clauses step', '条項抽出を開く')}</button></section>;

  const counts = (verdict: VerdictDto) => current?.results.filter((result) => (result.humanDecision ?? result.verdict) === verdict).length ?? 0;

  return <section className="contract-step contract-review" aria-label={text('Review', 'レビュー')}>
    {error !== undefined && <ApiFailure cause={error} />}
    {notice !== undefined && <p className="contract-saved" role="status">{notice}</p>}
    <LegalNotice {...(review === undefined ? {} : { notice: review.notice })} />
    {!capabilities.review.llm && <p className="contract-hint">{text('AI yes/no criteria need a model; the rule-based criteria are still checked.', 'AI の はい/いいえ 基準にはモデルが必要です（決定的な基準は判定されます）。')}</p>}
    <div className="contract-toolbar">
      {aborter === undefined
        ? <button type="button" className="primary" disabled={finalized && !current?.stale} onClick={() => void run()}>{current === undefined ? text('Run the review', 'レビューを実行') : text('Run the review again', '再レビュー')}</button>
        : <><span role="status">{text(`Reviewing… ${elapsed}s`, `レビュー中… ${elapsed} 秒`)}</span><button type="button" className="secondary" onClick={() => aborter.abort()}>{text('Stop', '中断')}</button></>}
    </div>
    {current === undefined ? <p className="empty-state">{text('No review yet. Run the review to check the confirmed clauses against the playbook.', 'まだレビューしていません。レビューを実行すると、確定した条項を審査基準で確認します。')}</p> : <>
      <div className="contract-summary">
        <span>{text('Overall', '総合')}: <VerdictChip verdict={current.overall} /></span>
        {(['reject', 'negotiate', 'unresolved', 'accept'] as const).map((verdict) => <span key={verdict}>{verdictLabel(verdict, text)} {counts(verdict)}</span>)}
        <small>{text(`Playbook: ${current.playbookName}`, `審査基準: ${current.playbookName}`)}</small>
        {finalized && <span className="judge-chip">{text('Finalized', '確定済み')}</span>}
      </div>
      {current.stale && <ReasonCard code="review-stale" onAction={(action) => { if (action.kind === 'rerun-review') void run(); }} />}
      {current.documentFindings.length > 0 && <div className="workspace-card"><h3>{text('Findings for the whole document', '文書全体の所見')}</h3>
        {current.documentFindings.map((finding, index) => <ReasonCard key={index} code={finding.code} {...(finding.detail === undefined ? {} : { detail: finding.detail })} {...(finding.topicId === undefined ? {} : { topicId: finding.topicId })} onAction={(action) => onAction(action)} />)}
      </div>}
      <div className="contract-split">
        <ContractTextView document={document} ranges={ranges} {...(focus === undefined ? {} : { focus })} />
        <div className="contract-cards">
          {current.results.map((result) => {
            const draft = drafts[result.topicId];
            const decision = draft?.decision ?? result.humanDecision;
            return <article key={result.topicId} className={`workspace-card contract-card${focus?.topicId === result.topicId ? ' active' : ''}`} data-topic-card={result.topicId} onClick={() => setFocus({ topicId: result.topicId, seq: Date.now() })}>
              <header><h3>{result.topicLabel}</h3><VerdictChip verdict={result.verdict} />{!result.present && <small>{text('clause not present', '条項なし')}</small>}</header>
              {result.reasons.map((reason, index) => <ReasonCard key={index} code={reason.code} {...(reason.detail === undefined ? {} : { detail: reason.detail })} {...(reason.criterionId === undefined ? {} : { criterionId: reason.criterionId })} topicId={result.topicId} onAction={(action) => handleAction(action, result)} />)}
              {result.criteria.filter((criterion) => criterion.llm !== undefined).map((criterion) => <p key={criterion.criterionId} className="contract-llm"><small>{text('AI answer', 'AI の回答')}: {criterion.llm!.answer}</small> {criterion.llm!.reasoning}{criterion.llm!.evidenceQuote !== null && <q>{criterion.llm!.evidenceQuote}</q>}</p>)}
              {result.recommendedTexts.length > 0 && <div className="contract-recommended"><h4>{text('Suggested wording', '推奨修正文案')}</h4>{result.recommendedTexts.map((entry) => <p key={entry}>{entry}</p>)}
                <button type="button" className="secondary" onClick={() => { void navigator.clipboard?.writeText(result.recommendedTexts.join('\n')); setNotice(text('Copied the suggested wording.', '修正文案をコピーしました。')); }}>{text('Copy', 'コピー')}</button></div>}
              <fieldset className="contract-fieldset" disabled={finalized}><legend>{text('Your decision', '人の判断')}</legend>
                {(['accept', 'negotiate', 'reject'] as const).map((option) => <label key={option} className="contract-check"><input type="radio" name={`decision-${result.topicId}`} checked={decision === option} onChange={() => setDrafts((all) => ({ ...all, [result.topicId]: { ...all[result.topicId], decision: option } }))} />{verdictLabel(option, text)}</label>)}
                <Field label={text('Note', 'メモ')}><input value={draft?.note ?? result.humanNote ?? ''} onChange={(event) => setDrafts((all) => ({ ...all, [result.topicId]: { ...all[result.topicId], note: event.target.value } }))} /></Field>
              </fieldset>
            </article>;
          })}
        </div>
      </div>
      {!finalized && <div className="run-failure-actions">
        <button type="button" className="secondary" disabled={busy || Object.keys(drafts).length === 0} onClick={() => void saveDecisions()}>{text('Save decisions', '判断を保存')}</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void finalize()}>{text('Finalize the review', '判定を確定')}</button>
      </div>}
    </>}
  </section>;
}
