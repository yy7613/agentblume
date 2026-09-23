/**
 * 応用: ツール設計の規則（v50 R1）。
 *
 * 「検証を通るのに答えが間違う形」の検査のうち、**グラフとプロファイル（と設計時プレビュー）だけで
 * 判定できるもの**をここに集める。Factory の修復ループ（`generate-agent-assets.ts`）と
 * 設計アシスタント（`design-tool-chat.ts`）の両方が同じ関数を呼ぶ。
 *
 * 計画や目的の語を読む判定（「最新を求めるか」など）は Factory 固有なので、ここには置かない。
 * どの文も差し戻しの理由としてモデルへそのまま渡る英語の原文で、画面は既存の日本語化経路へ通す。
 */
import type { ToolGraph } from '../../domain/etl/graph';
import { PARSE_PERIOD_TYPE } from '../../domain/etl/nodes/parse-period';
import { isRecord } from '../../domain/shared/assert';
import type { PreviewResult, PropagationResult } from '../etl/engine';
import type { DataProfile } from '../factory/profile-data-sources';
import { JOIN_NODE_TYPE } from '../factory/roles/tool-smith-role';
import { diagnoseEmptyResult, noMatchText } from './empty-result-diagnosis';

/** 注記・備考のような自由記述列（結合キーにすると、値が揃わない行を黙って落とす）。 */
const NOTE_LIKE_COLUMN = /注記|備考|摘要|remarks?|notes?|comments?/i;

/**
 * 結合Toolの**設計**の検査（ADR-0047 第5ラウンド）。実測の3ソース結合で起きた2つを塞ぐ。
 *
 * 1. 枝ごとに `parse-period` を走らせると、2つ目の結合で
 *    `right column 'periodStart' still conflicts after suffix: periodStart_right` になる。
 *    期間ラベル列は結合キーとして残るので、`parse-period` は**最後の結合の後で1回だけ**走らせる。
 * 2. 結合キーに `注記` のような自由記述列を混ぜると、値が揃わない行が黙って消える。
 *    キーはプロファイルの `joinCandidates` が挙げたものだけにする。
 *
 * `profile` が無い（設計アシスタントでプロファイルが取れなかった）ときも、プロファイルに頼らない
 * 規則（parse-period の位置・自由記述列のキー）はそのまま効く。
 *
 * 結合候補が 1 つも無いとき（候補の計算で重なりが足りなかった・設計アシスタントがプロファイルを 1 件ずつ取った）は、
 * 「候補に無いキー」の規則は判定の根拠が無いので効かせず、自由記述のキーだけを外させる。以前は注記と並んだ
 * `地域コード` のような正しいキーまで「外せ」に含め、直したモデルがキーを失って結合できなくなっていた。
 */
export function describeJoinDesignViolations(
  graph: ToolGraph,
  profile: DataProfile | undefined,
  additionalProfiles: readonly DataProfile[] = [],
): string | undefined {
  const joins = graph.nodes.filter((node) => node.type === JOIN_NODE_TYPE);
  if (joins.length === 0) return undefined;
  const candidates = [...(profile === undefined ? [] : [profile]), ...additionalProfiles].flatMap((source) => source.joinCandidates ?? []);
  const inputsOf = new Map<string, { from: string; toInput: number }[]>();
  for (const edge of graph.edges) {
    const list = inputsOf.get(edge.to) ?? [];
    list.push({ from: edge.from, toInput: edge.toInput ?? 0 });
    inputsOf.set(edge.to, list);
  }
  const problems: string[] = [];
  const parsePeriods = graph.nodes.filter((node) => node.type === PARSE_PERIOD_TYPE);
  const upstreamOf = (nodeId: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const edge of inputsOf.get(current) ?? []) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        queue.push(edge.from);
      }
    }
    return seen;
  };

  if (parsePeriods.length > 1) {
    problems.push(`this joined tool runs '${PARSE_PERIOD_TYPE}' ${parsePeriods.length} times (${parsePeriods.map((node) => `'${node.id}'`).join(', ')}). Each run adds 'periodStart' / 'periodGranularity', so the second join cannot merge them ("still conflicts after suffix"). Run it exactly ONCE, after the LAST join, on the primary period label column — the label column survives the join because it is a key`);
  } else if (parsePeriods.length === 1) {
    const upstream = upstreamOf(parsePeriods[0]!.id);
    if (!joins.some((join) => upstream.has(join.id))) {
      problems.push(`'${PARSE_PERIOD_TYPE}' node '${parsePeriods[0]!.id}' sits on a branch BEFORE the join. Move it after the last join (the period label column survives the join as a key), so that 'periodStart' exists once instead of once per branch`);
    }
  }

  // 結合キーは、プロファイルが「値が十分に重なる」と判定した列だけから選ぶ。
  const allowedKeys = new Set(candidates.flatMap((candidate) => candidate.keys));
  const codeColumns = new Set((profile?.columns ?? []).map((column) => column.name).filter((name) => /コード|code$|_code|id$/i.test(name)));
  for (const join of joins) {
    const config = (join.config ?? {}) as { keys?: unknown };
    const keys = (Array.isArray(config.keys) ? config.keys : [])
      .map((key) => (typeof key === 'string' ? key : (key as { left?: unknown } | null)?.left))
      .filter((key): key is string => typeof key === 'string');
    const notes = keys.filter((key) => NOTE_LIKE_COLUMN.test(key));
    const unlisted = allowedKeys.size === 0
      ? []
      : keys.filter((key) => !allowedKeys.has(key) && !notes.includes(key));
    if (notes.length === 0 && unlisted.length === 0) continue;
    const redundant = keys.some((key) => codeColumns.has(key)) && keys.some((key) => !codeColumns.has(key) && !NOTE_LIKE_COLUMN.test(key));
    problems.push([
      `the '${JOIN_NODE_TYPE}' node '${join.id}' joins on ${[...notes, ...unlisted].map((key) => `'${key}'`).join(', ')}, which ${notes.length > 0 ? 'is free-text (a note/remark column): rows whose notes differ are silently dropped' : 'the data profile did not list as a shared key'}. Remove ${[...notes, ...unlisted].map((key) => `'${key}'`).join(', ')} from "keys" and join only on the columns joinCandidates lists${allowedKeys.size === 0 ? '' : ` (${[...allowedKeys].map((key) => `'${key}'`).join(', ')})`}`,
      ...(redundant ? ['The code column alone already identifies the row, so a redundant name column next to it can be dropped too.'] : []),
    ].join(' '));
  }
  return problems.length === 0 ? undefined : `joined tool design is wrong: ${problems.join('. ')}`;
}

/**
 * 期間ラベルの文字列列で並べ替える: '2025年9月' が '2025年12月' より後に来る（文字列順）。実測で
 * 「新しい順に」に対し 12B は `時点` をそのまま desc に並べた。parse-period → periodStart で並べさせる。
 */
export function sortsOnPeriodLabel(graph: ToolGraph, propagation: PropagationResult, profiles: readonly DataProfile[]): string[] {
  const problems: string[] = [];
  const periodLabels = new Set(profiles.flatMap((profile) => (profile.periodColumns ?? []).map((column) => column.column)));
  for (const node of graph.nodes) {
    if (node.type !== 'sort' || !isRecord(node.config) || !Array.isArray(node.config['keys'])) continue;
    const upstream = graph.edges.find((edge) => edge.to === node.id)?.from;
    const inputSchema = upstream === undefined ? undefined : propagation.nodes[upstream]?.schema;
    for (const key of node.config['keys']) {
      const column = isRecord(key) && typeof key['column'] === 'string' ? key['column'] : undefined;
      if (column === undefined || !periodLabels.has(column)) continue;
      const type = inputSchema?.columns.find((candidate) => candidate.name === column)?.type;
      if (type !== undefined && type !== 'string') continue;
      problems.push(`node '${node.id}': sorting on '${column}' orders the period LABELS as text ('2025年9月' comes after '2025年12月'), not by time; add a parse-period node upstream (column "${column}") and sort on its start column "periodStart" instead`);
    }
  }
  return problems;
}

/**
 * 粒度が混在する期間列を parse-period で開いたのに、粒度で絞る filter が無い: 月次と年次の行が混ざって集計や
 * 「新しい順」が狂う（ADR-0047 決定 4 と同じ規則）。実測で「年次に絞って」の指示が落ちた。
 */
export function missingGranularityFilter(graph: ToolGraph, profiles: readonly DataProfile[]): string[] {
  const problems: string[] = [];
  const mixedLabels = new Set(profiles.flatMap((profile) => (profile.periodColumns ?? []).filter((column) => column.mixed).map((column) => column.column)));
  for (const node of graph.nodes) {
    if (node.type !== 'parse-period' || !isRecord(node.config)) continue;
    const source = typeof node.config['column'] === 'string' ? node.config['column'] : '';
    if (!mixedLabels.has(source)) continue;
    const granularityColumn = typeof node.config['granularityColumn'] === 'string' ? node.config['granularityColumn'] : 'periodGranularity';
    const filtered = graph.nodes.some((candidate) => candidate.type === 'filter' && JSON.stringify(candidate.config ?? {}).includes(JSON.stringify(granularityColumn)));
    if (filtered) continue;
    problems.push(`node '${node.id}': the period column '${source}' mixes granularities (monthly, quarterly, yearly and fiscal-year rows share it), but no filter narrows "${granularityColumn}" to one granularity; add a filter { "column": "${granularityColumn}", "op": "eq", "value": "<one of the granularities in the profile>" } right after the parse-period node so the rows are not mixed`);
  }
  return problems;
}

/**
 * 設計時プレビューが 0 行: 画面のプレビューが空になり、人には壊れて見える。どの条件が空振りしたか
 * （`diagnoseEmptyResult`）を添えて、見本の値を実在する値に直させる。
 * `executable` はデータソースを解決した後のグラフ（空振りの診断はそれを実行して行う）。
 */
export function emptyPreviewProblem(executable: ToolGraph, preview: PreviewResult): string | undefined {
  const terminal = preview.nodes[preview.terminalId];
  if (terminal === undefined || terminal.rowCount !== 0) return undefined;
  const noMatch = preview.tables === undefined ? undefined : diagnoseEmptyResult({ graph: executable, tables: preview.tables });
  return noMatch === undefined
    ? 'the design-time preview returned 0 rows, so the tool shows nothing on the canvas; use design-time values that exist in the data (see the profiles) so that the preview has rows'
    : `the design-time preview returned 0 rows: ${noMatchText(noMatch)}; use design-time values that exist in the data so that the preview has rows`;
}

/** 設計アシスタントの意味の検査の材料（`graph` は正規化後・解決前、`executable` は解決後）。 */
export interface DesignCheckContext {
  readonly graph: ToolGraph;
  readonly executable: ToolGraph;
  readonly propagation: PropagationResult;
  readonly preview: PreviewResult;
  readonly profiles: readonly DataProfile[];
  /** `graph` が参照しているデータソース id（出現順）。先頭を結合の主ソースとして読む。 */
  readonly dataSourceIds: readonly string[];
}

/**
 * 設計アシスタントの意味の検査（検証を通るのに答えが間違う形を、差し戻しの理由にする。Factory の意味検査の縮小版）。
 *
 * hard = 必ず間違う形（差し戻しても直らなければ適用しない）。soft = 指示によっては正しい形（「全行を」）なので、差し戻しは 1 回まで。
 * 結合の設計（`describeJoinDesignViolations`）も hard に入れる: 設計アシスタントで結合を作ると、Factory と同じ事故
 * （結合前の parse-period・注記キー）が起き得るため。設計アシスタントが読むプロファイルは 1 件ずつ取るので
 * `joinCandidates` が空で、「プロファイルに無いキー」の規則は効かない（効くのはプロファイルに頼らない 2 つ）。
 */
export function describeDesignProblems(context: DesignCheckContext): { readonly hard: string[]; readonly soft: string[] } {
  const { graph, executable, propagation, preview, profiles, dataSourceIds } = context;
  const referenced = dataSourceIds
    .map((id) => profiles.find((profile) => profile.dataSourceId === id))
    .filter((profile): profile is DataProfile => profile !== undefined);
  const primary = profiles.find((profile) => profile.dataSourceId === dataSourceIds[0]);
  const joinDesign = describeJoinDesignViolations(graph, primary, referenced.filter((profile) => profile !== primary));
  const empty = emptyPreviewProblem(executable, preview);
  return {
    hard: [
      ...(joinDesign === undefined ? [] : [joinDesign]),
      ...sortsOnPeriodLabel(graph, propagation, profiles),
      ...(empty === undefined ? [] : [empty]),
    ],
    soft: missingGranularityFilter(graph, profiles),
  };
}
