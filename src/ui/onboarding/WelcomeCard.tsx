import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { SampleDataSummaryDto } from '../api/types';
import { useI18n } from '../i18n';
import { useNavigateScreen } from '../navigation';
import {
  dismissWelcome, isWelcomeDismissed, onboardingProgressRatio, onboardingSteps, shouldShowWelcome,
  type OnboardingProgress, type OnboardingStepId,
} from './onboarding-state';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

type Translate = (english: string, japanese: string) => string;

function stepLabel(id: OnboardingStepId, text: Translate): string {
  switch (id) {
    case 'model': return text('Set the model', 'モデルを設定');
    case 'data': return text('Register a data source', 'データソースを登録');
    case 'tool': return text('Build a Tool', 'ツールを作る');
    case 'agent': return text('Assemble an Agent', 'エージェントを組み立てる');
    case 'try': return text('Try it in Chat', 'チャットで試す');
  }
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }

function sampleSummaryLabel(sample: SampleDataSummaryDto, text: Translate): string {
  const counts = `${sample.dataSources.length} / ${sample.tools.length} / ${sample.skills.length} / ${sample.agents.length} / ${sample.wikis.length}`;
  return text(
    `Data sources / Tools / Skills / Agents / Wikis: ${counts}`,
    `データソース / ツール / スキル / エージェント / Wiki: ${counts}`,
  );
}

/**
 * 初回起動のウェルカムカード。
 *
 * **オーバーレイ（position: fixed）として置く**。左ナビと同じ列に積むと、`.cc-chat` が `height: 100vh` の
 * チャット画面を画面外へ押し出してしまい、既定画面が使えなくなるため。背景（backdrop）は敷かないので、
 * 表示中でも左ナビと画面本体はそのまま操作できる（モーダルではない）。
 *
 * 表示条件は「今後表示しないを押していない」かつ「ワークスペースが空」。資産を作り始めたら自動的に消える。
 */
export function WelcomeCard({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const navigate = useNavigateScreen();
  const [dismissed, setDismissed] = useState(() => isWelcomeDismissed());
  const [progress, setProgress] = useState<OnboardingProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sample, setSample] = useState<SampleDataSummaryDto>();

  const refresh = useCallback(async (): Promise<void> => {
    // モデル設定だけは未設定でも致命的でない（環境変数の既定で動く構成がある）ので、失敗しても全体を倒さない。
    const settings = typeof client.getModelSettings === 'function' ? client.getModelSettings(scope).catch(() => undefined) : Promise.resolve(undefined);
    const [dataSources, tools, agents, saved] = await Promise.all([
      client.listDataSources(scope),
      client.listTools(scope),
      client.listAgents(scope),
      settings,
    ]);
    setProgress({
      modelConfigured: saved?.main !== undefined,
      dataSources: dataSources.length,
      tools: tools.length,
      agents: agents.length,
    });
  }, [client]);

  useEffect(() => {
    if (dismissed) return;
    // 一覧APIを持たないclient（画面単体テストのスタブなど）ではウェルカムを出さない。
    const partial = client as Partial<ToolApiClient>;
    if (typeof partial.listDataSources !== 'function' || typeof partial.listTools !== 'function' || typeof partial.listAgents !== 'function') return;
    // 取得できないときは黙ってウェルカムを出さない（接続診断は設定画面の役目で、ここで騒ぐと初回体験が壊れる）。
    void refresh().catch(() => { /* noop */ });
  }, [client, dismissed, refresh]);

  const loadSample = useCallback(async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await client.seedSampleData(scope);
      setSample(result);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }, [client, refresh]);

  function close(): void { setDismissed(true); dismissWelcome(); }

  // 投入直後はワークスペースが空でなくなるが、結果を読ませたいのでカードは残す。
  if (dismissed || progress === undefined) return null;
  if (sample === undefined && !shouldShowWelcome({ dismissed, progress })) return null;

  const steps = onboardingSteps(progress);
  const ratio = onboardingProgressRatio(progress);

  return <aside className="welcome-card" aria-label={text('Getting started', 'はじめかた')}>
    <header>
      <div><span className="eyebrow">{text('Welcome', 'ようこそ')}</span><h2>{text('Welcome to AgentBlume', 'AgentBlumeへようこそ')}</h2></div>
      <button type="button" className="ghost" aria-label={text('Close', '閉じる')} onClick={() => setDismissed(true)}>×</button>
    </header>
    <p className="welcome-lead">{text(
      'AgentBlume turns your own data into an AI agent you can talk to — no code. Connect data, wrap it in a Tool, assemble an Agent, then chat with it.',
      'AgentBlumeは、あなたのデータをコードなしで「話しかけられるAIエージェント」に変えるスタジオです。データをつなぎ、ツールにまとめ、エージェントを組み立てて、チャットで試します。',
    )}</p>

    {error !== undefined && <p className="api-error" role="alert">{error}</p>}

    {!progress.modelConfigured && <div className="welcome-priority">
      <strong>{text('Set the model first', 'まずモデルを設定してください')}</strong>
      <p>{text(
        'No model is saved for this workspace. Agents cannot answer until a model is configured (or the server environment default is in use).',
        'このワークスペースにはモデルが保存されていません。モデルを設定するまで（またはサーバー側の環境変数の既定を使わない限り）エージェントは応答できません。',
      )}</p>
      <button type="button" className="primary" onClick={() => navigate('Settings')}>{text('Open settings', '設定画面を開く')}</button>
    </div>}

    {sample === undefined ? <>
      <h3>{text('Pick a starting point', 'はじめかたを選ぶ')}</h3>
      <div className="welcome-choices">
        <button type="button" className="welcome-choice primary" disabled={busy} onClick={() => void loadSample()}>
          <strong>{busy ? text('Loading…', '読み込み中…') : text('Load the sample and try it', 'サンプルを読み込んで試す')}</strong>
          <small>{text('Adds a linked data source / Tool / Skill / Wiki / Agent set you can chat with right away.', 'データソース・ツール・スキル・Wiki・エージェントが繋がった一式を追加し、すぐチャットできます。')}</small>
        </button>
        <button type="button" className="welcome-choice" onClick={() => navigate('Data')}>
          <strong>{text('Start with my own data', '自分のデータで始める')}</strong>
          <small>{text('Upload a CSV or JSON file, or register a database connection.', 'CSV／JSONをアップロードするか、データベース接続を登録します。')}</small>
        </button>
        <button type="button" className="welcome-choice" onClick={() => navigate('Factory')}>
          <strong>{text('Generate one automatically', '自動生成で作る')}</strong>
          <small>{text('Describe a goal and let Agent Factory draft the Tools, Skills, and Agent.', 'やりたいことを書くと、Agent Factoryがツール・スキル・エージェントをdraftで生成します。')}</small>
        </button>
      </div>
    </> : <div className="welcome-sample-result" role="status">
      <strong>{sample.created > 0
        ? text(`Loaded the sample (${sample.created} new item(s)).`, `サンプルを読み込みました（新規${sample.created}件）。`)
        : text('The sample was already loaded — nothing changed.', 'サンプルは既に読み込み済みでした（変更はありません）。')}</strong>
      <p>{sampleSummaryLabel(sample, text)}</p>
      <ul className="welcome-sample-list">
        {sample.dataSources.map((name) => <li key={name}>{name}</li>)}
        {sample.agents.map((name) => <li key={name}>{name}</li>)}
      </ul>
      <div className="welcome-actions">
        <button type="button" className="primary" onClick={() => navigate('Chat')}>{text('Chat with the sample Agent', 'サンプルのエージェントと話す')}</button>
        <button type="button" className="secondary" onClick={() => navigate('Agent')}>{text('See how it is built', '中身を見る')}</button>
      </div>
    </div>}

    <h3>{text(`Progress ${ratio.done}/${ratio.total}`, `進捗 ${ratio.done}/${ratio.total}`)}</h3>
    <ol className="welcome-checklist">
      {steps.map((step) => <li key={step.id} className={step.done ? 'done' : ''}>
        <span className="welcome-check" aria-hidden="true">{step.done ? '✓' : '○'}</span>
        <button type="button" className="screen-link" onClick={() => navigate(step.screen)}>{stepLabel(step.id, text)}</button>
      </li>)}
    </ol>

    <button type="button" className="welcome-dismiss" onClick={close}>{text('Do not show this again', '今後表示しない')}</button>
  </aside>;
}
