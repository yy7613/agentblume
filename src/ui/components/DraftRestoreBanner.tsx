import { useI18n } from '../i18n';

/** 下書きの保存時刻を環境非依存の形（YYYY-MM-DD HH:mm）で出す。 */
function formatSavedAt(savedAt: string): string {
  const at = new Date(savedAt);
  if (Number.isNaN(at.getTime())) return savedAt;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 未保存の下書きが見つかったことを知らせ、復元／破棄をユーザーへ選ばせるバナー。
 * 自動復元はしない（古い内容で現在の編集を勝手に上書きしないため）。
 */
export function DraftRestoreBanner({ savedAt, onRestore, onDiscard }: {
  readonly savedAt: string;
  readonly onRestore: () => void;
  readonly onDiscard: () => void;
}) {
  const { text } = useI18n();
  const when = formatSavedAt(savedAt);
  return <div className="draft-banner" role="status">
    <span>{text(`Unsaved edits from ${when} were found. Restore them?`, `未保存の編集内容があります（${when}）。復元しますか？`)}</span>
    <span className="draft-banner-actions">
      <button type="button" className="primary" onClick={onRestore}>{text('Restore', '復元')}</button>
      <button type="button" className="secondary" onClick={onDiscard}>{text('Discard', '破棄')}</button>
    </span>
  </div>;
}
