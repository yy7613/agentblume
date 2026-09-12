import { useState } from 'react';
import { localizeRunTraceError, localizeToolCheckAssertion } from '../api/error-messages';
import { isAbortError, type ToolApiClient } from '../api/tool-api';
import type { JsonCell, SaveToolCheckCaseDto, SchemaDto, TenantScopeDto, ToolCheckCaseDto, ToolCheckRunResultDto, ToolCheckSuggestionDto, ToolCheckSuggestionsDto } from '../api/types';
import { InlineFeedback } from '../components/InlineFeedback';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
import { useI18n } from '../i18n';
import { ScreenLink } from '../navigation';
import {
  PER_CATEGORY_DEFAULT, PER_CATEGORY_MAX, PER_CATEGORY_MIN, ROW_LIMIT, buildSuggestDto, categoryLabel, clampPerCategory, groupSuggestions,
  isExpectedFailure, statusLabel, summarizeExpectations,
} from './tool-check-model';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function displayCell(value: JsonCell): string {
  return value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);
}

/** 提案1件の実行状態。running → done（結果あり）/ error（実行要求そのものが失敗）。 */
type RunState = { readonly kind: 'running' } | { readonly kind: 'done'; readonly result: ToolCheckRunResultDto } | { readonly kind: 'error'; readonly message: string };

/**
 * 「LLM でケースを提案」のインラインパネル。ツール定義（入力スキーマ・説明・出力スキーマ）からモデルが
 * 正常 / 境界 / 異常 のケース案を作り、利用者がレビューして **実行して確認 → エディタに読み込む / 保存** する。
 * 提案そのものはサーバーに保存されない（保存はケースとして明示的に行う）。
 *
 * 失敗の見せ方は他画面と同じ「原因 → 次の一手 → 直す場所へのボタン」: 502 MODEL_PROVIDER は error-messages.ts で
 * 「設定画面で構造化出力対応のモデルを確認」等の文言になり、ここでは設定画面へのリンクを添える。
 */
export function SuggestionPanel({ client, scope, toolId, version, inputSchema, disabled, onLoad, onSaved, onClose }: {
  readonly client: ToolApiClient;
  readonly scope: TenantScopeDto;
  readonly toolId: string;
  /** '' = 最新版（DTO には載せない）。 */
  readonly version: string;
  readonly inputSchema: SchemaDto | undefined;
  /** 画面側が別の操作中（実行・保存）のときは、提案の操作も止める。 */
  readonly disabled: boolean;
  /** 「エディタに読み込む」。直近の実行結果があれば一緒に渡し、エディタ側の結果欄に出す。 */
  readonly onLoad: (suggestion: ToolCheckSuggestionDto, result: ToolCheckRunResultDto | undefined) => void;
  /** 「保存」でケースが増えたとき（一覧の再読込と通知は画面側が担う）。 */
  readonly onSaved: (saved: ToolCheckCaseDto) => void;
  readonly onClose: () => void;
}) {
  const { text, language } = useI18n();
  const [perCategory, setPerCategory] = useState(String(PER_CATEGORY_DEFAULT));
  const [focus, setFocus] = useState('');
  const [aborter, setAborter] = useState<AbortController>();
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const [response, setResponse] = useState<ToolCheckSuggestionsDto>();
  const [runs, setRuns] = useState<ReadonlyMap<number, RunState>>(new Map());
  const [saved, setSaved] = useState<ReadonlySet<number>>(new Set());
  const [savingIndex, setSavingIndex] = useState<number>();
  const [bulk, setBulk] = useState<'save' | 'run'>();
  const [saveError, setSaveError] = useState<string>();
  const elapsedSeconds = useElapsedSeconds(aborter !== undefined);

  const loading = aborter !== undefined;
  const runningAny = [...runs.values()].some((state) => state.kind === 'running');
  const frozen = disabled || loading || savingIndex !== undefined || bulk !== undefined || runningAny;

  const suggest = async () => {
    if (loading) return;
    const controller = new AbortController();
    setAborter(controller);
    setError(undefined);
    setCancelled(false);
    setResponse(undefined);
    setRuns(new Map());
    setSaved(new Set());
    setSaveError(undefined);
    try {
      setResponse(await client.suggestToolCheckCases(buildSuggestDto({ toolId, version, perCategory: clampPerCategory(perCategory), focus }, scope), controller.signal));
    } catch (cause: unknown) {
      if (isAbortError(cause)) setCancelled(true);
      else setError(messageOf(cause));
    } finally {
      setAborter(undefined);
    }
  };

  const setRun = (index: number, state: RunState) => setRuns((current) => { const next = new Map(current); next.set(index, state); return next; });

  const runOne = async (index: number, suggestion: ToolCheckSuggestionDto) => {
    setRun(index, { kind: 'running' });
    try {
      const result = await client.runToolCheck({
        scope,
        toolId,
        ...(version === '' ? {} : { version }),
        arguments: suggestion.arguments,
        ...(Object.keys(suggestion.expectations).length === 0 ? {} : { expectations: suggestion.expectations }),
        rowLimit: ROW_LIMIT,
      });
      setRun(index, { kind: 'done', result });
    } catch (cause: unknown) {
      setRun(index, { kind: 'error', message: messageOf(cause) });
    }
  };

  const saveOne = async (index: number, suggestion: ToolCheckSuggestionDto): Promise<boolean> => {
    setSavingIndex(index);
    setSaveError(undefined);
    try {
      const dto: SaveToolCheckCaseDto = {
        scope,
        toolId,
        ...(version === '' ? {} : { toolVersion: version }),
        name: suggestion.name,
        arguments: suggestion.arguments,
        expectations: suggestion.expectations,
      };
      const item = await client.saveToolCheckCase(dto);
      setSaved((current) => new Set(current).add(index));
      onSaved(item);
      return true;
    } catch (cause: unknown) {
      setSaveError(text(`Could not save "${suggestion.name}": ${messageOf(cause)}`, `「${suggestion.name}」を保存できませんでした: ${messageOf(cause)}`));
      return false;
    } finally {
      setSavingIndex(undefined);
    }
  };

  /** 未保存の提案を順に保存する。1件失敗したらそこで止める（同じ原因で全件失敗するのを避ける）。 */
  const saveAll = async () => {
    if (response === undefined) return;
    setBulk('save');
    try {
      for (const [index, suggestion] of response.suggestions.entries()) {
        if (saved.has(index)) continue;
        if (!(await saveOne(index, suggestion))) break;
      }
    } finally {
      setBulk(undefined);
    }
  };

  /** 全提案を順に実行する（サーバー負荷を抑えるため直列）。1件のエラーは他に影響しない。 */
  const runAll = async () => {
    if (response === undefined) return;
    setBulk('run');
    try {
      for (const [index, suggestion] of response.suggestions.entries()) await runOne(index, suggestion);
    } finally {
      setBulk(undefined);
    }
  };

  const groups = response === undefined ? [] : groupSuggestions(response.suggestions);
  const unsavedCount = response === undefined ? 0 : response.suggestions.filter((_, index) => !saved.has(index)).length;

  return (
    <section className="tool-check-suggest" aria-label={text('Case suggestions from the model', 'LLM によるケース提案')}>
      <div className="tool-check-suggest-head">
        <h3>{text('Suggest cases with the model', 'LLMでケースを提案')}</h3>
        <button type="button" className="secondary" onClick={onClose} disabled={loading}>{text('Close', '閉じる')}</button>
      </div>
      <p className="tool-check-hint">{text('The model reads the tool definition and proposes normal, boundary and abnormal cases. Review each one, run it to confirm, then save the ones you want to keep.', 'モデルがツール定義を読み、正常 / 境界 / 異常 のケース案を作ります。1件ずつ確認し、実行して結果を見てから、残したいものを保存してください。')}</p>

      <div className="tool-check-suggest-options">
        <label className="tool-check-toolbar-field">
          <span>{text('Cases per category', 'カテゴリごとの件数')}</span>
          <input
            type="number"
            aria-label={text('Cases per category', 'カテゴリごとの件数')}
            min={PER_CATEGORY_MIN}
            max={PER_CATEGORY_MAX}
            step={1}
            value={perCategory}
            disabled={loading}
            onChange={(event) => setPerCategory(event.target.value)}
            // 範囲外（0 / 6 など）は欄を離れたときに 1〜5 へ丸める。送信時にも同じ丸めをかける。
            onBlur={() => setPerCategory(String(clampPerCategory(perCategory)))}
          />
        </label>
        <label className="tool-check-toolbar-field tool-check-suggest-focus">
          <span>{text('Focus (optional)', '重点（任意）')}</span>
          <input type="text" aria-label={text('Focus (optional)', '重点（任意）')} value={focus} disabled={loading} placeholder={text('e.g. price boundaries, empty region', '例: 価格の境界、空の地域')} onChange={(event) => setFocus(event.target.value)} />
        </label>
        <button type="button" className="primary" disabled={disabled || loading} onClick={() => void suggest()}>
          {loading ? text(`Suggesting… ${elapsedSeconds}s`, `提案を作成中… ${elapsedSeconds}秒`) : text('Create suggestions', '提案を作成')}
        </button>
        {loading && <button type="button" className="secondary" onClick={() => aborter?.abort()}>{text('Cancel', '中断')}</button>}
      </div>

      {loading && <p className="tool-check-suggest-progress" role="status">{text('Asking the model for cases. This can take a while for tools with many arguments.', 'モデルにケース案を問い合わせています。引数の多いツールでは時間がかかることがあります。')}</p>}
      {cancelled && <InlineFeedback kind="info">{text('Cancelled. No suggestions were made.', '中断しました。提案は作られていません。')}</InlineFeedback>}
      {error !== undefined && (
        <div className="api-error" role="alert">
          {error}{' '}
          <ScreenLink to="Settings">{text('Open Settings', '設定画面を開く')}</ScreenLink>
        </div>
      )}

      {response !== undefined && (
        <div className="tool-check-suggest-results">
          <div className="tool-check-suggest-toolbar">
            <span className="tool-check-suggest-count">
              {text(`${response.suggestions.length} suggestion${response.suggestions.length === 1 ? '' : 's'}`, `提案 ${response.suggestions.length} 件`)}
              {response.model !== undefined && <small className="tool-check-suggest-model"> · {response.model.provider} / {response.model.model}</small>}
            </span>
            {response.suggestions.length > 0 && (
              <div className="tool-check-suggest-bulk">
                <button type="button" className="secondary" disabled={frozen} onClick={() => void runAll()}>{bulk === 'run' ? text('Running all…', 'すべて実行中…') : text('Run all', 'すべて実行')}</button>
                <button type="button" className="secondary" disabled={frozen || unsavedCount === 0} onClick={() => void saveAll()}>{bulk === 'save' ? text('Saving all…', 'すべて保存中…') : text('Save all', 'すべて保存')}</button>
              </div>
            )}
          </div>
          {response.warnings.length > 0 && (
            <ul className="tool-check-suggest-warnings" aria-label={text('Notes about these suggestions', '提案全体への注意')}>
              {response.warnings.map((warning, index) => <li key={index}>⚠ {warning}</li>)}
            </ul>
          )}
          {saveError !== undefined && <div className="api-error" role="alert">{saveError}</div>}
          {response.suggestions.length === 0 && (
            <p className="empty-state">{text('The model returned no cases. Make the focus more specific or increase the count, then try again.', 'モデルはケースを返しませんでした。「重点」を具体的に書くか件数を増やして、もう一度提案してください。')}</p>
          )}
          {response.suggestions.length > 0 && groups.map((group) => {
            const [categoryEn, categoryJa] = categoryLabel(group.category);
            return (
              <div key={group.category} className="tool-check-suggest-group">
                <h4><span className={`tool-check-category ${group.category}`}>{text(categoryEn, categoryJa)}</span> <span className="tool-check-suggest-group-count">{group.items.length}</span></h4>
                {group.items.length === 0 && <p className="empty-state">{text('No cases in this category.', 'このカテゴリの提案はありません。')}</p>}
                {group.items.map(({ index, suggestion }) => {
                  const run = runs.get(index);
                  const isSaved = saved.has(index);
                  const expectsFailure = suggestion.expectations.outcome === 'error';
                  const [statusEn, statusJa] = statusLabel(run?.kind === 'done' ? run.result.status : undefined);
                  return (
                    <article key={index} className="tool-check-suggest-card" aria-label={suggestion.name}>
                      <div className="tool-check-suggest-card-head">
                        <strong className="tool-check-name">{suggestion.name}</strong>
                        <span className={`tool-check-category ${suggestion.category}`}>{text(categoryEn, categoryJa)}</span>
                        {expectsFailure && <span className="tool-check-chip expects-failure">{text('Failure expected', '失敗が期待値')}</span>}
                        {isSaved && <span className="tool-check-chip saved">{text('Saved', '保存済み')}</span>}
                        {run?.kind === 'running' && <span className="run-status tool-check-chip none" role="status">{text('Running…', '実行中…')}</span>}
                        {run?.kind === 'done' && <span className={`run-status tool-check-chip ${run.result.status}`}>{text(statusEn, statusJa)}</span>}
                        {run?.kind === 'error' && <span className="run-status tool-check-chip error">{text('Error', 'エラー')}</span>}
                      </div>
                      <p className="tool-check-suggest-rationale"><small>{suggestion.rationale}</small></p>
                      <dl className="tool-check-suggest-args" aria-label={text('Arguments', '引数')}>
                        {Object.keys(suggestion.arguments).length === 0 && <div><dt>{text('(no arguments)', '（引数なし）')}</dt></div>}
                        {Object.entries(suggestion.arguments).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{displayCell(value)}</code></dd></div>)}
                      </dl>
                      <ul className="tool-check-suggest-expectations" aria-label={text('Expectations', '期待')}>
                        {summarizeExpectations(suggestion.expectations).length === 0 && <li className="empty-state">{text('No expectations (only checks that the tool runs).', '期待なし（実行できることだけ確かめます）')}</li>}
                        {summarizeExpectations(suggestion.expectations).map((line) => <li key={line}>{localizeToolCheckAssertion(line, language)}</li>)}
                      </ul>
                      {suggestion.warnings.length > 0 && (
                        <ul className="tool-check-suggest-warnings">
                          {suggestion.warnings.map((warning, at) => <li key={at}><small>⚠ {warning}</small></li>)}
                        </ul>
                      )}
                      {run?.kind === 'error' && <div className="api-error" role="alert">{run.message}</div>}
                      {run?.kind === 'done' && <SuggestionRunSummary result={run.result} />}
                      <div className="tool-check-suggest-card-actions">
                        <button type="button" className="secondary" disabled={frozen} onClick={() => void runOne(index, suggestion)}>{text('Run to confirm', '実行して確認')}</button>
                        <button type="button" className="secondary" disabled={frozen} onClick={() => onLoad(suggestion, run?.kind === 'done' ? run.result : undefined)}>{text('Load into editor', 'エディタに読み込む')}</button>
                        <button type="button" className="secondary" disabled={frozen || isSaved} onClick={() => void saveOne(index, suggestion)}>{savingIndex === index ? text('Saving…', '保存中…') : text('Save', '保存')}</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * カード内の結果の要約。合格は 1 行、不合格は落ちた期待だけ、エラーは原因の文言。
 * 「失敗が期待値」で実際に失敗したときは、期待どおりであることと失敗の内容を情報として出す（直すボタンは出さない）。
 * 詳しい表（出力・ノード別行数）は「エディタに読み込む」で ResultPanel に出す。
 */
function SuggestionRunSummary({ result }: { readonly result: ToolCheckRunResultDto }) {
  const { text, language } = useI18n();
  const failed = result.assertions.filter((assertion) => !assertion.passed);
  if (isExpectedFailure(result) && result.error !== undefined) {
    return (
      <div className="tool-check-expected-failure" role="note">
        <p><strong>{text('The run failed as expected.', '期待どおり実行が失敗しました。')}</strong> {localizeRunTraceError(result.error, language)} <small><code>{result.error.code}</code></small></p>
      </div>
    );
  }
  if (result.status === 'error' && result.error !== undefined) {
    return (
      <div className="tool-check-suggest-run-detail error">
        <p>{localizeRunTraceError(result.error, language)} <small><code>{result.error.code}</code></small></p>
        <p><small>{text('Load it into the editor to see the fix buttons.', 'エディタに読み込むと、直す場所へのボタンが出ます。')}</small></p>
      </div>
    );
  }
  if (result.status === 'failed') {
    return (
      <ul className="tool-check-suggest-run-detail failed" aria-label={text('Failed expectations', '不合格の期待')}>
        {failed.map((assertion, index) => <li key={index}>✕ {localizeToolCheckAssertion(assertion.expected, language)} → {localizeToolCheckAssertion(assertion.actual, language, 'actual')}</li>)}
      </ul>
    );
  }
  return <p className="tool-check-suggest-run-detail passed"><small>{text(`${result.rowCount} rows · ${result.durationMs} ms`, `${result.rowCount} 行 · ${result.durationMs} ms`)}</small></p>;
}
