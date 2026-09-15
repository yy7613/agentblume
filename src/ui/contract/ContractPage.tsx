import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { contractApi, CONTRACT_CAPABILITIES_DISABLED_DTO } from '../api/contract-api';
import type { ContractCapabilitiesDto, ContractDocumentDto, ContractDocumentSummaryDto, PlaybookDto, ReviewEnvelopeDto } from '../api/contract-types';
import type { BusinessPageProps } from '../business/types';
import { BusinessStepper, type BusinessStep } from '../components/BusinessStepper';
import { useI18n } from '../i18n';
import { ScreenLink, useOpenInScreen, usePendingOpen } from '../navigation';
import { scope } from '../scope';
import { ClausesStep } from './ClausesStep';
import { parseContractTarget, stepBlocker, type ContractStep } from './contract-model';
import type { ReasonAction } from './contract-reasons';
import { ApiFailure, LegalNotice } from './contract-shared';
import { ImportStep } from './ImportStep';
import { LedgerStep } from './LedgerStep';
import { PlaybookStep } from './PlaybookStep';
import { ReviewStep } from './ReviewStep';
import { SignStep } from './SignStep';
import './contract.css';

/**
 * 契約書レビューと期限台帳（docs/23 §7）。手順: 審査基準 → 取込 → 条項抽出 → レビュー → 締結登録 → 期限台帳。
 * 最初に開くのは「取込」（審査基準は未保存でも既定テンプレートで判定できるので、設定表へいきなり着地させない）。
 * 理由コードのボタン（原因 → 次の一手 → その場所）はここで手順と対象へ振り分ける。ディープリンクは `usePendingOpen('Contract')`。
 */
export function ContractPage({ client }: BusinessPageProps) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const api = useMemo(() => contractApi(client), [client]);
  const [step, setStep] = useState<ContractStep>('import');
  const [capabilities, setCapabilities] = useState<ContractCapabilitiesDto>(CONTRACT_CAPABILITIES_DISABLED_DTO);
  const [documents, setDocuments] = useState<readonly ContractDocumentSummaryDto[]>([]);
  const [document, setDocument] = useState<ContractDocumentDto>();
  const [playbook, setPlaybook] = useState<PlaybookDto>();
  const [review, setReview] = useState<ReviewEnvelopeDto>();
  const [playbookFocus, setPlaybookFocus] = useState<{ readonly playbookId?: string; readonly nodeId?: string; readonly seq: number }>();
  const [topicFocus, setTopicFocus] = useState<{ readonly topicId: string; readonly seq: number }>();
  const [ledgerFocus, setLedgerFocus] = useState<string>();
  const [error, setError] = useState<unknown>();
  const seq = useRef(0);
  const next = () => { seq.current += 1; return seq.current; };

  useEffect(() => {
    let active = true;
    void api.capabilities().then((value) => { if (active) setCapabilities(value); }).catch(() => { if (active) setCapabilities(CONTRACT_CAPABILITIES_DISABLED_DTO); });
    return () => { active = false; };
  }, [api]);

  const reloadDocuments = useCallback(async () => {
    try { setDocuments(await api.listDocuments(scope)); setError(undefined); } catch (cause) { setError(cause); }
  }, [api]);
  useEffect(() => { void reloadDocuments(); }, [reloadDocuments]);

  /** 文書を開き、抽出に使った審査基準（無ければ既定）とレビューを読む。 */
  const openDocument = useCallback(async (id: string) => {
    try {
      const loaded = await api.getDocument(scope, id);
      setDocument(loaded);
      const list = await api.listPlaybooks(scope);
      const playbookId = loaded.extraction?.playbookId ?? list.playbooks.find((entry) => entry.isDefault)?.id ?? list.playbooks[0]?.id;
      if (playbookId !== undefined) setPlaybook((await api.getPlaybook(scope, playbookId)).playbook);
      setReview(loaded.reviewId === undefined ? undefined : await api.getReview(scope, loaded.reviewId));
      setError(undefined);
    } catch (cause) { setError(cause); }
  }, [api]);

  const refreshDocument = useCallback(async () => {
    await reloadDocuments();
    if (document !== undefined) await openDocument(document.id);
  }, [document, openDocument, reloadDocuments]);

  const goTo = useCallback((target: ContractStep, id?: string, nodeId?: string) => {
    setStep(target);
    if (target === 'playbook') setPlaybookFocus({ ...(id === undefined ? {} : { playbookId: id }), ...(nodeId === undefined ? {} : { nodeId }), seq: next() });
    else if (target === 'ledger') setLedgerFocus(id);
    else {
      if (id !== undefined && id !== document?.id) void openDocument(id);
      if (nodeId !== undefined) setTopicFocus({ topicId: nodeId, seq: next() });
    }
  }, [document?.id, openDocument]);

  usePendingOpen('Contract', (target) => {
    const parsed = parseContractTarget(target);
    if (parsed !== undefined) goTo(parsed.step, parsed.id, parsed.nodeId);
  });

  const handleAction = (action: ReasonAction) => {
    if (action.kind === 'settings') { openInScreen('Settings', { internalId: 'main', section: 'model-slot' }); return; }
    if (action.kind === 'step') { goTo(action.step, action.step === 'playbook' ? playbook?.id : undefined, action.nodeId); return; }
    if (action.kind === 'rescan-all' || action.kind === 'reread') { setStep('clauses'); return; }
    if (action.kind === 'rerun-review') { setStep('review'); }
  };

  const steps: readonly BusinessStep<ContractStep>[] = [
    { id: 'playbook', label: text('Playbook', '審査基準'), caption: text('Your own review criteria', '自社の審査基準を決める') },
    { id: 'import', label: text('Import', '取込'), caption: text('Paste text, PDF, or images', 'テキスト・PDF・画像を取り込む'), badge: text(`${documents.length}`, `${documents.length} 件`) },
    { id: 'clauses', label: text('Clauses', '条項抽出'), caption: text('Extract and confirm clauses', '条項を抜き出して確かめる') },
    { id: 'review', label: text('Review', 'レビュー'), caption: text('Check against the playbook', '審査基準で照合する') },
    { id: 'sign', label: text('Sign', '締結登録'), caption: text('Register the signed contract', '締結した契約を登録する') },
    { id: 'ledger', label: text('Ledger', '期限台帳'), caption: text('Renewal and notice deadlines', '更新・通知の期限を管理する') },
  ];
  const blocker = stepBlocker(step, document, text);

  return <main className="workspace-page contract-page">
    <ScreenLink to="Templates" className="template-back">{text('← Business templates', '← 業務テンプレート')}</ScreenLink>
    <header className="workspace-header"><div>
      <span className="eyebrow">{text('Business templates', '業務テンプレート')}</span>
      <h1>{text('Contract review and deadline ledger', '契約書レビューと期限台帳')}</h1>
      <p>{text('Check received contracts clause by clause against your own playbook, get suggested wording for points to negotiate, and track renewal and notice deadlines after signing.', '受け取った契約書を自社の審査基準で条項ごとに確認し、要交渉の条項には修正文案を添え、締結後は更新・解約通知の期限を台帳で管理します。')}</p>
    </div></header>
    <LegalNotice />
    {error !== undefined && <ApiFailure cause={error} />}
    <BusinessStepper steps={steps} active={step} onSelect={setStep} label={text('Contract review steps', '契約書レビューの手順')} />
    {document !== undefined && step !== 'playbook' && step !== 'ledger' && <p className="contract-current">{text(`Contract: ${document.title}`, `対象の契約書: ${document.title}`)}</p>}
    {blocker !== undefined
      ? <div className="empty-state"><p>{blocker}</p><button type="button" className="secondary" onClick={() => setStep(document === undefined ? 'import' : 'clauses')}>{document === undefined ? text('Open the import step', '取込を開く') : text('Open the clauses step', '条項抽出を開く')}</button></div>
      : step === 'playbook' ? <PlaybookStep api={api} {...(playbookFocus === undefined ? {} : { focus: playbookFocus })} onChanged={() => { if (document !== undefined) void openDocument(document.id); }} />
        : step === 'import' ? <ImportStep api={api} capabilities={capabilities} documents={documents} {...(document === undefined ? {} : { selected: document })} onImported={(imported) => { setDocument(imported); void reloadDocuments(); void openDocument(imported.id); }} onSelect={(id) => void openDocument(id)} onDeleted={() => { setDocument(undefined); setReview(undefined); void reloadDocuments(); }} />
          : step === 'clauses' && document !== undefined ? <ClausesStep api={api} capabilities={capabilities} document={document} {...(playbook === undefined ? {} : { playbook })} {...(topicFocus === undefined ? {} : { focusTopic: topicFocus })} onChanged={(updated) => { setDocument(updated); void reloadDocuments(); }} onAction={handleAction} />
            : step === 'review' && document !== undefined ? <ReviewStep api={api} capabilities={capabilities} document={document} {...(review === undefined ? {} : { review })} onReview={setReview} onDocumentChanged={() => void refreshDocument()} onAction={handleAction} />
              : step === 'sign' && document !== undefined ? <SignStep api={api} document={document} onRegistered={(contractId) => { void refreshDocument(); goTo('ledger', contractId); }} onAction={handleAction} />
                : <LedgerStep api={api} {...(ledgerFocus === undefined ? {} : { focusContractId: ledgerFocus })} onImport={() => setStep('import')} onChanged={() => void refreshDocument()} />}
  </main>;
}
