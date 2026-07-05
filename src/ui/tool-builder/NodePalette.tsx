import { NODE_CATALOG } from './node-catalog';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

export function NodePalette() {
  const addNode = useToolBuilderStore((state) => state.addNode);
  const { text } = useI18n();
  return (
    <aside className="node-palette" aria-label={text('Node palette', 'ノードパレット')}>
      <h2>{text('Nodes', 'ノード')}</h2>
      {(['source', 'transform'] as const).map((kind) => (
        <section key={kind}>
          <h3>{kind === 'source' ? text('source', '入力') : text('transform', '変換')}</h3>
          {NODE_CATALOG.filter((item) => item.kind === kind).map((item) => (
            <button key={item.type} type="button" onClick={() => addNode(item.type)} title={text(item.description, item.descriptionJa)}>
              <span>{text(item.label, item.labelJa)}</span><small>{text(item.description, item.descriptionJa)}</small>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
