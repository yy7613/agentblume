import type { ReactNode } from 'react';
import { ApiError } from '../api/tool-api';
import type { ReasonDetailDto, VerdictDto } from '../api/contract-types';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { legalNotice, verdictLabel, type ContractStep } from './contract-model';
import { reasonGuide, type ReasonAction } from './contract-reasons';

/** 契約画面の共通部品。エラー/診断は「原因 → 次にやる操作 → その場所を開くボタン」を必ず揃える。 */

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

export function LegalNotice({ notice }: { readonly notice?: string }) {
  const { text } = useI18n();
  return <p className="contract-legal-notice" role="note">{notice ?? legalNotice(text)}</p>;
}

export function VerdictChip({ verdict }: { readonly verdict: VerdictDto }) {
  const { text } = useI18n();
  return <span className={`judge-chip contract-verdict contract-verdict-${verdict}`}>{verdictLabel(verdict, text)}</span>;
}

/** 理由コード 1 件の 3 点セット。ボタンの行き先は画面（ContractPage）が `onAction` で解決する。 */
export function ReasonCard({ code, detail, criterionId, topicId, onAction }: {
  readonly code: string; readonly detail?: ReasonDetailDto; readonly criterionId?: string; readonly topicId?: string;
  readonly onAction: (action: ReasonAction) => void;
}) {
  const { text } = useI18n();
  const guide = reasonGuide(code, detail, text, { ...(criterionId === undefined ? {} : { criterionId }), ...(topicId === undefined ? {} : { topicId }) });
  return <div className={`contract-reason contract-reason-${guide.severity}`} data-reason={code}>
    <p><strong>{text('Cause', '原因')}:</strong> {guide.cause}</p>
    <p><strong>{text('Next', '次にやること')}:</strong> {guide.next}</p>
    <div className="run-failure-actions">
      {guide.actions.map((action) => <button key={`${action.kind}:${action.label}`} type="button" className="secondary" onClick={() => onAction(action)}>{action.label}</button>)}
    </div>
  </div>;
}

/**
 * API の失敗の案内。409（モデル未設定・能力不足）は設定画面へ、状態の衝突は関係する手順へのボタンを出す。
 */
export function ApiFailure({ cause, onStep, children }: { readonly cause: unknown; readonly onStep?: (step: ContractStep, id?: string) => void; readonly children?: ReactNode }) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const api = cause instanceof ApiError ? cause : undefined;
  const code = api?.code;
  const contractId = typeof api?.details?.['contractId'] === 'string' ? api.details['contractId'] : undefined;
  return <div className="notice-card contract-failure" role="alert">
    <strong>{messageOf(cause)}</strong>
    {api !== undefined && api.serverMessage !== '' && api.serverMessage !== api.message && <small>{api.serverMessage}</small>}
    <div className="run-failure-actions">
      {(code === 'CONTRACT_EXTRACTION_UNAVAILABLE') && <button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Change the model in Settings', '設定でモデルを変える')}</button>}
      {code === 'CONTRACT_EXTRACTION_UNAVAILABLE' && onStep !== undefined && <button type="button" className="secondary" onClick={() => onStep('import')}>{text('Paste the text and import it', 'テキストを貼り付けて取り込む')}</button>}
      {code === 'CONTRACT_STATE' && contractId !== undefined && onStep !== undefined && <button type="button" className="secondary" onClick={() => onStep('ledger', contractId)}>{text('Open it in the ledger', '台帳で開く')}</button>}
      {children}
    </div>
  </div>;
}

export function Field({ label, children, hint }: { readonly label: string; readonly children: ReactNode; readonly hint?: string }) {
  return <label className="contract-field"><span>{label}</span>{children}{hint !== undefined && <small>{hint}</small>}</label>;
}
