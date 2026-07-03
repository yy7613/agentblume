import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ToolSummaryDto } from '../api/types';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
export function McpPage({ client }: { readonly client: ToolApiClient }) {
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  useEffect(() => { let active = true; void client.listTools(scope).then((items) => { if (active) setTools(items); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Request failed'); }); return () => { active = false; }; }, [client]);
  const manifest = useMemo(() => ({ name: 'agentcontext-local', transport: 'streamable-http', authentication: 'required', tools: tools.filter((tool) => selected.has(tool.internalId)).map((tool) => ({ name: tool.publishName, source: `${tool.internalId}@${tool.latestVersion}` })) }), [selected, tools]);
  function toggle(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return <main className="workspace-page"><header className="workspace-header"><div><span className="eyebrow">MCP</span><h1>MCP publication</h1><p>保存済みToolからversion固定の公開manifestを構成します。</p></div><span className="run-status failed">publishing locked</span></header>{error !== undefined && <div className="api-error">{error}</div>}<div className="two-column-workspace"><section className="workspace-card"><h2>Tool catalog</h2>{tools.length === 0 && <p className="empty-state">公開候補のToolがありません。</p>}{tools.map((tool) => <label className="agent-tool-option" key={tool.internalId}><input type="checkbox" checked={selected.has(tool.internalId)} onChange={() => toggle(tool.internalId)} /><span><strong>{tool.displayName}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small>{tool.state}</small></label>)}</section><section className="workspace-card"><h2>Manifest preview</h2><pre className="manifest-preview">{JSON.stringify(manifest, null, 2)}</pre><div className="notice-card"><strong>External publication is unavailable</strong><p>認証、認可、監査、公開endpointの実装前はfail closedとします。manifestは保存・公開されません。</p></div><button type="button" className="primary" disabled>Publish MCP server</button></section></div></main>;
}
