/**
 * application層: 入金消込が BC の外（仕訳）へ出るポートと、ユースケースが共有する小道具。
 *
 * - `JournalDraftSink`（docs/22 §6.1）: 発行・消込の確定から仕訳の**下書き**を作る。実装は composition だけが持ち、
 *   仕訳の既存ユースケースを包む（receivables の application は仕訳の application を import しない。ADR-0041 決定 5）。
 * - `OrderDocumentReaderPort`（§10.3）: 注文書・見積書の画像を読む。実装は composition が仕訳の vision 読取を包む。
 *
 * ポートを 1 ファイルにまとめたのは、どちらも「composition が仕訳を包んで注入する」同じ性質の境界だから
 * （設計書の `journal-draft-sink.ts` / `order-document-reader.ts` の 2 ファイルをここに寄せた）。
 */
import type { DraftJournalEntry } from '../../domain/receivables/journal-lines';
import type { OrderDocumentRead } from '../../domain/receivables/invoice-draft';
import { JournalLinkError, type JournalLinkMissing } from '../../domain/receivables/errors';
import { journalLinkReferences, type ReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export interface JournalDraftRequest extends DraftJournalEntry {
  /** 前回作った下書き（再確定で差し替える）。 */
  readonly existingEntryId?: string;
}

export type JournalDraftResult =
  | { readonly status: 'created' | 'updated'; readonly entryId: string }
  | { readonly status: 'kept'; readonly entryId: string; readonly entryStatus: 'confirmed' | 'exported' };

export interface JournalDraftSink {
  /** 科目 id と税区分コードがマスタにあり有効か。無い（無効な）ものを返す（空なら使える）。 */
  checkAccounts(scope: TenantScope, refs: { readonly accountIds: readonly string[]; readonly taxCodes: readonly string[] }): Promise<readonly { readonly kind: 'account' | 'tax'; readonly id: string }[]>;
  /** 税区分の税率（手数料の税額を出すため）。無ければ undefined。 */
  taxRateOf(scope: TenantScope, taxCode: string): Promise<number | undefined>;
  /** 下書きを作る / 差し替える。既存が確定・出力済みなら**書かずに** kept。 */
  upsertDraft(scope: TenantScope, request: JournalDraftRequest): Promise<JournalDraftResult>;
  /** 下書きなら消す。確定 / 出力済みなら残す。無ければ not-found。 */
  discardDraft(scope: TenantScope, entryId: string): Promise<'deleted' | 'kept' | 'not-found'>;
}

export interface OrderDocumentReaderPort {
  read(input: { readonly image: string; readonly fileName: string }): Promise<OrderDocumentRead>;
}

/** 仕訳の確認が要る依頼。画面は仕訳を開くボタンを出す。 */
export interface JournalFollowUp {
  readonly entryId: string;
  readonly action: 'review' | 'reverse';
  readonly entryStatus?: 'confirmed' | 'exported';
}

/**
 * 仕訳連携に使う科目・税区分がマスタにあるかを確かめ、無ければ `JournalLinkError`（どの設定項目か付き）。
 * 呼び出しは発行 / 確定と同じ UnitOfWork の中で行い、投げれば発行 / 確定ごと巻き戻る。
 */
export async function assertJournalLink(
  sink: JournalDraftSink,
  scope: TenantScope,
  settings: ReceivablesSettings,
  used: { readonly accountPaths: readonly string[]; readonly taxPaths: readonly string[] },
): Promise<void> {
  const references = journalLinkReferences(settings);
  const accounts = references.accounts.filter((entry) => used.accountPaths.includes(entry.settingPath));
  const taxCodes = references.taxCodes.filter((entry) => used.taxPaths.includes(entry.settingPath));
  const missing = await sink.checkAccounts(scope, { accountIds: [...new Set(accounts.map((entry) => entry.id))], taxCodes: [...new Set(taxCodes.map((entry) => entry.id))] });
  if (missing.length === 0) return;
  const details: JournalLinkMissing[] = missing.flatMap((entry) => (entry.kind === 'account' ? accounts : taxCodes)
    .filter((reference) => reference.id === entry.id)
    .map((reference) => ({ kind: entry.kind, id: entry.id, settingPath: reference.settingPath })));
  throw new JournalLinkError(`journal accounts or tax categories are missing or disabled: ${details.map((entry) => `${entry.settingPath}=${entry.id}`).join(', ')}`, details);
}

/** サーバーのローカル日付（`current_datetime` ツールと同じ時計。期日超過・発行日の既定に使う）。 */
export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 読み込んだ設定、無ければ初期値（保存はしない）。 */
export async function settingsOrDefault(repo: { get(scope: TenantScope): Promise<ReceivablesSettings | null> }, scope: TenantScope, fallback: () => ReceivablesSettings): Promise<{ readonly settings: ReceivablesSettings; readonly saved: boolean }> {
  const stored = await repo.get(scope);
  return stored === null ? { settings: fallback(), saved: false } : { settings: stored, saved: true };
}
