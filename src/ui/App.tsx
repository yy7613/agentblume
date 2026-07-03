import { useState } from 'react';
import type { ToolApiClient } from './api/tool-api';
import { ToolBuilder } from './tool-builder/ToolBuilder';
import { StatusPage } from './status/StatusPage';
import { AgentBuilder } from './agent-builder/AgentBuilder';

const NAV_ITEMS = ['Chat', 'Agent', 'Skill', 'Tool', 'MCP', 'Validation', 'Settings', 'Status'];

export function App({ client }: { readonly client: ToolApiClient }) {
  const [screen, setScreen] = useState<'Agent' | 'Tool' | 'Status'>('Tool');
  return <div className="app-shell">
    <nav className="app-nav"><div className="brand"><span>AC</span><strong>AgentContext</strong></div>{NAV_ITEMS.map((item) => <button key={item} type="button" className={item === screen ? 'active' : ''} disabled={item !== 'Agent' && item !== 'Tool' && item !== 'Status'} onClick={() => { if (item === 'Agent' || item === 'Tool' || item === 'Status') setScreen(item); }}><span className="nav-dot" />{item}</button>)}<small>LOCAL · PREVIEW</small></nav>
    {screen === 'Tool' ? <ToolBuilder client={client} /> : screen === 'Agent' ? <AgentBuilder client={client} /> : <StatusPage client={client} />}
  </div>;
}
