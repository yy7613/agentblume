import { useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { SideEffectDto } from '../api/types';
import { currentGraph, useToolBuilderStore } from './store';

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
      <div className="title-block"><span className="eyebrow">Tool Builder</span><input aria-label="Display name" value={metadata.displayName} onChange={(event) => setMetadata('displayName', event.target.value)} /></div>
      <details>
        <summary>Metadata</summary>
        <div className="metadata-grid">
          <label>Internal ID<input value={metadata.internalId} onChange={(event) => setMetadata('internalId', event.target.value)} /></label>
          <label>Working name<input value={metadata.workingName} onChange={(event) => setMetadata('workingName', event.target.value)} /></label>
          <label>Publish name<input value={metadata.publishName} onChange={(event) => setMetadata('publishName', event.target.value)} /></label>
          <label>Owner<input value={metadata.owner} onChange={(event) => setMetadata('owner', event.target.value)} /></label>
          <label>Tenant<input value={metadata.tenantId} onChange={(event) => setMetadata('tenantId', event.target.value)} /></label>
          <label>Workspace<input value={metadata.workspaceId} onChange={(event) => setMetadata('workspaceId', event.target.value)} /></label>
          <label>Side effect<select value={metadata.sideEffect} onChange={(event) => setMetadata('sideEffect', event.target.value as SideEffectDto)}><option>read-only</option><option>write</option><option>external-action</option></select></label>
        </div>
      </details>
      <div className="save-actions">
        <span className={`validation-status ${error !== undefined || propagation?.hasErrors ? 'bad' : 'good'}`}>{error !== undefined ? 'Invalid draft' : propagation === undefined ? 'Checking…' : propagation.hasErrors ? 'Issues' : 'Valid draft'}</span>
        <button type="button" className="secondary" onClick={() => void refreshVersions()}>Versions</button>
        <select aria-label="Version history" value={currentVersion ?? ''} onChange={(event) => void load(event.target.value)}>
          <option value="">{versions.length === 0 ? 'No saved versions' : 'Select version'}</option>
          {versions.map((version) => <option key={version} value={version}>{version}</option>)}
        </select>
        <button type="button" className="primary" disabled={saving || error !== undefined || propagation?.hasErrors !== false} onClick={() => void save()}>{saving ? 'Saving…' : 'Save version'}</button>
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
