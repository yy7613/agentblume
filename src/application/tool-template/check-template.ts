/**
 * application層: テンプレートを**ノードレジストリ**に照らして見る検査（v43 実装契約 §2.4 の残り）。
 *
 * domain の `parseToolTemplate` は registry を知らない（層の規律）ので、
 * 「そのノード種別は登録されているか」「副作用のある sink を置いていないか」はここで見る。
 * カタログのアダプタがファイルを読んだ直後に呼び、落ちたものは `invalid[]` へ入れる。
 */
import type { NodeRegistry } from '../../domain/etl/registry';
import { nodeTypeNameOf, type ToolTemplate } from '../../domain/tool-template/template';

/** テンプレートが使ってよい唯一の sink（副作用のある終端を持ち込ませない）。 */
export const TEMPLATE_ALLOWED_SINK_TYPE = 'agent-output';

/** `$sourceType` が解決しうるノード種別（どちらも登録されていなければテンプレートは使えない）。 */
const SOURCE_TYPES: readonly string[] = ['csv-source', 'json-source'];

/**
 * ノード種別の検査。問題は 1 件ごとに「何が悪いか」と「どう直すか」を含む。
 *
 * テンプレートが使ってよい種別は**登録済みの全種別**である（一括 ToolSmith の許可リストには
 * 縛られない。構成をテンプレートが持つので、式や分析ノードを使ってよい）。ただし副作用のある
 * sink は置けない: 終端は `agent-output` ただ 1 つ。
 */
export function checkTemplateAgainstRegistry(template: ToolTemplate, registry: NodeRegistry): string[] {
  const problems: string[] = [];
  const registered = registry.types();

  for (const node of template.nodes) {
    const type = nodeTypeNameOf(node);
    if (type === undefined) {
      // `{"$sourceType": …}`: csv / json のどちらに解決しても動く必要がある。
      const missing = SOURCE_TYPES.filter((candidate) => !registry.has(candidate));
      if (missing.length > 0) {
        problems.push(`node '${node.id}' picks its source type from the data source, but ${missing.join(' and ')} is not registered in this build; write a fixed "type" that exists (${registered.join(', ')})`);
      }
      continue;
    }
    if (!registry.has(type)) {
      problems.push(`node '${node.id}' has type '${type}', which is not a registered node type; use one of ${registered.join(', ')}`);
      continue;
    }
    if (registry.get(type).kind === 'sink' && type !== TEMPLATE_ALLOWED_SINK_TYPE) {
      problems.push(`node '${node.id}' has type '${type}', which writes somewhere outside the tool; a template may only end in '${TEMPLATE_ALLOWED_SINK_TYPE}' — replace it`);
    }
  }
  return problems;
}
