import type { ToolApiClient } from './api/tool-api';
import { ToolBuilder } from './tool-builder/ToolBuilder';

const NAV_ITEMS = ['Chat', 'Agent', 'Skill', 'Tool', 'MCP', 'Validation', 'Settings', 'Status'];

export function App({ client }: { readonly client: ToolApiClient }) {
  return <div className="app-shell">
    <nav className="app-nav"><div className="brand"><span>AC</span><strong>AgentContext</strong></div>{NAV_ITEMS.map((item) => <button key={item} type="button" className={item === 'Tool' ? 'active' : ''} disabled={item !== 'Tool'}><span className="nav-dot" />{item}</button>)}<small>LOCAL · PREVIEW</small></nav>
    <ToolBuilder client={client} />
  </div>;
}
