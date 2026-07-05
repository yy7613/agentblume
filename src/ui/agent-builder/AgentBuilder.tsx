import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentKindDto, AgentPreviewRunDto, SkillSummaryDto, StructuredOutputFieldDto, StructuredOutputTypeDto, ToolSummaryDto } from '../api/types';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

export function AgentBuilder({ client }: { readonly client: ToolApiClient }) {
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [skills, setSkills] = useState<readonly SkillSummaryDto[]>([]);
  const [selectedTools, setSelectedTools] = useState<ReadonlySet<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(new Set());
  const [internalId, setInternalId] = useState('assistant-agent');
  const [workingName, setWorkingName] = useState('Assistant Agent');
  const [displayName, setDisplayName] = useState('Assistant Agent');
  const [publishName, setPublishName] = useState('assistant_agent');
  const [owner, setOwner] = useState('local-user');
  const [kind, setKind] = useState<AgentKindDto>('normal');
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful assistant.');
  const [structuredOutput, setStructuredOutput] = useState(false);
  const [outputFields, setOutputFields] = useState<StructuredOutputFieldDto[]>([{ name: 'answer', type: 'string', required: true }]);
  const [savedVersion, setSavedVersion] = useState<string>();
  const [chatMessage, setChatMessage] = useState('Use the available tools and explain the result.');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [busy, setBusy] = useState<'load' | 'generate' | 'save' | 'run'>();
  const [error, setError] = useState<string>();
  const { text } = useI18n();

  useEffect(() => {
    let active = true;
    setBusy('load');
    void Promise.all([client.listTools(scope), client.listSkills(scope)]).then(([toolItems, skillItems]) => { if (active) { setTools(toolItems); setSkills(skillItems); } })
      .catch((cause: unknown) => { if (active) setError(message(cause)); })
      .finally(() => { if (active) setBusy(undefined); });
    return () => { active = false; };
  }, [client]);

  const refs = useMemo(() => tools.filter((tool) => selectedTools.has(key(tool))).map((tool) => ({ internalId: tool.internalId, version: tool.latestVersion })), [selectedTools, tools]);
  const skillRefs = useMemo(() => skills.filter((skill) => selectedSkills.has(key(skill))).map((skill) => ({ internalId: skill.internalId, version: skill.latestVersion })), [selectedSkills, skills]);
  const output = useMemo(() => structuredOutput ? { name: responseFormatName(publishName), fields: outputFields } : undefined, [outputFields, publishName, structuredOutput]);
  const outputValid = !structuredOutput || (outputFields.length > 0 && outputFields.every((field) => field.name.trim() !== '') && new Set(outputFields.map((field) => field.name)).size === outputFields.length);

  function toggle(tool: ToolSummaryDto): void {
    const id = key(tool);
    setSelectedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSkill(skill: SkillSummaryDto): void {
    const id = key(skill);
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function generate(): Promise<void> {
    setBusy('generate'); setError(undefined);
    try {
      const draft = await client.generateAgentPrompt({ scope, displayName, kind, skills: skillRefs, tools: refs, ...(output !== undefined ? { output } : {}) });
      setSystemPrompt(draft.systemPromptDraft);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  async function save(): Promise<void> {
    setBusy('save'); setError(undefined);
    try {
      const agent = await client.saveAgent({ scope, internalId, workingName, displayName, publishName, owner, kind, systemPrompt, skills: skillRefs, tools: refs, ...(output !== undefined ? { output } : {}) });
      setSavedVersion(agent.metadata.version);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  function updateOutputField(index: number, patch: Partial<StructuredOutputFieldDto>): void {
    setOutputFields((fields) => fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  }

  async function runSaved(): Promise<void> {
    if (savedVersion === undefined || chatMessage.trim() === '') return;
    setBusy('run'); setError(undefined); setRun(undefined);
    try {
      setRun(await client.runSavedAgent({
        scope,
        agent: { internalId, version: savedVersion },
        message: chatMessage,
        mode: 'preview',
      }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  return <main className="agent-builder">
    <header className="agent-builder-header">
      <div><span className="eyebrow">{text('Agent Builder', 'エージェントビルダー')}</span><h1>{displayName}</h1><p>{text('Generate a system prompt from Skill and Tool metadata, then save the reviewed definition as a new version.', 'スキルとツールのメタデータからシステムプロンプトを生成し、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
      <div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void generate()}>{busy === 'generate' ? text('Generating…', '生成中…') : text('Generate draft', '草案を生成')}</button>
        <button type="button" className="primary" disabled={busy !== undefined || systemPrompt.trim() === '' || !outputValid} onClick={() => void save()}>{busy === 'save' ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
      </div>
    </header>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="agent-builder-grid">
      <section className="agent-definition-card">
        <h2>{text('Definition', '定義')}</h2>
        <div className="agent-fields">
          <label>{text('Internal ID', '内部ID')}<input aria-label={text('Agent internal ID', 'エージェント内部ID')} value={internalId} onChange={(event) => setInternalId(event.target.value)} /></label>
          <label>{text('Working name', '作業名')}<input value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
          <label>{text('Display name', '表示名')}<input aria-label={text('Agent display name', 'エージェント表示名')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label>{text('Publish name', '公開名')}<input value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
          <label>{text('Owner', '所有者')}<input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <label>{text('Kind', '種別')}<select aria-label={text('Agent kind', 'エージェント種別')} value={kind} onChange={(event) => setKind(event.target.value as AgentKindDto)}><option value="normal">{text('Normal', '通常')}</option><option value="pseudo-user">{text('Pseudo user', '疑似ユーザー')}</option><option value="evaluator">{text('Evaluator', '評価者')}</option></select></label>
        </div>
        <h2>{text('Skills', 'スキル')} <small>{skillRefs.length} {text('selected', '件選択')}</small></h2>
        <div className="agent-tool-list">
          {busy !== 'load' && skills.length === 0 && <p className="empty-state">保存済みSkillがありません。</p>}
          {skills.map((skill) => <label key={key(skill)} className="agent-tool-option"><input type="checkbox" checked={selectedSkills.has(key(skill))} onChange={() => toggleSkill(skill)} /><span><strong>{skill.displayName}</strong><code>{skill.publishName}@{skill.latestVersion}</code></span><small>{skill.state}</small></label>)}
        </div>
        <h2>{text('Tools', 'ツール')} <small>{refs.length} {text('selected', '件選択')}</small></h2>
        <div className="agent-tool-list">
          {busy === 'load' && <p className="empty-state">{text('Loading tools…', 'ツールを読み込み中…')}</p>}
          {busy !== 'load' && tools.length === 0 && <p className="empty-state">保存済みToolがありません。</p>}
          {tools.map((tool) => <label key={key(tool)} className="agent-tool-option"><input type="checkbox" checked={selectedTools.has(key(tool))} onChange={() => toggle(tool)} /><span><strong>{tool.displayName}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small>{tool.state}</small></label>)}
        </div>
        <h2>{text('Structured output', '構造化出力')}</h2>
        <label className="structured-output-toggle"><input aria-label={text('Enable structured output', '構造化出力を有効化')} type="checkbox" checked={structuredOutput} onChange={(event) => setStructuredOutput(event.target.checked)} /> {text('Require a validated JSON response', '検証済みJSON応答を必須にする')}</label>
        {structuredOutput && <div className="structured-output-fields">
          {outputFields.map((field, index) => <div className="structured-output-field" key={index}>
            <input aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('name', '名前')}`} value={field.name} onChange={(event) => updateOutputField(index, { name: event.target.value })} />
            <select aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('type', '型')}`} value={field.type} onChange={(event) => updateOutputField(index, { type: event.target.value as StructuredOutputTypeDto })}><option>string</option><option>number</option><option>integer</option><option>boolean</option></select>
            <label><input aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('required', '必須')}`} type="checkbox" checked={field.required} onChange={(event) => updateOutputField(index, { required: event.target.checked })} /> {text('required', '必須')}</label>
            <button aria-label={`${text('Remove output field', '出力フィールドを削除')} ${index + 1}`} type="button" className="secondary" disabled={outputFields.length === 1} onClick={() => setOutputFields((fields) => fields.filter((_, fieldIndex) => fieldIndex !== index))}>×</button>
          </div>)}
          <button type="button" className="secondary" onClick={() => setOutputFields((fields) => [...fields, { name: `field_${fields.length + 1}`, type: 'string', required: true }])}>{text('Add output field', '出力フィールドを追加')}</button>
          {!outputValid && <p className="field-error">{text('Field names must be non-empty and unique.', 'フィールド名は空にできず、重複も許可されません。')}</p>}
        </div>}
      </section>
      <section className="prompt-editor-card">
        <div className="panel-title"><div><span className="eyebrow">{text('Editable escape hatch', '編集可能')}</span><h2>{text('System prompt', 'システムプロンプト')}</h2></div><span className="version-chip">{systemPrompt.length} {text('chars', '文字')}</span></div>
        <textarea aria-label={text('System prompt', 'システムプロンプト')} rows={28} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
        <p>{text('Generating a draft does not save it. Review and edit the draft before saving a version.', '草案の生成だけでは保存されません。内容をレビュー・編集してからバージョンを保存してください。')}</p>
        <div className="agent-run-panel">
          <div className="panel-title"><div><span className="eyebrow">{text('Saved Agent preview', '保存済みエージェントのプレビュー')}</span><h2>{text('Chat', 'チャット')}</h2></div><span className="version-chip">{savedVersion === undefined ? text('Save first', '先に保存してください') : `Agent v${savedVersion}`}</span></div>
          <div className="chat-compose"><textarea aria-label={text('Agent chat message', 'エージェントへのメッセージ')} rows={2} value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} /><button type="button" className="primary" disabled={savedVersion === undefined || busy !== undefined || chatMessage.trim() === ''} onClick={() => void runSaved()}>{busy === 'run' ? text('Running…', '実行中…') : text('Run saved agent', '保存済みエージェントを実行')}</button></div>
          {run !== undefined && <><div className="chat-response"><span>{text('Assistant', 'アシスタント')}</span>{run.structuredResponse === undefined ? <p>{run.response}</p> : <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>}</div><div className="trace-list"><strong>{text('Trace', 'トレース')} · {run.runId}</strong>{run.trace.map((event) => <div className={`trace-event ${event.kind === 'tool-call' || event.kind === 'tool-result' ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind}</p></div>)}</div></>}
        </div>
      </section>
    </div>
  </main>;
}

function key(item: ToolSummaryDto | SkillSummaryDto): string { return `${item.internalId}@${item.latestVersion}`; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
function responseFormatName(publishName: string): string {
  const normalized = `${publishName}_response`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return normalized === '' ? 'agent_response' : normalized;
}
