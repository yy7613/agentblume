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
import { HarnessBuilder } from './harness-builder/HarnessBuilder';
import { FactoryPage } from './factory/FactoryPage';
import { ConfirmDialog } from './components/ConfirmDialog';
import { useHashScreen } from './routing';
import { UnsavedChangesProvider, useUnsavedChangesRegistry } from './unsaved-changes';
import { useI18n } from './i18n';

const ValidationPage = lazy(async () => ({ default: (await import('./validation/ValidationPage')).ValidationPage }));

// チャットは主役画面として単独で最上部、以降は作成フロー(Data→Tool→Skill→Agent→Harness→Factory)の順にグルーピングして提示する(UXレビュー反映)
const CHAT_ITEM = { id: 'Chat', ja: 'チャット' } as const;
const NAV_GROUPS = [
  { en: 'Build', ja: '作る', items: [{ id: 'Data', ja: 'データソース' }, { id: 'Tool', ja: 'ツール' }, { id: 'Skill', ja: 'スキル' }, { id: 'Agent', ja: 'エージェント' }, { id: 'Harness', ja: 'マルチエージェント' }, { id: 'Factory', ja: '自動生成 (Factory)' }] },
  { en: 'Check', ja: '確かめる', items: [{ id: 'Inspect', ja: '動作確認' }, { id: 'Validation', ja: '検証' }] },
  { en: 'Operate', ja: '運用', items: [{ id: 'Memory', ja: '記憶' }, { id: 'MCP', ja: 'MCP' }, { id: 'Status', ja: 'ステータス' }, { id: 'Settings', ja: '設定' }] },
] as const;
type Screen = (typeof CHAT_ITEM)['id'] | (typeof NAV_GROUPS)[number]['items'][number]['id'];
// URLルーティング用の全画面一覧（`#/tool` のように画面idの小文字がroute slugになる）。モジュールスコープに固定して参照を安定させる。
const SCREENS: readonly Screen[] = [CHAT_ITEM.id, ...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))];
const DEFAULT_SCREEN: Screen = 'Chat';
// ナビ項目の内部id(=画面遷移のキー)と英語表示文言を分離するための上書き表(idはそのまま、表示だけ変える)。
// HarnessのUI表示名は実態(マルチエージェント・オーケストレーション)に合わせて英語だけ'Multi-Agent'へ差し替える(id/route/型名は変更しない)。
const NAV_LABEL_EN_OVERRIDES: Readonly<Record<string, string>> = { Harness: 'Multi-Agent' };
function navLabel(id: string): string { return NAV_LABEL_EN_OVERRIDES[id] ?? id; }

export function App({ client }: { readonly client: ToolApiClient }) {
  const [screen, navigate] = useHashScreen(SCREENS, DEFAULT_SCREEN);
  // 未保存の編集を持つ画面から離れようとしたときの確認先。undefinedなら確認中でない。
  const [pendingScreen, setPendingScreen] = useState<Screen>();
  const unsavedChanges = useUnsavedChangesRegistry();
  const { text } = useI18n();

  // 左ナビのクリックは「未保存なら確認を挟む」経路へ集約する。
  function requestScreen(next: Screen): void {
    if (next === screen) return;
    if (unsavedChanges.unsaved) { setPendingScreen(next); return; }
    navigate(next);
  }
  function confirmLeave(): void {
    const next = pendingScreen;
    setPendingScreen(undefined);
    if (next !== undefined) navigate(next);
  }

  return <div className="app-shell">
    <nav className="app-nav"><div className="brand"><span>AB</span><strong>AgentBlume</strong></div><button type="button" className={`nav-chat${CHAT_ITEM.id === screen ? ' active' : ''}`} onClick={() => requestScreen(CHAT_ITEM.id)}><span className="nav-dot" />{text(navLabel(CHAT_ITEM.id), CHAT_ITEM.ja)}</button>{NAV_GROUPS.map((group) => <div key={group.en} className="nav-group"><small className="nav-group-label">{text(group.en, group.ja)}</small>{group.items.map((item) => <button key={item.id} type="button" className={item.id === screen ? 'active' : ''} onClick={() => requestScreen(item.id)}><span className="nav-dot" />{text(navLabel(item.id), item.ja)}</button>)}</div>)}<small>LOCAL · PREVIEW</small></nav>
    <UnsavedChangesProvider value={unsavedChanges.value}>
      {screen === 'Tool' ? <ToolBuilder client={client} /> : screen === 'Agent' ? <AgentBuilder client={client} /> : screen === 'Harness' ? <HarnessBuilder client={client} /> : screen === 'Skill' ? <SkillBuilder client={client} /> : screen === 'Chat' ? <ChatPage client={client} /> : screen === 'Inspect' ? <AgentInspectorPage client={client} /> : screen === 'Data' ? <DataSourcesPage client={client} /> : screen === 'MCP' ? <McpPage client={client} /> : screen === 'Validation' ? <Suspense fallback={<main className="workspace-page"><p className="empty-state">{text('Loading validation…', '検証画面を読み込み中…')}</p></main>}><ValidationPage client={client} /></Suspense> : screen === 'Factory' ? <FactoryPage client={client} /> : screen === 'Memory' ? <MemoryPage client={client} /> : screen === 'Settings' ? <SettingsPage client={client} /> : <StatusPage client={client} />}
    </UnsavedChangesProvider>
    <ConfirmDialog open={pendingScreen !== undefined} title={text('Leave this screen?', 'この画面を離れますか？')}
      message={text('This screen has unsaved edits. They are kept as a local draft, but the screen will be reset. Leave anyway?', 'この画面には未保存の編集があります。ローカルの下書きとして残りますが、画面はリセットされます。移動しますか？')}
      confirmLabel={text('Leave', '移動する')} cancelLabel={text('Stay', 'とどまる')}
      onConfirm={confirmLeave} onCancel={() => setPendingScreen(undefined)} />
  </div>;
}
