import { useEffect, useState } from 'react';
import type { ContractApi } from '../api/contract-api';
import type { ContractDocumentDto, DeadlinePreviewDto, SigningMethodDto } from '../api/contract-types';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { deadlineKindLabel, formatYen } from './contract-model';
import type { ReasonAction } from './contract-reasons';
import { ApiFailure, Field, ReasonCard } from './contract-shared';

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 締結登録（docs/23 §7.1）。締結日・締結方法・印紙を入れると、期限（満了日・通知期限・更新日）と突き合わせを即時に計算して見せる。
 * レビュー未実施・未確定でも登録できるが、その旨を警告する。
 */
export function SignStep({ api, document, onRegistered, onAction }: {
  readonly api: ContractApi;
  readonly document: ContractDocumentDto;
  readonly onRegistered: (contractId: string) => void;
  readonly onAction: (action: ReasonAction) => void;
}) {
  const { text } = useI18n();
  const [title, setTitle] = useState(document.title);
  const [counterparty, setCounterparty] = useState('');
  const [signedDate, setSignedDate] = useState(today());
  const [method, setMethod] = useState<SigningMethodDto>('paper');
  const [amount, setAmount] = useState(document.contractAmount === undefined ? '' : String(document.contractAmount));
  const [stampCode, setStampCode] = useState('');
  const [affixed, setAffixed] = useState<'yes' | 'no' | 'unknown'>('unknown');
  const [preview, setPreview] = useState<DeadlinePreviewDto>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const contractAmount = amount.trim() === '' || !Number.isFinite(Number(amount)) ? undefined : Math.trunc(Number(amount));

  useEffect(() => {
    let active = true;
    void api.previewDeadlines(scope, { documentId: document.id, ...(signedDate === '' ? {} : { signedDate }), signingMethod: method, ...(contractAmount === undefined ? {} : { contractAmount }) })
      .then((next) => { if (!active) return; setPreview(next); setCounterparty((current) => current || next.counterpartyName || ''); setError(undefined); })
      .catch((cause: unknown) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [api, document.id, signedDate, method, contractAmount]);

  async function register(): Promise<void> {
    setBusy(true); setError(undefined);
    try {
      const candidate = preview?.stampDutyCandidates.find((entry) => entry.documentTypeCode === stampCode);
      const result = await api.registerSigned(scope, {
        documentId: document.id, signedDate, signingMethod: method,
        ...(title.trim() === '' ? {} : { title: title.trim() }), ...(counterparty.trim() === '' ? {} : { counterpartyName: counterparty.trim() }),
        ...(method === 'paper' ? { stampDuty: { affixed: affixed === 'unknown' ? null : affixed === 'yes', ...(stampCode === '' ? {} : { documentTypeCode: stampCode }), ...(candidate?.amount === null || candidate === undefined ? {} : { amount: candidate.amount }) } } : {}),
      });
      onRegistered(result.contract.id);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  // 「台帳で開く」は該当契約まで開く（手順の切替だけだと台帳で契約が選ばれない）。契約 id が分かれば締結登録後と同じ導線を使う。
  const openInLedger = (contractId: string | undefined) => { if (contractId === undefined) onAction({ kind: 'step', step: 'ledger', label: '' }); else onRegistered(contractId); };

  if (document.status === 'signed') return <section className="contract-step"><p className="empty-state">{text('This contract is already registered as signed.', 'この契約は締結登録済みです。')}</p><button type="button" className="secondary" onClick={() => openInLedger(document.signedContractId)}>{text('Open it in the ledger', '台帳で開く')}</button></section>;

  return <section className="contract-step contract-sign" aria-label={text('Sign', '締結登録')}>
    {error !== undefined && <ApiFailure cause={error} onStep={(step, contractId) => step === 'ledger' ? openInLedger(contractId) : onAction({ kind: 'step', step, label: '' })} />}
    {preview?.review === 'none' && <p className="notice-card" role="note">{text('This contract has not been reviewed. It will be put on the ledger without checking it against the playbook.', 'この契約はレビューしていません。審査基準との照合なしで台帳に載せます。')}</p>}
    {preview?.review === 'draft' && <p className="notice-card" role="note">{text('The review is not finalized yet.', 'レビューの判定を確定していません。')}</p>}
    <div className="workspace-card contract-form-row">
      <Field label={text('Title', 'タイトル')}><input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label={text('Counterparty', '相手方')}><input value={counterparty} onChange={(event) => setCounterparty(event.target.value)} /></Field>
      <Field label={text('Signed on', '締結日')}><input type="date" value={signedDate} onChange={(event) => setSignedDate(event.target.value)} /></Field>
      <Field label={text('Signing method', '締結方法')}><select value={method} onChange={(event) => setMethod(event.target.value as SigningMethodDto)}><option value="paper">{text('paper', '紙')}</option><option value="electronic">{text('electronic', '電子')}</option><option value="unknown">{text('unknown', '不明')}</option></select></Field>
      <Field label={text('Contract amount (JPY)', '契約金額（円）')}><input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
    </div>
    <div className="workspace-card">
      <h3>{text('Stamp duty', '印紙')}</h3>
      {preview?.stampDutyCandidates.length === 0 && <p>{text('No stamp duty candidate for this contract nature.', 'この契約の性質では印紙税の候補はありません。')}</p>}
      {preview?.stampDutyCandidates.map((candidate) => <label key={candidate.documentTypeCode} className="contract-check">
        <input type="radio" name="stamp" checked={stampCode === candidate.documentTypeCode} onChange={() => setStampCode(candidate.documentTypeCode)} disabled={method !== 'paper'} />
        {candidate.name} — {candidate.electronic ? text('electronic contracts are generally not taxable documents; follow your company policy', '電子契約は課税文書の作成に当たらないとされます（社内の判断に従ってください）') : candidate.code === 'stamp-duty-amount-unknown' ? text('enter the contract amount to decide the tax', '契約金額を入れると税額が決まります') : formatYen(candidate.amount, text)}
        {candidate.sourceUrl !== '' && <a href={candidate.sourceUrl} target="_blank" rel="noreferrer"> {text('source', '出典')}</a>}
      </label>)}
      {method === 'paper' && <Field label={text('Stamp affixed?', '印紙を貼付しましたか')}><select value={affixed} onChange={(event) => setAffixed(event.target.value as 'yes' | 'no' | 'unknown')}><option value="unknown">{text('not checked', '未確認')}</option><option value="yes">{text('yes', 'はい')}</option><option value="no">{text('no', 'いいえ')}</option></select></Field>}
    </div>
    <div className="workspace-card">
      <h3>{text('Deadline preview', '期限プレビュー')}</h3>
      {preview === undefined ? <p>{text('Calculating…', '計算中…')}</p> : preview.deadlines.length === 0 ? <p className="empty-state">{text('No deadlines can be calculated yet.', 'まだ期限を計算できません。')}</p>
        : <table className="journal-table"><thead><tr><th>{text('Kind', '種類')}</th><th>{text('Due', '期限日')}</th><th>{text('Basis', '根拠')}</th></tr></thead>
          <tbody>{preview.deadlines.map((deadline) => <tr key={deadline.id}><td>{deadlineKindLabel(deadline.kind, text)}</td><td>{deadline.dueDate}</td><td>{deadline.basis}</td></tr>)}</tbody></table>}
      {preview?.warnings.map((warning, index) => warning.code === undefined ? <p key={index} className="contract-note">{warning.message}</p> : <ReasonCard key={index} code={warning.code} detail={{ message: warning.message, date: warning.message }} onAction={onAction} />)}
    </div>
    <button type="button" className="primary" disabled={busy || signedDate === '' || counterparty.trim() === ''} onClick={() => void register()}>{text('Register as signed', '締結登録する')}</button>
    {counterparty.trim() === '' && <small>{text('Enter the counterparty.', '相手方を入力してください。')}</small>}
  </section>;
}
