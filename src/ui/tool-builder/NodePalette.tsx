import { NODE_CATALOG } from './node-catalog';
import { useToolBuilderStore } from './store';

export function NodePalette() {
  const addNode = useToolBuilderStore((state) => state.addNode);
  return (
    <aside className="node-palette" aria-label="Node palette">
      <h2>Nodes</h2>
      {(['source', 'transform'] as const).map((kind) => (
        <section key={kind}>
          <h3>{kind}</h3>
          {NODE_CATALOG.filter((item) => item.kind === kind).map((item) => (
            <button key={item.type} type="button" onClick={() => addNode(item.type)} title={item.description}>
              <span>{item.label}</span><small>{item.description}</small>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
