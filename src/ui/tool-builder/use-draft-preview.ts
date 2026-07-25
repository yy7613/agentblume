import { useEffect, useRef } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import { useI18n } from '../i18n';
import { incompleteConfigNodeIds } from './draft-readiness';
import { flowToGraph, useToolBuilderStore } from './store';

export function useDraftPreview(client: ToolApiClient, delayMs = 300): void {
  const nodes = useToolBuilderStore((state) => state.nodes);
  const edges = useToolBuilderStore((state) => state.edges);
  const metadata = useToolBuilderStore((state) => state.metadata);
  const scope = { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId };
  const requestSequence = useRef(0);
  const { text } = useI18n();

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const graph = flowToGraph(nodes, edges);
      const store = useToolBuilderStore.getState();
      // 自動検証は draftIssue だけを上書きする。保存失敗(saveError)は保存操作の側で管理する。
      const incomplete = incompleteConfigNodeIds(nodes);
      if (incomplete.length > 0) {
        store.setPreviewLoading(false);
        store.setDraftIssue(text(`Configuration is incomplete: ${incomplete.join(', ')}`, `設定が未完了です: ${incomplete.join('、')}`));
        return;
      }
      store.setPreviewLoading(true);
      store.setDraftIssue(undefined);

      void client.inferDraft(graph, controller.signal, scope)
        .then(async (propagation) => {
          if (sequence !== requestSequence.current) return;
          useToolBuilderStore.getState().setPropagation(propagation);
          if (propagation.hasErrors) {
            // ノード単位のschema issueがある間は古いpreviewを残さない。「壊れているのに動いて
            // 見える」状態（バグ5）を防ぐため、直近の成功結果をここでクリアする。
            useToolBuilderStore.getState().setPreview(undefined);
            return;
          }
          const preview = await client.previewDraft(graph, 100, controller.signal, scope);
          if (sequence === requestSequence.current) {
            useToolBuilderStore.getState().setPreview(preview);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || sequence !== requestSequence.current) return;
          const failedStore = useToolBuilderStore.getState();
          failedStore.setPropagation(undefined);
          // 構造エラー（グラフ自体が不正で inferDraft/previewDraft が失敗）の間も、古いpreviewを
          // 残さない。既存のsaveError分離は変更しない（ここではdraftIssueだけを更新する）。
          failedStore.setPreview(undefined);
          failedStore.setDraftIssue(error instanceof Error ? error.message : 'Preview failed');
        })
        .finally(() => {
          if (sequence === requestSequence.current) {
            useToolBuilderStore.getState().setPreviewLoading(false);
          }
        });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, delayMs, edges, metadata.tenantId, metadata.workspaceId, nodes, text]);
}
