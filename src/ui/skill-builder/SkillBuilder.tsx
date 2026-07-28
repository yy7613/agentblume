import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { SerializedSkillDto, SkillSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DraftRestoreBanner } from '../components/DraftRestoreBanner';
import { InlineFeedback } from '../components/InlineFeedback';
import { draftKey, useDraftPersistence } from '../hooks/useDraftPersistence';
import { useReportUnsavedChanges } from '../unsaved-changes';
import { useI18n } from '../i18n';
import { scope } from '../scope';

type Translate = (english: string, japanese: string) => string;

/** 下書きへ退避する編集内容（保存対象の定義だけ。秘密情報は持たない）。 */
interface SkillDraft {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly description: string;
  readonly instructions: string;
}

function message(cause: unknown, text: Translate): string { return cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'); }

/**
 * SkillはAgentへ「名前・説明・内容」だけを渡す軽量なコンテキストとする。
 * 既存の保存契約に残る詳細項目は、説明と内容から後方互換用に導出する。
 */
export function SkillBuilder({ client }: { readonly client: ToolApiClient }) {
  const { text, language } = useI18n();
  // Layer 1: 保存済みSkill一覧。'list'が既定viewで、new/openでLayer 2（editor）へ遷移する。
  const [view, setView] = useState<'list' | 'editor'>('list');
  // editing=true は一覧からOpenした既存Skill。internalIdは別資産を分岐させてしまうため編集不可にする。
  const [editing, setEditing] = useState(false);
  const [skills, setSkills] = useState<readonly SkillSummaryDto[]>([]);
  const [internalId, setInternalId] = useState(''); const [workingName, setWorkingName] = useState('');
  const [displayName, setDisplayName] = useState(''); const [publishName, setPublishName] = useState(''); const [owner, setOwner] = useState('');
  const [description, setDescription] = useState(''); const [instructions, setInstructions] = useState('');
  const [savedVersion, setSavedVersion] = useState<string>(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  // 保存成功フィードバックと削除確認の対象（削除文言に表示名を入れるためsummaryごと保持する）。
  const [saveNotice, setSaveNotice] = useState<string>(); const [pendingDelete, setPendingDelete] = useState<SkillSummaryDto>();
  const dismissSaveNotice = useCallback(() => setSaveNotice(undefined), []);

  // 下書きの自動保存。キーは「編集中の既存Skill」または新規（internalIdは編集途中で変わるためキーにしない）。
  const draftValue = useMemo<SkillDraft>(() => ({ internalId, workingName, displayName, publishName, owner, description, instructions }),
    [internalId, workingName, displayName, publishName, owner, description, instructions]);
  const draft = useDraftPersistence<SkillDraft>({ key: draftKey('skill-builder', scope, editing ? internalId : undefined), value: draftValue, enabled: view === 'editor' });
  useReportUnsavedChanges('skill-builder', draft.dirty);
  function applyDraft(value: SkillDraft): void {
    setInternalId(value.internalId); setWorkingName(value.workingName); setDisplayName(value.displayName);
    setPublishName(value.publishName); setOwner(value.owner); setDescription(value.description); setInstructions(value.instructions);
  }

  useEffect(() => {
    let active = true;
    void client.listSkills(scope).then((items) => { if (active) setSkills(items); }).catch((cause: unknown) => { if (active) setError(message(cause, text)); });
    return () => { active = false; };
  }, [client, text]);

  async function refreshSkills(): Promise<void> {
    try { setSkills(await client.listSkills(scope)); }
    catch (cause) { setError(message(cause, text)); }
  }

  // saveSkillのサーバー必須項目（min(1)）と保存ボタンの活性条件を一致させる。未充足項目はそのまま理由ヒントへ出す。
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (internalId.trim() === '') missing.push(text('Internal ID', '内部ID'));
    if (workingName.trim() === '') missing.push(text('Working name', '作業名'));
    if (displayName.trim() === '') missing.push(text('Skill name', 'スキル名'));
    if (publishName.trim() === '') missing.push(text('Publish name', '公開名'));
    if (owner.trim() === '') missing.push(text('Owner', '所有者'));
    if (description.trim() === '') missing.push(text('Skill description', 'スキルの説明'));
    if (instructions.trim() === '') missing.push(text('Skill content', 'スキル内容'));
    return missing;
  }, [internalId, workingName, displayName, publishName, owner, description, instructions, text]);
  const missingRequiredLabel = missingRequired.join(language === 'ja' ? '、' : ', ');

  function resetEditorState(): void {
    setInternalId(''); setWorkingName(''); setDisplayName(''); setPublishName(''); setOwner('');
    setDescription(''); setInstructions(''); setSavedVersion(undefined); setSaveNotice(undefined);
    setEditing(false);
  }
  function startNewSkill(): void { resetEditorState(); setError(undefined); setView('editor'); }
  async function backToList(): Promise<void> { setView('list'); await refreshSkills(); }
  function populateEditorFromSkill(skill: SerializedSkillDto): void {
    setInternalId(skill.metadata.internalId);
    setWorkingName(skill.metadata.workingName);
    setDisplayName(skill.metadata.displayName);
    setPublishName(skill.metadata.publishName);
    setOwner(skill.metadata.owner);
    setDescription(skill.responsibility);
    setInstructions(skill.instructions);
    setSavedVersion(skill.metadata.version); setSaveNotice(undefined);
    setEditing(true);
  }
  async function openSkill(target: string): Promise<void> {
    setBusy(true); setError(undefined);
    try {
      const skill = await client.getSkill(target, scope);
      populateEditorFromSkill(skill);
      setView('editor');
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(false); }
  }
  // 削除はConfirmDialogの確認後だけ実行する（一覧行のDeleteはpendingDeleteを立てるだけ）。
  async function removeSkill(target: string): Promise<void> {
    setBusy(true); setError(undefined);
    try { await client.deleteSkill(target, scope); setPendingDelete(undefined); await refreshSkills(); }
    catch (cause) { setError(message(cause, text)); setPendingDelete(undefined); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(undefined); setSaveNotice(undefined);
    try {
      const skill = await client.saveSkill({
        scope, internalId, workingName, displayName, publishName, owner,
        // 現行バックエンドの詳細フィールドはUIへ露出せず、ユーザー記述をそのまま基にする。
        responsibility: description, activationCondition: description,
        inputDescription: text('See skill content.', 'スキル内容を参照。'), outputDescription: text('Follow skill content.', 'スキル内容に従う。'),
        instructions, tools: [],
      });
      setSavedVersion(skill.metadata.version);
      setSaveNotice(text(`Saved · version ${skill.metadata.version}`, `保存しました バージョン ${skill.metadata.version}`));
      draft.clear();
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(false); }
  }

  if (view === 'list') {
    return <main className="agent-builder skill-list-page">
      <header className="agent-builder-header">
        <div><span className="eyebrow">{text('Skill Builder', 'スキルビルダー')}</span><h1>{text('Skills', 'スキル一覧')}</h1><p>{text('Create a lightweight Agent context with a name, description, and content.', 'スキル名・説明・内容だけで、軽量なエージェント向けコンテキストを作成します。')}</p></div>
        <div className="save-actions"><button type="button" className="primary" onClick={startNewSkill}>{text('New skill', '新規作成')}</button></div>
      </header>
      {error !== undefined && <div className="api-error">{error}</div>}
      <section className="workspace-card agent-list">
        {skills.length === 0 ? <p className="empty-state">{text('No skills yet.', 'スキルはまだありません。')}</p> : <div className="agent-list-rows">{skills.map((item) => <article className="agent-list-row" key={item.internalId}>
          <div><strong>{item.displayName}</strong><code>{item.publishName}@{item.latestVersion}</code><small>{item.state}</small></div>
          <div className="agent-list-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void openSkill(item.internalId)}>{text('Open', '開く')}</button>
            <button type="button" className="secondary danger" disabled={busy} onClick={() => setPendingDelete(item)}>{text('Delete', '削除')}</button>
          </div>
        </article>)}</div>}
      </section>
      <ConfirmDialog open={pendingDelete !== undefined} title={text('Delete skill', 'スキルを削除')}
        message={text(`Delete "${pendingDelete?.displayName ?? ''}"? It disappears from this list. Saved versions are kept in history.`, `「${pendingDelete?.displayName ?? ''}」を削除しますか？一覧から表示されなくなります（保存済みバージョンは履歴に残ります）。`)}
        confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} danger busy={busy}
        onConfirm={() => { if (pendingDelete !== undefined) void removeSkill(pendingDelete.internalId); }} onCancel={() => setPendingDelete(undefined)} />
    </main>;
  }

  return <main className="agent-builder skill-builder">
    <header className="agent-builder-header">
      <div><button type="button" className="secondary agent-back-button" onClick={() => void backToList()}>{text('Back to list', '一覧へ戻る')}</button><span className="eyebrow">{text('Skill Builder', 'スキルビルダー')}</span><h1>{displayName || text('New Skill', '新しいスキル')}</h1><p>{text('Create a lightweight Agent context with a name, description, and content.', 'スキル名・説明・内容だけで、軽量なエージェント向けコンテキストを作成します。')}</p></div>
      <div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <button className="primary" type="button" disabled={busy || missingRequired.length > 0} title={missingRequired.length > 0 ? text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`) : undefined} onClick={() => void save()}>{text('Save version', 'バージョンを保存')}</button>
      </div>
    </header>
    {draft.pending !== undefined && <DraftRestoreBanner savedAt={draft.pending.savedAt}
      onRestore={() => { const value = draft.restore(); if (value !== undefined) applyDraft(value); }}
      onDiscard={draft.discard} />}
    {/* 保存ボタン近傍のフィードバック: 未充足の必須項目と保存成功。 */}
    <div className="skill-save-feedback">
      {missingRequired.length > 0 && <InlineFeedback kind="info">{text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`)}</InlineFeedback>}
      {saveNotice !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={dismissSaveNotice}>{saveNotice}</InlineFeedback>}
    </div>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="agent-builder-grid">
      <div className="skill-definition-stack">
        <section className="agent-definition-card skill-save-settings" aria-label={text('Save settings', '保存設定')}>
          <div className="panel-title"><div><span className="eyebrow">{text('Stored definition', '保存する定義')}</span><h2>{text('Save settings', '保存設定')}</h2></div></div>
          <p>{text('These fields identify and version the Skill. They are not Agent instructions.', 'ここはスキルを識別・バージョン保存するための項目です。エージェントへの指示には使いません。')}</p>
          <div className="agent-fields">
            <label>{text('Internal ID', '内部ID')}<span className="required-mark">*</span><input aria-label={text('Skill internal ID', 'スキル内部ID')} placeholder={text('e.g. data-analysis', '例: data-analysis')} value={internalId} readOnly={editing} title={editing ? text('Internal ID cannot change once saved (it would fork a new asset).', '保存済みの内部IDは変更できません（変更すると別資産になります）。') : undefined} onChange={(event) => { if (editing) return; setInternalId(event.target.value); }} /></label>
            <label>{text('Working name', '作業名')}<span className="required-mark">*</span><input aria-label={text('Skill working name', 'スキル作業名')} placeholder={text('e.g. Data analysis draft', '例: データ分析の下書き')} value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
            <label>{text('Skill name', 'スキル名')}<span className="required-mark">*</span><input aria-label={text('Skill display name', 'スキル名')} placeholder={text('e.g. Data analysis', '例: データ分析')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label>{text('Publish name', '公開名')}<span className="required-mark">*</span><input aria-label={text('Skill publish name', 'スキル公開名')} placeholder={text('e.g. data_analysis', '例: data_analysis')} value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
            <label>{text('Owner', '所有者')}<span className="required-mark">*</span><input aria-label={text('Skill owner', 'スキル所有者')} placeholder={text('e.g. team@example.com', '例: team@example.com')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          </div>
        </section>

        <section className="agent-definition-card skill-agent-context" aria-label={text('Agent context', 'エージェントへのコンテキスト')}>
          <div className="panel-title"><div><span className="eyebrow">{text('Sent to Agent', 'エージェントに渡す情報')}</span><h2>{text('Description', '説明')}</h2></div></div>
          <p>{text('Describe when and why an Agent should use this Skill. Put any detailed rules in the content.', 'エージェントがこのスキルをいつ・なぜ使うかを記述します。細かなルールは内容へ自由に記述してください。')}</p>
          <label>{text('Skill description', 'スキルの説明')}<span className="required-mark">*</span><textarea aria-label={text('Skill description', 'スキルの説明')} rows={7} placeholder={text('e.g. Analyze tabular data and explain the result to the user.', '例: 表形式データを分析し、結果を利用者に分かりやすく説明する。')} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        </section>
      </div>

      <section className="prompt-editor-card skill-instructions" aria-label={text('Skill content editor', 'スキル内容エディター')}>
        <div className="panel-title"><div><span className="eyebrow">{text('Sent to Agent', 'エージェントに渡す情報')}</span><h2>{text('Skill content', 'スキル内容')}<span className="required-mark">*</span></h2></div><span className="version-chip">{instructions.length} {text('chars', '文字')}</span></div>
        <p>{text('Write any instructions, format, constraints, or examples needed by the Agent. The structure is entirely up to you.', 'エージェントに必要な指示、形式、制約、例を自由に記述します。内容の構造はユーザーに委ねます。')}</p>
        <textarea aria-label={text('Skill content', 'スキル内容')} rows={34} placeholder={text('Write the content the Agent should follow.', 'エージェントに渡す内容を記述します。')} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </section>
    </div>
  </main>;
}
