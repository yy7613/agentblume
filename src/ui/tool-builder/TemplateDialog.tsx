import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import { ApiError } from '../api/tool-api';
import { toolTemplateSlotProblems } from '../api/error-messages';
import type {
  DataSourceDto,
  InvalidToolTemplateDto,
  LocalizedTextDto,
  TemplateSlotCandidatesDto,
  TemplateSlotOptionDto,
  TemplateSlotProblemDto,
  TemplateSlotValueDto,
  TemplateSlotValuesDto,
  ToolSummaryDto,
  ToolTemplateDto,
  ToolTemplateSlotDto,
} from '../api/types';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import { FUNCTION_NAME_PATTERN, useToolBuilderStore } from './store';

/**
 * 「テンプレートから作成」ダイアログ（v43 実装契約 §5 / ADR-0049）。
 *
 * 人は Tool を 1 から組む代わりに、**テンプレートを選び、スロットを埋める**。画面の役目は
 * 「選べる値」と**その根拠**（列の型・実在値の例・期間の粒度・結合キーの重なりと一意性）を
 * 並べて、当てずっぽうの選択を避けさせること。壊れて読めなかったテンプレートも一覧の下に
 * 理由と直し方つきで出す（黙って消すと「足したのに出てこない」になる）。
 *
 * 2 段階: (1) テンプレートを選ぶ → (2) データソースとスロットを埋め、名前を決めて作成。
 * 作成は保存ではなく、実体化したグラフをキャンバスへ展開するところまで。
 */

/** 表示名の上限（v45 実装契約 §4）。 */
const DISPLAY_NAME_MAX = 80;

/** 表示言語に合わせて日英のどちらかを取る。 */
function pick(value: LocalizedTextDto | undefined, language: 'en' | 'ja'): string {
  return value === undefined ? '' : (language === 'ja' ? value.ja : value.en);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Request failed';
}

/** そのスロットが「複数選ぶ」形か。 */
function isMultiple(slot: ToolTemplateSlotDto): boolean {
  return slot.kind === 'joinKeys' || (slot.kind === 'column' && slot.multiple !== undefined);
}

/** テンプレートの既定値（choice / number / text）を初期値にする。 */
export function initialSlotValues(template: ToolTemplateDto): TemplateSlotValuesDto {
  const values: Record<string, TemplateSlotValueDto> = {};
  for (const slot of template.slots) {
    if (slot.default !== undefined) values[slot.name] = slot.default;
    else if (isMultiple(slot)) values[slot.name] = [];
  }
  return values;
}

/** このテンプレートが読むデータソース（`dataSource` スロットの宣言順。未選択は落とす）。 */
export function chosenDataSourceIds(template: ToolTemplateDto, values: TemplateSlotValuesDto): readonly string[] {
  return template.slots
    .filter((slot) => slot.kind === 'dataSource')
    .map((slot) => values[slot.name])
    .filter((value): value is string => typeof value === 'string' && value !== '');
}

/** 候補の再取得が要る選択だけを写した鍵（データソースと列。文字入力では取り直さない）。 */
function candidateDependencyKey(template: ToolTemplateDto, values: TemplateSlotValuesDto): string {
  return JSON.stringify(template.slots
    .filter((slot) => slot.kind === 'dataSource' || slot.kind === 'column')
    .map((slot) => values[slot.name] ?? null));
}

/** 候補 1 件の表示（値 + 選ぶ根拠）。 */
function optionLabel(option: TemplateSlotOptionDto, language: 'en' | 'ja'): string {
  const parts: string[] = [];
  if (option.name !== undefined) parts.push(option.name);
  if (option.label !== undefined) parts.push(pick(option.label, language));
  const head = parts.length > 0 ? `${parts.join(' ')} (${option.value})` : option.value;
  const hints: string[] = [];
  if (option.type !== undefined) hints.push(option.type);
  if (option.granularities !== undefined) {
    const granularities = Object.entries(option.granularities).map(([name, count]) => `${name}×${count}`).join(' ');
    const range = option.minStart === undefined ? '' : ` ${option.minStart}〜${option.maxStart ?? ''}`;
    hints.push(`${granularities}${range}`);
  }
  if (option.examples !== undefined && option.examples.length > 0) {
    const examples = option.examples.join(', ');
    const more = option.distinctCount !== undefined && option.distinctCount > option.examples.length ? ' …' : '';
    hints.push(language === 'ja' ? `例: ${examples}${more}` : `e.g. ${examples}${more}`);
  }
  if (option.overlap !== undefined) hints.push(language === 'ja' ? `重なり ${Math.round(option.overlap * 100)}%` : `${Math.round(option.overlap * 100)}% overlap`);
  return hints.length === 0 ? head : `${head} — ${hints.join(' · ')}`;
}

/** 読み込めなかったテンプレート（既定は畳んでおく。普段は邪魔なので）。 */
function InvalidTemplates({ invalid }: { readonly invalid: readonly InvalidToolTemplateDto[] }) {
  const { text } = useI18n();
  if (invalid.length === 0) return null;
  return <details className="template-invalid">
    <summary>{text(`Templates that could not be read (${invalid.length})`, `読み込めなかったテンプレート（${invalid.length}件）`)}</summary>
    <p>{text('Fix the file and reopen this dialog — no restart is needed.', 'ファイルを直してこのダイアログを開き直せば反映されます（再起動は不要です）。')}</p>
    {invalid.map((entry) => <div className="template-invalid-row" key={entry.file}>
      <code>{entry.file}</code>
      <ul>{entry.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>
    </div>)}
  </details>;
}

/** スロット 1 つぶんの入力欄。 */
function SlotField({ slot, candidate, value, dataSources, problems, onChange }: {
  readonly slot: ToolTemplateSlotDto;
  readonly candidate?: TemplateSlotCandidatesDto;
  readonly value: TemplateSlotValueDto | undefined;
  readonly dataSources: readonly DataSourceDto[];
  readonly problems: readonly TemplateSlotProblemDto[];
  readonly onChange: (value: TemplateSlotValueDto | undefined) => void;
}) {
  const { text, language } = useI18n();
  const label = `${pick(slot.label, language)}${slot.optional ? text(' (optional)', '（任意）') : ''}`;
  const help = slot.help === undefined ? undefined : pick(slot.help, language);
  const selected = Array.isArray(value) ? value : [];
  const options = candidate?.options ?? [];
  const errors = problems.map((problem, index) => <small className="field-error" key={index} role="alert">{problem.message}</small>);

  // データソースは候補 API を待たずに選べる（候補はデータソースが決まって初めて作られる）。
  if (slot.kind === 'dataSource') {
    const files = dataSources.filter((source) => source.kind === 'file');
    return <label className="template-slot">{label}{help !== undefined && <small>{help}</small>}
      <select aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}>
        <option value="">{text('Select a data source', 'データソースを選択')}</option>
        {files.map((source) => <option key={source.id} value={source.id}>{source.name} ({source.format})</option>)}
      </select>
      {files.length === 0 && <small>{text('No file data source is registered yet. Register one on the Data sources screen first.', 'ファイルのデータソースがまだありません。先にデータソース画面で登録してください。')}</small>}
      {errors}
    </label>;
  }

  if (slot.kind === 'number') {
    // 範囲はスロット宣言が正本。候補 API（データソースを選んで初めて返る）を待たずに出す。
    const range = candidate?.range ?? (slot.min === undefined || slot.max === undefined ? undefined : { min: slot.min, max: slot.max });
    const hint = range === undefined ? '' : text(`${range.min}–${range.max}`, `${range.min}〜${range.max}`);
    return <label className="template-slot">{label}<small>{hint}</small>{help !== undefined && <small>{help}</small>}
      <input type="number" aria-label={label} value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        min={range?.min} max={range?.max} step={slot.integer === true ? 1 : 'any'}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />
      {errors}
    </label>;
  }

  if (slot.kind === 'intent') {
    return <label className="template-slot">{label}{help !== undefined && <small>{help}</small>}
      <textarea aria-label={label} rows={3} maxLength={slot.maxLength} value={typeof value === 'string' ? value : ''}
        placeholder={text('Describe what to compute in one sentence; the formula is written for you.', '何を計算するかを 1 文で書いてください（式は AI が書きます）。')}
        onChange={(event) => onChange(event.target.value)} />
      {errors}
    </label>;
  }

  if (slot.kind === 'text') {
    return <label className="template-slot">{label}{help !== undefined && <small>{help}</small>}
      <input aria-label={label} maxLength={slot.maxLength} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />
      {errors}
    </label>;
  }

  // 複数選ぶ列と結合キーはチェックボックス（何個選べるかを添える）。
  if (isMultiple(slot)) {
    const multiple = slot.multiple ?? { min: 1, max: options.length };
    const hint = text(`Choose ${multiple.min}–${multiple.max}`, `${multiple.min}〜${multiple.max}個を選びます`);
    const toggle = (name: string, checked: boolean) => onChange(checked ? [...selected, name] : selected.filter((item) => item !== name));
    // 結合キーは「共通のキーを全部選ばないと行が増える」。一意性はキー全部を使ったときの測定値。
    const allKeys = slot.kind === 'joinKeys' && options.length > 0 && selected.length === options.length;
    const notUnique = allKeys && options.some((option) => option.uniqueLeft === false || option.uniqueRight === false);
    const partial = slot.kind === 'joinKeys' && selected.length > 0 && selected.length < options.length;
    return <fieldset className="template-slot">
      <legend>{label}</legend>
      <small>{hint}</small>
      {help !== undefined && <small>{help}</small>}
      {options.length === 0 && <small>{text('Pick the data source first.', '先にデータソースを選んでください。')}</small>}
      {options.map((option) => <label className="check" key={option.value}>
        <input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => toggle(option.value, event.target.checked)} />
        {optionLabel(option, language)}
      </label>)}
      {partial && <small className="field-warning">{text('Some shared key columns are not selected; the join can multiply rows. Select every shared key.', '共通のキー列を選び残しています。結合で行が増えることがあるので、共通のキーはすべて選んでください。')}</small>}
      {notUnique && <small className="field-warning">{text('These keys do not identify a single row on both sides; the join will multiply rows.', 'このキーの組み合わせでは行が一意になりません（結合で行が増えます）。')}</small>}
      {errors}
    </fieldset>;
  }

  // 単一選択（列・choice）。
  const value1 = typeof value === 'string' ? value : '';
  return <label className="template-slot">{label}{help !== undefined && <small>{help}</small>}
    <select aria-label={label} value={value1} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}>
      <option value="">{slot.optional ? text('(none)', '（指定しない）') : text('Select', '選択してください')}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{optionLabel(option, language)}</option>)}
    </select>
    {options.length === 0 && slot.kind === 'column' && <small>{text('Pick the data source first.', '先にデータソースを選んでください。')}</small>}
    {errors}
  </label>;
}

export function TemplateDialog({ client, open, onClose }: {
  readonly client: ToolApiClient;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { text, language } = useI18n();
  const dialogRef = useModalBehavior<HTMLDivElement>({ open, onClose });
  const [catalog, setCatalog] = useState<{ readonly templates: readonly ToolTemplateDto[]; readonly invalid: readonly InvalidToolTemplateDto[] }>();
  const [catalogError, setCatalogError] = useState<string>();
  const [dataSources, setDataSources] = useState<readonly DataSourceDto[]>([]);
  // 保存済み Tool。関数名の重複を**保存まで待たずに**この場で弾くためだけに使う。
  const [savedTools, setSavedTools] = useState<readonly ToolSummaryDto[]>([]);
  const [filter, setFilter] = useState('');
  const [template, setTemplate] = useState<ToolTemplateDto>();
  // 名前（v45 / 実装契約 §4）。既定値は入れない: テンプレートの title / id を初期値にすると
  // そのまま押し通され、同じテンプレートから作った 2 本目が 1 本目と同じ内部IDになり、
  // 別のツールのつもりが 1 本目の新しいバージョンになってしまう。
  const [toolDisplayName, setToolDisplayName] = useState('');
  const [toolFunctionName, setToolFunctionName] = useState('');
  const [values, setValues] = useState<TemplateSlotValuesDto>({});
  const [candidates, setCandidates] = useState<readonly TemplateSlotCandidatesDto[]>([]);
  const [problems, setProblems] = useState<readonly TemplateSlotProblemDto[]>([]);
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCatalogError(undefined);
    void client.listToolTemplates(scope)
      .then((result) => { if (active) setCatalog(result); })
      .catch((cause: unknown) => { if (active) setCatalogError(messageOf(cause)); });
    void client.listDataSources(scope)
      .then((sources) => { if (active) setDataSources(sources); })
      .catch(() => { if (active) setDataSources([]); });
    // 重複チェックのための一覧は開いたときに 1 回だけ取る。取れなくても作成は止めない
    // （重複チェックだけ諦める。一覧が読めないことは、名前を決められない理由にはならない）。
    void client.listTools(scope)
      .then((items) => { if (active) setSavedTools(items); })
      .catch(() => { if (active) setSavedTools([]); });
    return () => { active = false; };
  }, [client, open]);

  const dataSourceIds = useMemo(() => template === undefined ? [] : chosenDataSourceIds(template, values), [template, values]);
  const dependencyKey = template === undefined ? '' : candidateDependencyKey(template, values);

  // 候補は「列やキーの選択に影響する選択」が変わったときだけ取り直す（部分的な値を送る）。
  useEffect(() => {
    if (template === undefined) return;
    if (dataSourceIds.length < template.sources.min || dataSourceIds.length > template.sources.max) {
      setCandidates([]);
      return;
    }
    let active = true;
    void client.toolTemplateSlotCandidates({ templateId: template.id, scope, dataSourceIds, values })
      .then((result) => { if (active) setCandidates(result.candidates); })
      .catch((cause: unknown) => { if (active) { setCandidates([]); setFormError(messageOf(cause)); } });
    return () => { active = false; };
    // values 全体ではなく dependencyKey で回す（文字入力のたびに取り直さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, template, dependencyKey]);

  if (!open) return null;

  const close = () => {
    setTemplate(undefined); setValues({}); setCandidates([]); setProblems([]); setFormError(undefined); setFilter('');
    setToolDisplayName(''); setToolFunctionName('');
    onClose();
  };

  // 名前の指摘（欄の真下に出し、片方でも残っていれば「作成」は押せない）。
  // 関数名は前後の空白を落とさずに形を見る（空白入りの名前は直してもらう対象で、黙って捨てる値ではない）。
  const displayName = toolDisplayName.trim();
  const duplicate = savedTools.find((tool) => tool.publishName.toLowerCase() === toolFunctionName.toLowerCase());
  const displayNameProblem = displayName === ''
    ? text('Enter a tool name.', 'ツール名を入力してください')
    : displayName.length > DISPLAY_NAME_MAX
      ? text(`The tool name must be 1–${DISPLAY_NAME_MAX} characters.`, `ツール名は1〜${DISPLAY_NAME_MAX}文字です`)
      : undefined;
  const functionNameProblem = toolFunctionName.trim() === ''
    ? text('Enter a function name.', '関数名を入力してください')
    : !FUNCTION_NAME_PATTERN.test(toolFunctionName)
      ? text('The function name must be 1–64 characters of letters, digits, _ or -.', '関数名は英数字・_・- で 1〜64 文字です')
      : duplicate === undefined
        ? undefined
        : text(`The tool "${duplicate.displayName}" already uses this function name. Choose a different one.`, `この関数名はツール「${duplicate.displayName}」が使っています。別の名前にしてください`);
  const namesReady = displayNameProblem === undefined && functionNameProblem === undefined;

  const startWith = (chosen: ToolTemplateDto) => {
    setTemplate(chosen);
    setValues(initialSlotValues(chosen));
    setCandidates([]);
    setProblems([]);
    setFormError(undefined);
  };

  const setValue = (name: string, value: TemplateSlotValueDto | undefined) => {
    setValues((current) => ({ ...current, [name]: value }));
    // その欄を触ったら、その欄の指摘は消す（直している最中に赤いままにしない）。
    setProblems((current) => current.filter((problem) => problem.slot !== name));
  };

  const create = async () => {
    if (template === undefined || !namesReady) return;
    setBusy(true); setFormError(undefined); setProblems([]);
    try {
      const instantiated = await client.instantiateToolTemplate({
        templateId: template.id, scope, dataSourceIds, values, language, toolName: toolFunctionName,
      });
      useToolBuilderStore.getState().loadTemplate(instantiated, displayName);
      close();
    } catch (cause) {
      if (cause instanceof ApiError) {
        const slots = toolTemplateSlotProblems(cause, language);
        setProblems(slots);
        // 欄ごとの指摘があるときは、それ自体が「どこを直すか」なので見出しを重ねない。
        // 指摘が 1 つも無い失敗（404・実体化そのものの失敗）だけを作成ボタンの近くへ出す。
        setFormError(slots.length === 0 ? cause.message : undefined);
      } else setFormError(messageOf(cause));
    } finally { setBusy(false); }
  };

  const matching = (catalog?.templates ?? []).filter((candidate) => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return true;
    return [candidate.id, pick(candidate.title, language), pick(candidate.summary, language), ...candidate.tags]
      .some((field) => field.toLowerCase().includes(needle));
  });
  const generalProblems = problems.filter((problem) => problem.slot === undefined);
  const title = template === undefined
    ? text('Create from a template', 'テンプレートから作成')
    : `${text('Create from a template', 'テンプレートから作成')}: ${pick(template.title, language)}`;

  return <div className="template-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialogRef} tabIndex={-1} className="template-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header>
        <div><span className="eyebrow">{text('Tool Builder', 'ツールビルダー')}</span><h2>{title}</h2></div>
        <button type="button" className="ghost" aria-label={text('Close', '閉じる')} onClick={close}>×</button>
      </header>

      {template === undefined ? <div className="template-dialog-body">
        <p>{text('Pick a ready-made tool shape, then fill in the data source and a few choices. The tool is built with the same checks a hand-built tool passes.', 'できあいのツールの形を選び、データソースといくつかの選択を埋めるだけでツールを作れます。手で組んだツールと同じ検査を通ります。')}</p>
        {catalogError !== undefined && <div className="api-error" role="alert">{catalogError}</div>}
        <label className="template-filter">{text('Filter', '絞り込み')}
          <input aria-label={text('Filter templates', 'テンプレートを絞り込む')} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={text('e.g. time series, ranking', '例: 時系列, ランキング')} />
        </label>
        {catalog !== undefined && matching.length === 0 && <p className="empty-state">{text('No template matches.', '一致するテンプレートがありません。')}</p>}
        <div className="template-list">{matching.map((candidate) => <article className="template-card" key={candidate.id}>
          <div>
            <strong>{pick(candidate.title, language)}</strong>
            <code>{candidate.id}@{candidate.version}</code>
            <p>{pick(candidate.summary, language)}</p>
            <ul>{(language === 'ja' ? candidate.whenToUse.ja : candidate.whenToUse.en).map((item, index) => <li key={index}>{item}</li>)}</ul>
            <small>{text(`Data sources: ${candidate.sources.min === candidate.sources.max ? candidate.sources.min : `${candidate.sources.min}–${candidate.sources.max}`}`, `データソース: ${candidate.sources.min === candidate.sources.max ? candidate.sources.min : `${candidate.sources.min}〜${candidate.sources.max}`}個`)}</small>
            <div className="template-tags">{candidate.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          </div>
          <button type="button" className="primary" onClick={() => startWith(candidate)}>{text('Use this template', 'このテンプレートを使う')}</button>
        </article>)}</div>
        <InvalidTemplates invalid={catalog?.invalid ?? []} />
      </div> : <div className="template-dialog-body">
        <p>{pick(template.summary, language)}</p>
        <div className="template-form">{template.slots.map((slot) => <SlotField
          key={slot.name}
          slot={slot}
          candidate={candidates.find((entry) => entry.slot === slot.name)}
          value={values[slot.name]}
          dataSources={dataSources}
          problems={problems.filter((problem) => problem.slot === slot.name)}
          onChange={(next) => setValue(slot.name, next)}
        />)}</div>
        {/*
          名前はスロットの後（テンプレートとデータソースを選んでから考える順）。既定値を入れないのは、
          同じテンプレートから 2 本目を作ったときに内部IDまで同じになり、1 本目の新しいバージョンに
          なってしまうのを、人が名前を決めることでしか防げないため（v45 / 実装契約 §4）。
        */}
        <div className="template-names">
          <label className="template-slot">{text('Tool name', 'ツール名（表示名）')}
            <small>{text('Shown in the tool list and when an agent picks a tool. e.g. Population by prefecture over time', '一覧とエージェントの選択画面に出ます。例: 都道府県別人口の推移')}</small>
            <input aria-label={text('Tool name', 'ツール名（表示名）')} value={toolDisplayName} onChange={(event) => setToolDisplayName(event.target.value)} />
            {displayNameProblem !== undefined && <small className="field-error" role="alert">{displayNameProblem}</small>}
          </label>
          <label className="template-slot">{text('Function name', '関数名')}
            <small>{text('The name the model sees when it picks this tool. e.g. population_series', 'モデルがこの名前でツールを選びます。例: population_series')}</small>
            <input aria-label={text('Function name', '関数名')} value={toolFunctionName} onChange={(event) => setToolFunctionName(event.target.value)} />
            {functionNameProblem !== undefined && <small className="field-error" role="alert">{functionNameProblem}</small>}
          </label>
        </div>
        {generalProblems.map((problem, index) => <div className="api-error" role="alert" key={index}>{problem.message}</div>)}
        {formError !== undefined && <div className="api-error" role="alert">{formError}</div>}
      </div>}

      <footer>
        {template !== undefined && <button type="button" className="secondary" disabled={busy} onClick={() => setTemplate(undefined)}>{text('Back to the list', 'テンプレート一覧へ戻る')}</button>}
        <button type="button" className="secondary" onClick={close}>{text('Cancel', 'キャンセル')}</button>
        {template !== undefined && <button type="button" className="primary" disabled={busy || !namesReady} onClick={() => void create()}>{busy ? text('Creating…', '作成中…') : text('Create', '作成')}</button>}
      </footer>
    </div>
  </div>;
}
