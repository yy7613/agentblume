import { useState } from 'react';
import type { ToolApiClient } from './api/tool-api';
import { ToolBuilder } from './tool-builder/ToolBuilder';
import { StatusPage } from './status/StatusPage';
import { AgentBuilder } from './agent-builder/AgentBuilder';
import { SkillBuilder } from './skill-builder/SkillBuilder';
import { ChatPage } from './chat/ChatPage';
import { McpPage } from './mcp/McpPage';
import { ValidationPage } from './validation/ValidationPage';
import { SettingsPage } from './settings/SettingsPage';

const NAV_ITEMS = ['Chat', 'Agent', 'Skill', 'Tool', 'MCP', 'Validation', 'Settings', 'Status'];

export function App({ client }: { readonly client: ToolApiClient }) {
  const [screen, setScreen] = useState<(typeof NAV_ITEMS)[number]>('Tool');
  return <div className="app-shell">
    <nav className="app-nav"><div className="brand"><span>AC</span><strong>AgentContext</strong></div>{NAV_ITEMS.map((item) => <button key={item} type="button" className={item === screen ? 'active' : ''} onClick={() => setScreen(item)}><span className="nav-dot" />{item}</button>)}<small>LOCAL · PREVIEW</small></nav>
    {screen === 'Tool' ? <ToolBuilder client={client} /> : screen === 'Agent' ? <AgentBuilder client={client} /> : screen === 'Skill' ? <SkillBuilder client={client} /> : screen === 'Chat' ? <ChatPage client={client} /> : screen === 'MCP' ? <McpPage client={client} /> : screen === 'Validation' ? <ValidationPage client={client} /> : screen === 'Settings' ? <SettingsPage client={client} /> : <StatusPage client={client} />}
  </div>;
}
