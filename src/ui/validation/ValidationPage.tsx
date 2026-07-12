import { lazy, Suspense, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import { useI18n } from '../i18n';
import { PersonasTab } from './PersonasTab';
import { RunsTab } from './RunsTab';
import { ScenariosTab } from './ScenariosTab';

const DatasetsTab = lazy(async () => ({ default: (await import('./DatasetsTab')).DatasetsTab }));
const ExperimentsTab = lazy(async () => ({ default: (await import('./ExperimentsTab')).ExperimentsTab }));
const QualityTab = lazy(async () => ({ default: (await import('./QualityTab')).QualityTab }));

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
type Tab = 'personas' | 'scenarios' | 'datasets' | 'experiments' | 'quality' | 'runs';

export function ValidationPage({ client }: { readonly client: ToolApiClient }) {
  const [tab, setTab] = useState<Tab>('personas');
  const { text } = useI18n();
  const tabs: readonly { readonly id: Tab; readonly label: string }[] = [
    { id: 'personas', label: text('Personas', 'ペルソナ') },
    { id: 'scenarios', label: text('Scenarios', 'シナリオ') },
    { id: 'datasets', label: text('Datasets', 'データセット') },
    { id: 'experiments', label: text('Experiments', '実験') },
    { id: 'quality', label: text('Quality gates', '品質ゲート') },
    { id: 'runs', label: text('Runs', '実行結果') },
  ];
  return <main className="workspace-page">
    <header className="workspace-header"><div><span className="eyebrow">{text('Validation', '検証')}</span><h1>{text('Scenario validation', 'シナリオ検証')}</h1><p>{text('Define personas and scenarios, run multi-turn pseudo-user conversations against saved Agents, and review transcripts and surveys.', 'ペルソナとシナリオを定義し、保存済みエージェントに対する疑似ユーザーの複数ターン会話を実行して、トランスクリプトとアンケートを確認します。')}</p></div></header>
    <div className="validation-tabs" role="tablist" aria-label={text('Validation tabs', '検証タブ')}>
      {tabs.map((item) => <button type="button" key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    {tab === 'personas' ? <PersonasTab client={client} scope={scope} />
      : tab === 'scenarios' ? <ScenariosTab client={client} scope={scope} onRunCompleted={() => setTab('runs')} />
      : tab === 'datasets' ? <Suspense fallback={<p className="empty-state">{text('Loading datasets…', 'データセットを読み込み中…')}</p>}><DatasetsTab client={client} scope={scope} /></Suspense>
      : tab === 'experiments' ? <Suspense fallback={<p className="empty-state">{text('Loading experiments…', '実験を読み込み中…')}</p>}><ExperimentsTab client={client} scope={scope} /></Suspense>
      : tab === 'quality' ? <Suspense fallback={<p className="empty-state">{text('Loading quality gates…', '品質ゲートを読み込み中…')}</p>}><QualityTab client={client} scope={scope} /></Suspense>
      : <RunsTab client={client} scope={scope} />}
  </main>;
}
