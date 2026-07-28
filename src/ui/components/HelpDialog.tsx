import { screenHelp } from '../help-content';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { useI18n } from '../i18n';
import type { ScreenName } from '../screens';

/**
 * 表示中の画面のアプリ内ヘルプ。
 *
 * Escape・フォーカストラップ・初期フォーカス・フォーカス復帰は useModalBehavior が担う。
 * 参照ドキュメントはリポジトリ内の Markdown で、ブラウザからは開けないためパスを文字列で示す。
 */
export function HelpDialog({ screen, onClose }: { readonly screen: ScreenName; readonly onClose: () => void }) {
  const { text } = useI18n();
  const dialogRef = useModalBehavior<HTMLElement>({ onClose });
  const help = screenHelp(screen);
  return <div className="confirm-backdrop" role="presentation" onClick={onClose}>
    <section ref={dialogRef} tabIndex={-1} className="help-dialog" role="dialog" aria-modal="true" aria-label={text('Help', 'ヘルプ')} onClick={(event) => event.stopPropagation()}>
      <header>
        <div><span className="eyebrow">{text('Help', 'ヘルプ')}</span><h2>{text(help.title.en, help.title.ja)}</h2></div>
        <button type="button" className="ghost" aria-label={text('Close help', 'ヘルプを閉じる')} onClick={onClose}>×</button>
      </header>
      <p className="help-summary">{text(help.summary.en, help.summary.ja)}</p>
      <ul className="help-steps">
        {help.steps.map((step) => <li key={step.en}>{text(step.en, step.ja)}</li>)}
      </ul>
      {help.doc !== undefined && <p className="help-doc">
        {text('More detail is in the repository (open it in your editor):', 'さらに詳しい説明はリポジトリ内にあります（エディタで開いてください）:')}
        {' '}<code>{help.doc}</code>
      </p>}
      <div className="confirm-actions">
        <button type="button" className="primary" onClick={onClose}>{text('Close', '閉じる')}</button>
      </div>
    </section>
  </div>;
}
