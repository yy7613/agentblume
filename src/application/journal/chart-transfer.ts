/**
 * application層: 科目マスタの CSV 取込 / 出力（docs/20 §5）。
 *
 * 列は `id,code,name,category,defaultTaxCode,aliases,enabled`（`aliases` は `;` 区切り、`enabled` は `true|false`）。
 * **取込は勘定科目の一覧だけを置き換え**、税区分（`taxCategories`）と補助軸（`dimensions`）は既存のものを残す。
 * 科目 CSV に税区分の定義は無いので、取込で税区分が消えると既存のルール・仕訳が全部 `unknown-account` 相当に
 * なってしまう（科目 CSV を「マスタ全体の上書き」と解釈してはならない理由）。
 *
 * 行の不正（未知の category・id の重複）は `JournalDomainError` に**行番号（1 始まり・ヘッダ込み）**を載せる。
 * 表計算ソフトの行番号と一致するので、利用者が直す場所を探せる。
 */
import { ACCOUNT_CATEGORIES, createChartOfAccounts, type Account, type AccountCategory, type ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { parseCsv, rowToRecord, toCsv } from '../../domain/journal/csv';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import { JournalDomainError } from '../../domain/journal/errors';
import { UTF8_BOM } from '../../domain/journal/export';
import type { ChartOfAccountsRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 科目 CSV の列（順序は固定。取込はヘッダ行の列名で引くので並べ替えても読める）。 */
export const CHART_CSV_COLUMNS = ['id', 'code', 'name', 'category', 'defaultTaxCode', 'aliases', 'enabled'] as const;
export type ChartCsvColumn = (typeof CHART_CSV_COLUMNS)[number];

/** 別名の区切り（`,` は CSV の区切りと衝突するので `;`）。 */
export const CHART_CSV_ALIAS_SEPARATOR = ';';

function isCategory(value: string): value is AccountCategory {
  return (ACCOUNT_CATEGORIES as readonly string[]).includes(value);
}

/** 科目マスタ → CSV（BOM 付き・CRLF。Excel でそのまま開ける）。 */
export class ExportChartCsvUseCase {
  constructor(private readonly charts: ChartOfAccountsRepository) {}

  async execute(scope: TenantScope): Promise<string> {
    const chart = (await this.charts.get(scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const rows = chart.accounts.map((account) => [
      account.id,
      account.code ?? '',
      account.name,
      account.category,
      account.defaultTaxCode ?? '',
      account.aliases.join(CHART_CSV_ALIAS_SEPARATOR),
      account.enabled ? 'true' : 'false',
    ]);
    return UTF8_BOM + toCsv([[...CHART_CSV_COLUMNS], ...rows]);
  }
}

export interface ImportChartCsvInput {
  readonly scope: TenantScope;
  readonly content: string;
}

/** CSV → 科目一覧の置き換え（税区分・補助軸は既存のまま）。 */
export class ImportChartCsvUseCase {
  constructor(
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ImportChartCsvInput): Promise<ChartOfAccounts> {
    // parseCsv が BOM を落とし、空行（全列が空白）を捨てる。
    const rows = parseCsv(input.content);
    if (rows.length === 0) throw new JournalDomainError('chart CSV: the file has no rows');
    const headers = rows[0]!.map((header) => header.replace(/^﻿/u, '').trim());
    for (const required of ['id', 'name', 'category'] as const) {
      if (!headers.includes(required)) throw new JournalDomainError(`chart CSV: the header row must include the '${required}' column (found: ${headers.join(', ')})`);
    }

    const accounts: Account[] = [];
    const seen = new Set<string>();
    for (const [index, row] of rows.slice(1).entries()) {
      // 行番号はヘッダ行を 1 とした 1 始まり（表計算ソフトの行番号と一致する）。
      const line = index + 2;
      const record = rowToRecord(headers, row);
      const id = (record['id'] ?? '').trim();
      if (id.length === 0) throw new JournalDomainError(`chart CSV row ${line}: id must not be empty`);
      if (seen.has(id)) throw new JournalDomainError(`chart CSV row ${line}: duplicate account id: ${id}`);
      seen.add(id);
      const category = (record['category'] ?? '').trim();
      if (!isCategory(category)) throw new JournalDomainError(`chart CSV row ${line}: unknown category: ${category === '' ? '(empty)' : category} (expected one of ${ACCOUNT_CATEGORIES.join(', ')})`);
      const enabledRaw = (record['enabled'] ?? 'true').trim().toLowerCase();
      if (enabledRaw !== 'true' && enabledRaw !== 'false' && enabledRaw !== '') throw new JournalDomainError(`chart CSV row ${line}: enabled must be true or false (found: ${enabledRaw})`);
      const code = (record['code'] ?? '').trim();
      const defaultTaxCode = (record['defaultTaxCode'] ?? '').trim();
      const aliases = (record['aliases'] ?? '').split(CHART_CSV_ALIAS_SEPARATOR).map((alias) => alias.trim()).filter((alias) => alias.length > 0);
      accounts.push({
        id,
        ...(code === '' ? {} : { code }),
        name: (record['name'] ?? '').trim(),
        category,
        ...(defaultTaxCode === '' ? {} : { defaultTaxCode }),
        aliases,
        enabled: enabledRaw !== 'false',
        // 並びは CSV の行順（利用者が表計算ソフトで並べ替えた結果をそのまま採る）。
        sortOrder: (index + 1) * 10,
      });
    }

    const existing = await this.charts.get(input.scope);
    const base = existing ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    // defaultTaxCode が既存の税区分に無ければ createChartOfAccounts が JournalDomainError を投げる。
    const chart = createChartOfAccounts({
      accounts,
      dimensions: base.dimensions,
      taxCategories: base.taxCategories,
      updatedAt: this.now().toISOString(),
    });
    await this.charts.save(input.scope, chart);
    return chart;
  }
}