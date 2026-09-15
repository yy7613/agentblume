/**
 * application層: 法人カード明細 CSV の取込（プレビュー → 取込。docs/21 §20.1.5 / §20.9.3。UC5）。
 *
 * - 列の対応: 指定のマッピング → 指定のプロファイル → 見出しの署名が一致する保存済みプロファイル → 見出しからの推定（プレビューだけ）。
 * - 二重取込: 同じファイル（SHA-256）は取込全体を 409、期間の重なるファイルの同じ行は `dedupeKey` で 1 件にする（`duplicates` に数える）。
 * - `saveProfileAs` を渡すと、今回の列の対応をプロファイルとして保存し、次回から自動で選ばれる（取込と同じトランザクション）。
 * - 読めない行は行番号と理由で返し、黙って捨てない。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createExpenseCardImport, createExpenseCardSettings, createExpenseCardTransaction, type CardImportMapping, type CardStatementProfile, type ExpenseCardImport } from '../../../domain/expense/card';
import { ExpenseCardImportError, ExpenseCardImportNotFoundError } from '../../../domain/expense/errors';
import {
  CARD_REQUIRED_COLUMNS, cardHeaderSignature, detectCardProfile, parseCardStatement, readCardStatementTable, suggestCardMapping,
  type CardColumnKey, type ParsedCardRow,
} from '../../../domain/expense/money/card-csv';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';

export const CARD_PREVIEW_ROWS = 5;
export const CARD_PREVIEW_SKIPPED_ROWS = 20;

export interface CardStatementPreviewInput {
  readonly content: string;
  readonly profileId?: string;
  readonly mapping?: CardImportMapping;
  readonly cardId?: string;
}

export interface CardStatementPreviewProblem {
  readonly code: 'mapping-missing' | 'card-import';
  readonly message: string;
  readonly row?: number;
  readonly missingColumns?: readonly string[];
}

export interface CardStatementPreview {
  readonly headers: readonly string[];
  readonly detectedProfileId?: string;
  readonly suggestedMapping: Partial<Record<CardColumnKey, string>>;
  readonly rows: readonly Omit<ParsedCardRow, 'raw' | 'dedupeKey'>[];
  readonly rowCount: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly problems: readonly CardStatementPreviewProblem[];
}

export interface CardStatementImportInput {
  readonly content: string;
  readonly fileName: string;
  readonly cardId?: string;
  readonly profileId?: string;
  readonly mapping?: CardImportMapping;
  /** 今回の列の対応をこの名前のプロファイルとして保存する（同じ名前があれば置き換える）。 */
  readonly saveProfileAs?: string;
}

export interface CardStatementImportResult {
  readonly importId: string;
  readonly imported: number;
  readonly duplicates: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly string[];
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly profileId?: string;
}

function mappingOf(profile: CardStatementProfile): CardImportMapping {
  return { columns: profile.columns, amountSign: profile.amountSign, skipLinesBefore: profile.skipLinesBefore };
}

export class ImportCardStatementUseCase {
  constructor(
    private readonly deps: ExpenseSystemDeps,
    private readonly makeId: () => string = () => randomUUID().replaceAll('-', '').slice(0, 16),
  ) {}

  /** 見出しの署名で保存済みのプロファイルを探す（プロファイルごとに前置きの行数が違うので、その行数で読んで比べる）。 */
  private detect(content: string, profiles: readonly CardStatementProfile[]): CardStatementProfile | undefined {
    for (const profile of profiles) {
      try {
        if (detectCardProfile(readCardStatementTable(content, profile.skipLinesBefore).headers, [profile]) !== undefined) return profile;
      } catch (error) {
        if (!(error instanceof ExpenseCardImportError)) throw error;
      }
    }
    return undefined;
  }

  private profileById(profiles: readonly CardStatementProfile[], profileId: string | undefined): CardStatementProfile | undefined {
    if (profileId === undefined) return undefined;
    const profile = profiles.find((entry) => entry.id === profileId);
    if (profile === undefined) throw new ExpenseCardImportError(`card statement: profile ${profileId} is not saved`);
    return profile;
  }

  async preview(scope: TenantScope, input: CardStatementPreviewInput): Promise<CardStatementPreview> {
    const { cards, profiles } = (await this.deps.settings.load(scope, 'cards')).value;
    const chosen = this.profileById(profiles, input.profileId);
    const detected = input.mapping === undefined && chosen === undefined ? this.detect(input.content, profiles) : undefined;
    const skip = input.mapping?.skipLinesBefore ?? (chosen ?? detected)?.skipLinesBefore ?? 0;
    const table = readCardStatementTable(input.content, skip);
    const suggestedMapping = suggestCardMapping(table.headers);
    const suggestionComplete = CARD_REQUIRED_COLUMNS.every((column) => suggestedMapping[column] !== undefined);
    const mapping = input.mapping ?? (chosen ?? detected === undefined ? undefined : mappingOf((chosen ?? detected) as CardStatementProfile))
      ?? (suggestionComplete ? { columns: suggestedMapping as CardImportMapping['columns'], amountSign: 'charge-positive' as const, skipLinesBefore: skip } : undefined);
    const base = { headers: table.headers, suggestedMapping, rowCount: table.rows.length, ...(detected === undefined ? {} : { detectedProfileId: detected.id }) };
    if (mapping === undefined) {
      const missing = CARD_REQUIRED_COLUMNS.filter((column) => suggestedMapping[column] === undefined);
      return { ...base, rows: [], skippedRows: [], problems: [{ code: 'mapping-missing', message: `列の対応を選んでください（見つからない項目: ${missing.join(', ')}）`, missingColumns: missing }] };
    }
    try {
      const parsed = parseCardStatement(input.content, { mapping, cards, ...(input.cardId === undefined ? {} : { cardId: input.cardId }) });
      return {
        ...base,
        rows: parsed.rows.slice(0, CARD_PREVIEW_ROWS).map(({ raw: _raw, dedupeKey: _dedupeKey, ...row }) => row),
        skippedRows: parsed.skippedRows.slice(0, CARD_PREVIEW_SKIPPED_ROWS),
        problems: [],
        ...(parsed.periodFrom === undefined ? {} : { periodFrom: parsed.periodFrom, periodTo: parsed.periodTo }),
      };
    } catch (error) {
      if (!(error instanceof ExpenseCardImportError)) throw error;
      return {
        ...base, rows: [], skippedRows: [],
        problems: [{ code: 'card-import', message: error.message, ...(error.row === undefined ? {} : { row: error.row }), ...(error.missingColumns === undefined ? {} : { missingColumns: error.missingColumns }) }],
      };
    }
  }

  async import(scope: TenantScope, input: CardStatementImportInput, by: string): Promise<CardStatementImportResult> {
    const settings = (await this.deps.settings.load(scope, 'cards')).value;
    const chosen = this.profileById(settings.profiles, input.profileId);
    const detected = input.mapping === undefined && chosen === undefined ? this.detect(input.content, settings.profiles) : undefined;
    const profile = chosen ?? detected;
    const mapping = input.mapping ?? (profile === undefined ? undefined : mappingOf(profile));
    if (mapping === undefined) {
      const table = readCardStatementTable(input.content, 0);
      const suggested = suggestCardMapping(table.headers);
      throw new ExpenseCardImportError('card statement: choose which columns hold the date, merchant, and amount', {
        missingColumns: CARD_REQUIRED_COLUMNS.filter((column) => suggested[column] === undefined), suggestedMapping: suggested as Record<string, string>,
      });
    }
    const parsed = parseCardStatement(input.content, { mapping, cards: settings.cards, ...(input.cardId === undefined ? {} : { cardId: input.cardId }) });
    if (parsed.rows.length === 0 || parsed.periodFrom === undefined || parsed.periodTo === undefined) {
      const first = parsed.skippedRows[0];
      throw new ExpenseCardImportError(`card statement: no rows could be imported${first === undefined ? '' : ` (row ${first.row}: ${first.reason})`}`, { ...(first === undefined ? {} : { row: first.row }) });
    }
    const at = this.deps.now().toISOString();
    const importId = `card-import-${this.makeId()}`;
    const existing = new Set((await this.deps.repositories.cards.listTransactions(scope, { from: parsed.periodFrom, to: parsed.periodTo, limit: 100_000 })).map((transaction) => transaction.dedupeKey));
    const duplicateCount = parsed.rows.filter((row) => existing.has(row.dedupeKey)).length;
    const fileSha256 = createHash('sha256').update(input.content, 'utf8').digest('hex');
    const importRecord: ExpenseCardImport = createExpenseCardImport({
      tenant: scope, id: importId, fileName: input.fileName, fileSha256, mapping,
      rowCount: parsed.rowCount, importedCount: parsed.rows.length - duplicateCount, duplicateCount, skippedRows: parsed.skippedRows,
      periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, by, createdAt: at,
      ...(profile === undefined ? {} : { profileId: profile.id }), ...(input.cardId === undefined ? {} : { cardId: input.cardId }),
    });
    const transactions = parsed.rows.map((row) => createExpenseCardTransaction({
      tenant: scope, id: `card-tx-${this.makeId()}`, importId, cardId: row.cardId, usedOn: row.usedOn, merchantRaw: row.merchantRaw, merchantKey: row.merchantKey,
      amount: row.amount, row: row.raw, dedupeKey: row.dedupeKey, status: 'unmatched', createdAt: at, updatedAt: at,
      ...(row.postedOn === undefined ? {} : { postedOn: row.postedOn }), ...(row.memo === undefined ? {} : { memo: row.memo }),
    }));
    let savedProfileId: string | undefined;
    const saved = await this.deps.unitOfWork.withTransaction(async () => {
      const counts = await this.deps.repositories.cards.saveImport(importRecord, transactions);
      const name = input.saveProfileAs?.trim();
      if (name !== undefined && name !== '') {
        const same = settings.profiles.find((entry) => entry.name === name);
        savedProfileId = same?.id ?? `profile-${this.makeId().toLowerCase()}`;
        const nextProfile: CardStatementProfile = { id: savedProfileId, name, headerSignature: cardHeaderSignature(parsed.headers), ...mapping };
        const next = createExpenseCardSettings({ cards: settings.cards, profiles: [...settings.profiles.filter((entry) => entry.id !== savedProfileId), nextProfile], updatedAt: at });
        await this.deps.repositories.settings.save(scope, 'cards', next);
      }
      return counts;
    });
    const warnings = [
      ...(parsed.skippedRows.length > 0 ? [`${parsed.skippedRows.length} 行を取り込めませんでした。行番号と理由を確かめ、必要なら CSV を直して取り込み直してください`] : []),
      ...(saved.duplicates > 0 ? [`${saved.duplicates} 行は取込済みの明細と同じなので入れませんでした`] : []),
    ];
    return {
      importId, imported: saved.inserted, duplicates: saved.duplicates, skippedRows: parsed.skippedRows, warnings, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo,
      ...(savedProfileId === undefined ? (profile === undefined ? {} : { profileId: profile.id }) : { profileId: savedProfileId }),
    };
  }

  async listImports(scope: TenantScope, limit = 100): Promise<readonly ExpenseCardImport[]> {
    return this.deps.repositories.cards.listImports(scope, { limit });
  }

  /** 取込と利用行を消す（対象外の印・手動の紐付けも消える）。 */
  async deleteImport(scope: TenantScope, id: string): Promise<number> {
    const removed = await this.deps.repositories.cards.deleteImport(scope, id);
    if (removed < 0) throw new ExpenseCardImportNotFoundError(`expense card import not found: ${id}`);
    return removed;
  }
}
