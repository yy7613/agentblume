import { lazy, Suspense, useState } from 'react';
import type { ToolApiClient } from './api/tool-api';
import { ToolBuilder } from './tool-builder/ToolBuilder';
import { StatusPage } from './status/StatusPage';
import { AgentBuilder } from './agent-builder/AgentBuilder';
import { SkillBuilder } from './skill-builder/SkillBuilder';
import { ChatPage } from './chat/ChatPage';
import { AgentInspectorPage } from './inspector/AgentInspectorPage';
import { McpPage } from './mcp/McpPage';
import { MemoryPage } from './memory/MemoryPage';
import { SettingsPage } from './settings/SettingsPage';
import { DataSourcesPage } from './data-sources/DataSourcesPage';
import { useI18n } from './i18n';

const ValidationPage = lazy(async () => ({ default: (await import('./validation/ValidationPage')).ValidationPage }));

const NAV_ITEMS = [
  { id: 'Chat', ja: 'チャット' }, { id: 'Inspect', ja: '動作確認' }, { id: 'Agent', ja: 'エージェント' }, { id: 'Skill', ja: 'スキル' }, { id: 'Data', ja: 'データソース' }, { id: 'Tool', ja: 'ツール' },
  { id: 'MCP', ja: 'MCP' }, { id: 'Validation', ja: '検証' }, { id: 'Memory', ja: '記憶' }, { id: 'Settings', ja: '設定' }, { id: 'Status', ja: 'ステータス' },
] as const;
type Screen = (typeof NAV_ITEMS)[number]['id'];

export function App({ client }: { readonly client: ToolApiClient }) {
  const [screen, setScreen] = useState<Screen>('Tool');
  const { text } = useI18n();
  return <div className="app-shell">
    <nav className="app-nav"><div className="brand"><span>AB</span><strong>agentblume</strong></div>{NAV_ITEMS.map((item) => <button key={item.id} type="button" className={item.id === screen ? 'active' : ''} onClick={() => setScreen(item.id)}><span className="nav-dot" />{text(item.id, item.ja)}</button>)}<small>LOCAL · PREVIEW</small></nav>
    {screen === 'Tool' ? <ToolBuilder client={client} /> : screen === 'Agent' ? <AgentBuilder client={client} /> : screen === 'Skill' ? <SkillBuilder client={client} /> : screen === 'Chat' ? <ChatPage client={client} /> : screen === 'Inspect' ? <AgentInspectorPage client={client} /> : screen === 'Data' ? <DataSourcesPage client={client} /> : screen === 'MCP' ? <McpPage client={client} /> : screen === 'Validation' ? <Suspense fallback={<main className="workspace-page"><p className="empty-state">{text('Loading validation…', '検証画面を読み込み中…')}</p></main>}><ValidationPage client={client} /></Suspense> : screen === 'Memory' ? <MemoryPage client={client} /> : screen === 'Settings' ? <SettingsPage client={client} /> : <StatusPage client={client} />}
  </div>;
}
