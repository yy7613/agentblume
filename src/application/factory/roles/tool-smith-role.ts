/**
 * application層: Agent Factory Stage 2 ToolSmithロール（v33 実装契約 §3 / docs/16-agent-factory.md §3, §4 Stage 2）。
 *
 * Tool計画1件を、安全な（read-only）ノード語彙に限定したETLグラフへ具体化する。source は計画の
 * dataSourceId・データソースformatに一致する csv-source/json-source ちょうど1つ、変換は
 * `SAFE_TRANSFORM_TYPES`（select/filter/sort/distinct/limit/parse-period/summary-statistics）のみ、
 * 終端は agent-output ちょうど1つに制約する（docs/16 §8: 生成Toolは
 * read-only/session-writeのみ、write/external-actionは保存前に拒否）。
 *
 * 期間（`時点` のような文字列ラベル列）は `parse-period` で開始日と粒度へ開いてから絞る・並べ替えるよう
 * 誘導し、引数を省略した既定の呼び出しでも `agent-output` の maxRows を溢れさせないよう出力を縛らせる
 * （ADR-0047: e-Stat 実データでの失敗から）。
 *
 * 検索・絞り込みを行うToolでは、未接続の `agent-input` ノード1つを「Tool引数の宣言」として置くことを
 * 許可する（エンジンは未接続の agent-input を終端候補から外す）。引数は filter条件の
 * `valueBinding: { source:'agent-input', field }`（値）/ `opBinding: { source:'agent-input', field, allowed? }`
 * （演算子）で消費し、実行時に `RunAgentPreviewUseCase` がエージェントの実引数へ差し替える。
 * グラフの検証（EtlEngine + 修復ループ）と inputSchema の導出は
 * 呼び出し側（`GenerateAgentAssetsUseCase`）が担う。本ロールは提案のみで、検証は行わない。
 */
import { FILTER_OPS, ORDER_OPS, VALUELESS_OPS } from '../../../domain/etl/nodes/filter';
import { PARSE_PERIOD_TYPE, PERIOD_GRANULARITIES } from '../../../domain/etl/nodes/parse-period';
import { MAX_TOOL_CALLS } from '../../agent/run-agent-preview';
import { FactoryValidationError } from '../../../domain/factory/errors';
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { ToolGraph } from '../../../domain/etl/graph';
import type { JsonSchemaObject, ModelProviderPort } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import type { DataProfile } from '../profile-data-sources';
import { wrapUntrusted } from './untrusted';

/**
 * M2で許可する変換ノード語彙（read-only のみ）。
 *
 * `parse-period` / `limit` は e-Stat 実データの検証（ADR-0047）で必須と分かって足した:
 * 期間ラベルが文字列のままでは範囲指定も時系列の並べ替えもできず、行数を縛る手段が無いと
 * 引数を省略した既定の呼び出しが `agent-output` の maxRows を必ず溢れさせる。
 */
export const SAFE_TRANSFORM_TYPES = ['select', 'filter', 'sort', 'distinct', 'limit', PARSE_PERIOD_TYPE, 'rename', 'join', 'summary-statistics'] as const;

/**
 * 複数データソースを束ねる結合ノード。`SAFE_TRANSFORM_TYPES` に含まれるが、入力を2つ取る唯一の
 * ノードなので、グラフの形（木）を語るときに名指しできるよう定数として分けておく。
 */
export const JOIN_NODE_TYPE = 'join';

/** `parse-period` が付ける粒度の語彙（プロンプトへ列挙する）。 */
const GRANULARITY_VOCABULARY = PERIOD_GRANULARITIES.map((granularity) => `'${granularity}'`).join(', ');

/**
 * この配線の `filter` が複数値演算子（`in` / `notIn`）を持つか（ADR-0047 round 3 / Part 2）。
 *
 * domain の正準リストから決定的に見る。持たないビルドでは `in` を勧める規則も、
 * 「カテゴリ引数は `in` で束縛せよ」という検査も**出さない**: エンジンが受け付けない演算子を
 * 書かせると、生成したToolが毎回修復ループで落ちてRunごと失敗するため。
 */
export function supportsMultiValueFilterOps(): boolean {
  return (FILTER_OPS as readonly string[]).includes('in');
}

/**
 * この役割がモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/tool-smith.md` にあり、
 * ここに残るのは「どの節をどの順に使うか」だけ。
 *
 * - `task.*` / `rules.source.*`: 単一ソースか結合かで 1 行ずつ入れ替わる。
 * - `rules.join`: 複数データソースを束ねるToolにだけ足す（ADR-0047 round 3）。実測では
 *   「同じ時点で並べて説明する」目的に対して 1ソース1Toolを3つ作り、行の突き合わせを
 *   エージェント任せにして失敗した。1つのToolで結合して返せば、突き合わせは決定的に済む。
 * - `rules.join.example`: 3ソース以上のときだけ出す完成例。12B級のモデルには、規則の列挙より
 *   「動く形をそのまま見せる」方が通りやすい（2ソースでは長すぎて他の規則を薄める）。
 * - `rules.category.in` / `rules.category.omit`: `filter` が複数値演算子（`in`）を持つビルドかで
 *   入れ替わる（`supportsMultiValueFilterOps`）。
 */
export const TOOL_SMITH_PROMPT: PromptSpec = {
  id: 'factory/tool-smith',
  sections: [
    'system', 'task.single', 'task.joined', 'rules.header', 'rules.source.single', 'rules.source.joined',
    'rules.core', 'rules.join', 'rules.join.example', 'rules.category.header', 'rules.category.in',
    'rules.category.omit', 'rules.tail', 'closing',
  ],
};

/** プロンプトへ列挙する演算子語彙（domain の正準リスト `FILTER_OPS` から導出し、リテラルの複製を持たない）。 */
const OP_VOCABULARY = FILTER_OPS.map((op) => `'${op}'`).join(', ');
/** 順序比較演算子（列型 number|date 必須）のスラッシュ区切り表記（`ORDER_OPS` から導出）。 */
const ORDER_OP_VOCABULARY = [...ORDER_OPS].map((op) => `'${op}'`).join('/');
/** 値を取らない演算子のスラッシュ区切り表記（`VALUELESS_OPS` から導出）。 */
const VALUELESS_OP_VOCABULARY = [...VALUELESS_OPS].map((op) => `'${op}'`).join('/');

const TOOL_SMITH_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['graph', 'agentTool'],
  properties: {
    graph: {
      type: 'object',
      additionalProperties: false,
      required: ['nodes', 'edges'],
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'type', 'config'],
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              config: { type: 'object', additionalProperties: true },
            },
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to'],
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              toInput: { type: 'number' },
            },
          },
        },
      },
    },
    agentTool: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
    },
  },
};

export interface ToolSmithRoleInput {
  readonly toolPlan: FactoryToolPlan;
  /** 主データソースのプロファイル（グラフの左端・`join` の左側になる）。 */
  readonly profile: DataProfile;
  /**
   * 結合する追加データソースのプロファイル（計画の `additionalDataSourceIds` 順）。
   * 空・未指定なら従来どおりの単一ソースTool（ADR-0047 round 3）。
   */
  readonly additionalProfiles?: readonly DataProfile[];
  /** 直前の検証エラー（EtlEngine.propagateSchemas/preview 由来）。修復再試行時のみ設定する。 */
  readonly priorError?: string;
}

export interface ToolSmithProposal {
  readonly graph: ToolGraph;
  readonly agentTool: { readonly name: string; readonly description: string };
}

export class ToolSmithRole {
  constructor(private readonly model: ModelProviderPort, private readonly prompts: PromptCatalogPort) {}

  available(): boolean {
    return this.model.capabilities().includes('structured-output');
  }

  async propose(input: ToolSmithRoleInput, signal?: AbortSignal): Promise<ToolSmithProposal> {
    if (!this.available()) throw new FactoryValidationError('ToolSmithRole: model does not support structured output');
    const sourceType = input.profile.format === 'json' ? 'json-source' : 'csv-source';
    const additional = input.additionalProfiles ?? [];
    const prompt = this.prompts.get(TOOL_SMITH_PROMPT.id);
    const sourceLine = additional.length === 0
      ? prompt.render('rules.source.single', { sourceType, dataSourceId: input.toolPlan.dataSourceId })
      : prompt.render('rules.source.joined', {
        sourceCount: 1 + additional.length,
        dataSourceId: input.toolPlan.dataSourceId,
        sourceType,
        additionalSources: additional
          .map((profile) => `{ "dataSourceId": "${profile.dataSourceId}" } (type '${profile.format === 'json' ? 'json-source' : 'csv-source'}')`)
          .join(', '),
      });
    const system = [
      prompt.render('system'),
      additional.length === 0 ? prompt.render('task.single') : prompt.render('task.joined'),
      prompt.render('rules.header'),
      sourceLine,
      prompt.render('rules.core', {
        transformTypes: SAFE_TRANSFORM_TYPES.join(', '),
        parsePeriodType: PARSE_PERIOD_TYPE,
        granularities: GRANULARITY_VOCABULARY,
        joinNodeType: JOIN_NODE_TYPE,
      }),
      ...(additional.length === 0 ? [] : [prompt.render('rules.join', { parsePeriodType: PARSE_PERIOD_TYPE })]),
      // 3ソース以上のときだけ、完成した形をそのまま見せる（2ソースでは長すぎて他の規則を薄める）。
      ...(additional.length >= 2 ? [prompt.render('rules.join.example', { parsePeriodType: PARSE_PERIOD_TYPE })] : []),
      prompt.render('rules.category.header', { maxToolCalls: MAX_TOOL_CALLS }),
      supportsMultiValueFilterOps() ? prompt.render('rules.category.in') : prompt.render('rules.category.omit'),
      prompt.render('rules.tail', {
        orderOps: ORDER_OP_VOCABULARY,
        filterOps: OP_VOCABULARY,
        valuelessOps: VALUELESS_OP_VOCABULARY,
      }),
      prompt.render('closing'),
    ].join('\n');
    const payload = {
      toolPlan: input.toolPlan,
      dataSource: {
        dataSourceId: input.profile.dataSourceId,
        name: input.profile.name,
        format: input.profile.format,
        columns: input.profile.columns,
        rowCount: input.profile.rowCount,
        periodColumns: input.profile.periodColumns ?? [],
        categoricalColumns: input.profile.categoricalColumns ?? [],
        sampleRows: input.profile.sampleRows.slice(0, 3),
      },
      // 結合するToolだけ、追加ソースのプロファイルと「どの列で結合できるか」を添える。
      ...(additional.length === 0 ? {} : {
        additionalDataSources: additional.map((profile) => ({
          dataSourceId: profile.dataSourceId,
          name: profile.name,
          format: profile.format,
          columns: profile.columns,
          rowCount: profile.rowCount,
          periodColumns: profile.periodColumns ?? [],
          categoricalColumns: profile.categoricalColumns ?? [],
          sampleRows: profile.sampleRows.slice(0, 3),
        })),
        joinCandidates: joinCandidatesFor(input.profile, additional),
      }),
      ...(input.priorError === undefined ? {} : { priorValidationError: input.priorError }),
    };
    const completion = await this.model.complete({
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: wrapUntrusted('factory-tool-smith-input', payload) },
      ],
      responseFormat: { name: 'factory_tool_proposal', strict: true, schema: TOOL_SMITH_SCHEMA },
    }, signal);
    return parseProposal(completion.message.content);
  }
}

/**
 * このToolが束ねるソースの組み合わせに関係する結合候補だけを取り出す（向きは問わない）。
 * `joinCandidates` はRun全体の一覧なので、無関係なペアを渡すとモデルが別のソースを読みに行く。
 */
function joinCandidatesFor(primary: DataProfile, additional: readonly DataProfile[]): DataProfile['joinCandidates'] {
  const involved = new Set([primary.dataSourceId, ...additional.map((profile) => profile.dataSourceId)]);
  return (primary.joinCandidates ?? []).filter((candidate) => involved.has(candidate.leftDataSourceId) && involved.has(candidate.rightDataSourceId));
}

function parseProposal(content: string | null): ToolSmithProposal {
  if (content === null) throw new FactoryValidationError('ToolSmithRole: model returned empty content');
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw new FactoryValidationError(`ToolSmithRole: invalid JSON: ${String(error)}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FactoryValidationError('ToolSmithRole: response is not a JSON object');
  const record = value as Record<string, unknown>;
  const graph = record['graph'];
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) throw new FactoryValidationError('ToolSmithRole: response is missing graph');
  const graphRecord = graph as Record<string, unknown>;
  if (!Array.isArray(graphRecord['nodes']) || !Array.isArray(graphRecord['edges'])) throw new FactoryValidationError('ToolSmithRole: graph is missing nodes/edges arrays');
  const agentTool = record['agentTool'];
  if (agentTool === null || typeof agentTool !== 'object' || Array.isArray(agentTool)) throw new FactoryValidationError('ToolSmithRole: response is missing agentTool');
  const agentToolRecord = agentTool as Record<string, unknown>;
  if (typeof agentToolRecord['name'] !== 'string' || typeof agentToolRecord['description'] !== 'string') {
    throw new FactoryValidationError('ToolSmithRole: agentTool must have string name/description');
  }
  return {
    graph: graph as ToolGraph,
    agentTool: { name: agentToolRecord['name'], description: agentToolRecord['description'] },
  };
}
