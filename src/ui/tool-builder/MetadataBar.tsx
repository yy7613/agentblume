import { useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { SideEffectDto } from '../api/types';
import { currentGraph, useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

export function MetadataBar({ client }: { readonly client: ToolApiClient }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const setMetadata = useToolBuilderStore((state) => state.setMetadata);
  const currentVersion = useToolBuilderStore((state) => state.currentVersion);
  const versions = useToolBuilderStore((state) => state.versions);
  const setSavedVersion = useToolBuilderStore((state) => state.setSavedVersion);
  const setVersions = useToolBuilderStore((state) => state.setVersions);
  const loadTool = useToolBuilderStore((state) => state.loadTool);
  const setError = useToolBuilderStore((state) => state.setError);
  const propagation = useToolBuilderStore((state) => state.propagation);
  const error = useToolBuilderStore((state) => state.error);
  const [saving, setSaving] = useState(false);
  const { text } = useI18n();

  const scope = { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId };

  async function save(): Promise<void> {
    setSaving(true); setError(undefined);
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
        ...(inputSchema() !== undefined ? { inputSchema: inputSchema() } : {}),
        ...(outputSchema() !== undefined ? { outputSchema: outputSchema() } : {}),
      });
      const nextVersions = await client.listVersions(metadata.internalId, scope);
      setSavedVersion(tool.metadata.version, nextVersions);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Save failed');
    } finally { setSaving(false); }
  }

  async function refreshVersions(): Promise<void> {
    try { setVersions(await client.listVersions(metadata.internalId, scope)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Version lookup failed'); }
  }

  async function load(version: string): Promise<void> {
    if (version === '') return;
    try { loadTool(await client.getTool(metadata.internalId, scope, version)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Version load failed'); }
  }

  return (
    <header className="metadata-bar">
      <div className="title-block"><span className="eyebrow">{text('Tool Builder', 'ツールビルダー')}</span><input aria-label={text('Display name', '表示名')} value={metadata.displayName} onChange={(event) => setMetadata('displayName', event.target.value)} /></div>
      <details>
        <summary>{text('Metadata', 'メタデータ')}</summary>
        <div className="metadata-grid">
          <label>{text('Internal ID', '内部ID')}<input value={metadata.internalId} onChange={(event) => setMetadata('internalId', event.target.value)} /></label>
          <label>{text('Working name', '作業名')}<input value={metadata.workingName} onChange={(event) => setMetadata('workingName', event.target.value)} /></label>
          <label>{text('Publish name', '公開名')}<input value={metadata.publishName} onChange={(event) => setMetadata('publishName', event.target.value)} /></label>
          <label>{text('Owner', '所有者')}<input value={metadata.owner} onChange={(event) => setMetadata('owner', event.target.value)} /></label>
          <label>{text('Tenant', 'テナント')}<input value={metadata.tenantId} onChange={(event) => setMetadata('tenantId', event.target.value)} /></label>
          <label>{text('Workspace', 'ワークスペース')}<input value={metadata.workspaceId} onChange={(event) => setMetadata('workspaceId', event.target.value)} /></label>
          <label>{text('Side effect', '副作用')}<select value={metadata.sideEffect} onChange={(event) => setMetadata('sideEffect', event.target.value as SideEffectDto)}><option>read-only</option><option>write</option><option>external-action</option></select></label>
        </div>
      </details>
      <div className="save-actions">
        <span className={`validation-status ${error !== undefined || propagation?.hasErrors ? 'bad' : 'good'}`}>{error !== undefined ? text('Invalid draft', '草案に問題あり') : propagation === undefined ? text('Checking…', '確認中…') : propagation.hasErrors ? text('Issues', '問題あり') : text('Valid draft', '有効な草案')}</span>
        <button type="button" className="secondary" onClick={() => void refreshVersions()}>{text('Versions', 'バージョン')}</button>
        <select aria-label={text('Version history', 'バージョン履歴')} value={currentVersion ?? ''} onChange={(event) => void load(event.target.value)}>
          <option value="">{versions.length === 0 ? text('No saved versions', '保存済みバージョンなし') : text('Select version', 'バージョンを選択')}</option>
          {versions.map((version) => <option key={version} value={version}>{version}</option>)}
        </select>
        <button type="button" className="primary" disabled={saving || error !== undefined || propagation?.hasErrors !== false} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
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
