import { useEffect, useRef, useState } from 'react';
import type { ExpenseApi } from '../api/expense-api';
import type {
  ExpenseCapabilitiesDto, ExpenseClaimDto, ExpenseClaimSummaryDto, ExpenseItemExtractionDto, ExpenseItemSourceDto, ExpensePolicyDto,
  ExtractExpenseReceiptResultDto, ImportExpenseCsvResultDto, SaveExpenseItemDto,
} from '../api/expense-types';
import { ApiError, isAbortError } from '../api/tool-api';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import {
  EXTRACTABLE_IMAGE_TYPES, IMAGE_JPEG_QUALITY, IMAGE_SKIP_REENCODE_BYTES, IMAGE_TARGET_LONG_EDGE, MAX_EXTRACTION_IMAGES, PDF_MIME,
  decodeCsvText, formatYen, pickedFileKind, previewRows, scaledSize, withinDataUrlLimit, type CsvPreview,
} from '../journal/journal-model';
import { useOpenInScreen, type OpenTarget } from '../navigation';
import { scope } from '../scope';
import {
  EXPENSE_PAYMENT_METHODS, categoryHints, claimDraftFromClaim, claimInputFromDraft, claimStatusLabel, copyIssueDate, csvFieldLabel, defaultPeriod, emptyClaimDraft,
  emptyItemDraft, isIsoDate, itemDraftFrom, itemInputFromDraft, itemLabel, paymentMethodLabel, warningFields, withOptional,
  type ClaimFormDraft, type ExpenseTab, type ItemField, type ItemFormDraft, type Message, type Translate,
} from './expense-model';
import {
  ExtractionCapabilityNotice, ExtractionUnavailableNotice, FieldError, ReceiptViewer, StatusChip, VerdictChip, messageOf, useExpenseSlotEnvironment, type ExpenseFocusRequest,
} from './expense-shared';
import { ClaimAdvanceField, ClaimantField, DetailReadControls, ItemRouteFields } from './expense-slots';

/** 読取に送る 1 単位（画像 1 枚、PDF は 1 ファイルのページ群）。 */
export interface PreparedReceipt {
  readonly label: string;
  readonly fileName: string;
  readonly images: readonly string[];
  readonly text?: string;
  readonly notices: readonly string[];
}

export type PrepareReceiptFile = (file: File, text: Translate) => Promise<PreparedReceipt>;

/**
 * 画像を送信できる data URL にする。仕訳の取込と同じ規則（長辺 2000px を超えるものだけ縮小して JPEG、十分小さければそのまま）。
 * 仕訳の `ImageIngest` は仕訳の API と結び付いているので使わず、縮小の定数と関数だけを共有する（docs/21 §18 R-2）。
 */
async function readImageFile(file: File): Promise<string> {
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot decode images for resizing (createImageBitmap is unavailable).');
  const bitmap = await createImageBitmap(file);
  try {
    const target = scaledSize(bitmap.width, bitmap.height, IMAGE_TARGET_LONG_EDGE);
    if (target.width === bitmap.width && target.height === bitmap.height && file.size <= IMAGE_SKIP_REENCODE_BYTES) {
      const asIs = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The file could not be read.'));
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.readAsDataURL(file);
      });
      if (withinDataUrlLimit(asIs)) return asIs;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, target.width);
    canvas.height = Math.max(1, target.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The browser did not provide a 2D canvas context.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    if (!withinDataUrlLimit(dataUrl)) throw new Error('The image is still too large after resizing. Crop it to the receipt, then try again.');
    return dataUrl;
  } finally {
    bitmap.close?.();
  }
}

export const prepareReceiptFile: PrepareReceiptFile = async (file, text) => {
  const kind = pickedFileKind(file);
  if (kind === 'image') return { label: file.name, fileName: file.name, images: [await readImageFile(file)], notices: [] };
  if (kind === 'pdf') {
    const { rasterizePdf } = await import('../journal/pdf-raster');
    const raster = await rasterizePdf(new Uint8Array(await file.arrayBuffer()), { maxPages: MAX_EXTRACTION_IMAGES });
    const notices = raster.totalPages > raster.pages.length
      ? [text(`"${file.name}" has ${raster.totalPages} pages; only the first ${raster.pages.length} are read. Split the PDF if a later page holds the receipt.`, `「${file.name}」は ${raster.totalPages} ページありますが、先頭 ${raster.pages.length} ページだけを読み取ります。後ろのページに領収書があるときは PDF を分割してください。`)]
      : [];
    return { label: file.name, fileName: file.name, images: raster.pages.map((page) => page.dataUrl), ...(raster.text === '' ? {} : { text: raster.text }), notices };
  }
  throw new Error(text(`"${file.name}" is not an image or a PDF. Choose a PNG / JPEG / WebP / GIF image or a PDF.`, `「${file.name}」は画像でも PDF でもありません。PNG / JPEG / WebP / GIF か PDF を選んでください。`));
};

/** ファイル 1 件の準備の失敗を、原因 → 次の一手の 1 文にする。 */
function describeFileFailure(name: string, cause: unknown, text: Translate): string {
  const kind = (cause as { readonly kind?: string } | null)?.kind;
  if (kind === 'password') return text(`"${name}" is password-protected. Save a copy without the password, then choose it again.`, `「${name}」はパスワードで保護されています。パスワードを外して保存し直してから選び直してください。`);
  if (kind === 'corrupt') return text(`"${name}" could not be read as a PDF (it may be damaged). Print it to a new PDF and try again.`, `「${name}」を PDF として読めませんでした（壊れている可能性があります）。印刷して PDF を作り直してから試してください。`);
  return text(`"${name}" could not be prepared: ${messageOf(cause)}`, `「${name}」を準備できませんでした: ${messageOf(cause)}`);
}

/** 確認フォームで編集中の明細。 */
interface ItemEditing {
  readonly seq: number;
  readonly itemId?: string;
  readonly draft: ItemFormDraft;
  readonly source: ExpenseItemSourceDto;
  readonly extraction?: Partial<ExpenseItemExtractionDto>;
  readonly receipt?: SaveExpenseItemDto['receipt'];
  readonly warnings: readonly string[];
  readonly confidence?: number;
  readonly hasStoredReceipt: boolean;
  readonly focusField?: string;
}

type IngestMode = 'image' | 'manual' | 'csv';

function localized(message: Message | undefined, text: Translate): string | undefined {
  return message === undefined ? undefined : text(message[0], message[1]);
}

/**
 * 申請取込タブ（docs/21 §6, §11）。申請一覧と新しい申請、選んだ申請への 画像 / PDF・手入力・CSV の 3 系統。
 * 読取の結果は保存せず、確認フォームで人が直してから明細として保存する（値は自動補正しない。警告のある欄を強調する）。
 */
export function IngestTab({ api, policy, claims, onClaimsChanged, capabilities, selectedClaimId, onSelectClaim, focus, onOpen, onTab, prepareFile = prepareReceiptFile }: {
  readonly api: ExpenseApi;
  readonly policy: ExpensePolicyDto | undefined;
  readonly claims: readonly ExpenseClaimSummaryDto[];
  readonly onClaimsChanged: () => Promise<void> | void;
  readonly capabilities: ExpenseCapabilitiesDto | undefined;
  readonly selectedClaimId: string | undefined;
  readonly onSelectClaim: (id: string | undefined) => void;
  readonly focus: ExpenseFocusRequest | undefined;
  readonly onOpen: (target: OpenTarget) => void;
  readonly onTab: (tab: ExpenseTab) => void;
  /** 画像 / PDF を送信できる形にする（テストで差し替える）。 */
  readonly prepareFile?: PrepareReceiptFile;
}) {
  const { text } = useI18n();
  const slot = useExpenseSlotEnvironment();
  const [claim, setClaim] = useState<ExpenseClaimDto>();
  const [claimError, setClaimError] = useState<string>();
  const [claimForm, setClaimForm] = useState<{ readonly mode: 'new' | 'edit'; readonly draft: ClaimFormDraft; readonly showErrors: boolean }>();
  const [mode, setMode] = useState<IngestMode>('image');
  const [editing, setEditing] = useState<ItemEditing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<{ readonly kind: 'claim' } | { readonly kind: 'item'; readonly itemId: string; readonly label: string }>();
  const seqRef = useRef(0);
  const nextSeq = () => { seqRef.current += 1; return seqRef.current; };

  useEffect(() => {
    if (selectedClaimId === undefined) { setClaim(undefined); return; }
    let active = true;
    setClaimError(undefined);
    api.getClaim(scope, selectedClaimId)
      .then((next) => { if (active) setClaim(next); })
      .catch((cause: unknown) => { if (active) { setClaim(undefined); setClaimError(messageOf(cause)); } });
    return () => { active = false; };
  }, [api, selectedClaimId]);

  // 理由カードの「金額を入力」などから来たら、その明細を確認フォームで開き、該当欄へフォーカスする。
  useEffect(() => {
    if (focus === undefined || claim === undefined || claim.id !== focus.id) return;
    // 期間と申請者（従業員マスタの選び直し）は、明細ではなく申請の編集フォームで直す。
    if (focus.field === 'period' || focus.section === 'claimant') {
      setClaimForm({ mode: 'edit', draft: claimDraftFromClaim(claim), showErrors: false });
      return;
    }
    // 仮払の紐付け欄は申請の詳細にある（B の ClaimAdvanceField）。明細フォームは開かず、欄の位置まで送る。
    if (focus.section === 'advance-link') {
      document.getElementById('expense-claim-advance-link')?.scrollIntoView?.({ block: 'center' });
      return;
    }
    const item = focus.itemId === undefined ? undefined : claim.items.find((candidate) => candidate.id === focus.itemId);
    setMode('manual');
    if (item === undefined) {
      setEditing({ seq: nextSeq(), draft: emptyItemDraft(), source: { type: 'manual' }, warnings: [], hasStoredReceipt: false, ...(focus.field === undefined ? {} : { focusField: focus.field }) });
    } else {
      setEditing({
        seq: nextSeq(), itemId: item.id, draft: itemDraftFrom(item), source: item.source, extraction: item.extraction, warnings: item.extraction.warnings,
        ...(item.extraction.confidence === undefined ? {} : { confidence: item.extraction.confidence }), hasStoredReceipt: item.hasReceipt,
        ...(focus.field === undefined ? {} : { focusField: focus.field }),
      });
    }
    // focus.seq と読み込んだ申請の id だけで動かす。
  }, [focus?.seq, claim?.id]);

  useEffect(() => {
    if (claimForm?.mode !== 'edit') return;
    if (focus?.field === 'period') document.getElementById('expense-claim-from')?.focus();
    else if (focus?.section === 'claimant') document.getElementById('expense-claim-name')?.focus();
  }, [claimForm?.mode, focus?.field, focus?.section, focus?.seq]);

  const editable = claim !== undefined && claim.status !== 'approved' && claim.status !== 'settled';
  const categories = [...(policy?.categories ?? [])].sort((left, right) => left.sortOrder - right.sortOrder);

  const saveClaim = async () => {
    if (claimForm === undefined) return;
    const { input } = claimInputFromDraft(claimForm.draft);
    if (input === undefined) { setClaimForm({ ...claimForm, showErrors: true }); return; }
    setBusy(true);
    setError(undefined);
    try {
      const saved = claimForm.mode === 'new' ? await api.createClaim(scope, input) : await api.updateClaim(scope, claim?.id ?? '', input);
      setClaim(saved);
      onSelectClaim(saved.id);
      setClaimForm(undefined);
      setFeedback(claimForm.mode === 'new' ? text('Created the claim. Add items below.', '申請を作りました。下で明細を足してください。') : text('Saved the claim. Check it again if it had been checked.', '申請を保存しました。チェック済みだった場合はもう一度チェックしてください。'));
      await onClaimsChanged();
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveItem = async (input: SaveExpenseItemDto) => {
    if (claim === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api.saveItem(scope, claim.id, input);
      setClaim(saved);
      setEditing(undefined);
      setFeedback(text('Saved the item. Run the check in the Check step.', '明細を保存しました。チェックステップでチェックしてください。'));
      await onClaimsChanged();
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteTarget = async () => {
    if (confirmDelete === undefined || claim === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      if (confirmDelete.kind === 'claim') {
        await api.deleteClaim(scope, claim.id);
        onSelectClaim(undefined);
        setClaim(undefined);
        setFeedback(text('Deleted the claim and its receipts.', '申請と領収書を削除しました。'));
      } else {
        setClaim(await api.deleteItem(scope, claim.id, confirmDelete.itemId));
        if (editing?.itemId === confirmDelete.itemId) setEditing(undefined);
        setFeedback(text('Deleted the item.', '明細を削除しました。'));
      }
      await onClaimsChanged();
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
      setConfirmDelete(undefined);
    }
  };

  /** 読取結果の「申請者に使う」: 申請者欄に入れるだけで、保存は人が押す。 */
  const useClaimant = (name: string) => {
    if (claim !== undefined && editable) setClaimForm({ mode: 'edit', draft: { ...claimDraftFromClaim(claim), name }, showErrors: false });
    else setClaimForm({ mode: 'new', draft: { ...emptyClaimDraft(), name }, showErrors: false });
  };

  const claimErrors = claimForm === undefined ? {} : claimInputFromDraft(claimForm.draft).errors;

  return <div className="expense-layout">
    <section className="workspace-card" aria-labelledby="expense-claims-heading">
      <div className="expense-row-between">
        <h2 id="expense-claims-heading">{text('Claims', '申請')}</h2>
        <button type="button" className="secondary" onClick={() => setClaimForm({ mode: 'new', draft: emptyClaimDraft(), showErrors: false })}>{text('New claim', '新しい申請')}</button>
      </div>
      {claims.length === 0
        ? <div className="expense-empty">
          <p className="empty-state">{text('No claims yet. Start by reading a receipt image or importing an expense CSV.', 'まだ申請がありません。領収書の画像か経費明細の CSV を取り込んで始めます。')}</p>
          <p className="empty-state">{text('Sample CSV files are in samples/expense/ of the repository.', 'リポジトリの samples/expense/ に見本の CSV があります。')}</p>
        </div>
        : <ul className="expense-claim-list">{claims.map((summary) => <li key={summary.id}>
          <button type="button" className="expense-claim-row" aria-current={summary.id === selectedClaimId} onClick={() => { onSelectClaim(summary.id); setEditing(undefined); setClaimForm(undefined); }}>
            <strong>{summary.claimant.name}{summary.title === undefined ? '' : ` · ${summary.title}`}</strong>
            <span className="expense-claim-meta">{summary.period.from}〜{summary.period.to} · {text(`${summary.itemCount} items`, `${summary.itemCount} 件`)} · {formatYen(summary.totalAmount)}</span>
            <span className="expense-claim-meta"><StatusChip status={summary.status} />{summary.verdict !== undefined && <VerdictChip verdict={summary.verdict} stale={summary.stale} />}</span>
          </button>
        </li>)}</ul>}
    </section>

    <div>
      {claimForm !== undefined && <section className="workspace-card" aria-labelledby="expense-claim-form-heading">
        <h2 id="expense-claim-form-heading">{claimForm.mode === 'new' ? text('New claim', '新しい申請') : text('Edit the claim', '申請を編集')}</h2>
        <div className="expense-form">
          <label>{text('Claimant name', '申請者の氏名')}<input id="expense-claim-name" aria-label={text('Claimant name', '申請者の氏名')} value={claimForm.draft.name} onChange={(event) => setClaimForm({ ...claimForm, draft: { ...claimForm.draft, name: event.target.value } })} />
            {claimForm.showErrors && <FieldError message={localized(claimErrors.name, text)} />}</label>
          <ClaimantField transport={slot.transport} scope={slot.scope} onOpen={onOpen} mode={claimForm.mode} claim={claimForm.mode === 'edit' ? claim : undefined}
            draft={claimForm.draft} onChange={(draft) => setClaimForm((current) => (current === undefined ? current : { ...current, draft }))} inputId="expense-claim-name" />
          <label>{text('Employee code', '社員番号')}<input value={claimForm.draft.employeeCode} onChange={(event) => setClaimForm({ ...claimForm, draft: { ...claimForm.draft, employeeCode: event.target.value } })} /></label>
          <label>{text('Department', '部署')}<input value={claimForm.draft.department} onChange={(event) => setClaimForm({ ...claimForm, draft: { ...claimForm.draft, department: event.target.value } })} /></label>
          <label>{text('Period from', '期間（開始）')}<input id="expense-claim-from" aria-label={text('Period from', '期間（開始）')} type="date" value={claimForm.draft.from} onChange={(event) => setClaimForm({ ...claimForm, draft: { ...claimForm.draft, from: event.target.value } })} />
            {claimForm.showErrors && <FieldError message={localized(claimErrors.from, text)} />}</label>
          <label>{text('Period to', '期間（終了）')}<input aria-label={text('Period to', '期間（終了）')} type="date" value={claimForm.draft.to} onChange={(event) => setClaimForm({ ...claimForm, draft: { ...claimForm.draft, to: event.target.value } })} />
            {claimForm.showErrors && <FieldError message={localized(claimErrors.to, text)} />}</label>
          <label>{text('Title (optional)', '件名（任意）')}<input value={claimForm.draft.title} onChange={(event) => setClaimForm({ ...claimForm, draft: { ...claimForm.draft, title: event.target.value } })} /></label>
        </div>
        <div className="expense-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void saveClaim()}>{claimForm.mode === 'new' ? text('Create the claim', '申請を作る') : text('Save the claim', '申請を保存')}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setClaimForm(undefined)}>{text('Cancel', 'キャンセル')}</button>
        </div>
      </section>}

      {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
      {error !== undefined && <p className="api-error" role="alert">{error}</p>}
      {claimError !== undefined && <p className="api-error" role="alert">{claimError}</p>}

      {claim !== undefined && <section className="workspace-card" aria-labelledby="expense-claim-heading">
        <div className="expense-row-between">
          <h2 id="expense-claim-heading">{claim.claimant.name}{claim.title === undefined ? '' : ` · ${claim.title}`}</h2>
          <span className="expense-claim-meta"><StatusChip status={claim.status} />{claim.judgment !== undefined && <VerdictChip verdict={claim.judgment.verdict} stale={claim.stale} />}</span>
        </div>
        <p className="expense-claim-meta">{claim.id} · {claim.period.from}〜{claim.period.to} · <span className="expense-total">{formatYen(claim.totalAmount)}</span></p>
        {!editable && <p className="notice-card">{text(`This claim is ${claimStatusLabel(claim.status, text)} and cannot be edited. Cancel the approval first in the Approve step.`, `この申請は${claimStatusLabel(claim.status, text)}のため編集できません。先に承認ステップで承認を取り消してください。`)}</p>}
        <div className="expense-actions">
          <button type="button" className="secondary" disabled={!editable || busy} onClick={() => setClaimForm({ mode: 'edit', draft: claimDraftFromClaim(claim), showErrors: false })}>{text('Edit claimant / period', '申請者・期間を編集')}</button>
          <button type="button" className="secondary" onClick={() => onTab('check')}>{text('Go to Check', 'チェックへ進む')}</button>
          <button type="button" className="secondary danger" disabled={!editable || busy} onClick={() => setConfirmDelete({ kind: 'claim' })}>{text('Delete the claim', '申請を削除')}</button>
        </div>
        <div id="expense-claim-advance-link">
          <ClaimAdvanceField transport={slot.transport} scope={slot.scope} onOpen={onOpen} claim={claim} editable={editable && claim.status !== 'in-approval'}
            focused={focus?.section === 'advance-link' && focus.id === claim.id}
            onClaimChanged={(next) => { setClaim(next); void onClaimsChanged(); }} />
        </div>
        {claim.items.length === 0
          ? <p className="empty-state">{text('No items yet. Read a receipt, enter an item by hand, or import a CSV below.', 'まだ明細がありません。下で領収書を読み取るか、手入力するか、CSV を取り込んでください。')}</p>
          : <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>{text('Date', '取引日')}</th><th>{text('Payee', '支払先')}</th><th>{text('Description', '内容')}</th><th>{text('Category', '費目')}</th><th>{text('Amount', '金額')}</th><th>{text('Receipt', '領収書')}</th><th /></tr></thead>
            <tbody>{claim.items.map((item, index) => {
              const label = itemLabel(item, index, text);
              return <tr key={item.id}>
                <td>{index + 1}</td><td>{item.facts.transactionDate ?? '—'}</td><td>{item.facts.payeeName ?? '—'}</td><td>{item.facts.description ?? '—'}</td>
                <td>{categories.find((category) => category.id === item.categoryId)?.name ?? item.categoryId ?? item.categoryText ?? '—'}</td>
                <td>{formatYen(item.facts.amount)}</td><td>{item.hasReceipt ? '✓' : '—'}</td>
                <td><div className="expense-actions">
                  <button type="button" className="secondary" disabled={!editable} aria-label={text(`Edit ${label}`, `${label} を編集`)} onClick={() => { setMode('manual'); setEditing({ seq: nextSeq(), itemId: item.id, draft: itemDraftFrom(item), source: item.source, extraction: item.extraction, warnings: item.extraction.warnings, ...(item.extraction.confidence === undefined ? {} : { confidence: item.extraction.confidence }), hasStoredReceipt: item.hasReceipt }); }}>{text('Edit', '編集')}</button>
                  <button type="button" className="secondary danger" disabled={!editable} aria-label={text(`Delete ${label}`, `${label} を削除`)} onClick={() => setConfirmDelete({ kind: 'item', itemId: item.id, label })}>{text('Delete', '削除')}</button>
                </div></td>
              </tr>;
            })}</tbody>
          </table></div>}
      </section>}

      <section className="workspace-card" aria-labelledby="expense-ingest-heading">
        <h2 id="expense-ingest-heading">{text('Add items', '明細を取り込む')}</h2>
        <div className="expense-subtabs" role="tablist" aria-label={text('Ingest method', '取込の方法')}>
          {([['image', text('Image / PDF', '画像 / PDF')], ['manual', text('Manual entry', '手入力')], ['csv', text('CSV', 'CSV')]] as const).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)}>{label}</button>)}
        </div>
        {mode === 'csv'
          ? <CsvImport api={api} claim={editable ? claim : undefined} onImported={async (result) => { await onClaimsChanged(); const only = result.claims[0]; if (result.claims.length === 1 && only !== undefined) onSelectClaim(only.id); }} onSelectClaim={onSelectClaim} />
          : claim === undefined || !editable
            ? <p className="empty-state">{text('Choose or create a claim first (image and manual items are added to the selected claim). CSV import can create claims by itself.', '先に申請を選ぶか作ってください（画像と手入力の明細は選んだ申請に足します）。CSV 取込は申請ごと作れます。')}</p>
            : mode === 'image'
              ? <ReceiptReader api={api} capabilities={capabilities} prepareFile={prepareFile} onUseClaimant={useClaimant} onOpen={onOpen}
                onPick={(draft, receipt) => {
                  setEditing({
                    seq: nextSeq(), draft: itemDraftFrom(draft), source: draft.source, extraction: draft.extraction, warnings: draft.extraction.warnings,
                    ...(draft.extraction.confidence === undefined ? {} : { confidence: draft.extraction.confidence }), hasStoredReceipt: false, ...(receipt === undefined ? {} : { receipt }),
                  });
                }} />
              : <div className="expense-actions">
                <button type="button" className="secondary" onClick={() => setEditing({ seq: nextSeq(), draft: emptyItemDraft(), source: { type: 'manual' }, warnings: [], hasStoredReceipt: false })}>{text('New item', '新しい明細')}</button>
              </div>}
        {editing !== undefined && claim !== undefined && editable && mode !== 'csv' && <ItemForm key={editing.seq} api={api} claim={claim} editing={editing} categories={categories} transportSettings={policy?.transport} busy={busy} prepareFile={prepareFile}
          onSave={(input) => void saveItem(input)} onCancel={() => setEditing(undefined)} onOpen={onOpen} />}
      </section>
    </div>

    <ConfirmDialog open={confirmDelete !== undefined} danger busy={busy}
      title={confirmDelete?.kind === 'claim' ? text('Delete this claim?', 'この申請を削除しますか？') : text('Delete this item?', 'この明細を削除しますか？')}
      message={confirmDelete?.kind === 'claim'
        ? text('The claim, its items, and the attached receipt images are deleted. This cannot be undone.', '申請と明細、添付した領収書の画像が削除されます。元に戻せません。')
        : text(`"${confirmDelete?.kind === 'item' ? confirmDelete.label : ''}" and its receipt image are deleted.`, `「${confirmDelete?.kind === 'item' ? confirmDelete.label : ''}」と領収書の画像が削除されます。`)}
      confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} onConfirm={() => void deleteTarget()} onCancel={() => setConfirmDelete(undefined)} />
  </div>;
}

/* 画像 / PDF ---------------------------------------------------------------- */

interface ReadResult { readonly unit: PreparedReceipt; readonly result: ExtractExpenseReceiptResultDto }

function ReceiptReader({ api, capabilities, prepareFile, onPick, onUseClaimant, onOpen }: {
  readonly api: ExpenseApi;
  readonly capabilities: ExpenseCapabilitiesDto | undefined;
  readonly prepareFile: PrepareReceiptFile;
  readonly onPick: (draft: ExtractExpenseReceiptResultDto['drafts'][number], receipt: SaveExpenseItemDto['receipt'] | undefined) => void;
  readonly onUseClaimant: (name: string) => void;
  readonly onOpen: (target: OpenTarget) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const slot = useExpenseSlotEnvironment();
  /** 経費専用の追加読取もするか（C の `DetailReadControls` が切り替える。既定 off）。 */
  const [detail, setDetail] = useState(false);
  const [units, setUnits] = useState<readonly PreparedReceipt[]>([]);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<{ readonly done: number; readonly total: number }>();
  const [aborter, setAborter] = useState<AbortController>();
  const [results, setResults] = useState<readonly ReadResult[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const [schemaError, setSchemaError] = useState<string>();
  const [error, setError] = useState<string>();
  const elapsed = useElapsedSeconds(aborter !== undefined);
  const ready = capabilities?.extraction.enabled === true && capabilities.extraction.vision;
  const reading = aborter !== undefined;

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setPreparing(true);
    const messages: string[] = [];
    const prepared: PreparedReceipt[] = [];
    for (const file of files) {
      try {
        const unit = await prepareFile(file, text);
        prepared.push(unit);
        messages.push(...unit.notices);
      } catch (cause: unknown) {
        messages.push(describeFileFailure(file.name, cause, text));
      }
    }
    setPreparing(false);
    setUnits((current) => [...current, ...prepared]);
    setNotices(messages);
  };

  /** 1 単位ずつ順に読む（1 枚に十数秒〜数分かかるので、進捗と中断を出す）。 */
  const readAll = async () => {
    if (units.length === 0 || reading) return;
    const controller = new AbortController();
    setAborter(controller);
    setCancelled(false);
    setUnavailable(undefined);
    setSchemaError(undefined);
    setError(undefined);
    const collected: ReadResult[] = [];
    try {
      for (const [index, unit] of units.entries()) {
        setProgress({ done: index, total: units.length });
        const result = await api.extractReceipt(scope, { images: unit.images, fileName: unit.fileName, ...(unit.text === undefined ? {} : { text: unit.text }), ...(detail ? { detail: true } : {}) }, controller.signal);
        collected.push({ unit, result });
        setResults([...collected]);
      }
      setUnits([]);
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else if (cause instanceof ApiError && cause.code === 'JOURNAL_EXTRACTION_UNAVAILABLE') setUnavailable(messageOf(cause));
      else if (cause instanceof ApiError && cause.code === 'JOURNAL_EXTRACTION_SCHEMA') setSchemaError(messageOf(cause));
      else setError(messageOf(cause));
      // 読み終えた分は結果に残し、未読の分だけを待ち行列に残す。
      setUnits((current) => current.slice(collected.length));
    } finally {
      setAborter(undefined);
      setProgress(undefined);
    }
  };

  return <div className="expense-reader">
    <ExtractionCapabilityNotice capabilities={capabilities} />
    <label>{text('Receipt images or PDFs', '領収書の画像または PDF')}
      <input type="file" multiple accept={[...EXTRACTABLE_IMAGE_TYPES, PDF_MIME].join(',')} disabled={!ready || reading || preparing}
        onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
    </label>
    <DetailReadControls placement="reader" transport={slot.transport} scope={slot.scope} onOpen={onOpen} capabilities={capabilities} detail={detail} onDetailChange={setDetail} />
    {preparing && <p className="empty-state" role="status">{text('Preparing the files…', 'ファイルを準備しています…')}</p>}
    {notices.map((notice) => <p key={notice} className="notice-card">{notice}</p>)}
    {units.length > 0 && <ul className="expense-thumbs" aria-label={text('Files to read', '読み取るファイル')}>
      {units.map((unit, index) => <li key={`${unit.label}-${index}`}>
        {unit.images[0] !== undefined && <img src={unit.images[0]} alt={unit.label} />}
        <span>{unit.label}{unit.images.length > 1 ? text(` (${unit.images.length} pages)`, `（${unit.images.length} ページ）`) : ''}</span>
        <button type="button" className="secondary danger" disabled={reading} onClick={() => setUnits((current) => current.filter((_, at) => at !== index))}>{text('Remove', '外す')}</button>
      </li>)}
    </ul>}
    <div className="expense-actions">
      <button type="button" className="primary" disabled={!ready || reading || units.length === 0} onClick={() => void readAll()}>
        {reading ? text(`Reading ${(progress?.done ?? 0) + 1} / ${progress?.total ?? units.length}… ${elapsed}s`, `読み取り中 ${(progress?.done ?? 0) + 1} / ${progress?.total ?? units.length}… ${elapsed}秒`) : text('Read with AI', 'AI で読み取る')}
      </button>
      {reading && <button type="button" className="secondary" onClick={() => aborter?.abort()}>{text('Cancel', '中断')}</button>}
    </div>
    {reading && elapsed > 30 && <div className="notice-card" role="note">
      <p>{text('Some models take minutes per receipt. A smaller model in Settings reads faster.', 'モデルによっては 1 枚に数分かかります。設定でより小さいモデルに変えると速くなります。')}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Change the model in Settings', '設定でモデルを変える')}</button></div>
    </div>}
    {cancelled && <InlineFeedback kind="info">{text('Cancelled. Files not read yet are still in the list; nothing was saved.', '中断しました。まだ読んでいないファイルは一覧に残っています。保存は行っていません。')}</InlineFeedback>}
    {unavailable !== undefined && <ExtractionUnavailableNotice message={unavailable} />}
    {schemaError !== undefined && <div className="notice-card" role="alert">
      <strong>{text('The model returned a reading that did not fit the expected form', 'モデルの読み取り結果が決まった形になりませんでした')}</strong>
      <p>{schemaError}</p>
      <p>{text('Next step: read it again, or try another model in Settings. You can also enter the item by hand.', '次の一手: もう一度読み取るか、設定で別のモデルを試してください。手入力で明細を足すこともできます。')}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Try another model in Settings', '設定で別のモデルを試す')}</button></div>
    </div>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}

    {results.map(({ unit, result }, resultIndex) => <article key={`${unit.label}-${resultIndex}`} className="expense-item-card" aria-label={text(`Reading of ${unit.label}`, `${unit.label} の読み取り結果`)}>
      <h4>{unit.label}</h4>
      {result.claimantHint !== undefined && <p>
        {text('Claimant on the document: ', '書類の申請者: ')}
        <button type="button" className="expense-chip-button" onClick={() => onUseClaimant(result.claimantHint ?? '')}>{text(`Use "${result.claimantHint}" as the claimant`, `「${result.claimantHint}」を申請者に使う`)}</button>
      </p>}
      {result.warnings.map((warning) => <p key={warning} className="notice-card">{warning}</p>)}
      {result.drafts.length === 0 && <p className="empty-state">{text('Nothing could be read as an item. Enter it by hand.', '明細として読み取れるものがありませんでした。手入力してください。')}</p>}
      {result.drafts.length > 1 && <p className="empty-state">{text(`This expense report was split into ${result.drafts.length} items. Review each one.`, `この精算書は ${result.drafts.length} 件の明細に分けました。1 件ずつ確認してください。`)}</p>}
      {result.drafts.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>{text('Date', '取引日')}</th><th>{text('Payee', '支払先')}</th><th>{text('Description', '内容')}</th><th>{text('Amount', '金額')}</th><th>{text('Warnings', '警告')}</th><th /></tr></thead>
        <tbody>{result.drafts.map((draft, index) => <tr key={index}>
          <td>{index + 1}</td><td>{draft.facts.transactionDate ?? '—'}</td><td>{draft.facts.payeeName ?? '—'}</td><td>{draft.facts.description ?? '—'}</td><td>{formatYen(draft.facts.amount)}</td>
          <td>{draft.extraction.warnings.length}</td>
          <td>
            <DetailReadControls placement="draft" transport={slot.transport} scope={slot.scope} onOpen={onOpen} capabilities={capabilities} draft={draft} images={unit.images}
              onDraftChange={(next) => setResults((current) => current.map((entry, at) => (at !== resultIndex ? entry : { ...entry, result: { ...entry.result, drafts: entry.result.drafts.map((candidate, draftIndex) => (draftIndex === index ? next : candidate)) } })))} />
            <button type="button" className="secondary" onClick={() => onPick(draft, unit.images[0] === undefined ? undefined : { dataUrl: unit.images[0], fileName: unit.fileName, ...(unit.text === undefined ? {} : { text: unit.text }) })}>{text('Review in the form', '確認フォームへ')}</button>
          </td>
        </tr>)}</tbody>
      </table></div>}
    </article>)}
  </div>;
}

/* 明細の確認フォーム --------------------------------------------------------- */

function ItemForm({ api, claim, editing, categories, transportSettings, busy, prepareFile, onSave, onCancel, onOpen }: {
  readonly api: ExpenseApi;
  readonly claim: ExpenseClaimDto;
  readonly editing: ItemEditing;
  readonly categories: readonly ExpensePolicyDto['categories'][number][];
  readonly transportSettings: ExpensePolicyDto['transport'];
  readonly busy: boolean;
  readonly prepareFile: PrepareReceiptFile;
  readonly onSave: (input: SaveExpenseItemDto) => void;
  readonly onCancel: () => void;
  readonly onOpen: (target: OpenTarget) => void;
}) {
  const { text } = useI18n();
  const slot = useExpenseSlotEnvironment();
  const [draft, setDraft] = useState(editing.draft);
  const [receipt, setReceipt] = useState(editing.receipt);
  const [showErrors, setShowErrors] = useState(false);
  const [attachError, setAttachError] = useState<string>();

  useEffect(() => {
    if (editing.focusField !== undefined) document.getElementById(`expense-item-${editing.focusField}`)?.focus();
  }, [editing.focusField]);

  const category = categories.find((candidate) => candidate.id === draft.categoryId);
  const hints = categoryHints(category, text);
  const warned = warningFields(editing.warnings);
  const result = itemInputFromDraft(draft, {
    ...(editing.itemId === undefined ? {} : { itemId: editing.itemId }), source: editing.source,
    ...(editing.extraction === undefined ? {} : { extraction: editing.extraction }), ...(receipt === undefined ? {} : { receipt }),
    // 開いたときの値と比べ、人が直した欄の読取の印を外して送る（残すと read-values-unconfirmed が確認後も消えない）。
    original: editing.draft,
  });
  const set = (patch: Partial<ItemFormDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const fieldClass = (field: ItemField) => [hints.required.has(field) ? 'expense-required-field' : '', warned.has(field) ? 'expense-warned' : ''].filter((name) => name !== '').join(' ');
  const labelText = (field: ItemField, label: string) => <span className={hints.required.has(field) ? 'expense-required' : ''}>{label}</span>;
  const errorOf = (field: ItemField) => (showErrors ? localized(result.errors[field], text) : undefined);
  const input = (field: ItemField, label: string, value: string, onChange: (next: string) => void, type = 'text') => <label className={fieldClass(field)}>
    {labelText(field, label)}
    <input id={`expense-item-${field}`} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    <FieldError message={errorOf(field)} />
  </label>;
  const lowConfidence = editing.confidence !== undefined && editing.confidence < 0.7;
  const unknownCategory = draft.categoryId !== '' && category === undefined;

  const attach = async (file: File | undefined) => {
    if (file === undefined) return;
    setAttachError(undefined);
    try {
      const unit = await prepareFile(file, text);
      const first = unit.images[0];
      if (first !== undefined) setReceipt({ dataUrl: first, fileName: unit.fileName, ...(unit.text === undefined ? {} : { text: unit.text }) });
    } catch (cause: unknown) {
      setAttachError(describeFileFailure(file.name, cause, text));
    }
  };

  const form = <div>
    {editing.warnings.length > 0 && <div className="notice-card" role="note">
      <strong>{text('Check these reading warnings (values were not corrected)', '読み取りの注意点を確認してください（値は自動で直していません）')}</strong>
      <ul>{editing.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </div>}
    {lowConfidence && <p className="notice-card">{text('The model was not confident about this reading. Compare every field with the receipt.', 'モデルの確信度が低い読み取りです。すべての項目を領収書と見比べてください。')}</p>}
    <div className="expense-form">
      <label className={fieldClass('categoryId')}>{text('Category', '費目')}
        <select id="expense-item-categoryId" value={draft.categoryId} onChange={(event) => set({ categoryId: event.target.value })}>
          <option value="">{text('— choose a category —', '— 費目を選択 —')}</option>
          {unknownCategory && <option value={draft.categoryId}>{text(`${draft.categoryId} (not in the policy)`, `${draft.categoryId}（規程に無い）`)}</option>}
          {categories.filter((candidate) => candidate.enabled).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        {draft.categoryId === '' && draft.categoryText !== '' && <small className="expense-limit-hint">{text(`Imported as "${draft.categoryText}"`, `取込時の費目: 「${draft.categoryText}」`)}</small>}
        {category !== undefined && <button type="button" className="screen-link" onClick={() => onOpen({ internalId: category.id, section: 'category' })}>{text('Open this category in the policy', '規程でこの費目を開く')}</button>}
      </label>
      {hints.limits.length > 0 && <p className="expense-limit-hint expense-wide" aria-label={text('Limits of the category', '費目の上限')}>{hints.limits.join(' · ')}</p>}
      <ItemRouteFields transport={slot.transport} scope={slot.scope} onOpen={onOpen} claim={claim} category={category} transportSettings={transportSettings}
        transactionDate={draft.transactionDate} route={draft.route} onChange={(route) => setDraft((current) => withOptional(current, 'route', route))} inputId="expense-item-route" />
      {input('transactionDate', text('Transaction date', '取引日'), draft.transactionDate, (next) => set({ transactionDate: next, dateSource: draft.dateSource === 'issue-copied' ? 'manual' : draft.dateSource }), 'date')}
      <label className={fieldClass('issueDate')}>{text('Issue date', '発行日')}
        <input id="expense-item-issueDate" type="date" value={draft.issueDate} onChange={(event) => set({ issueDate: event.target.value })} />
        <FieldError message={errorOf('issueDate')} />
        <button type="button" className="secondary" disabled={draft.issueDate === '' || !isIsoDate(draft.issueDate)} onClick={() => setDraft(copyIssueDate(draft))}>{text('Use the issue date as the transaction date', '発行日を取引日にする')}</button>
      </label>
      {input('payeeName', text('Payee', '支払先'), draft.payeeName, (next) => set({ payeeName: next }))}
      {input('amount', text('Amount (tax included, yen)', '金額（税込・円）'), draft.amount, (next) => set({ amount: next }))}
      <label className={fieldClass('registrationNumber')}>{labelText('registrationNumber', text('Registration number (T + 13 digits)', '登録番号（T + 13 桁）'))}
        <input id="expense-item-registrationNumber" value={draft.registrationNumber} onChange={(event) => set({ registrationNumber: event.target.value })} />
        {result.warnings.map((warning) => <small key={warning[0]} className="expense-limit-hint">{text(warning[0], warning[1])}</small>)}
        {editing.extraction?.rejectedRegistrationNumber !== undefined && <small className="expense-limit-hint">{text(`Read but not used: "${editing.extraction.rejectedRegistrationNumber}"`, `読み取ったが採用しなかった値: 「${editing.extraction.rejectedRegistrationNumber}」`)}</small>}
      </label>
      <label className={fieldClass('paymentMethod')}>{text('Payment method', '支払方法')}
        <select id="expense-item-paymentMethod" value={draft.paymentMethod} onChange={(event) => set({ paymentMethod: event.target.value as ItemFormDraft['paymentMethod'] })}>
          <option value="">{text('— not set —', '— 未設定 —')}</option>
          {EXPENSE_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{paymentMethodLabel(method, text)}</option>)}
        </select>
        <span><input type="checkbox" checked={draft.corporatePayment} onChange={(event) => set({ corporatePayment: event.target.checked })} /> {text('Paid by the company', '会社払い')}</span>
      </label>
      {input('description', text('Description', '内容・但し書き'), draft.description, (next) => set({ description: next }))}
      {input('purpose', text('Purpose (with whom, for what)', '目的（誰と・何のために）'), draft.purpose, (next) => set({ purpose: next }))}
      {input('attendeesCount', text('Attendees', '参加人数'), draft.attendeesCount, (next) => set({ attendeesCount: next }))}
      {input('attendeeNames', text('Attendee names (separate with ;)', '参加者（; 区切り）'), draft.attendeeNames, (next) => set({ attendeeNames: next }))}
      {input('attendeeRelation', text('Relation', '関係（取引先・社内など）'), draft.attendeeRelation, (next) => set({ attendeeRelation: next }))}
      {input('unitCount', category?.limits.perUnit === undefined ? text('Days / nights', '日数・泊数') : text(`Number of ${category.limits.perUnit.label}`, `${category.limits.perUnit.label}数`), draft.unitCount, (next) => set({ unitCount: next }))}
      {input('preApprovalRef', text('Pre-approval number', '事前承認番号'), draft.preApprovalRef, (next) => set({ preApprovalRef: next }))}
      <label className={`expense-wide ${fieldClass('receipt')}`}>{labelText('receipt', text('Receipt image (optional)', '領収書の画像（任意）'))}
        <input id="expense-item-receipt" type="file" accept={[...EXTRACTABLE_IMAGE_TYPES, PDF_MIME].join(',')} onChange={(event) => { void attach(event.target.files?.[0]); event.target.value = ''; }} />
        {receipt !== undefined && <small className="expense-limit-hint">{text(`Attached: ${receipt.fileName ?? 'image'}`, `添付: ${receipt.fileName ?? '画像'}`)}</small>}
        {receipt === undefined && editing.hasStoredReceipt && <small className="expense-limit-hint">{text('A receipt is already stored; choosing a file replaces it.', '領収書は保存済みです。ファイルを選ぶと差し替えます。')}</small>}
        <FieldError message={attachError} />
      </label>
    </div>
    <div className="expense-actions">
      <button type="button" className="primary" disabled={busy} onClick={() => { if (result.input === undefined) { setShowErrors(true); return; } onSave(result.input); }}>{editing.itemId === undefined ? text('Save the item', '明細を保存') : text('Save changes', '変更を保存')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{text('Cancel', 'キャンセル')}</button>
    </div>
  </div>;

  const preview = receipt?.dataUrl;
  return <section className="expense-item-card" aria-label={text('Item form', '明細の確認フォーム')}>
    <h4>{editing.itemId === undefined ? text('New item', '新しい明細') : text('Edit the item', '明細を編集')}</h4>
    {preview !== undefined
      ? <div className="expense-with-receipt"><img className="expense-receipt-image" src={preview} alt={receipt?.fileName ?? text('Receipt image', '領収書の画像')} />{form}</div>
      : editing.itemId !== undefined && editing.hasStoredReceipt
        ? <div className="expense-with-receipt"><ReceiptViewer api={api} claimId={claim.id} itemId={editing.itemId} onClose={onCancel} />{form}</div>
        : form}
  </section>;
}

/* CSV ----------------------------------------------------------------------- */

function CsvImport({ api, claim, onImported, onSelectClaim }: {
  readonly api: ExpenseApi;
  /** 追記先に選べる申請（編集できるものだけ）。 */
  readonly claim: ExpenseClaimDto | undefined;
  readonly onImported: (result: ImportExpenseCsvResultDto) => Promise<void>;
  readonly onSelectClaim: (id: string) => void;
}) {
  const { text } = useI18n();
  const [file, setFile] = useState<{ readonly name: string; readonly content: string; readonly encoding: string; readonly preview: CsvPreview }>();
  const initial = claim?.period ?? defaultPeriod();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [append, setAppend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ImportExpenseCsvResultDto>();

  const pick = async (picked: File | undefined) => {
    if (picked === undefined) return;
    setError(undefined);
    setResult(undefined);
    const decoded = decodeCsvText(new Uint8Array(await picked.arrayBuffer()));
    setFile({ name: picked.name, content: decoded.content, encoding: decoded.encoding, preview: previewRows(decoded.content, 5) });
  };

  const periodValid = isIsoDate(from) && isIsoDate(to) && from <= to;
  const importNow = async () => {
    if (file === undefined || !periodValid) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.importCsv(scope, { content: file.content, period: { from, to }, fileName: file.name, ...(append && claim !== undefined ? { claimId: claim.id } : {}) });
      setResult(next);
      await onImported(next);
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className="expense-csv">
    <p className="empty-state">{text('Columns are matched by header name and aliases (date and amount columns are required; claimant is required unless you append to a claim). Shift_JIS files are converted automatically.', '列は見出し名と別名で当てます（日付と金額の列は必須。申請に追記しないときは申請者の列も必須）。Shift_JIS のファイルは自動で変換します。')}</p>
    <label>{text('Expense CSV', '経費明細 CSV')}<input type="file" accept=".csv,text/csv" onChange={(event) => { void pick(event.target.files?.[0]); event.target.value = ''; }} /></label>
    {file !== undefined && <>
      <p className="expense-claim-meta">{file.name} · {file.encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-8'} · {text(`${file.preview.totalRows} rows`, `${file.preview.totalRows} 行`)}</p>
      <div className="table-wrap"><table aria-label={text('CSV preview (first 5 rows)', 'CSV のプレビュー（先頭 5 行）')}>
        <thead><tr>{file.preview.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead>
        <tbody>{file.preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table></div>
      <div className="expense-form">
        <label>{text('Claim period from', '申請期間（開始）')}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>{text('Claim period to', '申請期間（終了）')}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        {claim !== undefined && <label><span><input type="checkbox" checked={append} onChange={(event) => setAppend(event.target.checked)} /> {text(`Append to the selected claim (${claim.claimant.name})`, `選んだ申請（${claim.claimant.name}）に追記する`)}</span></label>}
      </div>
      {!periodValid && <FieldError message={text('Enter a valid period (the end on or after the start).', '正しい期間を入力してください（終了日は開始日以降）。')} />}
      <button type="button" className="primary" disabled={busy || !periodValid} onClick={() => void importNow()}>{busy ? text('Importing…', '取り込み中…') : text('Import', '取り込む')}</button>
    </>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
    {result !== undefined && <div className="expense-csv-result">
      <InlineFeedback kind="success">{text(`Imported ${result.claims.reduce((sum, entry) => sum + entry.importedCount, 0)} items into ${result.claims.length} claims.`, `${result.claims.length} 件の申請に ${result.claims.reduce((sum, entry) => sum + entry.importedCount, 0)} 件の明細を取り込みました。`)}</InlineFeedback>
      <div className="table-wrap"><table aria-label={text('Column matches', '列の対応')}>
        <thead><tr><th>{text('CSV column', 'CSV の列')}</th><th>{text('Field', '項目')}</th></tr></thead>
        <tbody>{result.columnMatches.map((match, index) => <tr key={`${match.header}-${index}`} className={match.field === null ? 'expense-unmatched' : ''}><td>{match.header}</td><td>{csvFieldLabel(match.field, text)}</td></tr>)}</tbody>
      </table></div>
      {result.columnMatches.some((match) => match.field === null) && <p className="empty-state">{text('Columns marked "(not used)" were ignored. Rename the header to one of the aliases in docs/21-expense.md §6.3 to use them.', '「（当たらない）」の列は取り込んでいません。使うなら見出しを docs/21-expense.md §6.3 の別名に直してください。')}</p>}
      {result.skippedRows.length > 0 && <div className="notice-card" role="note">
        <strong>{text(`${result.skippedRows.length} rows were skipped`, `${result.skippedRows.length} 行を読み飛ばしました`)}</strong>
        <ul>{result.skippedRows.map((row) => <li key={row.row}>{text(`Row ${row.row}`, `${row.row} 行目`)}: {row.reason}</li>)}</ul>
      </div>}
      {result.warnings.map((warning) => <p key={warning} className="notice-card">{warning}</p>)}
      <ul>{result.claims.map((entry) => <li key={entry.id}>
        {entry.claimant.name} · {entry.created ? text('new claim', '新しい申請') : text('appended', '追記')} · {text(`${entry.importedCount} items`, `${entry.importedCount} 件`)}{' '}
        <button type="button" className="screen-link" onClick={() => onSelectClaim(entry.id)}>{text('Open', '開く')}</button>
      </li>)}</ul>
    </div>}
  </div>;
}
