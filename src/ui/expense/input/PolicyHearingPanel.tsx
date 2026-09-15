import { useRef, useState } from 'react';
import { expenseInputApi } from '../../api/expense-input-api';
import type {
  ExpenseHearingAnswerValueDto, ExpenseHearingQuestionDto, ExpensePolicyChangeKindDto, ExpensePolicyDiffDto, ExpensePolicyHearingDto, ExpensePolicyHearingSummaryDto,
} from '../../api/expense-input-types';
import type { ExpenseCapabilitiesDto } from '../../api/expense-types';
import { isAbortError } from '../../api/tool-api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import type { ExpensePolicyHearingSlotProps } from '../expense-slots';
import { messageOf } from '../expense-shared';
import { ModelUnavailableNotice, compactValue, isApiErrorCode, readFileBytes, useOpenModelSettings } from './input-shared';
import './input.css';

export const HEARING_DOCUMENT_MAX = 50_000;

type Text = (english: string, japanese: string) => string;
type Failure =
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'schema'; readonly message: string; readonly retry: () => void }
  | { readonly kind: 'error'; readonly message: string };

export function hearingAvailable(capabilities: ExpenseCapabilitiesDto | undefined): boolean {
  return (capabilities?.policyHearing as { readonly enabled?: boolean } | undefined)?.enabled === true;
}

function kindLabel(kind: ExpensePolicyChangeKindDto, text: Text): string {
  return kind === 'add' ? text('Add', '追加') : kind === 'update' ? text('Change', '変更') : text('Disable', '無効化');
}

/** 質問に未回答の最後の往復。 */
function openQuestions(hearing: ExpensePolicyHearingDto): readonly ExpenseHearingQuestionDto[] {
  const last = hearing.turns[hearing.turns.length - 1];
  return last === undefined || last.answers !== undefined ? [] : last.questions;
}

/** 規程の「社内規程から案を作る」ボタンとヒアリングのパネル（§20.7.2, §20.10.1）。 */
export function PolicyHearingPanel(props: ExpensePolicyHearingSlotProps) {
  const { text } = useI18n();
  const openSettings = useOpenModelSettings();
  const api = expenseInputApi(props.transport);
  const available = hearingAvailable(props.capabilities);
  const [open, setOpen] = useState(false);
  const [resumable, setResumable] = useState<readonly ExpensePolicyHearingSummaryDto[]>([]);
  const [mode, setMode] = useState<'document' | 'questions'>('document');
  const [documentText, setDocumentText] = useState('');
  const [fileName, setFileName] = useState('');
  const [hearing, setHearing] = useState<ExpensePolicyHearingDto>();
  const [answers, setAnswers] = useState<Readonly<Record<string, ExpenseHearingAnswerValueDto>>>({});
  const [diff, setDiff] = useState<ExpensePolicyDiffDto>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [aborter, setAborter] = useState<AbortController>();
  const [failure, setFailure] = useState<Failure>();
  const [notice, setNotice] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [confirmSave, setConfirmSave] = useState(false);
  const lastAction = useRef<() => void>(() => undefined);

  const fail = (cause: unknown, retry: () => void) => {
    if (isAbortError(cause)) { setNotice(text('Stopped. Nothing was changed.', '中断しました。何も変わっていません。')); return; }
    const message = messageOf(cause);
    if (isApiErrorCode(cause, 'EXPENSE_HEARING_UNAVAILABLE')) setFailure({ kind: 'unavailable', message });
    else if (isApiErrorCode(cause, 'EXPENSE_POLICY_CONFLICT')) setFailure({ kind: 'conflict', message });
    else if (isApiErrorCode(cause, 'EXPENSE_HEARING_SCHEMA')) setFailure({ kind: 'schema', message, retry });
    else setFailure({ kind: 'error', message });
  };

  /** 待つ操作（中断できるものは signal を受け取る）。 */
  const perform = async (action: (signal: AbortSignal) => Promise<void>, retry: () => void) => {
    const controller = new AbortController();
    lastAction.current = retry;
    setAborter(controller);
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    setFeedback(undefined);
    try {
      await action(controller.signal);
    } catch (cause: unknown) {
      fail(cause, retry);
    } finally {
      setBusy(false);
      setAborter(undefined);
    }
  };

  const loadDiff = async (id: string) => {
    const next = await api.diffHearing(props.scope, id);
    setDiff(next);
    setSelected(new Set());
  };

  const receive = async (next: ExpensePolicyHearingDto) => {
    setHearing(next);
    setAnswers({});
    setDiff(undefined);
    if (next.status === 'proposed') await loadDiff(next.id);
  };

  const openPanel = () => {
    setOpen(true);
    void api.listHearings(props.scope)
      .then((hearings) => setResumable(hearings.filter((entry) => entry.status === 'open' || entry.status === 'proposed')))
      .catch(() => setResumable([]));
  };

  const start = () => void perform(async (signal) => {
    const body = mode === 'document'
      ? { mode, documentText, ...(fileName.trim() === '' ? {} : { fileName: fileName.trim() }) }
      : { mode };
    await receive(await api.startHearing(props.scope, body, signal));
  }, start);

  const resume = (id: string) => void perform(async () => { await receive(await api.getHearing(props.scope, id)); }, () => resume(id));

  const answer = () => {
    if (hearing === undefined) return;
    const id = hearing.id;
    const payload = openQuestions(hearing).filter((question) => answers[question.id] !== undefined).map((question) => ({ questionId: question.id, value: answers[question.id] as ExpenseHearingAnswerValueDto }));
    void perform(async (signal) => { await receive(await api.answerHearing(props.scope, id, payload, signal)); }, answer);
  };

  const rebuildDiff = () => {
    if (hearing === undefined) return;
    const id = hearing.id;
    void perform(async () => { await loadDiff(id); }, rebuildDiff);
  };

  const accept = () => {
    if (hearing === undefined || diff === undefined) return;
    const id = hearing.id;
    const changeIds = [...selected];
    const base = diff.basePolicyUpdatedAt;
    setConfirmSave(false);
    void perform(async () => {
      const result = await api.acceptHearing(props.scope, id, changeIds, base);
      setHearing(result.hearing);
      setDiff(undefined);
      setSelected(new Set());
      props.onPolicySaved({ policy: result.policy, saved: true });
      setFeedback(text(`Saved ${changeIds.length} change(s) to the policy. Check the claims again to apply them.`, `${changeIds.length} 件の変更を規程に保存しました。反映するには申請をもう一度チェックしてください。`));
    }, accept);
  };

  const cancelHearing = () => {
    if (hearing === undefined) return;
    const id = hearing.id;
    void perform(async () => {
      await api.cancelHearing(props.scope, id);
      setHearing(undefined);
      setDiff(undefined);
      setSelected(new Set());
      setResumable((current) => current.filter((entry) => entry.id !== id));
      setNotice(text('The hearing was cancelled. The policy was not changed.', 'ヒアリングをやめました。規程は変わっていません。'));
    }, cancelHearing);
  };

  const loadFile = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      setDocumentText(new TextDecoder('utf-8').decode(await readFileBytes(file)));
      setFileName(file.name);
    } catch (cause: unknown) {
      setFailure({ kind: 'error', message: messageOf(cause) });
    }
  };

  const toggle = (id: string, on: boolean) => setSelected((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });

  if (!available) {
    return <section className="workspace-card expense-input-hearing" aria-labelledby="expense-input-hearing-heading">
      <h2 id="expense-input-hearing-heading">{text('Draft the policy from your company rules', '社内規程から案を作る')}</h2>
      <button type="button" className="secondary" disabled>{text('Draft from company rules', '社内規程から案を作る')}</button>
      <ModelUnavailableNotice title={text('Available once a model is chosen in Settings', '設定でモデルを選ぶと使えます')} cause={props.capabilities === undefined
        ? text('The server has not reported whether drafting is available yet.', 'サーバーから案づくりの可否がまだ取得できていません。')
        : text('Drafting the policy needs a main model with structured output.', '案づくりには構造化出力に対応した main モデルが必要です。')} />
    </section>;
  }

  const documentLength = documentText.length;
  const questions = hearing === undefined ? [] : openQuestions(hearing);
  const proposal = hearing?.proposal;

  return <section className="workspace-card expense-input-hearing" aria-labelledby="expense-input-hearing-heading">
    <div className="expense-row-between">
      <h2 id="expense-input-hearing-heading">{text('Draft the policy from your company rules', '社内規程から案を作る')}</h2>
      {!open && <button type="button" className="secondary" onClick={openPanel}>{text('Draft from company rules', '社内規程から案を作る')}</button>}
    </div>
    <p className="expense-input-hint">{text('A model reads your rules and proposes changes. Nothing is saved until you choose changes and save them.', 'モデルが規程を読んで変更の案を作ります。変更を選んで保存するまで規程は変わりません。')}</p>
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    {!open ? null : <>
      <p className="notice-card" role="note">{text('If the main model is an external provider, the rule text you paste is sent to that provider.', 'main モデルが外部のプロバイダの場合、貼り付けた規程文はそのプロバイダへ送られます。')}</p>

      {failure?.kind === 'unavailable' && <ModelUnavailableNotice failed title={text('Available once a model is chosen in Settings', '設定でモデルを選ぶと使えます')} cause={failure.message} />}
      {failure?.kind === 'conflict' && <div className="notice-card" role="alert">
        <strong>{text('The policy changed after the proposal was made', '案を作った後に規程が変わりました')}</strong>
        <p>{failure.message}</p>
        <div className="run-failure-actions"><button type="button" className="primary" onClick={rebuildDiff}>{text('Recreate the diff', '差分を作り直す')}</button></div>
      </div>}
      {failure?.kind === 'schema' && <div className="notice-card" role="alert">
        <strong>{text('The proposal did not fit the expected form', '案が決まった形になりませんでした')}</strong>
        <p>{failure.message}</p>
        <div className="run-failure-actions">
          <button type="button" className="secondary" onClick={failure.retry}>{text('Try again', 'もう一度試す')}</button>
          <button type="button" className="secondary" onClick={openSettings}>{text('Try another model (open Settings)', '別のモデルで試す（設定を開く）')}</button>
        </div>
      </div>}
      {failure?.kind === 'error' && <div className="api-error" role="alert">
        <p>{failure.message}</p>
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => lastAction.current()}>{text('Try again', 'もう一度試す')}</button></div>
      </div>}
      {notice !== undefined && <p className="empty-state" role="status">{notice}</p>}
      {aborter !== undefined && <div className="expense-actions">
        <span role="status">{text('Working with the model… this can take a few minutes.', 'モデルで処理しています…数分かかることがあります。')}</span>
        <button type="button" className="secondary" onClick={() => aborter.abort()}>{text('Stop', '中断')}</button>
      </div>}

      {hearing === undefined && <>
        {resumable.length > 0 && <div>
          <h3>{text('Continue a hearing', '続きから再開')}</h3>
          <ul>{resumable.map((entry) => <li key={entry.id}>
            {entry.fileName ?? (entry.mode === 'document' ? text('Pasted rules', '貼り付けた規程') : text('Questions', '質問'))}{' '}
            ({entry.status === 'proposed' ? text(`${entry.proposedItemCount} proposed`, `案 ${entry.proposedItemCount} 件`) : text('answering', '回答中')}){' '}
            <button type="button" className="secondary" disabled={busy} onClick={() => resume(entry.id)}>{text('Resume', '再開')}</button>
          </li>)}</ul>
        </div>}
        <fieldset>
          <legend>{text('How to start', '始め方')}</legend>
          <label><input type="radio" name="expense-input-hearing-mode" checked={mode === 'document'} onChange={() => setMode('document')} /> {text('Paste the rules document', '規程の文書を貼る')}</label>{' '}
          <label><input type="radio" name="expense-input-hearing-mode" checked={mode === 'questions'} onChange={() => setMode('questions')} /> {text('Answer questions', '質問に答える')}</label>
        </fieldset>
        {mode === 'document' && <div className="expense-form">
          <label className="expense-wide">{text('Rules text', '規程文')}
            <textarea aria-label={text('Rules text', '規程文')} value={documentText} onChange={(event) => setDocumentText(event.target.value)} />
            <small className={documentLength > HEARING_DOCUMENT_MAX ? 'expense-input-warn' : 'expense-input-hint'}>
              {documentLength.toLocaleString('en-US')} / {HEARING_DOCUMENT_MAX.toLocaleString('en-US')}
              {documentLength > HEARING_DOCUMENT_MAX ? text(' — too long. Paste only the expense-related sections.', ' — 長すぎます。経費に関係する節だけを貼ってください。') : ''}
            </small>
          </label>
          <label>{text('File name (optional)', 'ファイル名（任意）')}
            <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
          </label>
          <label>{text('Load a text file', 'テキストファイルを読み込む')}
            <input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => { void loadFile(event.target.files?.[0]); event.target.value = ''; }} />
          </label>
        </div>}
        <div className="expense-actions">
          <button type="button" className="primary" disabled={busy || (mode === 'document' && (documentText.trim() === '' || documentLength > HEARING_DOCUMENT_MAX))} onClick={start}>
            {mode === 'document' ? text('Create a proposal', '案を作る') : text('Start the questions', '質問を始める')}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>{text('Close', '閉じる')}</button>
        </div>
      </>}

      {hearing !== undefined && hearing.status === 'open' && <div>
        <h3>{text('Questions', '質問')}</h3>
        {questions.length === 0
          ? <p className="empty-state">{text('There are no questions to answer right now.', 'いま答える質問はありません。')}</p>
          : questions.map((question) => <QuestionField key={question.id} question={question} value={answers[question.id]}
            onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))} />)}
        <div className="expense-actions">
          {questions.length > 0 && <button type="button" className="primary" disabled={busy} onClick={answer}>{text('Send the answers', '回答を送る')}</button>}
          <button type="button" className="secondary danger" disabled={busy} onClick={cancelHearing}>{text('Stop this hearing', 'このヒアリングをやめる')}</button>
        </div>
      </div>}

      {hearing !== undefined && hearing.status === 'proposed' && <div>
        <h3>{text('Proposed changes', '変更の案')}</h3>
        {diff?.stale === true && <p className="notice-card" role="note">{text('The policy changed after the proposal was made (the diff was recreated against the current policy).', '案を作った後に規程が変わりました（差分は現在の規程に対して作り直しています）')}</p>}
        {proposal !== undefined && proposal.warnings.length > 0 && <div className="notice-card" role="note">
          <strong>{text('Warnings', '注意')}</strong>
          <ul>{proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>}
        {diff === undefined
          ? <div className="expense-actions">
            <p className="empty-state">{text('The diff has not been loaded.', '差分をまだ読み込んでいません。')}</p>
            <button type="button" className="secondary" disabled={busy} onClick={rebuildDiff}>{text('Load the diff', '差分を読み込む')}</button>
          </div>
          : diff.changes.length === 0
            ? <p className="empty-state">{text('The proposal matches the current policy. There is nothing to change.', '案は現在の規程と同じです。変更はありません。')}</p>
            : <>
              <div className="expense-actions">
                <button type="button" className="secondary" onClick={() => setSelected(new Set(diff.changes.filter((change) => change.rationale?.quoteFound === true).map((change) => change.id)))}>{text('Select all changes with a source', '根拠のある変更をすべて選ぶ')}</button>
                <span>{text(`${selected.size} of ${diff.changes.length} selected`, `${diff.changes.length} 件中 ${selected.size} 件を選択`)}</span>
              </div>
              <div className="table-wrap"><table className="expense-input-table">
                <thead><tr><th>{text('Use', '採用')}</th><th>{text('Kind', '種類')}</th><th>{text('Path', '場所')}</th><th>{text('Before → after', '前 → 後')}</th><th>{text('Source', '根拠')}</th></tr></thead>
                <tbody>{diff.changes.map((change) => {
                  const before = compactValue(change.before);
                  const after = compactValue(change.after);
                  return <tr key={change.id}>
                    <td><input type="checkbox" aria-label={text(`Use ${change.path}`, `${change.path} を採用`)} checked={selected.has(change.id)} onChange={(event) => toggle(change.id, event.target.checked)} /></td>
                    <td>{kindLabel(change.kind, text)}</td>
                    <td><code>{change.path}</code></td>
                    <td className="expense-input-value"><span title={before.full}>{before.short}</span> → <span title={after.full}>{after.short}</span></td>
                    <td>
                      {change.rationale?.quote !== undefined && <q>{change.rationale.quote}</q>}
                      {change.rationale === undefined
                        ? <span className="expense-input-not-found">{text('No source', '根拠なし')}</span>
                        : change.rationale.quoteFound
                          ? <span className="expense-input-found"> {text('Source found', '根拠あり')}</span>
                          : <span className="expense-input-not-found"> {text('Source not found', '根拠が見つからない')}</span>}
                      {change.rationale?.note !== undefined && <small className="expense-input-hint">{change.rationale.note}</small>}
                    </td>
                  </tr>;
                })}</tbody>
              </table></div>
            </>}
        {proposal !== undefined && proposal.dropped.length > 0 && <details>
          <summary>{text(`Dropped proposals (${proposal.dropped.length})`, `捨てた案（${proposal.dropped.length} 件）`)}</summary>
          <ul>{proposal.dropped.map((entry) => <li key={`${entry.path}-${entry.reason}`}><code>{entry.path}</code>: {entry.reason}</li>)}</ul>
        </details>}
        <div className="expense-actions">
          <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={() => { if (props.dirty) setConfirmSave(true); else accept(); }}>{text('Save the selected changes', '選んだ変更を保存')}</button>
          <button type="button" className="secondary danger" disabled={busy} onClick={cancelHearing}>{text('Stop this hearing', 'このヒアリングをやめる')}</button>
        </div>
      </div>}

      {hearing !== undefined && (hearing.status === 'accepted' || hearing.status === 'cancelled') && <div className="expense-actions">
        <button type="button" className="secondary" onClick={() => { setHearing(undefined); setFeedback(undefined); }}>{text('Start another hearing', '別のヒアリングを始める')}</button>
      </div>}
    </>}
    <ConfirmDialog open={confirmSave}
      title={text('Discard unsaved policy changes?', '規程タブの未保存の変更を捨てますか？')}
      message={text('Unsaved changes on the policy tab will be lost when the policy is reloaded.', '規程タブの未保存の変更は読み直しで消えます')}
      confirmLabel={text('Save the selected changes', '選んだ変更を保存')} cancelLabel={text('Cancel', 'キャンセル')}
      onConfirm={accept} onCancel={() => setConfirmSave(false)} />
  </section>;
}

function QuestionField({ question, value, onChange }: { readonly question: ExpenseHearingQuestionDto; readonly value: ExpenseHearingAnswerValueDto | undefined; readonly onChange: (value: ExpenseHearingAnswerValueDto) => void }) {
  const { text } = useI18n();
  const name = `expense-input-question-${question.id}`;
  const options = question.options ?? [];
  const body = (() => {
    switch (question.kind) {
      case 'single': return options.map((option) => <label key={option}><input type="radio" name={name} checked={value === option} onChange={() => onChange(option)} /> {option}</label>);
      case 'multi': {
        const chosen = Array.isArray(value) ? value as readonly string[] : [];
        return options.map((option) => <label key={option}><input type="checkbox" checked={chosen.includes(option)} onChange={(event) => onChange(event.target.checked ? [...chosen, option] : chosen.filter((entry) => entry !== option))} /> {option}</label>);
      }
      case 'number': return <input type="number" aria-label={question.text} value={typeof value === 'number' ? value : ''} onChange={(event) => { if (event.target.value !== '') onChange(Number(event.target.value)); }} />;
      case 'confirm': return <>
        <label><input type="radio" name={name} checked={value === true} onChange={() => onChange(true)} /> {text('Yes', 'はい')}</label>
        <label><input type="radio" name={name} checked={value === false} onChange={() => onChange(false)} /> {text('No', 'いいえ')}</label>
      </>;
      case 'text': return <input aria-label={question.text} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />;
    }
  })();
  return <fieldset className="expense-input-question">
    <legend>{question.text}</legend>
    <div className="expense-checks">{body}</div>
  </fieldset>;
}
