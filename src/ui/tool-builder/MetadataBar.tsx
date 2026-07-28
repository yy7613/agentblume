import { useCallback, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { SideEffectDto } from '../api/types';
import { InlineFeedback } from '../components/InlineFeedback';
import { currentGraph, missingRequiredMetadata, useToolBuilderStore, type RequiredMetadataKey } from './store';
import { useI18n } from '../i18n';
import { scope } from '../scope';

/** onSaved: 保存が成功した直後に呼ぶ（ToolBuilder側で退避中の下書きを消すために使う）。 */
export function MetadataBar({ client, onSaved }: { readonly client: ToolApiClient; readonly onSaved?: () => void }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const setMetadata = useToolBuilderStore((state) => state.setMetadata);
  const currentVersion = useToolBuilderStore((state) => state.currentVersion);
  const versions = useToolBuilderStore((state) => state.versions);
  const setSavedVersion = useToolBuilderStore((state) => state.setSavedVersion);
  const setVersions = useToolBuilderStore((state) => state.setVersions);
  const loadTool = useToolBuilderStore((state) => state.loadTool);
  const setSaveError = useToolBuilderStore((state) => state.setSaveError);
  const propagation = useToolBuilderStore((state) => state.propagation);
  const draftIssue = useToolBuilderStore((state) => state.draftIssue);
  const saveError = useToolBuilderStore((state) => state.saveError);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string>();
  const dismissNotice = useCallback(() => setSavedNotice(undefined), []);
  const { text } = useI18n();

  const label: Record<RequiredMetadataKey, string> = {
    internalId: text('Internal ID', '内部ID'),
    workingName: text('Working name', '作業名'),
    displayName: text('Display name', '表示名'),
    publishName: text('Publish name', '公開名'),
    owner: text('Owner', '所有者'),
  };
  // 保存ボタンのdisabledは「必須項目の未入力」と「保存中」だけで決める。
  // 検証エラーで押せなくなる状態を作らないので、入力し直せば必ず復帰する。
  const missing = missingRequiredMetadata(metadata);
  const missingText = missing.map((key) => label[key]).join(text(', ', '、'));

  async function save(): Promise<void> {
    setSaving(true); setSaveError(undefined); setSavedNotice(undefined);
    try {
      const tool = await client.saveTool({
        scope,
        internalId: metadata.internalId,
        workingName: metadata.workingName,
        displayName: metadata.displayName,
        publishName: metadata.publishName,
        owner: metadata.owner,
        sideEffect: metadata.sideEffect,
        graph: currentGraph(),
        ...(metadata.agentName.trim() !== '' && metadata.agentDescription.trim() !== ''
          ? { agentTool: { name: metadata.agentName, description: metadata.agentDescription } }
          : {}),
        ...(inputSchema() !== undefined ? { inputSchema: inputSchema() } : {}),
        ...(outputSchema() !== undefined ? { outputSchema: outputSchema() } : {}),
      });
      const nextVersions = await client.listVersions(metadata.internalId, scope);
      setSavedVersion(tool.metadata.version, nextVersions);
      setSavedNotice(tool.metadata.version);
      onSaved?.();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Save failed');
    } finally { setSaving(false); }
  }

  async function refreshVersions(): Promise<void> {
    setSaveError(undefined);
    try { setVersions(await client.listVersions(metadata.internalId, scope)); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Version lookup failed'); }
  }

  async function load(version: string): Promise<void> {
    if (version === '') return;
    setSaveError(undefined);
    try { loadTool(await client.getTool(metadata.internalId, scope, version)); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Version load failed'); }
  }

  return (
    <header className="metadata-bar">
      <div className="title-block"><span className="eyebrow">{text('Tool Builder', 'ツールビルダー')}</span><div style={{ display: 'flex', alignItems: 'baseline' }}><input aria-label={text('Display name', '表示名')} placeholder={text('e.g. Customer search', '例: 顧客検索')} value={metadata.displayName} onChange={(event) => setMetadata('displayName', event.target.value)} /><span className="required-mark" title={text('Required', '必須')}>*</span></div></div>
      <details>
        <summary>{text('Metadata', 'メタデータ')}</summary>
        <div className="metadata-grid">
          <label>{text('Internal ID', '内部ID')}<span className="required-mark">*</span><input aria-label={text('Internal ID', '内部ID')} placeholder={text('e.g. customer-search', '例: customer-search')} value={metadata.internalId} onChange={(event) => setMetadata('internalId', event.target.value)} /></label>
          <label>{text('Working name', '作業名')}<span className="required-mark">*</span><input aria-label={text('Working name', '作業名')} placeholder={text('e.g. Customer search draft', '例: 顧客検索の下書き')} value={metadata.workingName} onChange={(event) => setMetadata('workingName', event.target.value)} /></label>
          <label>{text('Publish name', '公開名')}<span className="required-mark">*</span><input aria-label={text('Publish name', '公開名')} placeholder={text('e.g. customer_search', '例: customer_search')} value={metadata.publishName} onChange={(event) => setMetadata('publishName', event.target.value)} /></label>
          <label>{text('Owner', '所有者')}<span className="required-mark">*</span><input aria-label={text('Owner', '所有者')} placeholder={text('e.g. team@example.com', '例: team@example.com')} value={metadata.owner} onChange={(event) => setMetadata('owner', event.target.value)} /></label>
          {/* テナント／ワークスペースは編集させない。保存先は認証済みPrincipalがサーバー側で決めるので、
              ここで入力できても効かないうえ、以前は書き換えた瞬間にToolが他画面から見えなくなる罠だった。
              現在地の確認のためだけに読み取り専用で出す。 */}
          <div className="metadata-readonly"><span>{text('Tenant', 'テナント')}</span><code>{scope.tenantId}</code></div>
          <div className="metadata-readonly"><span>{text('Workspace', 'ワークスペース')}</span><code>{scope.workspaceId}</code></div>
          <label>{text('Side effect', '副作用')}<select value={metadata.sideEffect} onChange={(event) => setMetadata('sideEffect', event.target.value as SideEffectDto)}><option>read-only</option><option>session-write</option><option>write</option><option>external-action</option></select></label>
        </div>
      </details>
      <div className="save-column" style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', minWidth: 0 }}>
        <div className="save-actions">
          <span className={`validation-status ${draftIssue !== undefined || propagation?.hasErrors === true ? 'bad' : 'good'}`}>{draftIssue !== undefined ? text('Invalid draft', '草案に問題あり') : propagation === undefined ? text('Checking…', '確認中…') : propagation.hasErrors ? text('Issues', '問題あり') : text('Valid draft', '有効な草案')}</span>
          <button type="button" className="secondary" onClick={() => void refreshVersions()}>{text('Versions', 'バージョン')}</button>
          <select aria-label={text('Version history', 'バージョン履歴')} value={currentVersion ?? ''} onChange={(event) => void load(event.target.value)}>
            <option value="">{versions.length === 0 ? text('No saved versions', '保存済みバージョンなし') : text('Select version', 'バージョンを選択')}</option>
            {versions.map((version) => <option key={version} value={version}>{version}</option>)}
          </select>
          <button type="button" className="primary" disabled={saving || missing.length > 0} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
        </div>
        {missing.length > 0 && <small className="empty-state" style={{ textAlign: 'right' }}>{text(`${missingText} required to save.`, `${missingText}が未入力です。`)}</small>}
        {saveError !== undefined && <div className="api-error" role="alert" style={{ margin: 0, maxWidth: '420px', textAlign: 'right' }}>{saveError}</div>}
        {savedNotice !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={dismissNotice}>{text(`Saved version ${savedNotice}`, `保存しました バージョン ${savedNotice}`)}</InlineFeedback>}
      </div>
    </header>
  );
}

function inputSchema() {
  const graph = currentGraph();
  const node = graph.nodes.find((candidate) => candidate.type === 'agent-input');
  const config = node?.config as { schema?: import('../api/types').SchemaDto } | undefined;
  return config?.schema;
}

function outputSchema() {
  const propagation = useToolBuilderStore.getState().propagation;
  if (propagation === undefined) return undefined;
  const terminalId = propagation?.order.at(-1);
  return terminalId === undefined ? undefined : propagation.nodes[terminalId]?.schema;
}
