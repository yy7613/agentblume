import { useEffect, useRef, useState } from 'react';
import { isAbortError, type ToolApiClient } from '../api/tool-api';
import type { AcceptJournalHearingResultDto, JournalChartOfAccountsDto, JournalHearingDto, JournalHearingQuestionDto, JournalJsonValueDto, SaveJournalRuleDto } from '../api/types';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import {
  answeredHearingQuestions, describeOutcomeLine, formatYen, hearingAnswerLabel, hearingAnswerValue, pendingHearingQuestions, resolveAccountName, resolveTaxName,
  summarizeConditions, summarizeScope,
} from './journal-model';
import { messageOf } from './journal-shared';

/** 質問 1 問分の下書き（multi だけ配列）。 */
type AnswerDraft = string | readonly string[];

/**
 * ヒアリング（Stage 2、docs/20 §7）のパネル。質問カード → 提案カード → 登録。
 *
 * 提案の科目は**利用者のマスタの名前**で見せる（マスタに無い新規科目は提案の newAccounts の名前で見せ、
 * 「これらを科目マスタに登録します」のチェックは **既定ですべて外す**。登録は利用者が選んだものだけ）。
 * 提案が使えないとき（科目と合わない等）は「原因 → 次の一手 → 手でルールを作るボタン」に倒す。
 */
export function HearingPanel({ client, chart, documentId, hearingId, onEditRule, onAccepted, onClosed, onOpenEntry, onManualRule }: {
  readonly client: ToolApiClient;
  readonly chart: JournalChartOfAccountsDto | undefined;
  readonly documentId: string;
  /** 進行中のヒアリングがあればその id（無ければ新しく始める）。 */
  readonly hearingId: string | undefined;
  /** 「ルールを編集してから登録」。ルールタブの編集フォームへ提案を持っていく。 */
  readonly onEditRule: (rule: SaveJournalRuleDto) => void;
  readonly onAccepted: (result: AcceptJournalHearingResultDto) => void;
  /** ヒアリングを閉じた（中止した）。一覧を読み直して未確定に戻す。 */
  readonly onClosed: () => void;
  readonly onOpenEntry: (entryId: string) => void;
  /** 「手でルールを作る」（提案が使えないとき）。 */
  readonly onManualRule: () => void;
}) {
  const { text } = useI18n();
  const [hearing, setHearing] = useState<JournalHearingDto>();
  const [aborter, setAborter] = useState<AbortController>();
  const [phase, setPhase] = useState<'starting' | 'answering'>();
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const [drafts, setDrafts] = useState<Readonly<Record<string, AnswerDraft>>>({});
  const [blocked, setBlocked] = useState<string>();
  const [pickedAccounts, setPickedAccounts] = useState<ReadonlySet<string>>(new Set());
  const [pickedTaxes, setPickedTaxes] = useState<ReadonlySet<string>>(new Set());
  const [pickedDimensionValues, setPickedDimensionValues] = useState<ReadonlySet<string>>(new Set());
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState<AcceptJournalHearingResultDto>();
  const [acceptError, setAcceptError] = useState<string>();
  const [closing, setClosing] = useState(false);
  const startedRef = useRef(false);
  const elapsedSeconds = useElapsedSeconds(aborter !== undefined);
  const busy = aborter !== undefined;

  /** LLM を待つ呼び出しの共通処理（中断は失敗ではない）。 */
  const run = async (next: 'starting' | 'answering', call: (signal: AbortSignal) => Promise<JournalHearingDto>) => {
    const controller = new AbortController();
    setAborter(controller);
    setPhase(next);
    setError(undefined);
    setCancelled(false);
    try {
      setHearing(await call(controller.signal));
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else setError(messageOf(cause));
    } finally {
      setAborter(undefined);
      setPhase(undefined);
    }
  };

  const start = () => run('starting', (signal) => (hearingId === undefined
    ? client.createJournalHearing(scope, { documentId }, signal)
    : client.getJournalHearing(hearingId, scope, signal)));

  // 開いた時点で 1 回だけ開始する（中断後の再開は「もう一度試す」ボタンから）。
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [client, documentId, hearingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = hearing === undefined ? [] : pendingHearingQuestions(hearing);
  const answered = hearing === undefined ? [] : answeredHearingQuestions(hearing);
  const proposal = hearing?.proposal;
  const usableProposal = proposal !== undefined && proposal.rule.outcome.lines.length > 0;

  const submit = async () => {
    if (hearing === undefined) return;
    const answers: { readonly questionId: string; readonly value: JournalJsonValueDto }[] = [];
    const missing: string[] = [];
    for (const question of pending) {
      const value = hearingAnswerValue(question, drafts[question.id] ?? '');
      if (value === undefined) missing.push(question.text);
      else answers.push({ questionId: question.id, value });
    }
    if (missing.length > 0) {
      setBlocked(text(`Answer these before continuing: ${missing.join(' / ')}`, `先にこの質問に答えてください: ${missing.join(' / ')}`));
      return;
    }
    setBlocked(undefined);
    await run('answering', (signal) => client.answerJournalHearing(hearing.id, scope, { answers }, signal));
  };

  const accept = async () => {
    if (hearing === undefined || proposal === undefined) return;
    setAccepting(true);
    setAcceptError(undefined);
    try {
      const result = await client.acceptJournalHearing(hearing.id, scope, {
        registerAccountIds: [...pickedAccounts],
        registerDimensionValueIds: [...pickedDimensionValues],
        registerTaxCodes: [...pickedTaxes],
      });
      setAccepted(result);
      setHearing(result.hearing);
      onAccepted(result);
    } catch (cause: unknown) {
      setAcceptError(messageOf(cause));
    } finally {
      setAccepting(false);
    }
  };

  const close = async () => {
    if (hearing === undefined) { onClosed(); return; }
    setClosing(true);
    setAcceptError(undefined);
    try {
      await client.cancelJournalHearing(hearing.id, scope);
      onClosed();
    } catch (cause: unknown) {
      setAcceptError(messageOf(cause));
    } finally {
      setClosing(false);
    }
  };

  const toggle = (set: ReadonlySet<string>, update: (next: ReadonlySet<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    update(next);
  };

  return <section className="journal-hearing" aria-label={text('Hearing', 'ヒアリング')}>
    <h3>{text('Hearing', 'ヒアリング')}</h3>

    {busy && <p role="status">{phase === 'starting'
      ? text(`Preparing the questions… ${elapsedSeconds}s`, `質問を準備しています… ${elapsedSeconds}秒`)
      : text(`Thinking about your answers… ${elapsedSeconds}s`, `回答をもとに考えています… ${elapsedSeconds}秒`)}</p>}
    {busy && <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => aborter?.abort()}>{text('Cancel', '中断')}</button></div>}
    {cancelled && <InlineFeedback kind="info">{text('Cancelled. Nothing was changed; you can start again.', '中断しました。何も変わっていません。もう一度始められます。')}</InlineFeedback>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
    {(hearing?.sessionWarnings ?? []).length > 0 && <ul className="journal-warnings">
      {(hearing?.sessionWarnings ?? []).map((warning, index) => <li key={index} className="notice-card">{warning}</li>)}
    </ul>}
    {!busy && (cancelled || error !== undefined) && <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={() => void start()}>{text('Try again', 'もう一度試す')}</button>
      <button type="button" className="secondary" onClick={onManualRule}>{text('Write a rule by hand', '手でルールを作る')}</button>
      <button type="button" className="secondary" onClick={() => void close()}>{text('Close the hearing', 'ヒアリングをやめる')}</button>
    </div>}

    {answered.length > 0 && <ul className="journal-hearing-history" aria-label={text('Answers so far', 'これまでの回答')}>
      {answered.map(({ question, value }) => <li key={question.id}>{question.text} → <strong>{hearingAnswerLabel(question, value, text)}</strong></li>)}
    </ul>}

    {accepted === undefined && pending.length > 0 && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {pending.map((question) => <QuestionCard
        key={question.id}
        question={question}
        draft={drafts[question.id] ?? ''}
        disabled={busy}
        onChange={(value) => setDrafts((current) => ({ ...current, [question.id]: value }))}
      />)}
      {blocked !== undefined && <p className="field-error" role="alert">{blocked}</p>}
      <div className="run-failure-actions">
        <button type="submit" className="primary" disabled={busy}>{text('Send the answers', '回答を送る')}</button>
        <button type="button" className="secondary" disabled={busy || closing} onClick={() => void close()}>{text('Stop the hearing', 'ヒアリングをやめる')}</button>
      </div>
    </form>}

    {accepted === undefined && usableProposal && proposal !== undefined && <div className="journal-proposal">
      <h4>{text('Proposed rule', '提案されたルール')}</h4>
      <p>{proposal.rationale}</p>
      <p><strong>{text('When', 'こういうとき')}:</strong> {summarizeScope(proposal.rule.scope, text)}{proposal.rule.conditions.length === 0 ? '' : ` · ${summarizeConditions(proposal.rule.conditions, text)}`}</p>
      <ul aria-label={text('Proposed entry lines', '提案する仕訳行')}>
        {proposal.rule.outcome.lines.map((line, index) => <li key={index}>{describeOutcomeLine(line, chart, proposal, text)}</li>)}
      </ul>

      <h4>{text('Entry preview', '仕訳のプレビュー')}</h4>
      <div className="table-wrap"><table className="journal-table" aria-label={text('Proposed entry', '提案する仕訳')}>
        <thead><tr><th>{text('Side', '貸借')}</th><th>{text('Account', '科目')}</th><th>{text('Tax', '税区分')}</th><th>{text('Amount', '金額')}</th></tr></thead>
        <tbody>{proposal.entry.lines.map((line, index) => <tr key={index}>
          <td>{line.side === 'debit' ? text('Debit', '借方') : text('Credit', '貸方')}</td>
          <td>{resolveAccountName(line.accountId, chart, proposal.newAccounts)}</td>
          <td>{resolveTaxName(line.taxCode, chart, proposal.newTaxCategories)}</td>
          <td className="journal-amount">{formatYen(line.amount)}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="empty-state">{proposal.entry.date} · {proposal.entry.description}</p>

      {proposal.warnings.length > 0 && <ul className="journal-warnings">{proposal.warnings.map((warning, index) => <li key={index} className="notice-card">{warning}</li>)}</ul>}

      {(proposal.newAccounts.length > 0 || proposal.newTaxCategories.length > 0 || proposal.newDimensionValues.length > 0) && <div className="journal-register">
        <strong>{text('These will be added to your chart of accounts', 'これらを科目マスタに登録します')}</strong>
        <p className="empty-state">{text('Nothing is added unless you tick it. Untick anything you would rather map to an account you already have (then use "Edit the rule before registering").', 'チェックを入れたものだけを登録します。既存の科目に寄せたいものは外して、「ルールを編集してから登録」で科目を選び直してください。')}</p>
        {proposal.newAccounts.map((account) => <label key={account.id}>
          <input type="checkbox" checked={pickedAccounts.has(account.id)} onChange={() => toggle(pickedAccounts, setPickedAccounts, account.id)} />
          {text(`Account: ${account.name}`, `科目: ${account.name}`)}{account.code === undefined || account.code === '' ? '' : `（${account.code}）`}
        </label>)}
        {proposal.newTaxCategories.map((tax) => <label key={tax.code}>
          <input type="checkbox" checked={pickedTaxes.has(tax.code)} onChange={() => toggle(pickedTaxes, setPickedTaxes, tax.code)} />
          {text(`Tax category: ${tax.name}`, `税区分: ${tax.name}`)}（{tax.code}）
        </label>)}
        {proposal.newDimensionValues.map((value) => <label key={`${value.dimensionId}:${value.id}`}>
          <input type="checkbox" checked={pickedDimensionValues.has(value.id)} onChange={() => toggle(pickedDimensionValues, setPickedDimensionValues, value.id)} />
          {text(`Dimension value: ${value.name}`, `補助軸の値: ${value.name}`)}
        </label>)}
      </div>}

      {acceptError !== undefined && <p className="api-error" role="alert">{acceptError}</p>}
      <div className="run-failure-actions">
        <button type="button" className="primary" disabled={accepting || closing} onClick={() => void accept()}>{accepting ? text('Registering…', '登録中…') : text('Register this rule', 'このルールを登録')}</button>
        <button type="button" className="secondary" disabled={accepting || closing} onClick={() => onEditRule(proposal.rule)}>{text('Edit the rule before registering', 'ルールを編集してから登録')}</button>
        <button type="button" className="secondary" disabled={accepting || closing} onClick={() => void close()}>{text('Stop the hearing', 'ヒアリングをやめる')}</button>
      </div>
    </div>}

    {/* 提案が無い / 使えない（科目と噛み合わない）。原因 → 次の一手 → 手でルールを作るボタン。 */}
    {accepted === undefined && !busy && !cancelled && error === undefined && hearing !== undefined && pending.length === 0 && !usableProposal && <div className="journal-reason journal-reason-undecided" role="alert">
      <p><strong>{text('Cause', '原因')}:</strong> {text("The model's proposal did not line up with your chart of accounts, so there is nothing to register.", 'モデルの提案が科目マスタと合わなかったため、登録できるルールになりませんでした。')}</p>
      <p><strong>{text('Next step', '次の一手')}:</strong> {text('Write the rule by hand (the conditions are prefilled from this document), or try the hearing again.', 'ルールを手で作る（この帳票から条件を事前入力します）か、もう一度ヒアリングを試してください。')}</p>
      {proposal !== undefined && proposal.warnings.length > 0 && <ul className="journal-warnings">{proposal.warnings.map((warning, index) => <li key={index} className="notice-card">{warning}</li>)}</ul>}
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={onManualRule}>{text('Write a rule by hand', '手でルールを作る')}</button>
        <button type="button" className="secondary" onClick={() => void start()}>{text('Try the hearing again', 'もう一度ヒアリングする')}</button>
        <button type="button" className="secondary" disabled={closing} onClick={() => void close()}>{text('Stop the hearing', 'ヒアリングをやめる')}</button>
      </div>
    </div>}

    {accepted !== undefined && <div className="journal-proposal">
      <InlineFeedback kind="success">{text(`Registered rule "${accepted.rule.name}" and created the entry. The document is decided now.`, `ルール「${accepted.rule.name}」を登録し、仕訳を作りました。この帳票は確定になりました。`)}</InlineFeedback>
      <div className="table-wrap"><table className="journal-table" aria-label={text('Created entry', '作成した仕訳')}>
        <thead><tr><th>{text('Side', '貸借')}</th><th>{text('Account', '科目')}</th><th>{text('Tax', '税区分')}</th><th>{text('Amount', '金額')}</th></tr></thead>
        <tbody>{accepted.entry.lines.map((line, index) => <tr key={index}>
          <td>{line.side === 'debit' ? text('Debit', '借方') : text('Credit', '貸方')}</td>
          <td>{resolveAccountName(line.accountId, accepted.chart)}</td>
          <td>{resolveTaxName(line.taxCode, accepted.chart)}</td>
          <td className="journal-amount">{formatYen(line.amount)}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => onOpenEntry(accepted.entry.id)}>{text('Open in the Export tab', '出力タブで開く')}</button>
        <button type="button" className="secondary" onClick={onClosed}>{text('Close', '閉じる')}</button>
      </div>
    </div>}
  </section>;
}

/** 質問 1 問。kind ごとに入力の形を変え、法令メモ（note）があれば question の下に出す。 */
function QuestionCard({ question, draft, disabled, onChange }: {
  readonly question: JournalHearingQuestionDto;
  readonly draft: AnswerDraft;
  readonly disabled: boolean;
  readonly onChange: (value: AnswerDraft) => void;
}) {
  const { text } = useI18n();
  const selected = Array.isArray(draft) ? draft : [];
  const single = Array.isArray(draft) ? draft[0] ?? '' : draft;
  const note = question.note === undefined || question.note === '' ? null : <small className="journal-question-note">{question.note}</small>;

  if (question.kind === 'text' || question.kind === 'number') {
    return <div className="journal-question">
      <strong>{question.text}</strong>
      {note}
      <input
        type={question.kind === 'number' ? 'number' : 'text'}
        aria-label={question.text}
        value={single}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>;
  }

  const options = question.kind === 'confirm'
    ? [{ value: 'yes', label: text('Yes', 'はい') }, { value: 'no', label: text('No', 'いいえ') }]
    : (question.options ?? []).map((option) => ({ value: option.value, label: option.label, ...(option.hint === undefined ? {} : { hint: option.hint }) }));

  return <fieldset className="journal-question">
    <legend>{question.text}</legend>
    {note}
    {options.map((option) => <label key={option.value}>
      <input
        type={question.kind === 'multi' ? 'checkbox' : 'radio'}
        name={question.id}
        value={option.value}
        disabled={disabled}
        checked={question.kind === 'multi' ? selected.includes(option.value) : single === option.value}
        onChange={() => onChange(question.kind === 'multi'
          ? (selected.includes(option.value) ? selected.filter((item) => item !== option.value) : [...selected, option.value])
          : option.value)}
      />
      {option.label}{'hint' in option && option.hint !== undefined ? ` — ${option.hint}` : ''}
    </label>)}
  </fieldset>;
}
