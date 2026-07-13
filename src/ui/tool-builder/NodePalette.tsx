import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { SearchProviderDto } from '../api/types';
import { NODE_CATALOG } from './node-catalog';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

export function NodePalette({ client }: { readonly client?: ToolApiClient }) {
  const addNode = useToolBuilderStore((state) => state.addNode);
  const { text } = useI18n();
  const [providers, setProviders] = useState<readonly SearchProviderDto[]>([]);
  useEffect(() => {
    if (client === undefined) return;
    void client.listSearchProviders().then(setProviders).catch(() => setProviders([]));
  }, [client]);
  return (
    <aside className="node-palette" aria-label={text('Node palette', 'ノードパレット')}>
      <h2>{text('Nodes', 'ノード')}</h2>
      {(['source', 'transform', 'analyze', 'sink'] as const).map((kind) => (
        <section key={kind}>
          <h3>{kind === 'source' ? text('source', '入力') : kind === 'transform' ? text('transform', '変換') : kind === 'analyze' ? text('analysis', '分析') : text('output', '出力')}</h3>
          {NODE_CATALOG.filter((item) => item.kind === kind && (item.type !== 'web-search-source' || providers.length > 0)).map((item) => (
            <button key={item.type} type="button" onClick={() => addNode(item.type)} title={text(item.description, item.descriptionJa)}>
              <span>{text(item.label, item.labelJa)}</span><small>{text(item.description, item.descriptionJa)}</small>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
