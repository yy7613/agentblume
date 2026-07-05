import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type {
  PersonaArchetypeDto, PersonaLanguageDto, PersonaLevelDto, PersonaSummaryDto, PersonaVerbosityDto, TenantScopeDto,
} from '../api/types';
import { useI18n } from '../i18n';

const ARCHETYPES: readonly PersonaArchetypeDto[] = ['novice', 'expert', 'busy', 'vague', 'skeptical', 'custom'];
const LEVELS: readonly PersonaLevelDto[] = ['low', 'mid', 'high'];
const VERBOSITIES: readonly PersonaVerbosityDto[] = ['terse', 'normal', 'chatty'];
const LANGUAGES: readonly PersonaLanguageDto[] = ['ja', 'en'];

export function PersonasTab({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  const [personas, setPersonas] = useState<readonly PersonaSummaryDto[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [internalId, setInternalId] = useState('novice-user');
  const [workingName, setWorkingName] = useState('Novice user draft');
  const [displayName, setDisplayName] = useState('Novice user');
  const [publishName, setPublishName] = useState('novice_user');
  const [owner, setOwner] = useState('local-user');
  const [archetype, setArchetype] = useState<PersonaArchetypeDto>('novice');
  const [knowledgeLevel, setKnowledgeLevel] = useState<PersonaLevelDto>('low');
  const [patience, setPatience] = useState<PersonaLevelDto>('mid');
  const [tone, setTone] = useState('polite');
  const [verbosity, setVerbosity] = useState<PersonaVerbosityDto>('normal');
  const [language, setLanguage] = useState<PersonaLanguageDto>('ja');
  const [extraInstructions, setExtraInstructions] = useState('');
  const [promptOverride, setPromptOverride] = useState('');
  const [bump, setBump] = useState<'major' | 'minor' | 'patch'>('patch');
  const [savedVersion, setSavedVersion] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void client.listPersonas(scope).then((items) => { if (active) setPersonas(items); })
      .catch((cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [client, scope]);

  async function edit(summary: PersonaSummaryDto): Promise<void> {
    setError(undefined); setSavedVersion(undefined);
    try {
      const persona = await client.getPersona(summary.internalId, scope);
      setEditingId(persona.metadata.internalId);
      setInternalId(persona.metadata.internalId); setWorkingName(persona.metadata.workingName);
      setDisplayName(persona.metadata.displayName); setPublishName(persona.metadata.publishName); setOwner(persona.metadata.owner);
      setArchetype(persona.archetype); setKnowledgeLevel(persona.knowledgeLevel); setPatience(persona.patience);
      setTone(persona.tone); setVerbosity(persona.verbosity); setLanguage(persona.language);
      setExtraInstructions(persona.extraInstructions ?? ''); setPromptOverride(persona.promptOverride ?? '');
    } catch (cause) { setError(message(cause)); }
  }

  function startNew(): void {
    setEditingId(undefined); setSavedVersion(undefined);
    setInternalId(''); setWorkingName(''); setDisplayName(''); setPublishName(''); setOwner('local-user');
    setArchetype('novice'); setKnowledgeLevel('low'); setPatience('mid'); setTone('polite'); setVerbosity('normal'); setLanguage('ja');
    setExtraInstructions(''); setPromptOverride('');
  }

  async function save(): Promise<void> {
    setBusy(true); setError(undefined);
    try {
      const persona = await client.savePersona({
        scope, internalId, workingName, displayName, publishName, owner,
        archetype, knowledgeLevel, patience, tone, verbosity, language,
        ...(extraInstructions.trim() !== '' ? { extraInstructions } : {}),
        ...(promptOverride.trim() !== '' ? { promptOverride } : {}),
        bump,
      });
      setSavedVersion(persona.metadata.version);
      setEditingId(persona.metadata.internalId);
      setPersonas(await client.listPersonas(scope));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const valid = internalId.trim() !== '' && workingName.trim() !== '' && displayName.trim() !== '' && publishName.trim() !== '' && owner.trim() !== '' && tone.trim() !== '';

  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <div className="two-column-workspace">
    <section className="workspace-card" aria-label={text('Persona list', 'ペルソナ一覧')}>
      <div className="panel-title"><h2>{text('Personas', 'ペルソナ')}</h2><button type="button" className="secondary" onClick={startNew}>{text('New persona', '新規ペルソナ')}</button></div>
      <div className="validation-list">
        {personas.length === 0 && <p className="empty-state">{text('No saved personas.', '保存済みペルソナはありません。')}</p>}
        {personas.map((persona) => <button type="button" key={persona.internalId} className={persona.internalId === editingId ? 'selected' : ''} onClick={() => void edit(persona)}>
          <span className="archetype-badge">{persona.archetype}</span><strong>{persona.displayName}</strong><span className="version-chip">{persona.latestVersion}</span>
        </button>)}
      </div>
    </section>
    <section className="workspace-card" aria-label={text('Persona form', 'ペルソナフォーム')}>
      <div className="panel-title"><h2>{editingId === undefined ? text('New persona', '新規ペルソナ') : text('Edit persona', 'ペルソナを編集')}</h2><div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <select aria-label={text('Persona version bump', 'ペルソナのバージョン更新種別')} value={bump} onChange={(event) => setBump(event.target.value as typeof bump)}><option value="patch">patch</option><option value="minor">minor</option><option value="major">major</option></select>
        <button type="button" className="primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
      </div></div>
      <div className="agent-fields">
        <label>{text('Internal ID', '内部ID')}<input aria-label={text('Persona internal ID', 'ペルソナ内部ID')} value={internalId} onChange={(event) => setInternalId(event.target.value)} /></label>
        <label>{text('Working name', '作業名')}<input aria-label={text('Persona working name', 'ペルソナ作業名')} value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
        <label>{text('Display name', '表示名')}<input aria-label={text('Persona display name', 'ペルソナ表示名')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>{text('Publish name', '公開名')}<input aria-label={text('Persona publish name', 'ペルソナ公開名')} value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
        <label>{text('Owner', '所有者')}<input aria-label={text('Persona owner', 'ペルソナ所有者')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
        <label>{text('Archetype', '種別')}<select aria-label={text('Persona archetype', 'ペルソナ種別')} value={archetype} onChange={(event) => setArchetype(event.target.value as PersonaArchetypeDto)}>{ARCHETYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{text('Knowledge level', '知識レベル')}<select aria-label={text('Persona knowledge level', 'ペルソナ知識レベル')} value={knowledgeLevel} onChange={(event) => setKnowledgeLevel(event.target.value as PersonaLevelDto)}>{LEVELS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{text('Patience', '忍耐力')}<select aria-label={text('Persona patience', 'ペルソナ忍耐力')} value={patience} onChange={(event) => setPatience(event.target.value as PersonaLevelDto)}>{LEVELS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{text('Tone', '口調')}<input aria-label={text('Persona tone', 'ペルソナ口調')} value={tone} onChange={(event) => setTone(event.target.value)} /></label>
        <label>{text('Verbosity', '発話量')}<select aria-label={text('Persona verbosity', 'ペルソナ発話量')} value={verbosity} onChange={(event) => setVerbosity(event.target.value as PersonaVerbosityDto)}>{VERBOSITIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{text('Language', '言語')}<select aria-label={text('Persona language', 'ペルソナ言語')} value={language} onChange={(event) => setLanguage(event.target.value as PersonaLanguageDto)}>{LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      </div>
      <label>{text('Extra instructions', '追加の人物設定')}<textarea aria-label={text('Persona extra instructions', 'ペルソナ追加指示')} rows={3} value={extraInstructions} onChange={(event) => setExtraInstructions(event.target.value)} /></label>
      <label>{text('Prompt override', 'プロンプト上書き')}<textarea aria-label={text('Persona prompt override', 'ペルソナプロンプト上書き')} rows={7} placeholder={text('Leave empty to use the generated prompt', '空のままにすると生成プロンプトを使用します')} value={promptOverride} onChange={(event) => setPromptOverride(event.target.value)} /></label>
      <p className="empty-state">{text(
        'When left empty, the pseudo-user system prompt is generated deterministically on the server from the archetype and attributes at run time. Fill this field only to replace the generated prompt entirely.',
        '空の場合、疑似ユーザーのシステムプロンプトは実行時に種別と属性からサーバー側で決定的に生成されます。生成プロンプトを完全に置き換えたい場合のみ入力してください。',
      )}</p>
    </section>
    </div>
  </>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
