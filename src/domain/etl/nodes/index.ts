/**
 * ドメイン: v1 ノード集約（実装契約 §9.7）
 *
 * 6 ノード（json-source / csv-source / select / filter / rename / cast）を
 * register 済みの NodeRegistry を生成する。
 * 依存の向き: registry ← nodes（registry.ts は本ファイルを import しない）。
 */
import { NodeRegistry } from '../registry';
import { jsonSourceNode } from './json-source';
import { csvSourceNode } from './csv-source';
import { selectNode } from './select';
import { filterNode } from './filter';
import { renameNode } from './rename';
import { castNode } from './cast';

export { jsonSourceNode } from './json-source';
export type { JsonSourceConfig } from './json-source';
export { csvSourceNode } from './csv-source';
export type { CsvSourceConfig } from './csv-source';
export { selectNode } from './select';
export type { SelectConfig } from './select';
export { filterNode } from './filter';
export type { FilterConfig, FilterOp } from './filter';
export { renameNode } from './rename';
export type { RenameConfig } from './rename';
export { castNode } from './cast';
export type { CastConfig } from './cast';

/** v1 の 6 ノードを登録済みの NodeRegistry を返す。 */
export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(jsonSourceNode);
  registry.register(csvSourceNode);
  registry.register(selectNode);
  registry.register(filterNode);
  registry.register(renameNode);
  registry.register(castNode);
  return registry;
}
