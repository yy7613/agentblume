import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentKindDto, AgentPreviewRunDto, AgentSummaryDto, RunTraceEventDto, SerializedAgentDto, SideEffectDto, SkillSummaryDto, StructuredOutputFieldDto, StructuredOutputTypeDto, ToolSummaryDto, WikiSpaceSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';

type Translate = (english: string, japanese: string) => string;

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

export function AgentBuilder({ client }: { readonly client: ToolApiClient }) {
  // Layer 1: 保存済みAgent一覧。'list'が既定viewで、new/openでLayer 2（editor）へ遷移する。
  const [view, setView] = useState<'list' | 'editor'>('list');
  // editing=true は一覧からOpenした既存Agent。internalIdは別資産を分岐させてしまうため編集不可にする。
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [skills, setSkills] = useState<readonly SkillSummaryDto[]>([]);
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [wikis, setWikis] = useState<readonly WikiSpaceSummaryDto[]>([]);
  const [selectedWikis, setSelectedWikis] = useState<ReadonlySet<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<ReadonlySet<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(new Set());
  const [subAgents, setSubAgents] = useState<ReadonlyMap<string, string>>(new Map());
  const [subDefs, setSubDefs] = useState<ReadonlyMap<string, SerializedAgentDto>>(new Map());
  const [internalId, setInternalId] = useState('');
  const [workingName, setWorkingName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [publishName, setPublishName] = useState('');
  const [owner, setOwner] = useState('');
  const [kind, setKind] = useState<AgentKindDto>('normal');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [structuredOutput, setStructuredOutput] = useState(false);
  const [outputFields, setOutputFields] = useState<StructuredOutputFieldDto[]>([{ name: '', type: 'string', required: true }]);
  const [savedVersion, setSavedVersion] = useState<string>();
  const [chatMessage, setChatMessage] = useState('');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [busy, setBusy] = useState<'load' | 'generate' | 'save' | 'run'>();
  const [error, setError] = useState<string>();
  // 保存成功フィードバック（savedVersionはpreview実行のために残るため、通知は別stateで自動消去する）。
  const [saveNotice, setSaveNotice] = useState<string>();
  // 削除確認ダイアログの対象（対象名を文言へ入れるためsummaryごと保持する）。
  const [pendingDelete, setPendingDelete] = useState<AgentSummaryDto>();
  const { text, language } = useI18n();
  const dismissSaveNotice = useCallback(() => setSaveNotice(undefined), []);

  useEffect(() => {
    let active = true;
    setBusy('load');
    const wikiItems = typeof client.listWikis === 'function' ? client.listWikis(scope) : Promise.resolve([]);
    void Promise.all([client.listTools(scope), client.listSkills(scope), wikiItems]).then(([toolItems, skillItems, wikiSpaces]) => { if (active) { setTools(toolItems); setSkills(skillItems); setWikis(wikiSpaces); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, text)); })
      .finally(() => { if (active) setBusy(undefined); });
    return () => { active = false; };
  }, [client, text]);

  // 保存済みAgent一覧（Layer 1の一覧表示 兼 サブエージェント委譲候補）を読み込む。
  useEffect(() => {
    let active = true;
    void client.listAgents(scope).then((items) => { if (active) setAgents(items); }).catch((cause: unknown) => { if (active) setError(message(cause, text)); });
    return () => { active = false; };
  }, [client, text]);
  async function refreshAgents(): Promise<void> {
    try { setAgents(await client.listAgents(scope)); }
    catch (cause) { setError(message(cause, text)); }
  }

  const refs = useMemo(() => tools.filter((tool) => selectedTools.has(tool.internalId)).map((tool) => ({ internalId: tool.internalId, version: tool.latestVersion })), [selectedTools, tools]);
  const skillRefs = useMemo(() => skills.filter((skill) => selectedSkills.has(skill.internalId)).map((skill) => ({ internalId: skill.internalId, version: skill.latestVersion })), [selectedSkills, skills]);
  // 委譲候補は自分自身を除外する。usage は各サブ必須。
  const selectableAgents = useMemo(() => agents.filter((agent) => agent.internalId !== internalId), [agents, internalId]);
  const subAgentRefs = useMemo(() => selectableAgents.filter((agent) => subAgents.has(agent.internalId))
    .map((agent) => ({ internalId: agent.internalId, version: agent.latestVersion, usage: (subAgents.get(agent.internalId) ?? '').trim() })), [selectableAgents, subAgents]);
  const subAgentsValid = subAgentRefs.every((ref) => ref.usage !== '');

  // 実効副作用バッジ用: 選択サブから到達可能なAgent定義を取得する（近似・厳密値は保存時にサーバ検証）。
  useEffect(() => {
    if (subAgentRefs.length === 0) { setSubDefs(new Map()); return; }
    let active = true;
    void (async () => {
      const defs = new Map<string, SerializedAgentDto>();
      const queue = subAgentRefs.map((ref) => ref.internalId);
      const seen = new Set<string>();
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        try {
          const def = await client.getAgent(id, scope);
          defs.set(id, def);
          for (const sub of def.agents) if (!seen.has(sub.internalId)) queue.push(sub.internalId);
        } catch { /* 近似バッジ用途のため取得失敗は無視 */ }
      }
      if (active) setSubDefs(defs);
    })();
    return () => { active = false; };
  }, [subAgentRefs, client]);

  const effectiveSideEffect = useMemo<SideEffectDto | 'unknown'>(() => {
    const rank: Record<SideEffectDto, number> = { 'read-only': 0, 'session-write': 1, write: 2, 'external-action': 3 };
    const higher = (a: SideEffectDto, b: SideEffectDto): SideEffectDto => rank[a] >= rank[b] ? a : b;
    const toolEffect = (id: string): SideEffectDto => tools.find((tool) => tool.internalId === id)?.sideEffect ?? 'read-only';
    const visited = new Set<string>();
    const effectOf = (toolRefs: readonly { internalId: string }[], subRefs: readonly { internalId: string }[], depth: number): SideEffectDto | 'unknown' => {
      let effect: SideEffectDto = 'read-only';
      for (const ref of toolRefs) effect = higher(effect, toolEffect(ref.internalId));
      if (depth > 3) return effect;
      for (const ref of subRefs) {
        if (visited.has(ref.internalId)) continue;
        visited.add(ref.internalId);
        const def = subDefs.get(ref.internalId);
        if (def === undefined) return 'unknown';
        const nested = effectOf(def.tools, def.agents, depth + 1);
        if (nested === 'unknown') return 'unknown';
        effect = higher(effect, nested);
      }
      return effect;
    };
    return effectOf(refs, subAgentRefs, 0);
  }, [refs, subAgentRefs, tools, subDefs]);
  const output = useMemo(() => structuredOutput ? { name: responseFormatName(publishName), fields: outputFields } : undefined, [outputFields, publishName, structuredOutput]);
  const outputValid = !structuredOutput || (outputFields.length > 0 && outputFields.every((field) => field.name.trim() !== '') && new Set(outputFields.map((field) => field.name)).size === outputFields.length);
  // saveAgentのサーバー必須項目（min(1)）と保存ボタンの活性条件を一致させる。未充足項目はそのまま理由ヒントへ出す。
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (internalId.trim() === '') missing.push(text('Internal ID', '内部ID'));
    if (workingName.trim() === '') missing.push(text('Working name', '作業名'));
    if (displayName.trim() === '') missing.push(text('Display name', '表示名'));
    if (publishName.trim() === '') missing.push(text('Publish name', '公開名'));
    if (owner.trim() === '') missing.push(text('Owner', '所有者'));
    if (systemPrompt.trim() === '') missing.push(text('System prompt', 'システムプロンプト'));
    return missing;
  }, [internalId, workingName, displayName, publishName, owner, systemPrompt, text]);
  const missingRequiredLabel = missingRequired.join(language === 'ja' ? '、' : ', ');
  const saveBlocked = missingRequired.length > 0 || !outputValid || !subAgentsValid;

  function toggle(tool: ToolSummaryDto): void {
    const id = tool.internalId;
    setSelectedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSkill(skill: SkillSummaryDto): void {
    const id = skill.internalId;
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleWiki(wikiId: string): void {
    setSelectedWikis((current) => { const next = new Set(current); if (next.has(wikiId)) next.delete(wikiId); else next.add(wikiId); return next; });
  }

  function toggleSubAgent(agent: AgentSummaryDto): void {
    setSubAgents((current) => {
      const next = new Map(current);
      if (next.has(agent.internalId)) next.delete(agent.internalId); else next.set(agent.internalId, '');
      return next;
    });
  }

  function setSubAgentUsage(id: string, usage: string): void {
    setSubAgents((current) => { const next = new Map(current); next.set(id, usage); return next; });
  }

  async function generate(): Promise<void> {
    setBusy('generate'); setError(undefined);
    try {
      const draft = await client.generateAgentPrompt({ scope, displayName, kind, skills: skillRefs, tools: refs, agents: subAgentRefs, ...(output !== undefined ? { output } : {}) });
      setSystemPrompt(draft.systemPromptDraft);
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }

  async function save(): Promise<void> {
    setBusy('save'); setError(undefined); setSaveNotice(undefined);
    try {
      const agent = await client.saveAgent({ scope, internalId, workingName, displayName, publishName, owner, kind, systemPrompt, skills: skillRefs, tools: refs, agents: subAgentRefs, wikis: kind === 'pseudo-user' ? [] : [...selectedWikis].map((wikiId) => ({ wikiId })), ...(output !== undefined ? { output } : {}) });
      setSavedVersion(agent.metadata.version);
      setSaveNotice(text(`Saved · version ${agent.metadata.version}`, `保存しました バージョン ${agent.metadata.version}`));
    } catch (cause) { setError(message(cause, text)); }
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
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }

  function resetEditorState(): void {
    setInternalId(''); setWorkingName(''); setDisplayName(''); setPublishName(''); setOwner('');
    setKind('normal'); setSystemPrompt('');
    setSelectedTools(new Set()); setSelectedSkills(new Set()); setSelectedWikis(new Set()); setSubAgents(new Map());
    setStructuredOutput(false); setOutputFields([{ name: '', type: 'string', required: true }]);
    setSavedVersion(undefined); setChatMessage(''); setRun(undefined); setSaveNotice(undefined);
    setEditing(false);
  }
  function startNewAgent(): void { resetEditorState(); setError(undefined); setView('editor'); }
  async function backToList(): Promise<void> { setView('list'); await refreshAgents(); }
  async function openAgent(target: string): Promise<void> {
    setBusy('load'); setError(undefined);
    try {
      const agent = await client.getAgent(target, scope);
      populateEditorFromAgent(agent);
      setView('editor');
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }
  // 削除はConfirmDialogの確認後だけ実行する（一覧行のDeleteはpendingDeleteを立てるだけ）。
  async function removeAgent(target: string): Promise<void> {
    setBusy('load'); setError(undefined);
    try { await client.deleteAgent(target, scope); setPendingDelete(undefined); await refreshAgents(); }
    catch (cause) { setError(message(cause, text)); setPendingDelete(undefined); }
    finally { setBusy(undefined); }
  }
  // 一覧からOpenした保存済みAgentをeditor stateへ復元する。tool/skillの選択はinternalId基準で、
  // saveAgent実行時は常に現在のlatestVersionへ再pinされる（保存済みrefのversionをそのまま保持しない）。
  function populateEditorFromAgent(agent: SerializedAgentDto): void {
    setInternalId(agent.metadata.internalId);
    setWorkingName(agent.metadata.workingName);
    setDisplayName(agent.metadata.displayName);
    setPublishName(agent.metadata.publishName);
    setOwner(agent.metadata.owner);
    setKind(agent.kind);
    setSystemPrompt(agent.systemPrompt);
    setSelectedTools(new Set(agent.tools.map((ref) => ref.internalId)));
    setSelectedSkills(new Set(agent.skills.map((ref) => ref.internalId)));
    setSelectedWikis(new Set((agent.wikis ?? []).map((ref) => ref.wikiId)));
    setSubAgents(new Map(agent.agents.map((ref) => [ref.internalId, ref.usage])));
    if (agent.output !== undefined) { setStructuredOutput(true); setOutputFields([...agent.output.fields]); }
    else { setStructuredOutput(false); setOutputFields([{ name: '', type: 'string', required: true }]); }
    setSavedVersion(agent.metadata.version);
    setChatMessage(''); setRun(undefined); setSaveNotice(undefined);
    setEditing(true);
  }

  if (view === 'list') {
    return <main className="agent-builder agent-list-page">
      <header className="agent-builder-header">
        <div><span className="eyebrow">{text('Agent Builder', 'エージェントビルダー')}</span><h1>{text('Agents', 'エージェント一覧')}</h1><p>{text('Generate a system prompt from Skill and Tool metadata, then save the reviewed definition as a new version.', 'スキルとツールのメタデータからシステムプロンプトを生成し、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
        <div className="save-actions"><button type="button" className="primary" onClick={startNewAgent}>{text('New agent', '新規作成')}</button></div>
      </header>
      {error !== undefined && <div className="api-error">{error}</div>}
      <section className="workspace-card agent-list">
        {agents.length === 0 ? <p className="empty-state">{text('No agents yet.', 'エージェントはまだありません。')}</p> : <div className="agent-list-rows">{agents.map((item) => <article className="agent-list-row" key={item.internalId}>
          <div><strong>{item.displayName}</strong><code>{item.publishName}@{item.latestVersion}</code><small>{item.kind} · {item.state}</small></div>
          <div className="agent-list-actions">
            <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void openAgent(item.internalId)}>{text('Open', '開く')}</button>
            <button type="button" className="secondary danger" disabled={busy !== undefined} onClick={() => setPendingDelete(item)}>{text('Delete', '削除')}</button>
          </div>
        </article>)}</div>}
      </section>
      <ConfirmDialog open={pendingDelete !== undefined} title={text('Delete agent', 'エージェントを削除')}
        message={text(`Delete "${pendingDelete?.displayName ?? ''}"? It disappears from this list. Saved versions are kept in history.`, `「${pendingDelete?.displayName ?? ''}」を削除しますか？一覧から表示されなくなります（保存済みバージョンは履歴に残ります）。`)}
        confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} danger busy={busy !== undefined}
        onConfirm={() => { if (pendingDelete !== undefined) void removeAgent(pendingDelete.internalId); }} onCancel={() => setPendingDelete(undefined)} />
    </main>;
  }
  return <main className="agent-builder">
    <header className="agent-builder-header">
      <div><button type="button" className="secondary agent-back-button" onClick={() => void backToList()}>{text('Back to list', '一覧へ戻る')}</button><span className="eyebrow">{text('Agent Builder', 'エージェントビルダー')}</span><h1>{displayName || text('New Agent', '新しいエージェント')}</h1><p>{text('Generate a system prompt from Skill and Tool metadata, then save the reviewed definition as a new version.', 'スキルとツールのメタデータからシステムプロンプトを生成し、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
      <div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void generate()}>{busy === 'generate' ? text('Generating…', '生成中…') : text('Generate draft', '草案を生成')}</button>
        <button type="button" className="primary" disabled={busy !== undefined || saveBlocked} title={missingRequired.length > 0 ? text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`) : undefined} onClick={() => void save()}>{busy === 'save' ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
      </div>
    </header>
    {/* 保存ボタン近傍のフィードバック: 未充足の必須項目・Tool未選択の注意・保存成功。 */}
    <div className="agent-save-feedback">
      {missingRequired.length > 0 && <InlineFeedback kind="info">{text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`)}</InlineFeedback>}
      {!subAgentsValid && <InlineFeedback kind="info">{text('Every selected sub-agent needs a delegation usage.', '選択したサブエージェントには委譲基準の入力が必要です。')}</InlineFeedback>}
      {refs.length === 0 && <InlineFeedback kind="info">{text('No Tool is selected. This Agent cannot answer questions that need data.', 'ツールが選択されていません。データに関する質問には答えられません。')}</InlineFeedback>}
      {saveNotice !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={dismissSaveNotice}>{saveNotice}</InlineFeedback>}
    </div>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="agent-builder-grid">
      <section className="agent-definition-card">
        <h2>{text('Definition', '定義')}</h2>
        <div className="agent-fields">
          <label>{text('Internal ID', '内部ID')}<span className="required-mark">*</span><input aria-label={text('Agent internal ID', 'エージェント内部ID')} placeholder={text('e.g. support-agent', '例: support-agent')} value={internalId} readOnly={editing} title={editing ? text('Internal ID cannot change once saved (it would fork a new asset).', '保存済みの内部IDは変更できません（変更すると別資産になります）。') : undefined} onChange={(event) => { if (editing) return; setInternalId(event.target.value); }} /></label>
          <label>{text('Working name', '作業名')}<span className="required-mark">*</span><input aria-label={text('Working name', '作業名')} placeholder={text('e.g. Support agent draft', '例: サポートエージェントの下書き')} value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
          <label>{text('Display name', '表示名')}<span className="required-mark">*</span><input aria-label={text('Agent display name', 'エージェント表示名')} placeholder={text('e.g. Support Agent', '例: サポートエージェント')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label>{text('Publish name', '公開名')}<span className="required-mark">*</span><input aria-label={text('Publish name', '公開名')} placeholder={text('e.g. support_agent', '例: support_agent')} value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
          <label>{text('Owner', '所有者')}<span className="required-mark">*</span><input aria-label={text('Owner', '所有者')} placeholder={text('e.g. team@example.com', '例: team@example.com')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <label>{text('Kind', '種別')}<select aria-label={text('Agent kind', 'エージェント種別')} value={kind} onChange={(event) => setKind(event.target.value as AgentKindDto)}><option value="normal">{text('Normal', '通常')}</option><option value="pseudo-user">{text('Pseudo user', '疑似ユーザー')}</option><option value="evaluator">{text('Evaluator', '評価者')}</option></select></label>
        </div>
        <h2>{text('Skills', 'スキル')} <small>{skillRefs.length} {text('selected', '件選択')}</small></h2>
        {/* 選択行の種別バッジ: Skill / Tool / サブエージェント / Wiki を取り違えないようにする。 */}
        <div className="agent-tool-list">
          {busy !== 'load' && skills.length === 0 && <p className="empty-state">{text('No saved Skills yet.', '保存済みスキルがありません。')}</p>}
          {skills.map((skill) => <label key={key(skill)} className="agent-tool-option"><input type="checkbox" checked={selectedSkills.has(skill.internalId)} onChange={() => toggleSkill(skill)} /><span><strong>{skill.displayName}</strong><code>{skill.publishName}@{skill.latestVersion}</code></span><small className="validation-status">{text('Skill', 'スキル')}</small><small>{skill.state}</small></label>)}
        </div>
        <h2>{text('Tools', 'ツール')} <small>{refs.length} {text('selected', '件選択')}</small></h2>
        <div className="agent-tool-list">
          {busy === 'load' && <p className="empty-state">{text('Loading tools…', 'ツールを読み込み中…')}</p>}
          {busy !== 'load' && tools.length === 0 && <p className="empty-state">{text('No saved Tools yet.', '保存済みツールがありません。')}</p>}
          {tools.map((tool) => <label key={key(tool)} className="agent-tool-option"><input type="checkbox" checked={selectedTools.has(tool.internalId)} onChange={() => toggle(tool)} /><span><strong>{tool.displayName}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small className="validation-status">{text('Tool', 'ツール')}</small><small>{tool.state}</small></label>)}
        </div>
        <h2>{text('Sub-agents', 'サブエージェント')} <small>{subAgentRefs.length} {text('selected', '件選択')}</small></h2>
        <p className="agent-subagent-hint">{text('Delegated as an ask_<name> tool. The effective side-effect is validated on save.', 'ask_<名前> ツールとして委譲されます。実効副作用は保存時に検証されます。')}</p>
        {subAgentRefs.length > 0 && <p className="agent-effect">{text('Effective side-effect', '実効副作用')}: <span className={`validation-status ${effectiveSideEffect === 'read-only' ? 'good' : effectiveSideEffect === 'unknown' ? '' : 'bad'}`}>{effectiveSideEffect === 'unknown' ? text('estimating…', '推定中…') : effectiveSideEffect}</span> <small>{text('approx · preview requires read-only', '概算・previewはread-only必須')}</small></p>}
        <div className="agent-tool-list">
          {selectableAgents.length === 0 && <p className="empty-state">{text('No other saved Agents to delegate to.', '委譲できる他の保存済みエージェントがありません。')}</p>}
          {selectableAgents.map((agent) => {
            const selected = subAgents.has(agent.internalId);
            return <div key={agent.internalId} className="agent-subagent-option">
              <label className="agent-tool-option"><input type="checkbox" checked={selected} onChange={() => toggleSubAgent(agent)} /><span><strong>{agent.displayName}</strong><code>ask_{agent.publishName}@{agent.latestVersion}</code></span><small className="validation-status">{text('Sub-agent', 'サブエージェント')}</small><small>{agent.kind}</small></label>
              {selected && <input className="subagent-usage" aria-label={`${text('Delegation usage for', '委譲基準:')} ${agent.displayName}`} placeholder={text('When should work be delegated here?', 'どんな時にここへ委譲する？')} value={subAgents.get(agent.internalId) ?? ''} onChange={(event) => setSubAgentUsage(agent.internalId, event.target.value)} />}
            </div>;
          })}
        </div>
        <h2>{text('Wikis', 'Wiki')} <small>{selectedWikis.size} {text('selected', '件選択')}</small></h2>
        <p className="agent-subagent-hint">{text('Only pages from the selected Wikis can be retrieved during execution.', '実行時に参照できるのは選択したWiki内のページだけです。')}</p>
        <div className="agent-tool-list">
          {wikis.length === 0 && <p className="empty-state">{text('Create Wikis in Memory first.', '先に記憶画面でWikiを作成してください。')}</p>}
          {wikis.map((wiki) => <label key={wiki.id} className="agent-tool-option"><input aria-label={`${text('Use wiki', 'Wikiを使用')} ${wiki.name}`} type="checkbox" disabled={kind === 'pseudo-user'} checked={selectedWikis.has(wiki.id)} onChange={() => toggleWiki(wiki.id)} /><span><strong>{wiki.name}</strong><code>{wiki.id}</code></span><small className="validation-status">Wiki</small><small>{wiki.description}</small></label>)}
        </div>
        <h2>{text('Structured output', '構造化出力')}</h2>
        <label className="structured-output-toggle"><input aria-label={text('Enable structured output', '構造化出力を有効化')} type="checkbox" checked={structuredOutput} onChange={(event) => setStructuredOutput(event.target.checked)} /> {text('Require a validated JSON response', '検証済みJSON応答を必須にする')}</label>
        {structuredOutput && <div className="structured-output-fields">
          {outputFields.map((field, index) => <div className="structured-output-field" key={index}>
            <input aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('name', '名前')}`} placeholder={text('e.g. answer', '例: answer')} value={field.name} onChange={(event) => updateOutputField(index, { name: event.target.value })} />
            <select aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('type', '型')}`} value={field.type} onChange={(event) => updateOutputField(index, { type: event.target.value as StructuredOutputTypeDto })}><option>string</option><option>number</option><option>integer</option><option>boolean</option></select>
            <label><input aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('required', '必須')}`} type="checkbox" checked={field.required} onChange={(event) => updateOutputField(index, { required: event.target.checked })} /> {text('required', '必須')}</label>
            <button aria-label={`${text('Remove output field', '出力フィールドを削除')} ${index + 1}`} type="button" className="secondary" disabled={outputFields.length === 1} onClick={() => setOutputFields((fields) => fields.filter((_, fieldIndex) => fieldIndex !== index))}>×</button>
          </div>)}
          <button type="button" className="secondary" onClick={() => setOutputFields((fields) => [...fields, { name: `field_${fields.length + 1}`, type: 'string', required: true }])}>{text('Add output field', '出力フィールドを追加')}</button>
          {!outputValid && <p className="field-error">{text('Field names must be non-empty and unique.', 'フィールド名は空にできず、重複も許可されません。')}</p>}
        </div>}
      </section>
      <section className="prompt-editor-card">
        <div className="panel-title"><div><span className="eyebrow">{text('Editable escape hatch', '編集可能')}</span><h2>{text('System prompt', 'システムプロンプト')}<span className="required-mark">*</span></h2></div><span className="version-chip">{systemPrompt.length} {text('chars', '文字')}</span></div>
        <textarea aria-label={text('System prompt', 'システムプロンプト')} rows={28} placeholder={text('Describe the Agent role, boundaries, and response style.', 'エージェントの役割、制約、応答スタイルを記述します。')} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
        <p>{text('Generating a draft does not save it. Review and edit the draft before saving a version.', '草案の生成だけでは保存されません。内容をレビュー・編集してからバージョンを保存してください。')}</p>
        <div className="agent-run-panel">
          <div className="panel-title"><div><span className="eyebrow">{text('Saved Agent preview', '保存済みエージェントのプレビュー')}</span><h2>{text('Chat', 'チャット')}</h2></div><span className="version-chip">{savedVersion === undefined ? text('Save first', '先に保存してください') : `Agent v${savedVersion}`}</span></div>
          <div className="chat-compose"><textarea aria-label={text('Agent chat message', 'エージェントへのメッセージ')} rows={2} placeholder={text('Ask the saved Agent…', '保存済みエージェントに質問…')} value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} /><button type="button" className="primary" disabled={savedVersion === undefined || busy !== undefined || chatMessage.trim() === ''} onClick={() => void runSaved()}>{busy === 'run' ? text('Running…', '実行中…') : text('Run saved agent', '保存済みエージェントを実行')}</button></div>
          {run !== undefined && <><div className="chat-response"><span>{text('Assistant', 'アシスタント')}</span>{run.structuredResponse === undefined ? <p>{run.response}</p> : <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>}</div><div className="trace-list"><strong>{text('Trace', 'トレース')} · {run.runId}</strong>{run.trace.map((event) => {
            // 種別だけでは原因が分からないため、error/tool/委譲イベントは実メッセージも併記する。
            const detail = traceDetail(event, text);
            return <div className={`trace-event ${event.kind === 'tool-call' || event.kind === 'tool-result' ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind}</p>{detail !== undefined && <small className={event.kind === 'error' ? 'field-error' : undefined}>{detail}</small>}</div>;
          })}</div></>}
        </div>
      </section>
    </div>
  </main>;
}

function key(item: ToolSummaryDto | SkillSummaryDto): string { return `${item.internalId}@${item.latestVersion}`; }
function message(cause: unknown, text: Translate): string { return cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'); }
// トレース行の詳細文言。model-request/model-responseは本文をチャット側で表示するため重複させない。
function traceDetail(event: RunTraceEventDto, text: Translate): string | undefined {
  switch (event.kind) {
    case 'error': return `${event.code}: ${event.message}`;
    case 'tool-call': return `${text('tool', 'ツール')}: ${event.name}`;
    case 'tool-result': return `${text('tool', 'ツール')}: ${event.name}`;
    case 'agent_call': return `${event.toolName}${event.summary === '' ? '' : ` · ${event.summary}`}`;
    default: return undefined;
  }
}
function responseFormatName(publishName: string): string {
  const normalized = `${publishName}_response`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return normalized === '' ? 'agent_response' : normalized;
}
