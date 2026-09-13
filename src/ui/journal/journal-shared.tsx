import type { ReactNode } from 'react';
import type { JournalCapabilitiesDto, JournalChartOfAccountsDto, JournalDocumentStatusDto } from '../api/types';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';
import { accountsByCategory, categoryLabel, statusLabel } from './journal-model';

/** 仕訳タブ共通の小さな部品。科目・税区分のセレクトはすべて利用者のマスタから作る（名前のハードコード禁止）。 */

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 入力欄の直下に出す指摘。無ければ何も描かない。 */
export function FieldError({ message }: { readonly message: string | undefined }) {
  return message === undefined ? null : <small className="field-error" role="alert">{message}</small>;
}

export function StatusChip({ status }: { readonly status: JournalDocumentStatusDto }) {
  const { text } = useI18n();
  return <span className={`judge-chip journal-status journal-status-${status}`}>{statusLabel(status, text)}</span>;
}

/** 科目セレクト（有効な科目だけ、category ごとにグループ）。無効化された科目が選ばれたままなら、その id を選択肢として残して見せる。 */
export function AccountSelect({ chart, value, onChange, id, label, disabled = false }: {
  readonly chart: Pick<JournalChartOfAccountsDto, 'accounts'>; readonly value: string; readonly onChange: (accountId: string) => void; readonly id?: string; readonly label: string; readonly disabled?: boolean;
}) {
  const { text } = useI18n();
  const groups = accountsByCategory(chart);
  const known = chart.accounts.some((account) => account.enabled && account.id === value);
  return <select {...(id === undefined ? {} : { id })} aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="">{text('— choose an account —', '— 科目を選択 —')}</option>
    {!known && value !== '' && <option value={value}>{text(`${value} (not in the chart)`, `${value}（マスタに無い）`)}</option>}
    {groups.map((group) => <optgroup key={group.category} label={categoryLabel(group.category, text)}>{group.accounts.map((account) => <option key={account.id} value={account.id}>{account.code === undefined || account.code === '' ? account.name : `${account.code} ${account.name}`}</option>)}</optgroup>)}
  </select>;
}

export function TaxSelect({ chart, value, onChange, label, id, disabled = false }: {
  readonly chart: Pick<JournalChartOfAccountsDto, 'taxCategories'>; readonly value: string; readonly onChange: (code: string) => void; readonly label: string; readonly id?: string; readonly disabled?: boolean;
}) {
  const { text } = useI18n();
  const enabled = chart.taxCategories.filter((tax) => tax.enabled);
  const known = enabled.some((tax) => tax.code === value);
  return <select {...(id === undefined ? {} : { id })} aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="">{text('— choose a tax category —', '— 税区分を選択 —')}</option>
    {!known && value !== '' && <option value={value}>{text(`${value} (not in the chart)`, `${value}（マスタに無い）`)}</option>}
    {enabled.map((tax) => <option key={tax.code} value={tax.code}>{tax.name} ({tax.code})</option>)}
  </select>;
}

/**
 * 読み取りを実際に試したら 409（JOURNAL_EXTRACTION_UNAVAILABLE）で断られたときの案内。
 * 機能フラグ上は使える扱いでも、モデルを差し替えた直後などは実行時に判明する。原因（サーバーの文言）→ 次の一手 → 設定画面。
 */
export function ExtractionUnavailableNotice({ message }: { readonly message: string }) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  return <div className="notice-card journal-capability" role="alert">
    <strong>{text('AI reading is not available', 'AI 読み取りが使えません')}</strong>
    <p>{message}</p>
    <p>{text('Next step: pick a main model that accepts images and structured output in Settings, then read the document again.', '次の一手: 設定画面で、画像と構造化出力に対応した main モデルを選んでから、もう一度読み取ってください。')}</p>
    <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Set the main model in Settings', '設定で main モデルを設定')}</button>
    </div>
  </div>;
}

/**
 * LLM 抽出 / ヒアリングが使えないときの案内。原因 → 次の一手 → 設定画面（main モデルスロット）へのボタン。
 * `feature` で文言を切り替える。使える状態では何も描かない。
 */
export function CapabilityNotice({ capabilities, feature, children }: { readonly capabilities: JournalCapabilitiesDto | undefined; readonly feature: 'extraction' | 'vision' | 'hearing'; readonly children?: ReactNode }) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const available = capabilities !== undefined && (feature === 'extraction' ? capabilities.extraction.enabled : feature === 'vision' ? capabilities.extraction.enabled && capabilities.extraction.vision : capabilities.hearing.enabled);
  if (available) return null;
  const cause = capabilities === undefined
    ? text('The server has not reported whether LLM features are available.', 'サーバーから LLM 機能の可否がまだ取得できていません。')
    : feature === 'vision' && capabilities.extraction.enabled
      ? text('The configured main model does not accept images, so receipts cannot be read from images or PDFs.', '設定中の main モデルは画像を受け付けないため、画像 / PDF から帳票を読み取れません。')
      : feature === 'hearing'
        ? text('The hearing (stage 2) is not enabled on this server. It needs a main model that supports structured output.', 'ヒアリング（Stage 2）はこのサーバーで有効になっていません。構造化出力に対応した main モデルが必要です。')
        : text('LLM extraction is not enabled on this server. It needs a main model that supports structured output.', 'LLM 抽出はこのサーバーで有効になっていません。構造化出力に対応した main モデルが必要です。');
  return <div className="notice-card journal-capability" role="note">
    <strong>{feature === 'hearing' ? text('Hearing is not available yet', 'ヒアリングはまだ使えません') : text('AI reading is not available yet', 'AI 読み取りはまだ使えません')}</strong>
    <p>{cause}</p>
    <p>{text('Next step: set the main model slot in Settings (a model with structured output; with vision for images), then reopen this screen.', '次の一手: 設定画面で main モデルスロットを設定し（構造化出力対応。画像は vision 対応モデル）、この画面を開き直してください。')}</p>
    <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={() => openInScreen('Settings', { internalId: 'main', section: 'model-slot' })}>{text('Set the main model in Settings', '設定で main モデルを設定')}</button>
      {children}
    </div>
  </div>;
}
