import { useState } from 'react';
import type { ToolApiClient } from './api/tool-api';
import { ToolBuilder } from './tool-builder/ToolBuilder';
import { StatusPage } from './status/StatusPage';
import { AgentBuilder } from './agent-builder/AgentBuilder';
import { SkillBuilder } from './skill-builder/SkillBuilder';
import { ChatPage } from './chat/ChatPage';
import { AgentInspectorPage } from './inspector/AgentInspectorPage';
import { McpPage } from './mcp/McpPage';
import { ValidationPage } from './validation/ValidationPage';
import { SettingsPage } from './settings/SettingsPage';
import { useI18n } from './i18n';

const NAV_ITEMS = [
  { id: 'Chat', ja: 'チャット' }, { id: 'Inspect', ja: '動作確認' }, { id: 'Agent', ja: 'エージェント' }, { id: 'Skill', ja: 'スキル' }, { id: 'Tool', ja: 'ツール' },
  { id: 'MCP', ja: 'MCP' }, { id: 'Validation', ja: '検証' }, { id: 'Settings', ja: '設定' }, { id: 'Status', ja: 'ステータス' },
] as const;
type Screen = (typeof NAV_ITEMS)[number]['id'];

export function App({ client }: { readonly client: ToolApiClient }) {
  const [screen, setScreen] = useState<Screen>('Tool');
  const { text } = useI18n();
  return <div className="app-shell">
    <nav className="app-nav"><div className="brand"><span>AC</span><strong>AgentContext</strong></div>{NAV_ITEMS.map((item) => <button key={item.id} type="button" className={item.id === screen ? 'active' : ''} onClick={() => setScreen(item.id)}><span className="nav-dot" />{text(item.id, item.ja)}</button>)}<small>LOCAL · PREVIEW</small></nav>
    {screen === 'Tool' ? <ToolBuilder client={client} /> : screen === 'Agent' ? <AgentBuilder client={client} /> : screen === 'Skill' ? <SkillBuilder client={client} /> : screen === 'Chat' ? <ChatPage client={client} /> : screen === 'Inspect' ? <AgentInspectorPage client={client} /> : screen === 'MCP' ? <McpPage client={client} /> : screen === 'Validation' ? <ValidationPage client={client} /> : screen === 'Settings' ? <SettingsPage client={client} /> : <StatusPage client={client} />}
  </div>;
}
