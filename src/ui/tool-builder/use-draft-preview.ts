import { useEffect, useRef } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import { flowToGraph, useToolBuilderStore } from './store';

export function useDraftPreview(client: ToolApiClient, delayMs = 300): void {
  const nodes = useToolBuilderStore((state) => state.nodes);
  const edges = useToolBuilderStore((state) => state.edges);
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const graph = flowToGraph(nodes, edges);
      const store = useToolBuilderStore.getState();
      store.setPreviewLoading(true);
      store.setError(undefined);

      void client.inferDraft(graph, controller.signal)
        .then(async (propagation) => {
          if (sequence !== requestSequence.current) return;
          useToolBuilderStore.getState().setPropagation(propagation);
          if (propagation.hasErrors) return;
          const preview = await client.previewDraft(graph, 100, controller.signal);
          if (sequence === requestSequence.current) {
            useToolBuilderStore.getState().setPreview(preview);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || sequence !== requestSequence.current) return;
          const failedStore = useToolBuilderStore.getState();
          failedStore.setPropagation(undefined);
          failedStore.setError(error instanceof Error ? error.message : 'Preview failed');
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
  }, [client, delayMs, edges, nodes]);
}
