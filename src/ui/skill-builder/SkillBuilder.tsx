import { useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

/**
 * SkillはAgentへ「名前・説明・内容」だけを渡す軽量なコンテキストとする。
 * 既存の保存契約に残る詳細項目は、説明と内容から後方互換用に導出する。
 */
export function SkillBuilder({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [internalId, setInternalId] = useState(''); const [workingName, setWorkingName] = useState('');
  const [displayName, setDisplayName] = useState(''); const [publishName, setPublishName] = useState(''); const [owner, setOwner] = useState('');
  const [description, setDescription] = useState(''); const [instructions, setInstructions] = useState('');
  const [savedVersion, setSavedVersion] = useState<string>(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();

  async function save() {
    setBusy(true); setError(undefined);
    try {
      const skill = await client.saveSkill({
        scope, internalId, workingName, displayName, publishName, owner,
        // 現行バックエンドの詳細フィールドはUIへ露出せず、ユーザー記述をそのまま基にする。
        responsibility: description, activationCondition: description,
        inputDescription: text('See skill content.', 'スキル内容を参照。'), outputDescription: text('Follow skill content.', 'スキル内容に従う。'),
        instructions, tools: [],
      });
      setSavedVersion(skill.metadata.version);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  return <main className="agent-builder skill-builder">
    <header className="agent-builder-header">
      <div><span className="eyebrow">{text('Skill Builder', 'スキルビルダー')}</span><h1>{displayName || text('New Skill', '新しいスキル')}</h1><p>{text('Create a lightweight Agent context with a name, description, and content.', 'スキル名・説明・内容だけで、軽量なエージェント向けコンテキストを作成します。')}</p></div>
      <div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <button className="primary" type="button" disabled={busy || description.trim() === '' || instructions.trim() === ''} onClick={() => void save()}>{text('Save version', 'バージョンを保存')}</button>
      </div>
    </header>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="agent-builder-grid">
      <div className="skill-definition-stack">
        <section className="agent-definition-card skill-save-settings" aria-label={text('Save settings', '保存設定')}>
          <div className="panel-title"><div><span className="eyebrow">{text('Stored definition', '保存する定義')}</span><h2>{text('Save settings', '保存設定')}</h2></div></div>
          <p>{text('These fields identify and version the Skill. They are not Agent instructions.', 'ここはスキルを識別・バージョン保存するための項目です。エージェントへの指示には使いません。')}</p>
          <div className="agent-fields">
            <label>{text('Internal ID', '内部ID')}<input aria-label={text('Skill internal ID', 'スキル内部ID')} placeholder={text('e.g. data-analysis', '例: data-analysis')} value={internalId} onChange={(event) => setInternalId(event.target.value)} /></label>
            <label>{text('Working name', '作業名')}<input aria-label={text('Skill working name', 'スキル作業名')} placeholder={text('e.g. Data analysis draft', '例: データ分析の下書き')} value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
            <label>{text('Skill name', 'スキル名')}<input aria-label={text('Skill display name', 'スキル名')} placeholder={text('e.g. Data analysis', '例: データ分析')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label>{text('Publish name', '公開名')}<input aria-label={text('Skill publish name', 'スキル公開名')} placeholder={text('e.g. data_analysis', '例: data_analysis')} value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
            <label>{text('Owner', '所有者')}<input aria-label={text('Skill owner', 'スキル所有者')} placeholder={text('e.g. team@example.com', '例: team@example.com')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          </div>
        </section>

        <section className="agent-definition-card skill-agent-context" aria-label={text('Agent context', 'エージェントへのコンテキスト')}>
          <div className="panel-title"><div><span className="eyebrow">{text('Sent to Agent', 'エージェントに渡す情報')}</span><h2>{text('Description', '説明')}</h2></div></div>
          <p>{text('Describe when and why an Agent should use this Skill. Put any detailed rules in the content.', 'エージェントがこのスキルをいつ・なぜ使うかを記述します。細かなルールは内容へ自由に記述してください。')}</p>
          <label>{text('Skill description', 'スキルの説明')}<textarea aria-label={text('Skill description', 'スキルの説明')} rows={7} placeholder={text('e.g. Analyze tabular data and explain the result to the user.', '例: 表形式データを分析し、結果を利用者に分かりやすく説明する。')} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        </section>
      </div>

      <section className="prompt-editor-card skill-instructions" aria-label={text('Skill content editor', 'スキル内容エディター')}>
        <div className="panel-title"><div><span className="eyebrow">{text('Sent to Agent', 'エージェントに渡す情報')}</span><h2>{text('Skill content', 'スキル内容')}</h2></div><span className="version-chip">{instructions.length} {text('chars', '文字')}</span></div>
        <p>{text('Write any instructions, format, constraints, or examples needed by the Agent. The structure is entirely up to you.', 'エージェントに必要な指示、形式、制約、例を自由に記述します。内容の構造はユーザーに委ねます。')}</p>
        <textarea aria-label={text('Skill content', 'スキル内容')} rows={34} placeholder={text('Write the content the Agent should follow.', 'エージェントに渡す内容を記述します。')} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </section>
    </div>
  </main>;
}

function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Request failed'; }
