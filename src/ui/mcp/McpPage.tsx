import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ToolSummaryDto } from '../api/types';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
export function McpPage({ client }: { readonly client: ToolApiClient }) {
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const { text } = useI18n();
  const refresh = useCallback(async () => {
    setError(undefined);
    try { setTools(await client.listTools(scope)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  const manifest = useMemo(() => ({ name: 'agentcontext-local', transport: 'streamable-http', authentication: 'required', tools: tools.filter((tool) => selected.has(tool.internalId)).map((tool) => ({ name: tool.publishName, source: `${tool.internalId}@${tool.latestVersion}` })) }), [selected, tools]);
  function toggle(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return <main className="workspace-page"><header className="workspace-header"><div><span className="eyebrow">MCP</span><h1>{text('MCP publication', 'MCP公開')}</h1><p>{text('Build a version-pinned publication manifest from saved Tools.', '保存済みツールからバージョン固定の公開マニフェストを構成します。')}</p></div><span className="run-status failed">{text('publishing locked', '公開ロック中')}</span></header>{error !== undefined && <div className="api-error">{error}<button type="button" className="ghost" onClick={() => void refresh()}>{text('Reload', '再読み込み')}</button></div>}<div className="two-column-workspace"><section className="workspace-card"><h2>{text('Tool catalog', 'ツール一覧')}</h2>{tools.length === 0 && <p className="empty-state">{text('No Tools are available for publication.', '公開候補のツールがありません。')}</p>}{tools.map((tool) => <label className="agent-tool-option" key={tool.internalId}><input type="checkbox" checked={selected.has(tool.internalId)} onChange={() => toggle(tool.internalId)} /><span><strong>{tool.displayName}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small>{tool.state}</small></label>)}</section><section className="workspace-card"><h2>{text('Manifest preview', 'マニフェストプレビュー')}</h2><pre className="manifest-preview">{JSON.stringify(manifest, null, 2)}</pre><div className="notice-card"><strong>{text('External publication is unavailable', '外部公開は利用できません')}</strong><p>{text('Publication remains fail-closed until authentication, authorization, audit, and endpoint adapters exist. The manifest is not saved or published.', '認証・認可・監査・公開エンドポイントの実装前は安全側に遮断します。マニフェストは保存・公開されません。')}</p></div><button type="button" className="primary" disabled>{text('Publish MCP server', 'MCPサーバーを公開')}</button></section></div></main>;
}
