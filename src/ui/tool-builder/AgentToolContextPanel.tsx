import type { DataType, SchemaDto } from '../api/types';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

const DATA_TYPES: readonly DataType[] = ['string', 'number', 'boolean', 'date', 'null', 'unknown'];

/** Tool Builder内でAgentへ渡すFunction Calling契約を編集・確認する。 */
export function AgentToolContextPanel() {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const setMetadata = useToolBuilderStore((state) => state.setMetadata);
  const inputNode = useToolBuilderStore((state) => state.nodes.find((node) => node.data.nodeType === 'agent-input'));
  const propagation = useToolBuilderStore((state) => state.propagation);
  const updateNodeConfig = useToolBuilderStore((state) => state.updateNodeConfig);
  const { text } = useI18n();

  const inputConfig = inputNode?.data.config;
  const inputSchema = inputConfig?.['schema'] as SchemaDto | undefined;
  const columns = inputSchema?.columns ?? [];
  const outputSchema = propagation === undefined ? undefined : propagation.nodes[propagation.order.at(-1) ?? '']?.schema;
  const updateColumns = (next: SchemaDto['columns']) => {
    if (inputNode === undefined || inputConfig === undefined) return;
    updateNodeConfig(inputNode.id, { ...inputConfig, schema: { columns: next } });
  };

  return <section className="agent-tool-context" aria-label={text('Agent tool context', 'エージェント向けツール情報')}>
    <div className="panel-title"><div><span className="eyebrow">{text('Agent context', 'エージェント向けコンテキスト')}</span><h2>{text('Tool Calling contract', 'Tool Calling契約')}</h2></div><span className="version-chip">{metadata.sideEffect}</span></div>
    <p className="agent-context-hint">{text('This is the exact context an Agent receives when this Tool is attached.', 'AgentがこのToolを使う際に受け取る契約情報です。')}</p>
    <label>{text('Tool name', 'ツール名')}<input aria-label={text('Agent-facing name', 'エージェント向けツール名')} placeholder={text('e.g. search_customers', '例: search_customers')} value={metadata.agentName} onChange={(event) => setMetadata('agentName', event.target.value)} /><small>{text('1–64 ASCII letters, numbers, _ or -.', '英数字・_・- を使った1〜64文字のFunction名です。')}</small></label>
    <label>{text('Description', '説明')}<textarea aria-label={text('Agent-facing description', 'エージェント向け説明')} rows={4} placeholder={text('When should the Agent call this Tool, and what does it return?', 'このツールを呼び出す条件と、返す情報を記述します。')} value={metadata.agentDescription} onChange={(event) => setMetadata('agentDescription', event.target.value)} /><small>{text('Describe when the Agent should call it and what it returns.', 'いつ呼び出すか、何を返すかを記述します。')}</small></label>
    <section className="agent-contract-spec">
      <h3>{text('Arguments', '引数')}</h3>
      {inputNode === undefined
        ? <p className="empty-state">{text('Add an Agent Input node to declare arguments.', 'Agent Inputノードを追加して引数を宣言してください。')}</p>
        : <>
            <p>{text('Edit the Agent Input schema here. Sample values remain in the node settings for design-time preview.', 'ここでAgent Inputのスキーマを編集できます。設計時プレビュー用のサンプル値はノード設定で保持します。')}</p>
            <div className="agent-argument-grid" role="table" aria-label={text('Agent arguments', 'エージェント引数')}>
              <span>{text('Name', '名前')}</span><span>{text('Type', '型')}</span><span>{text('Required', '必須')}</span><span aria-hidden="true" />
              {columns.map((column, index) => <div className="agent-argument-row" role="row" key={`${column.name}-${index}`}>
                <input aria-label={`${text('Argument name', '引数名')} ${index + 1}`} value={column.name} onChange={(event) => updateColumns(columns.map((current, i) => i === index ? { ...current, name: event.target.value } : current))} />
                <select aria-label={`${text('Argument type', '引数型')} ${column.name || index + 1}`} value={column.type} onChange={(event) => updateColumns(columns.map((current, i) => i === index ? { ...current, type: event.target.value as DataType } : current))}>{DATA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select>
                <label className="check"><input aria-label={`${text('Argument required', '引数必須')} ${column.name || index + 1}`} type="checkbox" checked={!column.nullable} onChange={(event) => updateColumns(columns.map((current, i) => i === index ? { ...current, nullable: !event.target.checked } : current))} />{text('Required', '必須')}</label>
                <button type="button" aria-label={`${text('Remove argument', '引数を削除')} ${column.name || index + 1}`} onClick={() => updateColumns(columns.filter((_, i) => i !== index))}>×</button>
              </div>)}
            </div>
            <button type="button" className="secondary" onClick={() => updateColumns([...columns, { name: `argument${columns.length + 1}`, type: 'string', nullable: true }])}>{text('Add argument', '引数を追加')}</button>
          </>}
    </section>
    <section className="agent-contract-spec">
      <h3>{text('Returned data', '返却データ')}</h3>
      {outputSchema === undefined ? <p className="empty-state">{text('Output schema appears when the graph is valid.', 'グラフが有効になると出力スキーマを表示します。')}</p> : <div className="schema-strip">{outputSchema.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.type}{column.nullable ? ` · ${text('optional', '任意')}` : ''}</span></div>)}</div>}
    </section>
  </section>;
}
