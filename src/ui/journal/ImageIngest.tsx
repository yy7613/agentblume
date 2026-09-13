import { useRef, useState, type DragEvent } from 'react';
import { ApiError, isAbortError, type ToolApiClient } from '../api/tool-api';
import type { ExtractJournalDocumentResultDto, JournalCapabilitiesDto, JournalDocumentSourceDto } from '../api/types';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { scope } from '../scope';
import {
  EXTRACTABLE_IMAGE_TYPES, IMAGE_JPEG_QUALITY, IMAGE_LOW_RESOLUTION_LONG_EDGE, IMAGE_SKIP_REENCODE_BYTES, IMAGE_TARGET_LONG_EDGE, MAX_EXTRACTION_IMAGES, PDF_MIME,
  formatPixels, pickedFileKind, scaledSize, withinDataUrlLimit,
} from './journal-model';
import { CapabilityNotice, ExtractionUnavailableNotice, messageOf } from './journal-shared';

/** 送信する画像 1 枚（PDF は 1 ページ）。 */
interface PickedImage {
  readonly id: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** サムネイルの見出し（ファイル名。PDF は「名前 p.2」）。 */
  readonly label: string;
}

/**
 * 画像 / PDF の取込（docs/20 §6）。
 *
 * 画像は canvas で長辺 2000px に縮小して JPEG へ再エンコードし、PDF は `pdfjs-dist` でブラウザ側でページ画像化する
 * （ADR-0038: サーバーに PDF ライブラリを持ち込まない）。どちらも data URL にして `POST /journal/documents/extract` に渡し、
 * 返ってきた事実は取込タブの事実フォームへ載せる（保存は利用者が確認してから）。
 *
 * 解像度は読み取り精度に直結する（実測: A4 の請求書 1350x1355 は正解、レシート 510x881 は登録番号と 8% 対象額を誤読）。
 * そこで **元より大きくは引き伸ばさず**、長辺 1200px を下回るものはサムネイルと注意書きで知らせる（送信は止めない）。
 */
export function ImageIngest({ client, capabilities, onExtracted }: {
  readonly client: ToolApiClient;
  readonly capabilities: JournalCapabilitiesDto | undefined;
  /** 抽出できたら取込タブへ渡す（事実フォームに展開される）。 */
  readonly onExtracted: (result: ExtractJournalDocumentResultDto, source: JournalDocumentSourceDto) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const [images, setImages] = useState<readonly PickedImage[]>([]);
  const [pdfText, setPdfText] = useState('');
  const [fileName, setFileName] = useState('');
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [readError, setReadError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [aborter, setAborter] = useState<AbortController>();
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  /** 409（モデルが画像読取 / 構造化出力に非対応）。ただのエラーではなく設定への導線を出す。 */
  const [unavailable, setUnavailable] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const seqRef = useRef(0);
  const elapsedSeconds = useElapsedSeconds(aborter !== undefined);

  const ready = capabilities?.extraction.enabled === true && capabilities.extraction.vision;
  const extracting = aborter !== undefined;
  const busy = reading || extracting;
  const lowResolution = images.filter((image) => Math.max(image.width, image.height) < IMAGE_LOW_RESOLUTION_LONG_EDGE);

  /** 選ばれたファイルを読み、送信できる画像に変える。1 件の失敗は他を止めない。 */
  const addFiles = async (picked: readonly File[]) => {
    if (picked.length === 0) return;
    setReading(true);
    setReadError(undefined);
    setError(undefined);
    setCancelled(false);
    const accepted: PickedImage[] = [];
    const messages: string[] = [];
    let name = fileName;
    let extractedText = pdfText;
    try {
      for (const file of picked) {
        const kind = pickedFileKind(file);
        if (kind === 'other') {
          messages.push(text(
            `"${file.name}" is not an image or a PDF, so it cannot be read. Choose a PNG / JPEG / WebP / GIF image or a PDF.`,
            `「${file.name}」は画像でも PDF でもないため読み取れません。PNG / JPEG / WebP / GIF か PDF を選んでください。`,
          ));
          continue;
        }
        if (name === '') name = file.name;
        try {
          if (kind === 'image') {
            accepted.push(await readImageFile(file, nextId(seqRef)));
          } else {
            const { rasterizePdf } = await import('./pdf-raster');
            const raster = await rasterizePdf(new Uint8Array(await file.arrayBuffer()), { maxPages: MAX_EXTRACTION_IMAGES });
            for (const page of raster.pages) {
              accepted.push({ id: nextId(seqRef), dataUrl: page.dataUrl, width: page.width, height: page.height, label: `${file.name} p.${page.pageNumber}` });
            }
            if (raster.text !== '') extractedText = extractedText === '' ? raster.text : `${extractedText}\n${raster.text}`;
            if (raster.totalPages > raster.pages.length) {
              messages.push(text(
                `"${file.name}" has ${raster.totalPages} pages; only the first ${raster.pages.length} are sent. Split the PDF if a later page holds the invoice.`,
                `「${file.name}」は ${raster.totalPages} ページありますが、先頭 ${raster.pages.length} ページだけを送ります。後ろのページに帳票があるときは PDF を分割してください。`,
              ));
            }
          }
        } catch (cause: unknown) {
          messages.push(describeFileFailure(file.name, cause, text));
        }
      }
    } finally {
      setReading(false);
    }
    setFileName(name);
    setPdfText(extractedText);
    setImages((current) => {
      const merged = [...current, ...accepted];
      if (merged.length > MAX_EXTRACTION_IMAGES) {
        messages.push(text(
          `Only ${MAX_EXTRACTION_IMAGES} images can be read at once; the extra ones were dropped. Read them in separate runs.`,
          `一度に読み取れるのは ${MAX_EXTRACTION_IMAGES} 枚までです。超えた分は外しました。分けて読み取ってください。`,
        ));
      }
      return merged.slice(0, MAX_EXTRACTION_IMAGES);
    });
    setNotices(messages);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!ready || busy) return;
    void addFiles([...event.dataTransfer.files]);
  };

  const remove = (id: string) => setImages((current) => current.filter((image) => image.id !== id));

  const clear = () => { setImages([]); setPdfText(''); setFileName(''); setNotices([]); setReadError(undefined); setError(undefined); setCancelled(false); };

  const extract = async () => {
    if (images.length === 0 || extracting) return;
    const controller = new AbortController();
    setAborter(controller);
    setError(undefined);
    setUnavailable(undefined);
    setCancelled(false);
    try {
      const result = await client.extractJournalDocument(scope, {
        images: images.map((image) => image.dataUrl),
        ...(pdfText === '' ? {} : { text: pdfText }),
        ...(fileName === '' ? {} : { fileName }),
      }, controller.signal);
      const source: JournalDocumentSourceDto = {
        type: fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image',
        ...(fileName === '' ? {} : { fileName }),
        ...(images[0] === undefined ? {} : { dataUrl: images[0].dataUrl }),
        ...(pdfText === '' ? {} : { text: pdfText }),
      };
      onExtracted(result, source);
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else if (cause instanceof ApiError && cause.code === 'JOURNAL_EXTRACTION_UNAVAILABLE') setUnavailable(messageOf(cause));
      else setError(messageOf(cause));
    } finally {
      setAborter(undefined);
    }
  };

  return <section className="workspace-card journal-ingest-section" aria-labelledby="journal-image-heading">
    <h2 id="journal-image-heading">{text('Image / PDF', '画像 / PDF')}</h2>
    <p className="empty-state">{text('Photograph a receipt or drop a PDF invoice. The model reads the facts; you review them before saving. PDFs are turned into page images in your browser, so the file itself never leaves for a PDF service.', 'レシートの写真や PDF の請求書を選びます。モデルが事実を読み取り、保存前に確認できます。PDF はブラウザ側でページ画像にしてから送ります。')}</p>
    <div
      className={`journal-drop${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); if (ready && !busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="journal-file-row">
        <label>{text('Image (JPEG / PNG)', '画像（JPEG / PNG）')}
          <input type="file" multiple accept={EXTRACTABLE_IMAGE_TYPES.join(',')} disabled={!ready || busy} onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
        </label>
        <label>{text('PDF', 'PDF')}
          <input type="file" multiple accept={PDF_MIME} disabled={!ready || busy} onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
        </label>
      </div>
      <p className="empty-state">{text(`Or drop files here. Up to ${MAX_EXTRACTION_IMAGES} images (PDF pages count as images) per reading.`, `ここにファイルを落としても構いません。1 回の読み取りにつき ${MAX_EXTRACTION_IMAGES} 枚（PDF はページ数）までです。`)}</p>
    </div>

    <CapabilityNotice capabilities={capabilities} feature="vision" />
    {readError !== undefined && <p className="api-error" role="alert">{readError}</p>}
    {reading && <p role="status" className="empty-state">{text('Preparing the images…', '画像を準備しています…')}</p>}
    {notices.map((notice, index) => <p key={index} className="notice-card">{notice}</p>)}

    {images.length > 0 && <>
      <ul className="journal-thumbs" aria-label={text('Images to send', '送信する画像')}>
        {images.map((image) => {
          const low = Math.max(image.width, image.height) < IMAGE_LOW_RESOLUTION_LONG_EDGE;
          return <li key={image.id} className={low ? 'low-resolution' : ''}>
            <img src={image.dataUrl} alt={image.label} />
            <span className="journal-thumb-label">{image.label}</span>
            <small className="journal-thumb-size">{formatPixels(image.width, image.height)}{low ? ` · ${text('low resolution', '解像度が低い')}` : ''}</small>
            <button type="button" className="secondary danger" disabled={busy} onClick={() => remove(image.id)} aria-label={text(`Remove ${image.label}`, `${image.label} を外す`)}>{text('Remove', '外す')}</button>
          </li>;
        })}
      </ul>
      {lowResolution.length > 0 && <div className="notice-card journal-low-resolution" role="note">
        <strong>{text('These images may be misread', '読み取りを誤りやすい画像があります')}</strong>
        <p>{text(`${lowResolution.length} of the images are under ${IMAGE_LOW_RESOLUTION_LONG_EDGE}px on the long edge. At this size the model tends to misread registration numbers and per-rate amounts.`, `${lowResolution.length} 枚が長辺 ${IMAGE_LOW_RESOLUTION_LONG_EDGE}px を下回っています。この大きさでは登録番号や税率別の金額を読み誤りやすくなります。`)}</p>
        <p>{text('Next step: photograph it again larger (fill the frame with the document), or for a PDF take the page at a larger size. You can still read it now and fix the fields afterwards.', '次の一手: もっと大きい画像で撮り直す（帳票が画面いっぱいになるように写す）か、PDF ならページを拡大して取り込んでください。このまま読み取って、後から項目を直しても構いません。')}</p>
      </div>}
      {pdfText !== '' && <p className="empty-state">{text('The PDF text layer is sent along with the images, which helps the model read exact amounts.', 'PDF のテキスト層も画像と一緒に送ります（金額の読み取りが安定します）。')}</p>}
    </>}

    {images.length > 1 && !extracting && <p className="empty-state">{text(
      `${images.length} images · a local 12B-class model needs roughly 15-20 seconds per image, so allow a few minutes for this many.`,
      `${images.length} 枚 · ローカルの 12B 級モデルで 1 枚あたり十数秒かかります。この枚数だと数分を見込んでください。`,
    )}</p>}
    <div className="run-failure-actions">
      <button type="button" className="primary" disabled={!ready || busy || images.length === 0} onClick={() => void extract()}>
        {extracting ? text(`Reading… ${elapsedSeconds}s`, `読み取り中… ${elapsedSeconds}秒`) : text('Read with AI', 'AI で読み取る')}
      </button>
      {extracting && <button type="button" className="secondary" onClick={() => aborter?.abort()}>{text('Cancel', '中断')}</button>}
      {images.length > 0 && !extracting && <button type="button" className="secondary" disabled={busy} onClick={clear}>{text('Clear', 'すべて外す')}</button>}
    </div>
    {extracting && <p role="status" className="empty-state">{text('The model is reading the document. This takes longer for several pages.', 'モデルが帳票を読んでいます。ページ数が多いほど時間がかかります。')}</p>}
    {/* 実測: 12B 級で 1 枚 17〜19 秒、26B 級では同じレシートに 229 秒。待たされている人に「壊れていない」と「速くする手」を伝える。 */}
    {extracting && elapsedSeconds > 30 && <div className="notice-card" role="note">
      <p>{text('Some models take several minutes for a single document. Choosing a smaller model in Settings reads faster; a larger one is more accurate but much slower.', 'モデルによっては 1 枚に数分かかります。設定でより小さいモデルに変えると速くなります（大きいモデルほど正確ですが、その分遅くなります）。')}</p>
      <div className="run-failure-actions">
        <button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Change the model in Settings', '設定でモデルを変える')}</button>
      </div>
    </div>}
    {cancelled && <InlineFeedback kind="info">{text('Cancelled. Nothing was read and nothing was saved.', '中断しました。読み取りも保存も行っていません。')}</InlineFeedback>}
    {unavailable !== undefined && <ExtractionUnavailableNotice message={unavailable} />}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}
  </section>;
}

function nextId(seqRef: { current: number }): string {
  seqRef.current += 1;
  return `img-${seqRef.current}`;
}

/** ファイル 1 件の読み取り失敗を、原因 → 次の一手の 1 文にする。 */
function describeFileFailure(name: string, cause: unknown, text: (en: string, ja: string) => string): string {
  const kind = (cause as { readonly kind?: string } | null)?.kind;
  if (kind === 'password') {
    return text(
      `"${name}" is password-protected, so its pages cannot be read. Remove the password (open it and save a copy without one), then choose it again.`,
      `「${name}」はパスワードで保護されているためページを読めません。パスワードを外して保存し直してから選び直してください。`,
    );
  }
  if (kind === 'corrupt') {
    return text(
      `"${name}" could not be read as a PDF (the file may be damaged or incomplete). Open it in a PDF viewer to check it, or print it to a new PDF and try again.`,
      `「${name}」を PDF として読めませんでした（壊れているか、途中までしかない可能性があります）。PDF ビューアで開けるか確かめるか、印刷して PDF を作り直してから試してください。`,
    );
  }
  return text(`"${name}" could not be prepared: ${messageOf(cause)}`, `「${name}」を準備できませんでした: ${messageOf(cause)}`);
}

/**
 * 画像 1 枚を送信できる data URL にする。長辺 2000px を超えるものだけ canvas で縮小し JPEG に再エンコードする。
 * 十分に小さく上限内に収まるものはそのまま送る（再エンコードで劣化させない）。
 */
async function readImageFile(file: File, id: string): Promise<PickedImage> {
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot decode images for resizing (createImageBitmap is unavailable).');
  const bitmap = await createImageBitmap(file);
  try {
    const target = scaledSize(bitmap.width, bitmap.height, IMAGE_TARGET_LONG_EDGE);
    if (target.width === bitmap.width && target.height === bitmap.height && file.size <= IMAGE_SKIP_REENCODE_BYTES) {
      const asIs = await fileDataUrl(file);
      if (withinDataUrlLimit(asIs)) return { id, dataUrl: asIs, width: bitmap.width, height: bitmap.height, label: file.name };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, target.width);
    canvas.height = Math.max(1, target.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The browser did not provide a 2D canvas context.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    if (!withinDataUrlLimit(dataUrl)) throw new Error('The image is still too large after resizing. Crop it to the document, then try again.');
    return { id, dataUrl, width: canvas.width, height: canvas.height, label: file.name };
  } finally {
    bitmap.close?.();
  }
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}
