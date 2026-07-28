import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { McpServerDto, McpServerTestResultDto, ToolSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { ScreenLink } from '../navigation';
import {
  EMPTY_MCP_SERVER_FORM, formatMcpServersDocument, parseMcpServersDocumentText, toMcpServerForm, toMcpTransport, transportSummary,
  type McpServerFormValue, type McpServersDocumentParseResult,
} from './mcp-config';
import { scope } from '../scope';

type Translate = (english: string, japanese: string) => string;

function errorText(cause: unknown, text: Translate): string { return cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'); }

/**
 * 資格情報がマスク表示されることの説明。
 *
 * env / headers の値はサーバー側で暗号化して保管され、応答では `***` に置き換わる。
 * `***` のまま保存すると保存済みの値が維持される（モデル設定のAPIキーと同じ流儀）。
 * これを書いておかないと、利用者は「値が消えた」と誤解して実値を入れ直すことになる。
 */
function maskedSecretHint(text: Translate): string {
  return text(
    'Saved values are stored encrypted and shown as "***". Leave "***" to keep the stored value; type a real value to replace it.',
    '保存済みの値は暗号化して保管され、表示は "***" になります。"***" のままなら値は変わりません。変えるときだけ実際の値を入力してください。',
  );
}

/** JSONタブのパース失敗を画面文言へ落とす（純関数側は理由コードだけを返す）。 */
function documentErrorText(result: Extract<McpServersDocumentParseResult, { ok: false }>, text: Translate): string {
  switch (result.reason) {
    case 'invalid-json': return `${text('The document is not valid JSON', 'JSONとして解析できません')}: ${result.detail ?? ''}`;
    case 'not-an-object': return text('The document must be a JSON object.', 'ドキュメントはJSONオブジェクトである必要があります。');
    default: return text('The document must have an "mcpServers" object.', 'ドキュメントには "mcpServers" オブジェクトが必要です。');
  }
}

export function McpPage({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  // --- MCPクライアント（外部サーバー接続） ---
  const [servers, setServers] = useState<readonly McpServerDto[]>([]);
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [form, setForm] = useState<McpServerFormValue>(EMPTY_MCP_SERVER_FORM);
  // 編集中は name をキーにupsertするため readOnly にする（別名保存は「追加」から行う）。
  const [editingName, setEditingName] = useState<string>();
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string>();
  const [tests, setTests] = useState<Readonly<Record<string, McpServerTestResultDto>>>({});
  const [testing, setTesting] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<McpServerDto>();
  const [clientBusy, setClientBusy] = useState(false);
  const [clientError, setClientError] = useState<string>();
  const [clientNotice, setClientNotice] = useState<string>();
  const dismissNotice = useCallback(() => setClientNotice(undefined), []);

  // --- MCP公開（既存・fail-closed） ---
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setError(undefined);
    try { setTools(await client.listTools(scope)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);

  // MCPサーバー一覧。旧クライアント（メソッド未実装）でも公開セクションは動くようにする。
  const refreshServers = useCallback(async (): Promise<readonly McpServerDto[]> => {
    if (typeof client.listMcpServers !== 'function') return [];
    const items = await client.listMcpServers(scope);
    setServers(items);
    return items;
  }, [client]);
  useEffect(() => {
    let active = true;
    void refreshServers().catch((cause: unknown) => { if (active) setClientError(errorText(cause, text)); });
    return () => { active = false; };
  }, [refreshServers, text]);

  const manifest = useMemo(() => ({ name: 'agentcontext-local', transport: 'streamable-http', authentication: 'required', tools: tools.filter((tool) => selected.has(tool.internalId)).map((tool) => ({ name: tool.publishName, source: `${tool.internalId}@${tool.latestVersion}` })) }), [selected, tools]);
  function toggle(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }

  function update(patch: Partial<McpServerFormValue>): void { setForm((current) => ({ ...current, ...patch })); }
  function resetForm(): void { setForm(EMPTY_MCP_SERVER_FORM); setEditingName(undefined); }
  function editServer(server: McpServerDto): void { setForm(toMcpServerForm(server)); setEditingName(server.name); setTab('form'); setClientNotice(undefined); }
  // JSONタブは開いた時点の保存済み状態から生成する（編集中のフォーム入力は反映しない）。
  function openJsonTab(): void { setTab('json'); setJsonText(formatMcpServersDocument(servers)); setJsonError(undefined); }

  const saveBlocked = form.name.trim() === '' || (form.kind === 'stdio' ? form.command.trim() === '' : form.url.trim() === '');

  async function saveServer(): Promise<void> {
    setClientBusy(true); setClientError(undefined); setClientNotice(undefined);
    const name = form.name.trim();
    try {
      await client.saveMcpServer({ scope, server: { name, transport: toMcpTransport(form), disabled: form.disabled } });
      const next = await refreshServers();
      if (tab === 'json') setJsonText(formatMcpServersDocument(next));
      resetForm();
      setClientNotice(text(`Saved "${name}".`, `「${name}」を保存しました。`));
    } catch (cause) { setClientError(errorText(cause, text)); }
    finally { setClientBusy(false); }
  }

  async function testServer(name: string): Promise<void> {
    setTesting(name); setClientError(undefined);
    try { const result = await client.testMcpServer(name, scope); setTests((current) => ({ ...current, [name]: result })); }
    catch (cause) { setClientError(errorText(cause, text)); }
    finally { setTesting(undefined); }
  }

  async function removeServer(name: string): Promise<void> {
    setClientBusy(true); setClientError(undefined);
    try {
      await client.deleteMcpServer(name, scope);
      setPendingDelete(undefined);
      setTests((current) => { const next = { ...current }; delete next[name]; return next; });
      if (editingName === name) resetForm();
      const remaining = await refreshServers();
      if (tab === 'json') setJsonText(formatMcpServersDocument(remaining));
    } catch (cause) { setClientError(errorText(cause, text)); setPendingDelete(undefined); }
    finally { setClientBusy(false); }
  }

  // 適用は全置換。応答がそのまま新しい保存済み状態なので、フォームタブの一覧もこれで更新する。
  async function applyJson(): Promise<void> {
    const parsed = parseMcpServersDocumentText(jsonText);
    if (!parsed.ok) { setJsonError(documentErrorText(parsed, text)); return; }
    setJsonError(undefined); setClientBusy(true); setClientError(undefined); setClientNotice(undefined);
    try {
      const next = await client.replaceMcpServers({ scope, mcpServers: parsed.mcpServers });
      setServers(next);
      setJsonText(formatMcpServersDocument(next));
      setTests({}); resetForm();
      setClientNotice(text(`Applied · ${next.length} server(s) configured.`, `適用しました（${next.length}件）。`));
    } catch (cause) { setClientError(errorText(cause, text)); }
    finally { setClientBusy(false); }
  }

  return <main className="workspace-page mcp-page">
    <header className="workspace-header">
      <div>
        <span className="eyebrow">MCP</span>
        <h1>{text('MCP client (external servers)', 'MCPクライアント（外部サーバー接続）')}</h1>
        <p>{text('Register external MCP servers. Their tools are injected into Agents as mcp__<server>__<tool>.', '外部MCPサーバーを登録します。そのツールは mcp__<サーバー名>__<ツール名> としてエージェントへ注入されます。')}</p>
      </div>
    </header>
    <section className="workspace-card mcp-client-card">
      <div className="validation-tabs" role="tablist" aria-label={text('MCP client tabs', 'MCPクライアントのタブ')}>
        <button type="button" role="tab" aria-selected={tab === 'form'} className={tab === 'form' ? 'active' : ''} onClick={() => setTab('form')}>{text('Form', 'フォーム')}</button>
        <button type="button" role="tab" aria-selected={tab === 'json'} className={tab === 'json' ? 'active' : ''} onClick={openJsonTab}>JSON</button>
      </div>
      {clientError !== undefined && <div className="api-error">{clientError}</div>}
      {clientNotice !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={dismissNotice}>{clientNotice}</InlineFeedback>}
      {tab === 'form' ? <div className="mcp-client-grid">
        <div className="mcp-server-list">
          <h2>{text('Registered servers', '登録済みサーバー')}</h2>
          {servers.length === 0 ? <p className="empty-state">{text('No MCP servers yet.', 'MCPサーバーはまだありません。')}</p> : <div className="data-source-rows">{servers.map((server) => {
            const result = tests[server.name];
            return <article className="data-source-row mcp-server-row" key={server.name}>
              <div>
                <strong>{server.name}</strong>
                <code>{transportSummary(server.transport)}</code>
                {server.disabled && <small className="run-status failed">{text('disabled', '無効')}</small>}
                {result !== undefined && (result.ok
                  ? (result.tools ?? []).length === 0
                    ? <small className="empty-state">{text('Connected · no tools exposed', '接続成功・公開ツールなし')}</small>
                    : <ul className="mcp-tool-list">{(result.tools ?? []).map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.description !== undefined && <small>{tool.description}</small>}</li>)}</ul>
                  : <small className="field-error">{result.error ?? text('Connection failed', '接続に失敗しました')}</small>)}
              </div>
              <div className="data-source-actions">
                <button type="button" className="secondary" disabled={clientBusy || testing !== undefined} onClick={() => void testServer(server.name)}>{testing === server.name ? text('Testing…', 'テスト中…') : text('Test', 'テスト')}</button>
                <button type="button" className="secondary" disabled={clientBusy} onClick={() => editServer(server)}>{text('Edit', '編集')}</button>
                <button type="button" className="secondary danger" disabled={clientBusy} onClick={() => setPendingDelete(server)}>{text('Delete', '削除')}</button>
              </div>
            </article>;
          })}</div>}
        </div>
        <div className="mcp-server-form">
          <h2>{editingName === undefined ? text('Add server', 'サーバーを追加') : text('Edit server', 'サーバーを編集')}</h2>
          <label>{text('Name', '名前')}<input aria-label={text('MCP server name', 'MCPサーバー名')} placeholder={text('e.g. filesystem', '例: filesystem')} value={form.name} readOnly={editingName !== undefined} onChange={(event) => { if (editingName !== undefined) return; update({ name: event.target.value }); }} /></label>
          <fieldset className="mcp-transport-kind">
            <legend>{text('Transport', 'トランスポート')}</legend>
            <label><input type="radio" name="mcp-transport-kind" checked={form.kind === 'stdio'} onChange={() => update({ kind: 'stdio' })} /> stdio</label>
            <label><input type="radio" name="mcp-transport-kind" checked={form.kind === 'http'} onChange={() => update({ kind: 'http' })} /> http</label>
          </fieldset>
          {form.kind === 'stdio' ? <>
            <label>{text('Command', 'コマンド')}<input aria-label={text('MCP command', 'MCPコマンド')} placeholder={text('e.g. npx', '例: npx')} value={form.command} onChange={(event) => update({ command: event.target.value })} /></label>
            <label>{text('Args (one per line)', '引数（1行1件）')}<textarea aria-label={text('MCP args', 'MCP引数')} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} value={form.args} onChange={(event) => update({ args: event.target.value })} /></label>
            <label>{text('Env (one KEY=VALUE per line)', '環境変数（1行1件 KEY=VALUE）')}<textarea aria-label={text('MCP env', 'MCP環境変数')} rows={3} placeholder={'API_TOKEN=xxxx'} value={form.env} onChange={(event) => update({ env: event.target.value })} /></label>
            <small className="data-source-hint">{maskedSecretHint(text)}</small>
            <label>{text('Working directory (optional)', '作業ディレクトリ（任意）')}<input aria-label={text('MCP working directory', 'MCP作業ディレクトリ')} placeholder={text('e.g. C:\\workspace', '例: C:\\workspace')} value={form.cwd} onChange={(event) => update({ cwd: event.target.value })} /></label>
            <small className="data-source-hint">{text('On Windows, npx-based servers may need command "cmd" with args "/c", "npx", ...', 'Windowsでnpx系サーバーは command を "cmd"、args を "/c", "npx", ... とする必要がある場合があります')}</small>
          </> : <>
            <label>{text('URL', 'URL')}<input aria-label={text('MCP server URL', 'MCPサーバーURL')} placeholder="https://example.com/mcp" value={form.url} onChange={(event) => update({ url: event.target.value })} /></label>
            <label>{text('Headers (one "Header: value" per line)', 'ヘッダー（1行1件 "Header: value"）')}<textarea aria-label={text('MCP headers', 'MCPヘッダー')} rows={3} placeholder={'Authorization: Bearer xxxx'} value={form.headers} onChange={(event) => update({ headers: event.target.value })} /></label>
            <small className="data-source-hint">{maskedSecretHint(text)}</small>
          </>}
          <label className="structured-output-toggle"><input type="checkbox" aria-label={text('Disable this server', 'このサーバーを無効化')} checked={form.disabled} onChange={(event) => update({ disabled: event.target.checked })} /> {text('Disabled (skipped at run time)', '無効（実行時はスキップ）')}</label>
          <div className="save-actions">
            <button type="button" className="primary" disabled={clientBusy || saveBlocked} onClick={() => void saveServer()}>{clientBusy ? text('Saving…', '保存中…') : text('Save server', 'サーバーを保存')}</button>
            {editingName !== undefined && <button type="button" className="secondary" disabled={clientBusy} onClick={resetForm}>{text('Cancel edit', '編集をやめる')}</button>}
          </div>
        </div>
      </div> : <div className="mcp-json-tab">
        <div className="notice-card">
          <strong>{text('Apply replaces every server', '適用はすべて置き換えます')}</strong>
          <p>{text('Applying replaces all MCP server settings in this workspace with this document. Servers missing from it are deleted.', '適用するとこのワークスペースのMCPサーバー設定はこのドキュメントで全置換されます。記載の無いサーバーは削除されます。')}</p>
          <p>{text('Secrets in env and headers are shown as "***". Applying the document unchanged keeps them; replace "***" with a real value to change one. Because of this the document cannot be pasted into another tool as-is.', 'env と headers の値は "***" で伏せられます。このまま適用すれば保存済みの値が維持され、変えたいものだけ実際の値に書き換えます。このため書き出したドキュメントを他のツールへそのまま貼り付けることはできません。')}</p>
        </div>
        <textarea aria-label={text('mcpServers document', 'mcpServers ドキュメント')} className="mcp-json-editor" rows={18} value={jsonText} onChange={(event) => { setJsonText(event.target.value); setJsonError(undefined); }} />
        {jsonError !== undefined && <p className="field-error">{jsonError}</p>}
        <button type="button" className="primary" disabled={clientBusy} onClick={() => void applyJson()}>{text('Apply', '適用')}</button>
      </div>}
    </section>
    <ConfirmDialog open={pendingDelete !== undefined} title={text('Delete MCP server', 'MCPサーバーを削除')}
      message={text(`Delete "${pendingDelete?.name ?? ''}"? Agents that reference it lose those tools.`, `「${pendingDelete?.name ?? ''}」を削除しますか？参照しているエージェントはそのツールを失います。`)}
      confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} danger busy={clientBusy}
      onConfirm={() => { if (pendingDelete !== undefined) void removeServer(pendingDelete.name); }} onCancel={() => setPendingDelete(undefined)} />
    <section className="mcp-publication">
      <header className="workspace-header">
        <div><span className="eyebrow">MCP</span><h2>{text('MCP publication', 'MCP公開')}</h2><p>{text('Build a version-pinned publication manifest from saved Tools.', '保存済みツールからバージョン固定の公開マニフェストを構成します。')}</p></div>
        <span className="run-status failed">{text('publishing locked', '公開ロック中')}</span>
      </header>
      {error !== undefined && <div className="api-error">{error}<button type="button" className="ghost" onClick={() => void refresh()}>{text('Reload', '再読み込み')}</button></div>}
      <div className="two-column-workspace">
        <section className="workspace-card"><h2>{text('Tool catalog', 'ツール一覧')}</h2>{tools.length === 0 && <p className="empty-state"><span>{text('No Tools are available for publication.', '公開候補のツールがありません。')}</span> <ScreenLink to="Tool">{text('Open the Tool screen', 'ツール画面を開く')}</ScreenLink></p>}{tools.map((tool) => <label className="agent-tool-option" key={tool.internalId}><input type="checkbox" checked={selected.has(tool.internalId)} onChange={() => toggle(tool.internalId)} /><span><strong>{tool.displayName}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small>{tool.state}</small></label>)}</section>
        <section className="workspace-card"><h2>{text('Manifest preview', 'マニフェストプレビュー')}</h2><pre className="manifest-preview">{JSON.stringify(manifest, null, 2)}</pre><div className="notice-card"><strong>{text('External publication is unavailable', '外部公開は利用できません')}</strong><p>{text('Publication remains fail-closed until authentication, authorization, audit, and endpoint adapters exist. The manifest is not saved or published.', '認証・認可・監査・公開エンドポイントの実装前は安全側に遮断します。マニフェストは保存・公開されません。')}</p></div><button type="button" className="primary" disabled>{text('Publish MCP server', 'MCPサーバーを公開')}</button></section>
      </div>
    </section>
  </main>;
}
