/**
 * ドメイン: レジストリ（v1 実装契約 §8）
 *
 * `EtlNode` を `type` キーで登録・取得する。
 * `createDefaultRegistry` は nodes/index.ts 側に置く（依存の向き: registry ← nodes）。
 */
import { GraphError } from './errors';
import type { EtlNode } from './node';

export class NodeRegistry {
  private readonly nodes = new Map<string, EtlNode>();

  /** ノードを登録する。重複 type は GraphError。 */
  register(node: EtlNode): void {
    if (this.nodes.has(node.type)) {
      throw new GraphError(`node type already registered: ${node.type}`);
    }
    this.nodes.set(node.type, node);
  }

  /** type でノードを取得する。未知は GraphError。 */
  get(type: string): EtlNode {
    const node = this.nodes.get(type);
    if (node === undefined) {
      throw new GraphError(`unknown node type: ${type}`);
    }
    return node;
  }

  /** 指定 type が登録済みか。 */
  has(type: string): boolean {
    return this.nodes.has(type);
  }

  /** 登録済みの type 一覧（登録順）。 */
  types(): string[] {
    return [...this.nodes.keys()];
  }
}
