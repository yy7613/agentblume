/**
 * 系統 C（入力と規程）の UI 部品が共有する小さな道具。文言は日英ペア。
 */
import type { ReactNode } from 'react';
import { ApiError } from '../../api/tool-api';
import { useI18n } from '../../i18n';
import { useOpenInScreen } from '../../navigation';

/** 設定画面の main モデルスロットを開く（読取・ヒアリングのモデルを選ぶ場所）。 */
export function useOpenModelSettings(): () => void {
  const openInScreen = useOpenInScreen();
  return () => openInScreen('Settings', { internalId: 'main', section: 'model-slot' });
}

/** 失敗が指定の code の ApiError か。 */
export function isApiErrorCode(cause: unknown, ...codes: readonly string[]): cause is ApiError {
  return cause instanceof ApiError && codes.includes(cause.code);
}

/** CSV の行番号（1 始まり）。ApiError の `row` か `details.row`。 */
export function rowOf(cause: unknown): number | undefined {
  if (!(cause instanceof ApiError)) return undefined;
  if (cause.row !== undefined) return cause.row;
  const row = cause.details?.['row'];
  return typeof row === 'number' ? row : undefined;
}

/**
 * モデルが無くて使えない機能の案内。未設定は失敗ではないので、押す前の案内は `note`、押して断られたときだけ `alert` にする。
 */
export function ModelUnavailableNotice({ title, cause, failed = false, children }: {
  readonly title: string; readonly cause: string; readonly failed?: boolean; readonly children?: ReactNode;
}) {
  const { text } = useI18n();
  const openSettings = useOpenModelSettings();
  return <div className="notice-card expense-input-capability" role={failed ? 'alert' : 'note'}>
    <strong>{title}</strong>
    <p>{cause}</p>
    <p>{text('Next step: choose a model in Settings to use this.', '次の一手: 設定でモデルを選ぶと使えます。')}</p>
    <div className="run-failure-actions">
      <button type="button" className="secondary" onClick={openSettings}>{text('Choose a model in Settings', '設定でモデルを選ぶ')}</button>
      {children}
    </div>
  </div>;
}

export function formatYen(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : `¥${value.toLocaleString('ja-JP')}`;
}

/** 差分の前後の値を短く見せる（長い JSON は切る。全文は title）。 */
export function compactValue(value: unknown, max = 120): { readonly short: string; readonly full: string } {
  const full = value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return { short: full.length > max ? `${full.slice(0, max - 1)}…` : full, full };
}

/** ファイルのバイト列（`arrayBuffer` が無い環境では FileReader）。 */
export async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/** 取引日が YYYY-MM-DD か（運賃の有効期間の照合に渡せるか）。 */
export function isIsoDateText(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
