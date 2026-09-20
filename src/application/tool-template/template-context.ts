/**
 * application層: データプロファイルから、テンプレートの候補算出・検証・実体化が使う文脈を作る
 * （v43 実装契約 §3）。domain は `DataProfile` を知らないので、写すのはここの仕事。
 *
 * v42 の `toolSpecContextOf` と対になる関数だが、テンプレートは
 * - 期間列の実測範囲（`$profile` の `periodMin` / `periodMax`）
 * - ソースのファイル形式（`$sourceType` が csv / json のノード種別を選ぶ）
 * - **ソースの組ごと**の結合キー候補（`joinKeys` スロットは左右 2 つのスロットを名指しする）
 * を要るので、`ToolSpecContext` ではなく `TemplateContext` を組み立てる。
 */
import type { PeriodGranularity } from '../../domain/etl/nodes/parse-period';
import type {
  TemplateContext,
  TemplateJoinCandidateContext,
  TemplateSourceContext,
} from '../../domain/tool-template/template';
import type { DataProfile } from '../factory/profile-data-sources';

/** このツールが読むデータソース（主 → 追加の順）。`FactoryToolPlan` から呼び出し側が作る。 */
export interface TemplatePlanLike {
  readonly dataSourceIds: readonly string[];
}

function sourceContextOf(profile: DataProfile): TemplateSourceContext {
  return {
    dataSourceId: profile.dataSourceId,
    name: profile.name,
    // database data source のプロファイルは未対応（`format` が無ければ csv 相当として扱う）。
    format: profile.format === 'json' ? 'json' : 'csv',
    columns: profile.columns.map((column) => ({ name: column.name, type: column.type })),
    periodColumns: profile.periodColumns.map((column) => ({
      column: column.column,
      // 出現順はプロファイルのキー順（決定的）。
      granularities: Object.keys(column.granularities) as PeriodGranularity[],
      ...(column.minStart === undefined ? {} : { minStart: column.minStart }),
      ...(column.maxStart === undefined ? {} : { maxStart: column.maxStart }),
    })),
    categoricalColumns: profile.categoricalColumns.map((column) => ({ column: column.column, values: column.values })),
  };
}

/**
 * このツールが読むプロファイルだけから文脈を作る。
 *
 * 結合候補は**このツールが読むソース同士**のものに限る（Run 全体の候補をそのまま渡すと、
 * このツールが読まないソース間のキーを選べてしまう）。プロファイルが見つからない
 * `dataSourceId` は黙って落とす — 候補が 0 件になり、そのテンプレートは
 * `applicableTemplates` で「適用不可」として除かれる。
 */
export function templateContextOf(plan: TemplatePlanLike, profiles: readonly DataProfile[]): TemplateContext {
  const used = plan.dataSourceIds
    .map((id) => profiles.find((profile) => profile.dataSourceId === id))
    .filter((profile): profile is DataProfile => profile !== undefined);
  const ids = new Set(used.map((profile) => profile.dataSourceId));
  const joinCandidates: TemplateJoinCandidateContext[] = [];
  for (const candidate of used.flatMap((profile) => profile.joinCandidates)) {
    if (!ids.has(candidate.leftDataSourceId) || !ids.has(candidate.rightDataSourceId)) continue;
    const known = joinCandidates.some(
      (existing) => existing.leftDataSourceId === candidate.leftDataSourceId && existing.rightDataSourceId === candidate.rightDataSourceId,
    );
    if (known) continue;
    joinCandidates.push({
      leftDataSourceId: candidate.leftDataSourceId,
      rightDataSourceId: candidate.rightDataSourceId,
      keys: [...candidate.keys],
    });
  }
  return { sources: used.map(sourceContextOf), joinCandidates };
}
