/**
 * application層: 銀行明細 CSV のプレビューと取込（docs/22 §5）。
 *
 * ## プロファイルの決め方
 *
 * 明示指定（プロファイル id / その場の列マッピング）→ 利用者のプロファイル（新しい順）→ 組込み（仕訳の銀行プリセット）。
 * 銀行 CSV はヘッダ行の前に口座情報の行があることが多いので、先頭 20 行のどこかで署名が一致する行をヘッダ行とみなす。
 * どれにも当たらなければ、プレビューは「列マッピングが必要」を返し、取込は `ReceivablesCsvImportError`（行番号なし）で断る
 * （行の問題ではなく取込全体の前提なので。仕訳の取込と同じ扱い）。
 *
 * ## 1 行の失敗で取込全体を捨てない
 *
 * 読めない行は `skippedRows`（ファイル上の行番号 + 理由）、出金行は件数だけ、既に取り込んだ行は `duplicates` に積み、
 * 残りを保存する。行番号は**ファイル上の行番号**（前置き行を含む。表計算ソフトの行番号と一致させる）。
 *
 * ## 重複
 *
 * 指紋（口座・日付・金額・正規化名義・残高・同じファイル内の出現順）が既存と重なる行は取り込まない。
 * 残高列が無い明細では正当な入金を重複と見なし得るので、利用者が選んだ行（`forceRows`）は既存と重ならない指紋で取り込む。
 */
import { createHash, randomUUID } from 'node:crypto';
import { parseCsv, rowToRecord } from '../../domain/journal/csv';
import { detectPreset, normalizeHeader, rowToDocument, rowToDocumentWithMapping, type JournalDocumentInput } from '../../domain/journal/csv-presets';
import {
  BUILTIN_BANK_CSV_PROFILES, columnMappingProblems, findHeaderRow, HEADER_ROW_SCAN_LIMIT, isBuiltinProfileId, profileMatchesHeaders,
  toJournalColumnMapping, type BankCsvProfile, type ReceivablesColumnMapping,
} from '../../domain/receivables/bank-csv-profile';
import { createBankTransaction, type BankTransaction } from '../../domain/receivables/bank-transaction';
import { BankCsvProfileNotFoundError, ReceivablesCsvImportError } from '../../domain/receivables/errors';
import { FINGERPRINT_LENGTH, fingerprintSources, forcedFingerprintSource } from '../../domain/receivables/fingerprint';
import { normalizePayerName, payerNameFromDescription } from '../../domain/receivables/payer-name';
import type { BankCsvProfileRepository, BankTransactionRepository } from '../../domain/receivables/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { bytesFromBase64, decodeBankCsv, type CsvEncoding, type CsvEncodingHint, type CsvWarning } from './bank-csv-decode';

export const DEFAULT_ACCOUNT_KEY = 'default';
export const PREVIEW_ROWS = 10;

export interface BankCsvReadInput {
  readonly scope: TenantScope;
  readonly contentBase64: string;
  readonly encoding?: CsvEncodingHint;
  readonly profileId?: string;
  /** その場の列マッピング（保存しない）。 */
  readonly mapping?: ReceivablesColumnMapping;
  readonly headerRow?: number;
  readonly accountKey?: string;
  readonly fileName?: string;
}

interface Resolved {
  readonly profile?: BankCsvProfile;
  readonly mapping?: ReceivablesColumnMapping;
  readonly headerRow: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decode(input: BankCsvReadInput): { readonly rows: string[][]; readonly encoding: CsvEncoding; readonly warnings: CsvWarning[] } {
  const bytes = bytesFromBase64(input.contentBase64);
  if (bytes === undefined) throw new ReceivablesCsvImportError('CSV: the file is larger than 5 MiB; split it by period');
  const decoded = decodeBankCsv(bytes, input.encoding ?? 'auto');
  let rows: string[][];
  try { rows = parseCsv(decoded.text); }
  catch (error) { throw new ReceivablesCsvImportError(messageOf(error), (error as { row?: number }).row); }
  if (rows.length === 0) throw new ReceivablesCsvImportError('CSV: the file has no rows');
  return { rows, encoding: decoded.encoding, warnings: [...decoded.warnings] };
}

/** 署名が一致する行（1 始まり）。 */
function headerRowFor(profile: BankCsvProfile, rows: readonly (readonly string[])[]): number | undefined {
  if (profile.headerRow !== 'auto') return profile.headerRow <= rows.length ? profile.headerRow : undefined;
  const limit = Math.min(rows.length, HEADER_ROW_SCAN_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    const matches = profile.presetId === undefined ? profileMatchesHeaders(profile, rows[index]!) : detectPreset(rows[index]!) === profile.presetId;
    if (matches) return index + 1;
  }
  return undefined;
}

async function resolveProfile(profiles: BankCsvProfileRepository, input: BankCsvReadInput, rows: readonly (readonly string[])[]): Promise<Resolved | undefined> {
  if (input.mapping !== undefined) return { mapping: input.mapping, headerRow: input.headerRow ?? findHeaderRow(rows) ?? 1 };
  if (input.profileId !== undefined) {
    const profile = isBuiltinProfileId(input.profileId)
      ? BUILTIN_BANK_CSV_PROFILES.find((entry) => entry.id === input.profileId)
      : (await profiles.findById(input.scope, input.profileId)) ?? undefined;
    if (profile === undefined) throw new BankCsvProfileNotFoundError(`bank CSV profile not found: ${input.profileId}`);
    return { profile, ...(profile.mapping === undefined ? {} : { mapping: profile.mapping }), headerRow: input.headerRow ?? headerRowFor(profile, rows) ?? findHeaderRow(rows) ?? 1 };
  }
  for (const profile of [...await profiles.list(input.scope), ...BUILTIN_BANK_CSV_PROFILES]) {
    const headerRow = headerRowFor(profile, rows);
    if (headerRow !== undefined) return { profile, ...(profile.mapping === undefined ? {} : { mapping: profile.mapping }), headerRow };
  }
  return undefined;
}

export interface BankCsvPreview {
  readonly encoding: CsvEncoding;
  readonly warnings: readonly CsvWarning[];
  /** 1 始まり。 */
  readonly headerRow: number;
  readonly headers: readonly string[];
  readonly profile?: { readonly id: string; readonly name: string; readonly origin: string; readonly accountKey?: string };
  /** 判定したマッピング（組込みは無し）。 */
  readonly mapping?: ReceivablesColumnMapping;
  readonly mappingRequired: boolean;
  readonly mappingProblems: readonly string[];
  readonly preamble: readonly (readonly string[])[];
  readonly rows: readonly (readonly string[])[];
  readonly dataRowCount: number;
}

export class PreviewBankCsvUseCase {
  constructor(private readonly profiles: BankCsvProfileRepository) {}

  async execute(input: BankCsvReadInput): Promise<BankCsvPreview> {
    const { rows, encoding, warnings } = decode(input);
    const resolved = await resolveProfile(this.profiles, input, rows);
    const headerRow = resolved?.headerRow ?? input.headerRow ?? findHeaderRow(rows) ?? 1;
    const problems = resolved === undefined ? columnMappingProblems(undefined) : resolved.profile?.presetId !== undefined ? [] : columnMappingProblems(resolved.mapping);
    if (resolved?.profile !== undefined) warnings.push({ code: 'detected-profile', params: { profile: resolved.profile.name } });
    return {
      encoding, warnings, headerRow,
      headers: rows[headerRow - 1] ?? [],
      ...(resolved?.profile === undefined ? {} : { profile: { id: resolved.profile.id, name: resolved.profile.name, origin: resolved.profile.origin, ...(resolved.profile.accountKey === undefined ? {} : { accountKey: resolved.profile.accountKey }) } }),
      ...(resolved?.mapping === undefined ? {} : { mapping: resolved.mapping }),
      mappingRequired: problems.length > 0,
      mappingProblems: problems,
      preamble: rows.slice(0, headerRow - 1),
      rows: rows.slice(headerRow, headerRow + PREVIEW_ROWS),
      dataRowCount: Math.max(rows.length - headerRow, 0),
    };
  }
}

export interface BankCsvDuplicate {
  readonly row: number;
  readonly date: string;
  readonly amount: number;
  readonly payerName: string;
  readonly existingId: string;
}

export interface BankCsvImportResult {
  readonly profileId?: string;
  readonly encoding: CsvEncoding;
  readonly imported: readonly BankTransaction[];
  readonly skippedWithdrawals: number;
  readonly duplicates: readonly BankCsvDuplicate[];
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly CsvWarning[];
}

interface Candidate {
  readonly row: number;
  readonly date: string;
  readonly amount: number;
  readonly description: string;
  readonly payerName: string;
  readonly payerNameNorm: string;
  readonly balance?: number;
  readonly record: Record<string, string>;
}

const sha = (source: string) => createHash('sha256').update(source).digest('hex').slice(0, FINGERPRINT_LENGTH);

export class ImportBankCsvUseCase {
  constructor(
    private readonly profiles: BankCsvProfileRepository,
    private readonly transactions: BankTransactionRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: BankCsvReadInput & { readonly forceRows?: readonly number[] }): Promise<BankCsvImportResult> {
    const { rows, encoding, warnings } = decode(input);
    const resolved = await resolveProfile(this.profiles, input, rows);
    if (resolved === undefined) throw new ReceivablesCsvImportError('CSV: could not detect a bank CSV profile from the first 20 rows; map the columns (date and deposit or amount)');
    const problems = resolved.profile?.presetId !== undefined ? [] : columnMappingProblems(resolved.mapping);
    if (problems.length > 0) throw new ReceivablesCsvImportError(`CSV: the column mapping is missing: ${problems.join(', ')}`);
    const headers = (rows[resolved.headerRow - 1] ?? []).map(normalizeHeader);
    const presetId = resolved.profile?.presetId;
    const mapping = resolved.mapping;
    const options = input.fileName === undefined ? {} : { fileName: input.fileName };
    const accountKey = input.accountKey?.trim() || resolved.profile?.accountKey || DEFAULT_ACCOUNT_KEY;

    const candidates: Candidate[] = [];
    const skippedRows: { row: number; reason: string }[] = [];
    let skippedWithdrawals = 0;
    for (const [index, cells] of rows.slice(resolved.headerRow).entries()) {
      const row = resolved.headerRow + index + 1;
      const record = rowToRecord(headers, cells);
      let document: JournalDocumentInput;
      try {
        document = presetId === undefined ? rowToDocumentWithMapping(toJournalColumnMapping(mapping!), record, options, row) : rowToDocument(presetId, record, options, row);
      } catch (error) {
        skippedRows.push({ row, reason: messageOf(error) });
        continue;
      }
      if (document.facts.direction !== 'in') { skippedWithdrawals += 1; continue; }
      const description = document.facts.description ?? '';
      const payerName = mapping?.payerName === undefined ? payerNameFromDescription(description) : (record[normalizeHeader(mapping.payerName)] ?? '').trim();
      const balance = document.facts.extra?.['balance'];
      candidates.push({
        row, date: document.facts.transactionDate!, amount: document.facts.grandTotal!, description, payerName, payerNameNorm: normalizePayerName(payerName),
        ...(typeof balance === 'number' ? { balance } : {}), record,
      });
    }

    const sources = fingerprintSources(candidates.map((candidate) => ({ accountKey, ...candidate })));
    const fingerprints = sources.map(sha);
    const existing = new Map(await this.transactions.findByFingerprints(input.scope, fingerprints));
    const forced = new Set(input.forceRows ?? []);
    const imported: BankTransaction[] = [];
    const duplicates: BankCsvDuplicate[] = [];
    const at = this.now().toISOString();
    for (const [position, candidate] of candidates.entries()) {
      let fingerprint = fingerprints[position]!;
      const existingId = existing.get(fingerprint);
      if (existingId !== undefined) {
        if (!forced.has(candidate.row)) {
          duplicates.push({ row: candidate.row, date: candidate.date, amount: candidate.amount, payerName: candidate.payerName, existingId });
          continue;
        }
        // 利用者が「重複ではない」と選んだ行。既存と重ならない指紋を探す。
        for (let attempt = 1; ; attempt += 1) {
          fingerprint = sha(forcedFingerprintSource(sources[position]!, attempt));
          if (!existing.has(fingerprint) && (await this.transactions.findByFingerprints(input.scope, [fingerprint])).size === 0) break;
        }
      }
      try {
        const transaction = createBankTransaction({
          tenant: input.scope, accountKey, date: candidate.date, amount: candidate.amount, description: candidate.description,
          payerName: candidate.payerName, payerNameNorm: candidate.payerNameNorm, ...(candidate.balance === undefined ? {} : { balance: candidate.balance }),
          source: { ...(input.fileName === undefined ? {} : { fileName: input.fileName }), ...(resolved.profile === undefined ? {} : { profileId: resolved.profile.id }), row: candidate.record, rowNumber: candidate.row },
          fingerprint, createdAt: at, updatedAt: at,
        }, this.makeId);
        await this.transactions.save(transaction);
        existing.set(fingerprint, transaction.id);
        imported.push(transaction);
      } catch (error) {
        // 別の取込と競合して一意索引に弾かれた場合も 1 行の問題として扱う。
        skippedRows.push({ row: candidate.row, reason: messageOf(error) });
      }
    }

    if (candidates.length > 0 && candidates.every((candidate) => candidate.balance === undefined)) warnings.push({ code: 'no-balance-column', params: {} });
    if (skippedRows.length > 0) warnings.push({ code: 'skipped-rows', params: { count: skippedRows.length, total: Math.max(rows.length - resolved.headerRow, 0) } });
    return {
      ...(resolved.profile === undefined ? {} : { profileId: resolved.profile.id }),
      encoding, imported, skippedWithdrawals, duplicates, skippedRows, warnings,
    };
  }
}
