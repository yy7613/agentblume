/**
 * ドメイン: 仕訳（docs/20-journal.md）のノード登録。
 *
 * 業務のノードは業務ごとの登録関数にまとめ、`index.ts` はそれを呼ぶだけにする（ADR-0039）。
 * 並行して業務を足すときに、共有の `index.ts` を取り合わないため。
 */
import type { NodeRegistry } from '../registry';
import { journalAttachmentSourceNode } from './journal-attachment';
import { journalDraftEntrySourceNode } from './journal-draft-entry';
import { journalEntriesSourceNode } from './journal-entries-source';

export function registerJournalNodes(registry: NodeRegistry): void {
  registry.register(journalAttachmentSourceNode);
  registry.register(journalDraftEntrySourceNode);
  registry.register(journalEntriesSourceNode);
}
