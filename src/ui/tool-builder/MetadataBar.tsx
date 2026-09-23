import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, type ToolApiClient } from '../api/tool-api';
import type { SideEffectDto } from '../api/types';
import { InlineFeedback } from '../components/InlineFeedback';
import { setDesignChatPanelOpen } from './DesignChatPanel';
import { buildSaveDto, missingRequiredMetadata, saveBlocker, useToolBuilderStore, type RequiredMetadataKey, type SaveBlocker } from './store';
import { useI18n } from '../i18n';
import { scope } from '../scope';

type Translate = (english: string, japanese: string) => string;

/** onSaved: 保存が成功した直後に呼ぶ（ToolBuilder側で退避中の下書きを消すために使う）。 */
export function MetadataBar({ client, onSaved }: { readonly client: ToolApiClient; readonly onSaved?: () => void }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const nodes = useToolBuilderStore((state) => state.nodes);
  const setMetadata = useToolBuilderStore((state) => state.setMetadata);
  const currentVersion = useToolBuilderStore((state) => state.currentVersion);
  const versions = useToolBuilderStore((state) => state.versions);
  const setSavedVersion = useToolBuilderStore((state) => state.setSavedVersion);
  const setVersions = useToolBuilderStore((state) => state.setVersions);
  const loadTool = useToolBuilderStore((state) => state.loadTool);
  const setSaveError = useToolBuilderStore((state) => state.setSaveError);
  const propagation = useToolBuilderStore((state) => state.propagation);
  const propagationPending = useToolBuilderStore((state) => state.propagationPending);
  const previewLoading = useToolBuilderStore((state) => state.previewLoading);
  const draftIssue = useToolBuilderStore((state) => state.draftIssue);
  const saveError = useToolBuilderStore((state) => state.saveError);
  const diagnostics = useToolBuilderStore((state) => state.diagnostics);
  const setDiagnostics = useToolBuilderStore((state) => state.setDiagnostics);
  const designChatOpen = useToolBuilderStore((state) => state.designChat.open);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string>();
  const dismissNotice = useCallback(() => setSavedNotice(undefined), []);
  // 呼び出し診断の進行中の要求。新しい要求で前の要求を中断し、遅れて届いた古い結果を新しい結果と取り違えない。
  const diagnoseAborter = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => diagnoseAborter.current?.abort(), []);
  const { text } = useI18n();

  const label: Record<RequiredMetadataKey, string> = {
    internalId: text('Internal ID', '内部ID'),
    workingName: text('Working name', '作業名'),
    displayName: text('Display name', '表示名'),
    publishName: text('Publish name', '公開名'),
  };
  // 保存ガード（優先順）: 必須項目 → function 名 → Agent Input の衝突 → 検証待ち → グラフエラー。
  // どれも入力し直す・繋ぎ直す・待つことで解消でき、押せないまま行き止まりになる状態は作らない。
  const missing = missingRequiredMetadata(metadata);
  const blocker = saveBlocker({ metadata, nodes, propagation, propagationPending, previewLoading, draftIssue });
  const blockerText = blocker === undefined ? undefined : describeBlocker(blocker, label, text);

  async function save(): Promise<void> {
    setSaving(true); setSaveError(undefined); setSavedNotice(undefined);
    try {
      const tool = await client.saveTool(buildSaveDto());
      const nextVersions = await client.listVersions(metadata.internalId, scope);
      setSavedVersion(tool.metadata.version, nextVersions);
      setSavedNotice(tool.metadata.version);
      onSaved?.();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Save failed');
    } finally { setSaving(false); }
  }

  // 保存せずに、保存と同じ DTO でツール呼び出しの前提（function 定義・引数・グラフ・サンプル実行…）を検査する。
  // 検証待ちでは止めない: グラフが壊れているときこそ、どの段階で落ちるかを知りたい。
  async function diagnose(): Promise<void> {
    const controller = new AbortController();
    diagnoseAborter.current?.abort();
    diagnoseAborter.current = controller;
    setDiagnostics('loading');
    // 要求中に別のToolを読み込む・リセットすると diagnostics は消える。その遅延結果は捨てる。
    // 「消えたあとで再要求した」場合、store は再び 'loading' になるので、それだけでは前の要求の結果を
    // 見分けられない。自分の controller が最新であることも条件にする（前の結果を出して新しい結果を捨てない）。
    const current = () => diagnoseAborter.current === controller && useToolBuilderStore.getState().diagnostics === 'loading';
    try {
      const result = await client.diagnoseToolDraft(buildSaveDto(), controller.signal);
      if (current()) setDiagnostics(result);
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      if (current()) setDiagnostics({ failed: cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました') });
    }
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
          <label>{text('Owner', '所有者')}<input aria-label={text('Owner', '所有者')} placeholder={text('Optional (defaults to you)', '省略可（空欄なら自分の名前）')} value={metadata.owner} onChange={(event) => setMetadata('owner', event.target.value)} /></label>
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
          {/* 設計アシスタント（v47）。押すとキャンバスの右にチャットが開く。開閉は覚える。 */}
          <button type="button" className="secondary" aria-pressed={designChatOpen} title={text('Describe the tool you want in plain words and let the assistant edit the canvas.', '作りたいツールを文章で伝えると、アシスタントがキャンバスを編集します。')} onClick={() => setDesignChatPanelOpen(!designChatOpen)}>{text('Design assistant', '設計アシスタント')}</button>
          <button type="button" className="secondary" disabled={missing.length > 0 || diagnostics === 'loading'} title={text('Check whether an Agent could call this Tool as it is now, without saving.', '保存せずに、今の内容でエージェントから呼び出せるかを検査します。')} onClick={() => void diagnose()}>{diagnostics === 'loading' ? text('Diagnosing…', '診断中…') : text('Check readiness', '呼び出し診断')}</button>
          <button type="button" className="primary" disabled={saving || blocker !== undefined} title={blockerText} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
        </div>
        {blockerText !== undefined && <small className={`save-blocker ${blocker?.kind === 'invalid-function-name' || blocker?.kind === 'agent-input-conflict' || blocker?.kind === 'graph-errors' ? 'field-error' : 'empty-state'}`} style={{ textAlign: 'right', maxWidth: '520px' }}>{blockerText}</small>}
        {saveError !== undefined && <div className="api-error" role="alert" style={{ margin: 0, maxWidth: '420px', textAlign: 'right' }}>{saveError}</div>}
        {savedNotice !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={dismissNotice}>{text(`Saved version ${savedNotice}`, `保存しました バージョン ${savedNotice}`)}</InlineFeedback>}
      </div>
    </header>
  );
}

/** 保存できない理由の文言。何を直せば保存できるかまで書く。 */
function describeBlocker(blocker: SaveBlocker, label: Record<RequiredMetadataKey, string>, text: Translate): string {
  switch (blocker.kind) {
    case 'missing-metadata': {
      const missingText = blocker.keys.map((key) => label[key]).join(text(', ', '、'));
      return text(`${missingText} required to save.`, `${missingText}が未入力です。`);
    }
    case 'invalid-function-name':
      return text(
        `"${blocker.name}" is not a valid function name for models. Set an agent-facing name of 1–64 ASCII letters, digits, _ or - in the Agent context panel.`,
        `「${blocker.name}」はモデルへ公開できる function 名ではありません。「エージェント向けコンテキスト」で英数字・_・- の1〜64文字のツール名を設定してください`,
      );
    case 'agent-input-conflict':
      return text('Multiple Agent Input nodes declare different arguments. Keep a single Agent Input node.', 'Agent Inputノードが複数あり引数が一致しません。1つに統合してください');
    case 'validation-pending':
      return text('Waiting for graph validation…', 'グラフ検証の完了を待っています…');
    case 'graph-errors':
      return text('Fix the graph errors before saving so the tool keeps its output contract.', 'グラフにエラーがあるため出力スキーマを確定できません。エラーを直してから保存してください');
  }
}
