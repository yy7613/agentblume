import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { DataSourceDto, DatabaseConnectionDto, DatabaseConnectionStatusDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Request failed'; }
function sourceFormat(file: File): 'csv' | 'json' | undefined {
  const name = file.name.toLowerCase();
  return name.endsWith('.csv') ? 'csv' : name.endsWith('.json') ? 'json' : undefined;
}
function bytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`; }

export function DataSourcesPage({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [sources, setSources] = useState<readonly DataSourceDto[]>([]);
  const [connections, setConnections] = useState<readonly DatabaseConnectionDto[]>([]);
  const [statuses, setStatuses] = useState<Readonly<Record<string, DatabaseConnectionStatusDto>>>({});
  const [selectedFile, setSelectedFile] = useState<File>();
  const [fileName, setFileName] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [defaultSchema, setDefaultSchema] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [uploadedName, setUploadedName] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<{ readonly id: string; readonly name: string }>();

  const refresh = useCallback(async () => {
    try {
      const [nextSources, nextConnections] = await Promise.all([client.listDataSources(scope), client.listDatabaseConnections()]);
      setSources(nextSources); setConnections(nextConnections);
    } catch (cause) { setError(errorText(cause)); }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const upload = useCallback(async () => {
    if (selectedFile === undefined) return;
    const format = sourceFormat(selectedFile);
    if (format === undefined) { setError(text('Select a CSV or JSON file.', 'CSV または JSON ファイルを選択してください。')); return; }
    const name = fileName.trim() || selectedFile.name;
    setBusy(true); setError(undefined); setUploadedName(undefined);
    try {
      await client.uploadDataSourceFile({ scope, name, format, content: await selectedFile.text() });
      setSelectedFile(undefined); setFileName('');
      setUploadedName(name);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }, [client, fileName, refresh, selectedFile, text]);

  const registerDatabase = useCallback(async () => {
    if (connectionId === '') return;
    setBusy(true); setError(undefined);
    try {
      await client.registerDatabaseDataSource({ scope, name: databaseName.trim() || connectionId, connectionId, ...(defaultSchema.trim() === '' ? {} : { defaultSchema: defaultSchema.trim() }) });
      setConnectionId(''); setDatabaseName(''); setDefaultSchema('');
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }, [client, connectionId, databaseName, defaultSchema, refresh]);

  const test = useCallback(async (id: string) => {
    setBusy(true); setError(undefined);
    try { const status = await client.testDatabaseConnection(id, scope); setStatuses((current) => ({ ...current, [id]: status })); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }, [client]);

  const remove = useCallback(async (id: string) => {
    setBusy(true); setError(undefined);
    try { await client.deleteDataSource(id, scope); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }, [client, refresh]);

  return <main className="workspace-page data-sources-page">
    <header className="workspace-header"><div><span className="eyebrow">{text('Data sources', 'データソース')}</span><h1>{text('Data for Tools', 'ツールで扱うデータ')}</h1><p>{text('Upload CSV/JSON once and register database connections whose credentials stay on the server.', 'CSV／JSONを一度アップロードし、資格情報をサーバーだけで管理するDB接続を登録します。')}</p></div></header>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="data-sources-grid">
      <section className="workspace-card"><h2>{text('Upload file', 'ファイルをアップロード')}</h2><p className="data-source-hint">{text('The file body is retained by the backend. Up to 5 MB per CSV or JSON file.', 'ファイル本文はバックエンドで保持します。CSV／JSONを1ファイル最大5 MBまで登録できます。')}</p>
        <label>{text('CSV or JSON file', 'CSV または JSON ファイル')}<input aria-label={text('Data file', 'データファイル')} type="file" accept=".csv,.json,application/json,text/csv" onChange={(event) => { const file = event.currentTarget.files?.[0]; setSelectedFile(file); setFileName(file?.name ?? ''); }} /></label>
        <label>{text('Source name', 'ソース名')}<input aria-label={text('File source name', 'ファイルソース名')} placeholder={text('Leave empty to use the file name', '空の場合はファイル名を使用します')} value={fileName} onChange={(event) => setFileName(event.target.value)} /></label>
        <button type="button" className="primary" disabled={busy || selectedFile === undefined} onClick={() => void upload()}>{text('Upload', 'アップロード')}</button>
        {uploadedName !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={() => setUploadedName(undefined)}>{text(`Registered "${uploadedName}".`, `"${uploadedName}" を登録しました`)}</InlineFeedback>}
      </section>
      <section className="workspace-card"><h2>{text('Database connection', 'データベース接続')}</h2><p className="data-source-hint">{text('Only connection IDs configured by the backend are selectable. Passwords and connection strings never enter this browser.', 'バックエンドで構成済みの接続IDだけを選択できます。パスワードや接続文字列はブラウザに入力・表示されません。')}</p>
        <label>{text('Configured connection', '構成済みの接続')}<select aria-label={text('Database connection ID', 'データベース接続ID')} value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">{text('Select a connection', '接続を選択')}</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.id} · {connection.driver}</option>)}</select></label>
        <label>{text('Source name', 'ソース名')}<input aria-label={text('Database source name', 'データベースソース名')} placeholder={text('e.g. Sales reporting database', '例: 売上レポート用DB')} value={databaseName} onChange={(event) => setDatabaseName(event.target.value)} /></label>
        <label>{text('Default schema (optional)', '既定スキーマ（任意）')}<input aria-label={text('Default database schema', '既定データベーススキーマ')} placeholder={text('e.g. reporting', '例: reporting')} value={defaultSchema} onChange={(event) => setDefaultSchema(event.target.value)} /></label>
        <button type="button" className="primary" disabled={busy || connectionId === ''} onClick={() => void registerDatabase()}>{text('Register connection', '接続を登録')}</button>
        {connections.length === 0 && <p className="empty-state">{text('No database connections are configured. Set AGENTCONTEXT_DB_CONNECTIONS on the backend.', 'DB接続が構成されていません。バックエンドで AGENTCONTEXT_DB_CONNECTIONS を設定してください。')}</p>}
      </section>
    </div>
    <section className="workspace-card data-source-list"><h2>{text('Registered sources', '登録済みソース')}</h2>
      {sources.length === 0 ? <p className="empty-state">{text('No data sources yet.', 'データソースはまだありません。')}</p> : <div className="data-source-rows">{sources.map((source) => {
        const status = source.kind === 'database' ? statuses[source.connectionId] : undefined;
        return <article className="data-source-row" key={source.id}><div><strong>{source.name}</strong><code>{source.kind === 'file' ? `${source.format.toUpperCase()} · ${bytes(source.sizeBytes)}` : `${source.driver} · ${source.connectionId}${source.defaultSchema === undefined ? '' : ` · ${source.defaultSchema}`}`}</code>{status !== undefined && <small className={status.available ? 'connection-ready' : 'connection-unavailable'}>{status.available ? text('Connection available', '接続可能') : `${text('Unavailable', '利用不可')}: ${status.error ?? ''}`}</small>}</div><div className="data-source-actions">{source.kind === 'database' && <button type="button" className="secondary" disabled={busy} onClick={() => void test(source.connectionId)}>{text('Test', '接続テスト')}</button>}<button type="button" className="secondary danger" disabled={busy} onClick={() => setPendingDelete({ id: source.id, name: source.name })}>{text('Remove', '削除')}</button></div></article>;
      })}</div>}
    </section>
    <ConfirmDialog
      open={pendingDelete !== undefined}
      title={text('Remove data source', 'データソースの削除')}
      message={text(`Remove "${pendingDelete?.name ?? ''}"? This cannot be undone.`, `"${pendingDelete?.name ?? ''}" を削除しますか？この操作は元に戻せません。`)}
      confirmLabel={text('Remove', '削除')}
      cancelLabel={text('Cancel', 'キャンセル')}
      danger
      busy={busy}
      onConfirm={() => { if (pendingDelete === undefined) return; void remove(pendingDelete.id).then(() => setPendingDelete(undefined)); }}
      onCancel={() => setPendingDelete(undefined)}
    />
  </main>;
}
