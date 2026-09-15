import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContractApi } from '../api/contract-api';
import type { ClauseDto, ContractCapabilitiesDto, ContractDocumentDto, PlaybookDto } from '../api/contract-types';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { scope } from '../scope';
import { clauseFromSelection, emptyValue, evidenceRanges, setValueField, valueFields } from './contract-model';
import type { ReasonAction } from './contract-reasons';
import { ApiFailure, Field, isAbort, ReasonCard } from './contract-shared';
import { ContractTextView } from './ContractTextView';

/**
 * 条項抽出と確認（docs/23 §7.1）。左に本文（根拠をハイライト）、右にトピックごとのカード（値のフォーム・根拠・警告）。
 * 本文を選んで「このトピックの根拠にする」で手指定できる。人が確かめてから「確認して確定」。
 */
export function ClausesStep({ api, capabilities, document, playbook, focusTopic, onChanged, onAction }: {
  readonly api: ContractApi;
  readonly capabilities: ContractCapabilitiesDto;
  readonly document: ContractDocumentDto;
  readonly playbook?: PlaybookDto;
  readonly focusTopic?: { readonly topicId: string; readonly seq: number };
  readonly onChanged: (document: ContractDocumentDto) => void;
  readonly onAction: (action: ReasonAction) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [clauses, setClauses] = useState<readonly ClauseDto[]>(document.clauses);
  const [selection, setSelection] = useState<{ readonly start: number; readonly end: number }>();
  const [active, setActive] = useState<{ readonly topicId: string; readonly seq: number }>();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [aborter, setAborter] = useState<AbortController>();
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsedSeconds(aborter !== undefined);
  const seq = useRef(0);

  useEffect(() => { setClauses(document.clauses); }, [document]);
  useEffect(() => { if (focusTopic !== undefined) setActive(focusTopic); }, [focusTopic]);

  const topics = useMemo(() => (playbook?.topics ?? []).filter((topic) => topic.enabled).sort((left, right) => left.sortOrder - right.sortOrder), [playbook]);
  const ranges = useMemo(() => evidenceRanges(clauses), [clauses]);
  const signed = document.status === 'signed';

  async function extract(options: { readonly scanAllArticles?: boolean; readonly articleRefs?: readonly string[] } = {}): Promise<void> {
    const controller = new AbortController();
    setAborter(controller); setError(undefined); setNotice(undefined);
    try {
      const updated = await api.extract(scope, document.id, { ...options, ...(playbook === undefined ? {} : { playbookId: playbook.id }) }, controller.signal);
      onChanged(updated);
      setNotice(text('Extraction finished. Check each value and its evidence, then confirm.', '抽出が終わりました。値と根拠を確かめてから確定してください。'));
    } catch (cause) {
      if (isAbort(cause)) setNotice(text('Extraction stopped. Nothing was saved.', '抽出を中断しました。何も保存していません。'));
      else setError(cause);
    } finally { setAborter(undefined); }
  }

  async function confirm(): Promise<void> {
    setBusy(true); setError(undefined);
    try {
      const updated = await api.confirmClauses(scope, document.id, { clauses, ...(document.ourParty === undefined ? {} : { ourParty: document.ourParty }), ...(playbook === undefined ? {} : { playbookId: playbook.id }) });
      onChanged(updated);
      setNotice(text('Clauses confirmed. Run the review next.', '条項を確定しました。次はレビューです。'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  const setClause = (topicId: string, clause: ClauseDto | undefined) => setClauses((current) => clause === undefined ? current.filter((entry) => entry.topicId !== topicId) : current.some((entry) => entry.topicId === topicId) ? current.map((entry) => entry.topicId === topicId ? clause : entry) : [...current, clause]);

  /** 理由のボタン: 読み直し・全条文はこの画面で処理し、他は画面へ任せる。 */
  const handleAction = (action: ReasonAction, clause?: ClauseDto) => {
    if (action.kind === 'rescan-all') { void extract({ scanAllArticles: true }); return; }
    if (action.kind === 'reread') { void extract(clause?.articleRef === undefined ? {} : { articleRefs: [clause.articleRef.replace(/第[0-9]+項.*$/u, '')] }); return; }
    if (action.kind === 'step' && action.step === 'clauses') { if (action.nodeId !== undefined) { seq.current += 1; setActive({ topicId: action.nodeId, seq: seq.current }); } return; }
    if (action.kind === 'settings') { openInScreen('Settings', { internalId: 'main', section: 'model-slot' }); return; }
    onAction(action);
  };

  return <section className="contract-step contract-clauses" aria-label={text('Clauses', '条項抽出')}>
    {error !== undefined && <ApiFailure cause={error} />}
    {notice !== undefined && <p className="contract-saved" role="status">{notice}</p>}
    {!capabilities.extraction.enabled && <div className="notice-card" role="note">
      <p>{text('AI extraction is not available (it needs a main model with structured output). You can still enter every clause by hand.', 'AI による抽出は使えません（構造化出力に対応した main モデルが必要です）。条項はすべて手入力できます。')}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Set the main model in Settings', '設定で main モデルを設定')}</button></div>
    </div>}
    <div className="contract-toolbar">
      {aborter === undefined
        ? <button type="button" className="primary" disabled={!capabilities.extraction.enabled || signed} onClick={() => void extract()}>{text('Extract clauses', '条項を抽出')}</button>
        : <><span role="status">{text(`Extracting… ${elapsed}s (this can take a few minutes)`, `抽出中… ${elapsed} 秒（数分かかることがあります）`)}</span><button type="button" className="secondary" onClick={() => aborter.abort()}>{text('Stop', '中断')}</button></>}
      {(document.extraction?.unscannedArticleRefs.length ?? 0) > 0 && <>
        <small>{text(`${document.extraction!.unscannedArticleRefs.length} articles were not read (no keyword matched).`, `キーワードに当たらず読んでいない条文が ${document.extraction!.unscannedArticleRefs.length} 件あります。`)}</small>
        <button type="button" className="secondary" disabled={aborter !== undefined || signed} onClick={() => void extract({ scanAllArticles: true })}>{text('Read all articles', '全条文を読ませる')}</button>
      </>}
    </div>
    {topics.length === 0 && <p className="empty-state">{text('The playbook has no enabled clause types. Add clause types in the playbook step.', '審査基準に有効な条項の種類がありません。審査基準の手順で追加してください。')}</p>}
    <div className="contract-split">
      <ContractTextView document={document} ranges={ranges} {...(active === undefined ? {} : { focus: active })} onSelect={setSelection} />
      <div className="contract-cards">
        {topics.map((topic) => {
          const clause = clauses.find((entry) => entry.topicId === topic.id);
          const value = clause?.value;
          return <article key={topic.id} className={`workspace-card contract-card${active?.topicId === topic.id ? ' active' : ''}`} data-topic-card={topic.id} onClick={() => { seq.current += 1; setActive({ topicId: topic.id, seq: seq.current }); }}>
            <header><h3>{topic.label}</h3>{clause?.articleRef !== undefined && <small>{clause.articleRef}</small>}{clause?.confidence !== undefined && <small>{text(`confidence ${Math.round(clause.confidence * 100)}%`, `確信度 ${Math.round(clause.confidence * 100)}%`)}</small>}</header>
            {clause === undefined || !clause.present
              ? <p className="empty-state">{text('Not found in the contract text.', '本文に見つかりませんでした。')}</p>
              : clause.evidence.map((entry, index) => <blockquote key={index} className={entry.verified ? '' : 'contract-unverified'}>{entry.quote}{!entry.verified && <small> {text('(not found in the text)', '（本文に見つかりません）')}</small>}</blockquote>)}
            {clause?.warnings.map((warning, index) => warning.code === undefined
              ? <small key={index} className="contract-note">{warning.message}</small>
              : <ReasonCard key={index} code={warning.code} detail={{ message: warning.message, days: warning.days ?? null }} topicId={topic.id} onAction={(action) => handleAction(action, clause)} />)}
            {clause?.candidates !== undefined && clause.candidates.length > 1 && <fieldset className="contract-fieldset"><legend>{text('Choose the clause that prevails', '優先する条文を選ぶ')}</legend>
              {clause.candidates.map((candidate, index) => <button key={index} type="button" className="secondary" disabled={signed} onClick={() => setClause(topic.id, { ...clause, ...(candidate.articleRef === undefined ? {} : { articleRef: candidate.articleRef }), evidence: candidate.evidence, ...(candidate.value === undefined ? {} : { value: candidate.value }), source: 'manual', warnings: clause.warnings.filter((warning) => warning.code !== 'conflicting-clauses'), candidates: undefined })}>{candidate.articleRef ?? text(`Candidate ${index + 1}`, `候補 ${index + 1}`)}: {candidate.evidence[0]?.quote.slice(0, 60)}</button>)}
            </fieldset>}
            <div className="contract-value-form">
              {valueFields(topic.valueKind, text).map((field) => {
                const current = value?.[field.key];
                const update = (raw: string | boolean) => setClause(topic.id, { ...(clause ?? { topicId: topic.id, present: true, evidence: [], source: 'manual', warnings: [] }), present: true, source: 'manual', value: setValueField(value ?? emptyValue(topic.valueKind), field, raw) });
                if (field.input === 'boolean') return <label key={field.key} className="contract-check"><input type="checkbox" disabled={signed} checked={current === true} onChange={(event) => update(event.target.checked)} />{field.label}</label>;
                if (field.input === 'select') return <Field key={field.key} label={field.label}><select disabled={signed} value={current === undefined ? '' : String(current)} onChange={(event) => update(event.target.value)}>{field.options!.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>;
                if (field.input === 'day') return <Field key={field.key} label={field.label}><select disabled={signed} value={current === undefined ? '' : String(current)} onChange={(event) => update(event.target.value)}><option value="">{text('— unknown —', '— 不明 —')}</option><option value="month_end">{text('month end', '末日')}</option>{field.key === 'closingDay' && <option value="none">{text('no closing', '締めなし')}</option>}{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></Field>;
                return <Field key={field.key} label={field.label}><input disabled={signed} type={field.input === 'date' ? 'date' : field.input === 'number' ? 'number' : 'text'} value={current === undefined ? '' : String(current)} onChange={(event) => update(event.target.value)} /></Field>;
              })}
            </div>
            <div className="run-failure-actions">
              <button type="button" className="secondary" disabled={signed || selection === undefined} onClick={() => { if (selection !== undefined) setClause(topic.id, clauseFromSelection(clause, topic.id, document, selection.start, selection.end) ?? clause); }}>{text('Use the selected text as evidence', 'このトピックの根拠にする')}</button>
              {clause?.present === true && <button type="button" className="secondary" disabled={signed} onClick={() => setClause(topic.id, { topicId: topic.id, present: false, evidence: [], source: 'manual', warnings: [] })}>{text('Mark as not present', '条項なしにする')}</button>}
            </div>
          </article>;
        })}
      </div>
    </div>
    <div className="run-failure-actions">
      <button type="button" className="primary" disabled={busy || signed} onClick={() => void confirm()}>{text('Confirm the clauses', '確認して確定')}</button>
      {signed && <small>{text('This contract is registered as signed. Edit the clauses of the signed contract in the ledger.', 'この契約は締結登録済みです。条項は台帳の締結済み契約で直してください。')}</small>}
    </div>
  </section>;
}
