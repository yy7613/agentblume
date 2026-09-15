import { useI18n } from '../i18n';
import { useNavigateScreen } from '../navigation';

/**
 * 業務テンプレート（仕訳・経費精算・入金消込・契約）が**実験的な機能**であることの表示。
 *
 * 業務テンプレートは会計・法務の判断に近い結果を出すが、画面・保存形式・判定の仕様はまだ固まっていない。
 * 汎用の作成機能（ツール・エージェント）と同じ完成度だと受け取られないよう、入口（一覧・左ナビ）と
 * 各業務の画面の両方で同じ言葉で示す。文言を 1 か所に持つのは、場所ごとに言い方がずれないため。
 */

/** 印の title（どこに置いても同じ補足）。左ナビではボタンの title にも使う。 */
export function useExperimentalHint(): string {
  const { text } = useI18n();
  return text('Experimental feature: behavior and saved data may change.', '実験的な機能です。動作や保存データの形式は変わることがあります。');
}

/**
 * 見出しやカードに添える小さな印。
 * `compact` は幅の狭い左ナビ用で「β」だけを見せる。ボタンの名前（読み上げ・操作の目印）を変えないよう
 * 読み上げからは外し、言葉での説明は置いた側のボタンの title に任せる。
 */
export function ExperimentalBadge({ compact = false }: { readonly compact?: boolean }) {
  const { text } = useI18n();
  const hint = useExperimentalHint();
  return <span
    className={`experimental-badge${compact ? ' compact' : ''}`}
    title={hint}
    {...(compact ? { 'aria-hidden': true } : {})}
  >
    {compact ? 'β' : text('Experimental', '実験的')}
  </span>;
}

/**
 * 実験的な機能が非表示のときに、業務テンプレートの画面（直リンク `#/journal` 等）の代わりに出す案内。
 * 「なぜ開けないか」と「どこで有効にするか」をセットで示し、設定画面へ一手で行けるようにする。
 */
export function ExperimentalDisabledPage() {
  const { text } = useI18n();
  const navigate = useNavigateScreen();
  return <main className="workspace-page">
    <header className="workspace-header"><div>
      <span className="eyebrow">{text('Business templates', '業務テンプレート')}</span> <ExperimentalBadge />
      <h1>{text('Experimental features are hidden', '実験的な機能は非表示になっています')}</h1>
      <p>{text(
        'Business templates are an experimental feature, so they are hidden by default. Turn on "Show experimental features" in Settings to open this screen.',
        '業務テンプレートは実験的な機能のため、初期状態では非表示です。この画面を開くには、設定の「実験的な機能を表示する」をオンにしてください。',
      )}</p>
    </div></header>
    <button type="button" onClick={() => navigate('Settings')}>{text('Open Settings', '設定を開く')}</button>
  </main>;
}

/** 画面の先頭に出す注意書き。何が変わりうるかと、利用者がすべきことを 1 文ずつ。 */
export function ExperimentalBanner() {
  const { text } = useI18n();
  return <p className="experimental-banner" role="note">
    <ExperimentalBadge />
    <span>{text(
      'Business templates are an experimental feature. Screens, saved data formats, and judgment rules may change without notice. Always have a person review the results, and do not rely on them as final accounting, tax, or legal decisions.',
      '業務テンプレートは実験的な機能です。画面・保存データの形式・判定のルールは予告なく変わることがあります。結果は必ず人が確認し、会計・税務・法務の最終判断には使わないでください。',
    )}</span>
  </p>;
}
