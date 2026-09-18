import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError, type ToolApiClient } from '../api/tool-api';
import type { SaveToolCheckCaseDto, SerializedToolDto, ToolCheckCaseDto, ToolCheckCaseRunDto, ToolCheckRunResultDto, ToolCheckSuggestionDto, ToolSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { useI18n } from '../i18n';
import { ScreenLink } from '../navigation';
import { scope } from '../scope';
import { useReportUnsavedChanges } from '../unsaved-changes';
import { ArgumentForm } from './ArgumentForm';
import { CaseList } from './CaseList';
import { ExpectationEditor } from './ExpectationEditor';
import { ResultPanel } from './ResultPanel';
import { SuggestionPanel } from './SuggestionPanel';
import {
  EMPTY_EXPECTATIONS, aiJudgeNodes, argumentIssues, argumentNamesInMessage, buildArguments, buildExpectations, buildRunDto,
  editorFingerprint, editorFromCase, editorFromSuggestion, initialDrafts, isExpectedFailure, statusLabel, summarizeStatuses, type EditorState,
} from './tool-check-model';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyEditor(toolId: string): EditorState {
  return { toolId, version: '', caseName: '', drafts: {}, expectations: EMPTY_EXPECTATIONS };
}

type PendingAction = { readonly kind: 'discard'; readonly run: () => void } | { readonly kind: 'delete'; readonly item: ToolCheckCaseDto };

/**
 * ツール検証（Tool Check）画面。保存済みツールを引数付きで単体実行し、期待（行数・列・セル条件・所要時間）との
 * 合否を出す。左列が保存済みケース、右のエディタが引数・期待・結果。
 *
 * 失敗の見せ方は他画面と揃える: **次の一手 → 原因 → 失敗箇所 → 直す場所へのボタン**（ResultPanel → RunFailureNotice）。
 * サーバーの実装（src/application/tool-check）と DTO（src/ui/api/types.ts 末尾）を対で保守する。
 */
export function ToolCheckPage({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>();
  const [toolsError, setToolsError] = useState<string>();
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor(''));
  const [baseline, setBaseline] = useState(() => editorFingerprint(emptyEditor('')));
  const [versions, setVersions] = useState<readonly string[]>([]);
  const [definition, setDefinition] = useState<SerializedToolDto>();
  const [definitionError, setDefinitionError] = useState<string>();
  const [cases, setCases] = useState<readonly ToolCheckCaseDto[]>([]);
  const [casesError, setCasesError] = useState<string>();
  const [caseResults, setCaseResults] = useState<ReadonlyMap<string, ToolCheckRunResultDto>>(new Map());
  const [editingCaseId, setEditingCaseId] = useState<string>();
  const [result, setResult] = useState<ToolCheckRunResultDto>();
  const [runError, setRunError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  /** 実行中のリクエストを中断するための controller。存在＝中断できる実行が走っている。 */
  const [aborter, setAborter] = useState<AbortController>();
  const [runningCaseId, setRunningCaseId] = useState<string>();
  const [runningAll, setRunningAll] = useState(false);
  const [runAllResults, setRunAllResults] = useState<readonly ToolCheckCaseRunDto[]>();
  const [runAllError, setRunAllError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [feedback, setFeedback] = useState<{ readonly kind: 'success' | 'error' | 'info'; readonly text: string }>();
  const [pending, setPending] = useState<PendingAction>();
  const [onlySelectedTool, setOnlySelectedTool] = useState(false);
  /** LLM 提案が使えるか。undefined = 問い合わせ中。取得に失敗したら false（使えないものとして扱う）。 */
  const [suggestionCapability, setSuggestionCapability] = useState<boolean>();
  const [suggestOpen, setSuggestOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const elapsedSeconds = useElapsedSeconds(aborter !== undefined);

  const dirty = editorFingerprint(editor) !== baseline;
  useReportUnsavedChanges('tool-check', dirty);
  // 定義の読込後に既定値を埋めるとき、その時点で未保存だったかを見るため最新値を ref で持つ。
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const busy = aborter !== undefined || runningCaseId !== undefined || runningAll || saving;
  const selectedTool = tools?.find((tool) => tool.internalId === editor.toolId);

  const reloadCases = useCallback(async () => {
    try { setCases(await client.listToolCheckCases(scope)); setCasesError(undefined); }
    catch (cause: unknown) { setCasesError(messageOf(cause)); }
  }, [client]);

  // ツール一覧。初回は先頭のツールを選ぶ（保存済みケースを開いたときは上書きされる）。
  useEffect(() => {
    let active = true;
    void client.listTools(scope)
      .then((all) => {
        if (!active) return;
        setTools(all);
        setToolsError(undefined);
        const first = all[0]?.internalId;
        if (first !== undefined) {
          setEditor((current) => (current.toolId === '' ? emptyEditor(first) : current));
          setBaseline((current) => (current === editorFingerprint(emptyEditor('')) ? editorFingerprint(emptyEditor(first)) : current));
        }
      })
      .catch((cause: unknown) => { if (active) { setTools([]); setToolsError(messageOf(cause)); } });
    return () => { active = false; };
  }, [client]);

  useEffect(() => { void reloadCases(); }, [reloadCases]);

  // LLM 提案の可否は起動時に 1 回だけ確認する（設定を変えたらこの画面を開き直す）。
  useEffect(() => {
    let active = true;
    // 同期例外（古いクライアント等）も「使えない」に倒すため、Promise の中で呼ぶ。
    void Promise.resolve().then(() => client.toolCheckSuggestionCapability())
      .then((enabled) => { if (active) setSuggestionCapability(enabled); })
      .catch(() => { if (active) setSuggestionCapability(false); });
    return () => { active = false; };
  }, [client]);

  // 選択ツールの版一覧。
  useEffect(() => {
    if (editor.toolId === '') { setVersions([]); return; }
    let active = true;
    void client.listVersions(editor.toolId, scope)
      .then((all) => { if (active) setVersions(all); })
      .catch(() => { if (active) setVersions([]); });
    return () => { active = false; };
  }, [client, editor.toolId]);

  // 選択ツール（+版）の定義。入力スキーマから引数欄を作り、出力スキーマで期待の列候補を出す。
  useEffect(() => {
    if (editor.toolId === '') { setDefinition(undefined); return; }
    let active = true;
    setDefinitionError(undefined);
    void client.getTool(editor.toolId, scope, editor.version === '' ? undefined : editor.version)
      .then((loaded) => {
        if (!active) return;
        setDefinition(loaded);
        // 引数欄の既定値（boolean の 'false' など）を、まだ無いキーだけ埋める。ケースから開いた値は上書きしない。
        // 既定値を埋めた直後を「未保存」と見せないため、読込前に未保存でなければ基準も進める。
        const current = editorRef.current;
        const merged = { ...current, drafts: { ...initialDrafts(loaded.inputSchema), ...current.drafts } };
        setEditor(merged);
        if (!dirtyRef.current) setBaseline(editorFingerprint(merged));
      })
      .catch((cause: unknown) => { if (active) { setDefinition(undefined); setDefinitionError(messageOf(cause)); } });
    return () => { active = false; };
  }, [client, editor.toolId, editor.version]);

  const resetTo = (next: EditorState, caseId: string | undefined) => {
    setEditor(next);
    setBaseline(editorFingerprint(next));
    setEditingCaseId(caseId);
    setResult(undefined);
    setRunError(undefined);
    setCancelled(false);
    setNameError(undefined);
    setFeedback(undefined);
  };

  /** 編集中の内容を捨てる操作は、未保存なら確認を挟む。 */
  const guard = (run: () => void) => {
    if (dirty) setPending({ kind: 'discard', run });
    else run();
  };

  const switchTool = (toolId: string) => guard(() => resetTo(emptyEditor(toolId), undefined));
  const startNew = () => guard(() => resetTo(emptyEditor(editor.toolId), undefined));
  const openCase = (item: ToolCheckCaseDto) => guard(() => {
    resetTo(editorFromCase(item, item.toolId === definition?.metadata.internalId ? definition.inputSchema : undefined), item.id);
    const known = caseResults.get(item.id);
    if (known !== undefined) setResult(known);
  });

  const inputColumns = definition?.inputSchema?.columns ?? [];
  const issues = useMemo(() => argumentIssues(definition?.inputSchema, editor.drafts), [definition, editor.drafts]);
  // AI判定の期待は、選んだツールのグラフに ai-judge ノードがあるときだけ編集できる（無ければ節ごと出さない）。
  const judgeNodes = useMemo(() => aiJudgeNodes(definition?.graph), [definition]);
  // 期待どおりの失敗（outcome = error で合格）は直す対象ではないので、引数欄も強調しない。
  const highlighted = useMemo(
    () => (result !== undefined && !isExpectedFailure(result) && result.error?.code === 'TOOL_ARGUMENTS' ? argumentNamesInMessage(result.error.message, inputColumns.map((column) => column.name)) : []),
    [result, inputColumns],
  );

  const focusArgument = (name: string) => {
    const element = document.getElementById(`tool-check-arg-${name}`);
    if (element === null) return;
    element.focus();
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
  };

  const run = async () => {
    if (definition === undefined || aborter !== undefined) return;
    if (Object.keys(issues).length > 0) {
      setRunError(text('Fix the highlighted arguments before running.', '赤く示した引数を直してから実行してください'));
      focusArgument(Object.keys(issues)[0] ?? '');
      return;
    }
    const controller = new AbortController();
    setAborter(controller);
    setRunError(undefined);
    setCancelled(false);
    setFeedback(undefined);
    try {
      const next = await client.runToolCheck(buildRunDto(editor, scope, definition.inputSchema, definition.outputSchema), controller.signal);
      setResult(next);
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else setRunError(messageOf(cause));
    } finally {
      setAborter(undefined);
    }
  };

  const save = async () => {
    const name = editor.caseName.trim();
    if (name === '') {
      setNameError(text('Enter a case name before saving.', 'ケース名を入力してから保存してください'));
      nameRef.current?.focus();
      return;
    }
    if (definition === undefined) return;
    setNameError(undefined);
    setSaving(true);
    try {
      const dto: SaveToolCheckCaseDto = {
        scope,
        ...(editingCaseId === undefined ? {} : { id: editingCaseId }),
        toolId: editor.toolId,
        ...(editor.version === '' ? {} : { toolVersion: editor.version }),
        name,
        arguments: buildArguments(definition.inputSchema, editor.drafts),
        expectations: buildExpectations(editor.expectations, definition.outputSchema) ?? {},
      };
      const saved = await client.saveToolCheckCase(dto);
      const next = { ...editor, caseName: name };
      setEditor(next);
      setBaseline(editorFingerprint(next));
      setEditingCaseId(saved.id);
      setFeedback({ kind: 'success', text: editingCaseId === undefined ? text(`Saved case "${saved.name}".`, `ケース「${saved.name}」を保存しました`) : text(`Updated case "${saved.name}".`, `ケース「${saved.name}」を上書き保存しました`) });
      await reloadCases();
    } catch (cause: unknown) {
      setFeedback({ kind: 'error', text: text(`Could not save the case: ${messageOf(cause)}`, `ケースを保存できませんでした: ${messageOf(cause)}`) });
    } finally {
      setSaving(false);
    }
  };

  const deleteCase = async (item: ToolCheckCaseDto) => {
    setPending(undefined);
    try {
      await client.deleteToolCheckCase(item.id, scope);
      if (editingCaseId === item.id) setEditingCaseId(undefined);
      setCaseResults((current) => { const next = new Map(current); next.delete(item.id); return next; });
      setFeedback({ kind: 'success', text: text(`Deleted case "${item.name}".`, `ケース「${item.name}」を削除しました`) });
      await reloadCases();
    } catch (cause: unknown) {
      setFeedback({ kind: 'error', text: text(`Could not delete the case: ${messageOf(cause)}`, `ケースを削除できませんでした: ${messageOf(cause)}`) });
    }
  };

  const applyCaseRun = (runs: readonly ToolCheckCaseRunDto[]) => {
    setCaseResults((current) => { const next = new Map(current); for (const item of runs) next.set(item.case.id, item.result); return next; });
    setCases((current) => current.map((existing) => runs.find((item) => item.case.id === existing.id)?.case ?? existing));
    const open = runs.find((item) => item.case.id === editingCaseId);
    if (open !== undefined) setResult(open.result);
  };

  const runCase = async (item: ToolCheckCaseDto) => {
    setRunningCaseId(item.id);
    setFeedback(undefined);
    try { applyCaseRun([await client.runToolCheckCase(item.id, scope)]); }
    catch (cause: unknown) { setFeedback({ kind: 'error', text: text(`Could not run case "${item.name}": ${messageOf(cause)}`, `ケース「${item.name}」を実行できませんでした: ${messageOf(cause)}`) }); }
    finally { setRunningCaseId(undefined); }
  };

  const runAll = async () => {
    setRunningAll(true);
    setRunAllError(undefined);
    setRunAllResults(undefined);
    try {
      const runs = await client.runAllToolCheckCases(scope, onlySelectedTool && editor.toolId !== '' ? editor.toolId : undefined);
      applyCaseRun(runs);
      setRunAllResults(runs);
    } catch (cause: unknown) {
      setRunAllError(messageOf(cause));
    } finally {
      setRunningAll(false);
    }
  };

  /**
   * 提案をエディタに読み込む。未保存の編集があれば確認を挟む。基準（baseline）は進めないので、読み込んだ直後から
   * 「未保存」になる（保存するかどうかを利用者が決める）。実行済みなら結果も結果欄に出す。
   */
  const loadSuggestion = (suggestion: ToolCheckSuggestionDto, known: ToolCheckRunResultDto | undefined) => guard(() => {
    setEditor(editorFromSuggestion(suggestion, { toolId: editor.toolId, version: editor.version }, definition?.inputSchema));
    setEditingCaseId(undefined);
    setResult(known);
    setRunError(undefined);
    setCancelled(false);
    setNameError(undefined);
    setFeedback({ kind: 'info', text: text(`Loaded suggestion "${suggestion.name}" into the editor. Adjust it if needed, then save it as a case.`, `提案「${suggestion.name}」をエディタに読み込みました。必要なら直して、ケースとして保存してください。`) });
    nameRef.current?.focus();
  });

  const suggestionSaved = (saved: ToolCheckCaseDto) => {
    setFeedback({ kind: 'success', text: text(`Saved case "${saved.name}".`, `ケース「${saved.name}」を保存しました`) });
    void reloadCases();
  };

  const suggestDisabledReason = suggestionCapability === false
    ? text('The configured model does not support structured output. Choose one in Settings.', '設定中のモデルが構造化出力に対応していないため使えません。設定画面で対応モデルを選んでください')
    : undefined;

  const visibleCases = onlySelectedTool && editor.toolId !== '' ? cases.filter((item) => item.toolId === editor.toolId) : cases;
  const summary = runAllResults === undefined ? undefined : summarizeStatuses(runAllResults.map((item) => item.result.status));

  return (
    <main className="workspace-page tool-check-page">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">{text('Check', '確かめる')}</span>
          <h1>{text('Tool Check', 'ツール検証')}</h1>
          <p>{text('Run a saved tool by itself with the arguments an agent would pass, and compare the output with what you expect.', '保存済みツールを、エージェントが渡すのと同じ引数で単体実行し、期待する結果と比べます。')}</p>
        </div>
        <div className="save-actions tool-check-toolbar">
          <label className="tool-check-toolbar-field">
            <span>{text('Tool', 'ツール')}</span>
            <select aria-label={text('Tool', 'ツール')} value={editor.toolId} disabled={busy || tools === undefined || tools.length === 0} onChange={(event) => switchTool(event.target.value)}>
              {(tools ?? []).map((tool) => <option key={tool.internalId} value={tool.internalId}>{tool.displayName} ({tool.publishName})</option>)}
            </select>
          </label>
          <label className="tool-check-toolbar-field">
            <span>{text('Version', 'バージョン')}</span>
            <select aria-label={text('Tool version', 'ツールのバージョン')} value={editor.version} disabled={busy || editor.toolId === ''} onChange={(event) => setEditor((current) => ({ ...current, version: event.target.value }))}>
              <option value="">{text('latest', '最新')}{selectedTool === undefined ? '' : ` (${selectedTool.latestVersion})`}</option>
              {versions.map((version) => <option key={version} value={version}>{version}</option>)}
            </select>
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={onlySelectedTool} onChange={(event) => setOnlySelectedTool(event.target.checked)} />
            {text('Selected tool only', '選択中のツールのみ')}
          </label>
          <button type="button" className="primary" disabled={busy || visibleCases.length === 0} onClick={() => void runAll()}>{runningAll ? text('Running all…', 'すべて実行中…') : text('Run all', 'すべて実行')}</button>
        </div>
      </header>

      {toolsError !== undefined && <div className="api-error" role="alert">{text('Could not load tools: ', 'ツール一覧を読み込めませんでした: ')}{toolsError}</div>}
      {tools !== undefined && tools.length === 0 && toolsError === undefined && (
        <p className="empty-state">
          {text('No saved tools yet. ', '保存済みのツールがまだありません。')}
          <ScreenLink to="Tool">{text('Open the Tool screen to build one', 'ツール画面で作る')}</ScreenLink>
          {text(', then come back to check it here.', '。保存したらここで検証できます。')}
        </p>
      )}

      <div className="two-column-workspace tool-check-layout">
        <section className="workspace-card tool-check-cases-card" aria-labelledby="tool-check-cases-heading">
          <div className="panel-title"><h2 id="tool-check-cases-heading">{text('Saved cases', '保存済みケース')}</h2></div>
          {casesError !== undefined && <div className="api-error" role="alert">{text('Could not load cases: ', 'ケース一覧を読み込めませんでした: ')}{casesError}</div>}
          {runAllError !== undefined && <div className="api-error" role="alert">{text('Run all failed: ', 'すべて実行に失敗しました: ')}{runAllError}</div>}
          {summary !== undefined && runAllResults !== undefined && (
            <div className="tool-check-run-all" role="status">
              <strong>{text(`Run all: ${summary.passed} passed / ${summary.failed} failed / ${summary.error} error`, `すべて実行: 合格 ${summary.passed} / 不合格 ${summary.failed} / エラー ${summary.error}`)}</strong>
              <ul>
                {runAllResults.map((item) => {
                  const [statusEn, statusJa] = statusLabel(item.result.status);
                  return <li key={item.case.id}><span className={`run-status tool-check-chip ${item.result.status}`}>{text(statusEn, statusJa)}</span> <span className="tool-check-name">{item.case.name}</span></li>;
                })}
              </ul>
            </div>
          )}
          <CaseList
            cases={visibleCases}
            tools={tools ?? []}
            results={caseResults}
            selectedId={editingCaseId}
            busyId={runningCaseId}
            disabled={busy}
            onRun={(item) => void runCase(item)}
            onOpen={openCase}
            onDelete={(item) => setPending({ kind: 'delete', item })}
          />
        </section>

        <section className="workspace-card tool-check-editor" aria-labelledby="tool-check-editor-heading">
          <div className="panel-title">
            <h2 id="tool-check-editor-heading">{editingCaseId === undefined ? text('New check', '新しい検証') : text(`Case: ${editor.caseName}`, `ケース: ${editor.caseName}`)}</h2>
            <div className="tool-check-editor-actions">
              <button type="button" className="secondary" disabled={busy} onClick={startNew}>{text('New', '新規')}</button>
              <button
                type="button"
                className="secondary"
                disabled={busy || suggestionCapability !== true || editor.toolId === ''}
                aria-pressed={suggestOpen}
                {...(suggestDisabledReason === undefined ? {} : { title: suggestDisabledReason })}
                onClick={() => setSuggestOpen((open) => !open)}
              >
                {text('Suggest cases with the model', 'LLMでケースを提案')}
              </button>
              {suggestDisabledReason !== undefined && (
                <small className="tool-check-suggest-disabled">
                  {suggestDisabledReason}{' '}
                  <ScreenLink to="Settings">{text('Open Settings', '設定画面を開く')}</ScreenLink>
                </small>
              )}
            </div>
          </div>
          {suggestOpen && editor.toolId !== '' && (
            <SuggestionPanel
              client={client}
              scope={scope}
              toolId={editor.toolId}
              version={editor.version}
              inputSchema={definition?.inputSchema}
              disabled={busy}
              onLoad={loadSuggestion}
              onSaved={suggestionSaved}
              onClose={() => setSuggestOpen(false)}
            />
          )}
          {definitionError !== undefined && <div className="api-error" role="alert">{text('Could not load the tool definition: ', 'ツール定義を読み込めませんでした: ')}{definitionError}</div>}
          {editor.toolId !== '' && (
            <>
              <ArgumentForm
                schema={definition?.inputSchema}
                {...(definition?.agentTool === undefined ? {} : { description: definition.agentTool.description })}
                drafts={editor.drafts}
                highlighted={highlighted}
                issues={issues}
                disabled={busy}
                onChange={(name, draft) => setEditor((current) => ({ ...current, drafts: { ...current.drafts, [name]: draft } }))}
              />
              <ExpectationEditor draft={editor.expectations} outputSchema={definition?.outputSchema} judgeNodes={judgeNodes} disabled={busy} onChange={(expectations) => setEditor((current) => ({ ...current, expectations }))} />
              <div className="tool-check-actions">
                <button type="button" className="primary" disabled={busy || definition === undefined} onClick={() => void run()}>
                  {aborter === undefined ? text('Run', '実行') : text(`Running… ${elapsedSeconds}s`, `実行中… ${elapsedSeconds}秒`)}
                </button>
                {aborter !== undefined && <button type="button" className="secondary" onClick={() => aborter.abort()}>{text('Cancel', '中断')}</button>}
                <label className="tool-check-name-field">
                  <span>{text('Case name', 'ケース名')}</span>
                  <input ref={nameRef} type="text" value={editor.caseName} disabled={busy} aria-invalid={nameError === undefined ? undefined : true} onChange={(event) => { setNameError(undefined); setEditor((current) => ({ ...current, caseName: event.target.value })); }} />
                </label>
                <button type="button" className="secondary" disabled={busy || definition === undefined} onClick={() => void save()}>
                  {editingCaseId === undefined ? text('Save as case', 'ケースとして保存') : text('Overwrite case', '上書き保存')}
                </button>
              </div>
              {nameError !== undefined && <p className="field-error" role="alert">{nameError}</p>}
              {feedback !== undefined && <InlineFeedback kind={feedback.kind}>{feedback.text}</InlineFeedback>}
              {runError !== undefined && <div className="api-error" role="alert">{runError}</div>}
              {cancelled && <InlineFeedback kind="info">{text('Cancelled. Nothing was checked.', '中断しました。検証は行われていません。')}</InlineFeedback>}
              {result !== undefined && <ResultPanel result={result} argumentFields={highlighted} onFocusArgument={focusArgument} />}
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={pending !== undefined}
        title={pending?.kind === 'delete' ? text('Delete this case?', 'このケースを削除しますか') : text('Discard unsaved changes?', '編集中の内容を破棄しますか')}
        message={pending?.kind === 'delete'
          ? text(`"${pending.item.name}" will be removed. This cannot be undone.`, `「${pending.item.name}」を削除します。元に戻せません。`)
          : text('The arguments and expectations you edited have not been saved as a case.', '編集した引数と期待はケースとして保存されていません。')}
        confirmLabel={pending?.kind === 'delete' ? text('Delete', '削除する') : text('Discard', '破棄する')}
        cancelLabel={text('Cancel', 'キャンセル')}
        danger
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (pending === undefined) return;
          if (pending.kind === 'delete') void deleteCase(pending.item);
          else { setPending(undefined); pending.run(); }
        }}
      />
    </main>
  );
}
