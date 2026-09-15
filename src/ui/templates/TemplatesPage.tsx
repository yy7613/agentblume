import { useNavigateScreen } from '../navigation';
import type { ScreenName } from '../screens';
import { useI18n } from '../i18n';
import { ExperimentalBadge, ExperimentalBanner } from '../components/ExperimentalNotice';
import { BUSINESSES } from '../business/registry';
import type { Label } from '../business/types';

/**
 * 業務テンプレートの入口。
 *
 * 仕訳のような「特定業務にあらかじめ組んだ機能」は、データソース / ツール / エージェントのような
 * 汎用の作成機能と性質が違う。左ナビに並べると粒度が揃わず、業務が増えるほどナビが伸びてしまうので、
 * ここに集約して一覧から入る形にする。
 *
 * 各業務は独立した画面（ScreenName）として登録されているので、`#/journal` のような直リンクは従来どおり効く。
 * ここはその入口を一覧するだけで、業務側の実装には関与しない。
 */

export interface BusinessTemplate {
  readonly id: string;
  /** 開く先の画面。 */
  readonly screen: ScreenName;
  readonly title: Label;
  /** 何ができるところかを 1 文で。 */
  readonly summary: Label;
  /** 一覧での並び順（小さいほど前）。 */
  readonly order: number;
}

/**
 * 業務テンプレートの一覧。業務の記述子（`business/registry.ts`）から作る（ADR-0039）。
 *
 * 業務を増やすときは、業務の記述子を 1 つ足す（このファイルは触らない）。
 * 実装が無いもの（`listed: false`）は「準備中」として並べない（使えない入口は利用者の時間を奪うだけなので）。
 */
export const BUSINESS_TEMPLATES: readonly BusinessTemplate[] = BUSINESSES
  .filter((business) => business.listed)
  .map((business) => ({ id: business.id, screen: business.screen, title: business.card.title, summary: business.card.summary, order: business.card.order }));

export function TemplatesPage({ templates = BUSINESS_TEMPLATES }: {
  /** 差し替えられるのはテストのため。通常は既定のカタログを使う。 */
  readonly templates?: readonly BusinessTemplate[];
}) {
  const { text } = useI18n();
  const navigate = useNavigateScreen();
  const ordered = [...templates].sort((left, right) => left.order - right.order);

  function open(template: BusinessTemplate): void {
    // 遷移は App の未保存確認を通る唯一の経路（navigation context）に委ねる。
    // Provider の外（単体テスト等）では no-op になるので、ここで握り潰さない。
    navigate(template.screen);
  }

  return <main className="workspace-page templates-page">
    <header className="workspace-header"><div>
      <span className="eyebrow">{text('Business templates', '業務テンプレート')}</span> <ExperimentalBadge />
      <h1>{text('Business templates', '業務テンプレート')}</h1>
      <p>{text(
        'Features built for a specific line of work. Pick one to open it. Everything here is built on the same tools, agents, and data sources as the rest of the studio.',
        '特定の業務向けにあらかじめ組んである機能です。選ぶとその業務の画面に入ります。中身は他の画面と同じツール・エージェント・データソースの上に作られています。',
      )}</p>
    </div></header>
    <ExperimentalBanner />

    {ordered.length === 0
      ? <p className="empty-state">{text('No business templates are available yet.', 'まだ利用できる業務テンプレートはありません。')}</p>
      : <ul className="template-cards">
        {ordered.map((template) => <li key={template.id}>
          <button type="button" className="template-card" aria-label={text(template.title.en, template.title.ja)} onClick={() => open(template)}>
            <span className="template-card-title">{text(template.title.en, template.title.ja)} <ExperimentalBadge /></span>
            <span className="template-card-summary">{text(template.summary.en, template.summary.ja)}</span>
            <span className="template-card-open" aria-hidden="true">{text('Open →', '開く →')}</span>
          </button>
        </li>)}
      </ul>}
  </main>;
}
