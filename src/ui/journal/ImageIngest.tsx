import type { JournalCapabilitiesDto } from '../api/types';
import { useI18n } from '../i18n';
import { CapabilityNotice } from './journal-shared';

/**
 * 画像 / PDF の取込（Phase 2 で完成させる）。
 *
 * TODO(Phase 2): 画像は長辺 2000px の JPEG に縮小して data URL にし、PDF は `pdfjs-dist` でブラウザ側でページ画像化
 * （テキスト層があれば添付）してから `POST /journal/documents/extract` に渡す（docs/20 §6、ADR-0038: サーバーに PDF ライブラリを持ち込まない）。
 * Phase 1 ではファイル入力を置くだけで、機能の可否（vision）の案内と設定画面への導線を出す。
 */
export function ImageIngest({ capabilities }: { readonly capabilities: JournalCapabilitiesDto | undefined }) {
  const { text } = useI18n();
  const ready = capabilities?.extraction.enabled === true && capabilities.extraction.vision;
  return <section className="workspace-card journal-ingest-section" aria-labelledby="journal-image-heading">
    <h2 id="journal-image-heading">{text('Image / PDF', '画像 / PDF')}</h2>
    <p className="empty-state">{text('Photograph a receipt or drop a PDF invoice. The model reads the facts; you review them before saving.', 'レシートの写真や PDF の請求書を選びます。モデルが事実を読み取り、保存前に確認できます。')}</p>
    <div className="journal-file-row">
      <label>{text('Image (JPEG / PNG)', '画像（JPEG / PNG）')}<input type="file" accept="image/*" disabled={!ready} /></label>
      <label>{text('PDF', 'PDF')}<input type="file" accept="application/pdf" disabled={!ready} /></label>
      <button type="button" className="primary" disabled title={ready ? text('Coming in the next phase', '次のフェーズで対応') : undefined}>{text('Read with AI', 'AI で読み取る')}</button>
    </div>
    <CapabilityNotice capabilities={capabilities} feature="vision" />
    {ready && <p className="notice-card">{text('Image and PDF reading arrives in the next phase; until then, use the facts form or CSV import.', '画像 / PDF の読み取りは次のフェーズで対応します。それまでは事実フォームか CSV 取込を使ってください。')}</p>}
  </section>;
}
