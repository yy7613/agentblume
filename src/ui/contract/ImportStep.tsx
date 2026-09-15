import { useEffect, useRef, useState } from 'react';
import type { ContractApi } from '../api/contract-api';
import type {
  ContractCapabilitiesDto, ContractDocumentDto, ContractDocumentSummaryDto, ContractNatureDto, ContractPageDto, ContractSourceTypeDto,
  ImportContractDocumentDto, OurRoleDto, PartyKeyDto, ProfileAnswerDto,
} from '../api/contract-types';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { scope } from '../scope';
import { documentStatusLabel, previewParties, roleLabel } from './contract-model';
import { ApiFailure, Field, isAbort, messageOf } from './contract-shared';

type Source = 'text' | 'pdf' | 'images';
const BODY_MAX_CHARS = 300_000;
const NATURES: readonly ContractNatureDto[] = ['unknown', 'ukeoi', 'jun_inin', 'basic_transaction', 'sale', 'nda', 'license', 'other'];

/** 取込中のページ（テキスト層か、文字起こしが要るか）。 */
interface PendingPage {
  readonly page: number;
  readonly text: string;
  readonly method: 'text-layer' | 'vision';
  /** 文字起こしが必要で、まだ済んでいない。 */
  readonly needsTranscription: boolean;
  readonly warnings: readonly string[];
  /** 画像取込のときの data URL。 */
  readonly dataUrl?: string;
}

interface Meta {
  readonly title: string;
  readonly partyA: string;
  readonly partyB: string;
  readonly ourParty: PartyKeyDto | '';
  readonly ourRole: OurRoleDto;
  readonly toriteki: ProfileAnswerDto;
  readonly freelance: ProfileAnswerDto;
  readonly contractNature: ContractNatureDto;
  readonly contractAmount: string;
}

const EMPTY_META: Meta = { title: '', partyA: '', partyB: '', ourParty: '', ourRole: 'client', toriteki: 'unknown', freelance: 'unknown', contractNature: 'unknown', contractAmount: '' };

function metaOf(document: ContractDocumentDto): Meta {
  return {
    title: document.title, partyA: document.parties.A.name ?? '', partyB: document.parties.B.name ?? '', ourParty: document.ourParty ?? '',
    ourRole: document.ourRole ?? 'client', toriteki: document.counterpartyProfile.toriteki, freelance: document.counterpartyProfile.freelance,
    contractNature: document.contractNature?.value ?? 'unknown', contractAmount: document.contractAmount === undefined ? '' : String(document.contractAmount),
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('invalid image'));
    reader.readAsDataURL(file);
  });
}

/**
 * 取込（docs/23 §3.1 / §7.1）。テキスト貼り付け / PDF（テキスト層、スキャンページは 1 ページずつ文字起こし）/ 画像の 3 系統を
 * 本文 1 本 + ページ境界へ揃えて保存する。自社は甲か乙か・立場・相手方の区分（取適法 / フリーランス法）は人が選ぶ。
 */
export function ImportStep({ api, capabilities, documents, selected, onImported, onSelect, onDeleted }: {
  readonly api: ContractApi;
  readonly capabilities: ContractCapabilitiesDto;
  readonly documents: readonly ContractDocumentSummaryDto[];
  readonly selected?: ContractDocumentDto;
  readonly onImported: (document: ContractDocumentDto) => void;
  readonly onSelect: (id: string) => void;
  readonly onDeleted: () => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [source, setSource] = useState<Source>('text');
  const [pasted, setPasted] = useState('');
  const [pages, setPages] = useState<readonly PendingPage[]>([]);
  const [fileName, setFileName] = useState<string>();
  const [sha256, setSha256] = useState<string>();
  const [pdfBytes, setPdfBytes] = useState<Uint8Array>();
  // 新規取込のフォームと、選択中の文書の区分のフォームは別の状態にする（片方の入力がもう片方へ漏れないように）。
  const [meta, setMeta] = useState<Meta>(EMPTY_META);
  const [selectedMeta, setSelectedMeta] = useState<Meta>(EMPTY_META);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [progress, setProgress] = useState<{ readonly done: number; readonly total: number }>();
  const [busy, setBusy] = useState(false);
  const aborter = useRef<AbortController | undefined>(undefined);

  // 既存の文書を選んだら、立場と相手方区分をその値で編集できるようにする。
  useEffect(() => { if (selected !== undefined) setSelectedMeta(metaOf(selected)); }, [selected]);

  const body = source === 'text' ? pasted : pages.map((page) => page.text).join('\n');
  const pendingTranscription = pages.filter((page) => page.needsTranscription).length;
  const setterOf = (group: 'selected' | 'new') => <K extends keyof Meta>(key: K, value: Meta[K]) => (group === 'selected' ? setSelectedMeta : setMeta)((current) => ({ ...current, [key]: value }));

  const prefillParties = (value: string) => {
    const parties = previewParties(value);
    setMeta((current) => ({ ...current, partyA: current.partyA || parties.A || '', partyB: current.partyB || parties.B || '' }));
  };

  async function choosePdf(file: File): Promise<void> {
    setError(undefined); setNotice(undefined); setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { extractPdfText, sha256Hex } = await import('./pdf-text');
      const result = await extractPdfText(bytes);
      setPdfBytes(bytes); setFileName(file.name); setSha256(await sha256Hex(bytes));
      const next = result.pages.map((page): PendingPage => ({ page: page.page, text: page.hasTextLayer ? page.text : '', method: page.hasTextLayer ? 'text-layer' : 'vision', needsTranscription: !page.hasTextLayer, warnings: [] }));
      setPages(next);
      setMeta((current) => ({ ...current, title: current.title || file.name.replace(/\.pdf$/iu, '') }));
      prefillParties(next.map((page) => page.text).join('\n'));
    } catch (cause) {
      const kind = typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'kind') : undefined;
      setNotice(kind === 'password' ? text('This PDF is password-protected. Choose a PDF without a password, or paste the text.', 'この PDF はパスワードで保護されています。パスワードを外した PDF を選ぶか、テキストを貼り付けてください。')
        : kind === 'too-large' ? text('The PDF has more than 100 pages. Split it and import the parts separately.', 'PDF が 100 ページを超えています。分冊して取り込んでください。')
          : text('The PDF could not be read. Choose another file, or paste the text.', 'PDF を読めませんでした。別のファイルを選ぶか、テキストを貼り付けてください。'));
    } finally { setBusy(false); }
  }

  async function chooseImages(files: readonly File[]): Promise<void> {
    setError(undefined); setNotice(undefined);
    const images = await Promise.all(files.map(readAsDataUrl));
    setFileName(files[0]?.name); setSha256(undefined); setPdfBytes(undefined);
    setPages(images.map((dataUrl, index) => ({ page: index + 1, text: '', method: 'vision', needsTranscription: true, warnings: [], dataUrl })));
    setMeta((current) => ({ ...current, title: current.title || (files[0]?.name ?? '') }));
  }

  /** スキャンページを 1 ページずつ文字起こしする。中断しても読めたページは残る。 */
  async function transcribeAll(): Promise<void> {
    const targets = pages.filter((page) => page.needsTranscription);
    if (targets.length === 0) return;
    const controller = new AbortController();
    aborter.current = controller; setBusy(true); setError(undefined); setProgress({ done: 0, total: targets.length });
    try {
      for (const [index, target] of targets.entries()) {
        let image = target.dataUrl;
        if (image === undefined && pdfBytes !== undefined) image = await (await import('./pdf-text')).renderPdfPage(pdfBytes, target.page);
        if (image === undefined) continue;
        const result = await api.transcribe(scope, [image], fileName, controller.signal);
        const transcribed = result.pages[0];
        setPages((current) => current.map((page) => page.page === target.page ? { ...page, text: transcribed?.text ?? '', needsTranscription: false, warnings: transcribed?.warnings ?? [] } : page));
        setProgress({ done: index + 1, total: targets.length });
      }
      setPages((current) => { prefillParties(current.map((page) => page.text).join('\n')); return current; });
    } catch (cause) {
      if (isAbort(cause)) setNotice(text('Transcription stopped. The pages read so far are kept.', '文字起こしを中断しました。読めたページは残っています。'));
      else setError(cause);
    } finally { setBusy(false); aborter.current = undefined; }
  }

  function importInput(): ImportContractDocumentDto | undefined {
    if (body.trim() === '') { setNotice(text('The contract text is empty. Paste the text or read a PDF first.', '本文が空です。テキストを貼り付けるか PDF を読み込んでください。')); return undefined; }
    if (body.length > BODY_MAX_CHARS) { setNotice(text('The text exceeds 300,000 characters. Import the appendices separately.', '本文が 300,000 文字を超えています。別紙を分けて取り込んでください。')); return undefined; }
    const joined = source === 'text' ? undefined : joinedPages();
    const type: ContractSourceTypeDto = source === 'text' ? 'text' : source === 'images' ? 'image-ocr' : pages.some((page) => page.method === 'vision') ? 'pdf-ocr' : 'pdf-text';
    return {
      title: meta.title.trim() || text('Untitled contract', '無題の契約書'),
      body: joined?.body ?? body,
      source: { type, ...(fileName === undefined ? {} : { fileName }), ...(source === 'text' ? {} : { pageCount: pages.length }), ...(sha256 === undefined ? {} : { sha256 }) },
      ...(joined === undefined ? {} : { pages: joined.pages }),
      ...metaFields(meta),
    };
  }

  function joinedPages(): { readonly body: string; readonly pages: readonly ContractPageDto[] } {
    let text = '';
    const ranges: ContractPageDto[] = [];
    for (const page of pages) {
      if (text !== '') text += '\n';
      const start = text.length;
      text += page.text;
      ranges.push({ page: page.page, start, end: text.length, method: page.method, warnings: page.warnings });
    }
    return { body: text, pages: ranges };
  }

  function metaFields(meta: Meta) {
    const amount = meta.contractAmount.trim() === '' ? undefined : Number(meta.contractAmount.replace(/[,，円\s]/gu, ''));
    return {
      parties: { ...(meta.partyA.trim() === '' ? {} : { A: meta.partyA.trim() }), ...(meta.partyB.trim() === '' ? {} : { B: meta.partyB.trim() }) },
      ...(meta.ourParty === '' ? {} : { ourParty: meta.ourParty }),
      ourRole: meta.ourRole,
      counterpartyProfile: { toriteki: meta.toriteki, freelance: meta.freelance },
      ...(meta.contractNature === 'unknown' ? {} : { contractNature: meta.contractNature }),
      ...(amount === undefined || !Number.isFinite(amount) ? {} : { contractAmount: Math.trunc(amount) }),
    };
  }

  async function submit(): Promise<void> {
    const input = importInput();
    if (input === undefined) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api.importDocument(scope, input);
      setNotice(result.warnings.length > 0 ? result.warnings.join('\n') : undefined);
      setPasted(''); setPages([]); setFileName(undefined); setPdfBytes(undefined);
      onImported(result.document);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  async function updateSelected(): Promise<void> {
    if (selected === undefined) return;
    setBusy(true); setError(undefined);
    try {
      const document = await api.updateDocument(scope, selected.id, { title: selectedMeta.title.trim() || selected.title, body: selected.body, source: selected.source, pages: selected.pages, ...metaFields(selectedMeta) });
      onImported(document);
      setNotice(text('Saved the parties, role and counterparty category.', '当事者・立場・相手方の区分を保存しました。'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  async function remove(id: string): Promise<void> {
    if (typeof window.confirm === 'function' && !window.confirm(text('Delete this contract document?', 'この契約書を削除しますか？'))) return;
    try { await api.deleteDocument(scope, id); onDeleted(); } catch (cause) { setError(cause); }
  }

  // 選択中の文書と新規取込で同じフォームを 2 回描くので、ラジオの name は描く場所ごとに分ける（同名だと 1 つのグループになり、片方のチェックが消える）。
  const metaForm = (group: 'selected' | 'new') => { const value = group === 'selected' ? selectedMeta : meta; const setField = setterOf(group); return <div className="workspace-card contract-meta">
    <div className="contract-form-row">
      <Field label={text('Title', 'タイトル')}><input value={value.title} onChange={(event) => setField('title', event.target.value)} /></Field>
      <Field label={text('Party A (甲)', '甲の名前')}><input value={value.partyA} onChange={(event) => setField('partyA', event.target.value)} /></Field>
      <Field label={text('Party B (乙)', '乙の名前')}><input value={value.partyB} onChange={(event) => setField('partyB', event.target.value)} /></Field>
    </div>
    <fieldset className="contract-fieldset"><legend>{text('Which party are we?', '自社は甲・乙のどちらですか')}</legend>
      {(['A', 'B', ''] as const).map((key) => <label key={key || 'none'} className="contract-check"><input type="radio" name={`our-party-${group}`}checked={value.ourParty === key} onChange={() => setField('ourParty', key)} />{key === 'A' ? text('We are party A (甲)', '自社は甲') : key === 'B' ? text('We are party B (乙)', '自社は乙') : text('Not decided', '未設定')}</label>)}
    </fieldset>
    <div className="contract-form-row">
      <Field label={text('Our role', '自社の立場')}><select value={value.ourRole} onChange={(event) => setField('ourRole', event.target.value as OurRoleDto)}>{(['client', 'vendor', 'mutual'] as const).map((role) => <option key={role} value={role}>{roleLabel(role, text)}</option>)}</select></Field>
      <Field label={text('Contract nature', '契約の性質')} hint={text('Used only for stamp duty candidates.', '印紙税の候補にだけ使います。')}><select value={value.contractNature} onChange={(event) => setField('contractNature', event.target.value as ContractNatureDto)}>{NATURES.map((nature) => <option key={nature} value={nature}>{nature}</option>)}</select></Field>
      <Field label={text('Contract amount (JPY, optional)', '契約金額（円・任意）')}><input inputMode="numeric" value={value.contractAmount} onChange={(event) => setField('contractAmount', event.target.value)} /></Field>
    </div>
    <fieldset className="contract-fieldset"><legend>{text('Counterparty category (declared by you; not guessed)', '相手方の区分（利用者が申告します。推定しません）')}</legend>
      <Field label={text('Covered by the Toriteki Act (small / medium-sized contractor)?', '取適法の中小受託事業者ですか')} hint={text('Rough guide: capital / number of employees below the thresholds of the Act for the transaction type. Check the JFTC guidance.', '目安: 取引の種類ごとに定められた資本金・従業員数の基準以下の事業者。公正取引委員会の解説で確かめてください。')}>
        <select value={value.toriteki} onChange={(event) => setField('toriteki', event.target.value as ProfileAnswerDto)}><option value="unknown">{text('Unknown', '不明')}</option><option value="yes">{text('Yes', 'はい')}</option><option value="no">{text('No', 'いいえ')}</option></select>
      </Field>
      <Field label={text('A specified contractor under the Freelance Act?', 'フリーランス法の特定受託事業者ですか')} hint={text('Rough guide: an individual or a one-person company without employees.', '目安: 従業員を使用しない個人、または代表者 1 人だけの法人。')}>
        <select value={value.freelance} onChange={(event) => setField('freelance', event.target.value as ProfileAnswerDto)}><option value="unknown">{text('Unknown', '不明')}</option><option value="yes">{text('Yes', 'はい')}</option><option value="no">{text('No', 'いいえ')}</option></select>
      </Field>
    </fieldset>
  </div>; };

  return <section className="contract-step contract-import" aria-label={text('Import', '契約取込')}>
    {error !== undefined && <ApiFailure cause={error} />}
    {notice !== undefined && <p className="notice-card" role="status">{notice}</p>}
    <h2>{text('Imported contracts', '取込済みの契約書')}</h2>
    {documents.length === 0
      ? <p className="empty-state">{text('Import a contract to extract its clauses and check them against your playbook.', '契約書を取り込むと、条項を抜き出して審査基準で確認できます。')}</p>
      : <ul className="contract-list">{documents.map((document) => <li key={document.id} className={selected?.id === document.id ? 'active' : ''}>
        <button type="button" className="ghost" onClick={() => onSelect(document.id)}>{document.title}</button>
        <span className="judge-chip">{documentStatusLabel(document.status, text)}</span>
        {document.counterpartyName !== undefined && <small>{document.counterpartyName}</small>}
        {document.status !== 'signed' && <button type="button" className="secondary danger" onClick={() => void remove(document.id)}>{text('Delete', '削除')}</button>}
      </li>)}</ul>}

    {selected !== undefined && <div className="contract-selected">
      <h2>{text(`Selected: ${selected.title}`, `選択中: ${selected.title}`)}</h2>
      {metaForm('selected')}
      <button type="button" className="primary" disabled={busy || selected.status === 'signed'} onClick={() => void updateSelected()}>{text('Save parties and categories', '当事者と区分を保存')}</button>
    </div>}

    <h2>{text('Import a new contract', '新しく取り込む')}</h2>
    <div className="contract-tabs" role="tablist">
      {([['text', text('Paste text', 'テキスト貼り付け')], ['pdf', 'PDF'], ['images', text('Images', '画像')]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={source === id} className={source === id ? 'active' : ''} onClick={() => { setSource(id); setPages([]); }}>{label}</button>)}
    </div>
    {source === 'text' && <Field label={text('Contract text', '契約書の本文')}><textarea rows={12} value={pasted} onChange={(event) => { setPasted(event.target.value); prefillParties(event.target.value); }} /></Field>}
    {source === 'pdf' && <Field label={text('PDF file', 'PDF ファイル')}><input type="file" accept="application/pdf" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void choosePdf(file); event.currentTarget.value = ''; }} /></Field>}
    {source === 'images' && <>
      {!capabilities.extraction.vision && <div className="notice-card" role="note">
        <p>{text('Reading images needs a main model with vision.', '画像の文字起こしには画像を読める main モデルが必要です。')}</p>
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Set the main model in Settings', '設定で main モデルを設定')}</button><button type="button" className="secondary" onClick={() => setSource('text')}>{text('Paste the text instead', 'テキストを貼り付ける')}</button></div>
      </div>}
      <Field label={text('Page images', 'ページ画像')}><input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={(event) => { void chooseImages(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} /></Field>
    </>}
    {pages.length > 0 && <div className="workspace-card contract-pages">
      <p>{text(`${pages.length} pages · ${pendingTranscription} need transcription`, `${pages.length} ページ・文字起こしが必要 ${pendingTranscription} ページ`)}</p>
      {pendingTranscription > 0 && <div className="run-failure-actions">
        <button type="button" className="secondary" disabled={busy || !capabilities.extraction.vision} onClick={() => void transcribeAll()}>{text('Transcribe the scanned pages', 'スキャンページを文字起こし')}</button>
        {aborter.current !== undefined && <button type="button" className="secondary" onClick={() => aborter.current?.abort()}>{text('Stop', '中断')}</button>}
        {progress !== undefined && <span role="status">{text(`${progress.done} / ${progress.total} pages (about 20 seconds per page)`, `${progress.done} / ${progress.total} ページ（1 ページ 20 秒ほど）`)}</span>}
      </div>}
      <ol>{pages.map((page) => <li key={page.page}>
        <strong>{text(`Page ${page.page}`, `${page.page} ページ`)}</strong> <small>{page.needsTranscription ? text('needs transcription', '文字起こしが必要') : page.method === 'vision' ? text('transcribed — check it', '文字起こし済み（確認してください）') : text('text layer', 'テキスト層')}</small>
        {page.warnings.map((warning) => <small key={warning} className="field-error">{warning}</small>)}
        {!page.needsTranscription && <textarea aria-label={text(`Text of page ${page.page}`, `${page.page} ページの本文`)} rows={4} value={page.text} onChange={(event) => setPages((current) => current.map((entry) => entry.page === page.page ? { ...entry, text: event.target.value } : entry))} />}
      </li>)}</ol>
    </div>}
    {metaForm('new')}
    <button type="button" className="primary" disabled={busy || body.trim() === '' || pendingTranscription > 0} onClick={() => void submit()}>{text('Import', '取り込む')}</button>
    {pendingTranscription > 0 && <small>{text('Transcribe the scanned pages before importing.', '取り込む前にスキャンページを文字起こししてください。')}</small>}
    {busy && <small role="status">{messageOf(text('Working…', '処理中…'))}</small>}
  </section>;
}
