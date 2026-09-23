import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type {
  CodeScorerDto, EvaluationCaseDto, EvaluationDatasetSummaryDto, EvaluatorMetricDefinitionDto,
  EvaluatorProfileSummaryDto, JudgeCriterionDto, JudgeRubricSummaryDto, ScenarioSummaryDto, SerializedJudgeRubricDto, TenantScopeDto,
} from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

const SCORERS: readonly CodeScorerDto[] = ['keyword-coverage', 'completeness', 'tone-consistency', 'content-similarity'];
const commaList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
const message = (cause: unknown): string => cause instanceof Error ? cause.message : 'Request failed';

function newTurnCase(index: number): EvaluationCaseDto { return { id: `case-${index}`, kind: 'turn', input: '', tags: [], source: 'manual' }; }
function newCriterion(index: number): JudgeCriterionDto { return { id: `criterion-${index}`, label: `Criterion ${index}`, description: 'Describe the quality dimension.', weight: 1, levels: [{ score: 0, label: 'Does not meet', description: 'Does not meet the criterion.' }, { score: 1, label: 'Fully meets', description: 'Fully meets the criterion.' }] }; }
type JudgePolicy = NonNullable<SerializedJudgeRubricDto['tracePolicy']>;
/**
 * 0 / 1 の二値水準。順序尺度（0〜1 を 0.25 刻みなど）より判定者間の一致率が高いという研究結果に沿って
 * 「二値にする」ボタンで既存の水準を丸ごと置き換える。ラベルは表示言語に合わせる（保存後に判定者へ渡る文言）。
 */
export function binaryLevels(language: 'en' | 'ja'): JudgeCriterionDto['levels'] {
  return language === 'ja'
    ? [{ score: 0, label: '未達', description: '基準を満たしていない' }, { score: 1, label: '達成', description: '基準を満たしている' }]
    : [{ score: 0, label: 'Not met', description: 'Does not meet the criterion' }, { score: 1, label: 'Met', description: 'Meets the criterion' }];
}

/**
 * 他画面から「このルーブリックを開いて直す」依頼を受けるための参照。同じルーブリックを続けて依頼されても
 * 新しいオブジェクトで渡す（effect の依存が変わって再度開く）。
 */
export interface OpenRubricTarget { readonly internalId: string; readonly version?: string }

export function DatasetsTab({ client, scope, openRubric }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto; readonly openRubric?: OpenRubricTarget }) {
  const { language, text } = useI18n();
  const [datasets, setDatasets] = useState<readonly EvaluationDatasetSummaryDto[]>([]);
  const [profiles, setProfiles] = useState<readonly EvaluatorProfileSummaryDto[]>([]);
  const [rubrics, setRubrics] = useState<readonly JudgeRubricSummaryDto[]>([]);
  const [scenarios, setScenarios] = useState<readonly ScenarioSummaryDto[]>([]);
  const [internalId, setInternalId] = useState('quality-regression');
  const [workingName, setWorkingName] = useState('Quality regression draft');
  const [displayName, setDisplayName] = useState('Quality regression');
  const [publishName, setPublishName] = useState('quality_regression');
  const [owner, setOwner] = useState('local-user');
  const [cases, setCases] = useState<readonly EvaluationCaseDto[]>([newTurnCase(1)]);
  const [caseListInputs, setCaseListInputs] = useState<Readonly<Record<number, { readonly expectedTools?: string; readonly tags?: string }>>>({});
  const [datasetBump, setDatasetBump] = useState<'major' | 'minor' | 'patch'>('patch');
  const [savedVersion, setSavedVersion] = useState<string>();
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [transfer, setTransfer] = useState('');

  const [profileId, setProfileId] = useState('default-code-evaluator');
  const [profileWorkingName, setProfileWorkingName] = useState('Default code evaluator draft');
  const [profileDisplayName, setProfileDisplayName] = useState('Default code evaluator');
  const [profilePublishName, setProfilePublishName] = useState('default_code_evaluator');
  const [profileOwner, setProfileOwner] = useState('local-user');
  const [metrics, setMetrics] = useState<readonly EvaluatorMetricDefinitionDto[]>([{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }]);
  const [profileBump, setProfileBump] = useState<'major' | 'minor' | 'patch'>('patch');
  const [profileSavedVersion, setProfileSavedVersion] = useState<string>();
  const [rubricId, setRubricId] = useState('default-quality-rubric'); const [rubricWorkingName, setRubricWorkingName] = useState('Default quality rubric draft'); const [rubricDisplayName, setRubricDisplayName] = useState('Default quality rubric'); const [rubricPublishName, setRubricPublishName] = useState('default_quality_rubric'); const [rubricOwner, setRubricOwner] = useState('local-user');
  const [rubricInstructions, setRubricInstructions] = useState('Evaluate correctness, instruction adherence, safety, and answer quality.'); const [referencePolicy, setReferencePolicy] = useState<JudgePolicy>('optional'); const [tracePolicy, setTracePolicy] = useState<JudgePolicy>('optional'); const [criteria, setCriteria] = useState<readonly JudgeCriterionDto[]>([newCriterion(1)]); const [rubricBump, setRubricBump] = useState<'major' | 'minor' | 'patch'>('patch'); const [rubricSavedVersion, setRubricSavedVersion] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<{ readonly kind: 'dataset' | 'profile' | 'rubric'; readonly id: string; readonly name: string }>();

  useEffect(() => {
    let active = true;
    void Promise.all([client.listEvaluationDatasets(scope), client.listEvaluatorProfiles(scope), client.listJudgeRubrics(scope), client.listScenarios(scope)])
      .then(([datasetItems, profileItems, rubricItems, scenarioItems]) => { if (active) { setDatasets(datasetItems); setProfiles(profileItems); setRubrics(rubricItems); setScenarios(scenarioItems); } })
      .catch((cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [client, scope]);

  function updateCase(index: number, next: EvaluationCaseDto): void { setCases((items) => items.map((item, itemIndex) => itemIndex === index ? next : item)); }

  async function editDataset(summary: EvaluationDatasetSummaryDto): Promise<void> {
    setError(undefined);
    try {
      const dataset = await client.getEvaluationDataset(summary.internalId, scope);
      setInternalId(dataset.metadata.internalId); setWorkingName(dataset.metadata.workingName); setDisplayName(dataset.metadata.displayName);
      setPublishName(dataset.metadata.publishName); setOwner(dataset.metadata.owner); setCases(dataset.cases.map((entry) => structuredClone(entry)));
      setCaseListInputs({}); setSavedVersion(dataset.metadata.version); setTransfer('');
    } catch (cause) { setError(message(cause)); }
  }

  async function saveDataset(): Promise<void> {
    setBusy('dataset'); setError(undefined);
    try {
      const saved = await client.saveEvaluationDataset({ scope, internalId, workingName, displayName, publishName, owner, cases, bump: datasetBump });
      setSavedVersion(saved.metadata.version); setDatasets(await client.listEvaluationDatasets(scope));
    } catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  async function removeDataset(target: string): Promise<void> {
    setBusy('dataset'); setError(undefined);
    try { await client.deleteEvaluationDataset(target, scope); setDatasets(await client.listEvaluationDatasets(scope)); }
    catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  async function importCases(): Promise<void> {
    setBusy('import'); setError(undefined);
    try { setCases(await client.importEvaluationCases(scope, format, transfer)); setCaseListInputs({}); }
    catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  async function exportDataset(): Promise<void> {
    if (savedVersion === undefined) return;
    setBusy('export'); setError(undefined);
    try { setTransfer(await client.exportEvaluationDataset(internalId, scope, format, savedVersion)); }
    catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  async function editProfile(summary: EvaluatorProfileSummaryDto): Promise<void> {
    setError(undefined);
    try {
      const profile = await client.getEvaluatorProfile(summary.internalId, scope);
      setProfileId(profile.metadata.internalId); setProfileWorkingName(profile.metadata.workingName); setProfileDisplayName(profile.metadata.displayName);
      setProfilePublishName(profile.metadata.publishName); setProfileOwner(profile.metadata.owner); setMetrics(profile.metrics.map((metric) => ({ ...metric })));
      setProfileSavedVersion(profile.metadata.version);
    } catch (cause) { setError(message(cause)); }
  }

  async function saveProfile(): Promise<void> {
    setBusy('profile'); setError(undefined);
    try {
      const saved = await client.saveEvaluatorProfile({ scope, internalId: profileId, workingName: profileWorkingName, displayName: profileDisplayName, publishName: profilePublishName, owner: profileOwner, metrics, bump: profileBump });
      setProfileSavedVersion(saved.metadata.version); setProfiles(await client.listEvaluatorProfiles(scope));
    } catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  async function removeProfile(target: string): Promise<void> {
    setBusy('profile'); setError(undefined);
    try { await client.deleteEvaluatorProfile(target, scope); setProfiles(await client.listEvaluatorProfiles(scope)); }
    catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  async function editRubric(summary: JudgeRubricSummaryDto): Promise<void> { await openRubricEditor(summary.internalId); }
  /** 保存済みルーブリックをエディタへ読み込む。version 省略時は最新版。見つからなければアラート（画面はそのまま使える）。 */
  async function openRubricEditor(id: string, version?: string): Promise<void> {
    setError(undefined); try { const rubric = await (version === undefined ? client.getJudgeRubric(id, scope) : client.getJudgeRubric(id, scope, version)); setRubricId(rubric.metadata.internalId); setRubricWorkingName(rubric.metadata.workingName); setRubricDisplayName(rubric.metadata.displayName); setRubricPublishName(rubric.metadata.publishName); setRubricOwner(rubric.metadata.owner); setRubricInstructions(rubric.instructions); setReferencePolicy(rubric.referencePolicy); setTracePolicy(rubric.tracePolicy ?? 'optional'); setCriteria(rubric.criteria.map((criterion) => structuredClone(criterion))); setRubricSavedVersion(rubric.metadata.version); } catch (cause) { setError(message(cause)); }
  }
  // 他画面からの依頼: ルーブリックを読み込み、エディタの区画へスクロールして軌跡ポリシーの select にフォーカスする。
  useEffect(() => {
    if (openRubric === undefined) return;
    let active = true;
    void openRubricEditor(openRubric.internalId, openRubric.version).then(() => {
      if (!active) return;
      const editor = document.getElementById('judge-rubric-editor');
      // jsdom には scrollIntoView が無いので任意呼び出しにする。
      editor?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      editor?.querySelector<HTMLElement>('[data-field="trace-policy"]')?.focus();
    });
    return () => { active = false; };
  // openRubricEditor は毎描画で作られる関数なので依存に入れず、依頼オブジェクトが変わったときだけ開く。
  }, [openRubric]);
  async function saveRubric(): Promise<void> {
    setBusy('rubric'); setError(undefined); try { const saved = await client.saveJudgeRubric({ scope, internalId: rubricId, workingName: rubricWorkingName, displayName: rubricDisplayName, publishName: rubricPublishName, owner: rubricOwner, instructions: rubricInstructions, criteria, referencePolicy, tracePolicy, bump: rubricBump }); setRubricSavedVersion(saved.metadata.version); setRubrics(await client.listJudgeRubrics(scope)); } catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }
  async function removeRubric(target: string): Promise<void> {
    setBusy('rubric'); setError(undefined);
    try { await client.deleteJudgeRubric(target, scope); setRubrics(await client.listJudgeRubrics(scope)); }
    catch (cause) { setError(message(cause)); } finally { setBusy(undefined); }
  }

  const metadataValid = [internalId, workingName, displayName, publishName].every((value) => value.trim() !== '');
  const casesValid = cases.length > 0 && new Set(cases.map((entry) => entry.id)).size === cases.length && cases.every((entry) => entry.id.trim() !== '' && (entry.kind === 'turn' ? entry.input.trim() !== '' : entry.scenario.id.trim() !== '' && entry.scenario.version.trim() !== ''));
  const profileValid = [profileId, profileWorkingName, profileDisplayName, profilePublishName].every((value) => value.trim() !== '') && metrics.length > 0 && new Set(metrics.map((metric) => metric.id)).size === metrics.length && metrics.every((metric) => metric.id.trim() !== '' && Number.isFinite(metric.weight) && metric.weight > 0 && (metric.kind === 'code' || (metric.rubric.id.trim() !== '' && metric.rubric.version.trim() !== '')));
  const rubricValid = [rubricId, rubricWorkingName, rubricDisplayName, rubricPublishName, rubricInstructions].every((value) => value.trim() !== '') && criteria.length > 0 && new Set(criteria.map((criterion) => criterion.id)).size === criteria.length && criteria.every((criterion) => criterion.id.trim() !== '' && criterion.label.trim() !== '' && criterion.description.trim() !== '' && criterion.weight > 0 && criterion.levels.some((level) => level.score === 0) && criterion.levels.some((level) => level.score === 1));

  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <div className="two-column-workspace">
      <section className="workspace-card" aria-label={text('Evaluation asset list', '評価資産一覧')}>
        <h2>{text('Datasets', 'データセット')}</h2>
        <div className="validation-list">{datasets.length === 0 && <p className="empty-state">{text('No evaluation datasets.', '評価データセットはありません。')}</p>}{datasets.map((item) => <div className="validation-list-row" key={item.internalId}>
          <button type="button" onClick={() => void editDataset(item)}><strong>{item.displayName}</strong><span className="version-chip">{item.latestVersion}</span><span className="run-meta">{text(`${item.caseCount} cases`, `${item.caseCount}ケース`)}</span></button>
          <button type="button" className="secondary danger" disabled={busy !== undefined} onClick={() => setPendingDelete({ kind: 'dataset', id: item.internalId, name: item.displayName })}>{text('Delete', '削除')}</button>
        </div>)}</div>
        <h2 className="section-gap">{text('Evaluator profiles', '評価プロファイル')}</h2>
        <div className="validation-list">{profiles.length === 0 && <p className="empty-state">{text('No evaluator profiles.', '評価プロファイルはありません。')}</p>}{profiles.map((item) => <div className="validation-list-row" key={item.internalId}>
          <button type="button" onClick={() => void editProfile(item)}><strong>{item.displayName}</strong><span className="version-chip">{item.latestVersion}</span><span className="run-meta">{text(`${item.metricCount} metrics`, `${item.metricCount}メトリクス`)}</span></button>
          <button type="button" className="secondary danger" disabled={busy !== undefined} onClick={() => setPendingDelete({ kind: 'profile', id: item.internalId, name: item.displayName })}>{text('Delete', '削除')}</button>
        </div>)}</div>
        <h2 className="section-gap">{text('Judge rubrics', '審査ルーブリック')}</h2>
        <div className="validation-list">{rubrics.length === 0 && <p className="empty-state">{text('No judge rubrics.', '審査ルーブリックはありません。')}</p>}{rubrics.map((item) => <div className="validation-list-row" key={item.internalId}>
          <button type="button" onClick={() => void editRubric(item)}><strong>{item.displayName}</strong><span className="version-chip">{item.latestVersion}</span><span className="run-meta">{text(`${item.criterionCount} criteria`, `${item.criterionCount}基準`)}</span></button>
          <button type="button" className="secondary danger" disabled={busy !== undefined} onClick={() => setPendingDelete({ kind: 'rubric', id: item.internalId, name: item.displayName })}>{text('Delete', '削除')}</button>
        </div>)}</div>
      </section>

      <div className="evaluation-editors">
        <section className="workspace-card" aria-label={text('Dataset editor', 'データセット編集')}>
          <div className="panel-title"><h2>{text('Evaluation dataset', '評価データセット')}</h2><div className="save-actions">{savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}<select aria-label="Dataset version bump" value={datasetBump} onChange={(event) => setDatasetBump(event.target.value as typeof datasetBump)}><option value="patch">{text('patch', 'パッチ')}</option><option value="minor">{text('minor', 'マイナー')}</option><option value="major">{text('major', 'メジャー')}</option></select><button className="primary" type="button" disabled={busy !== undefined || !metadataValid || !casesValid} onClick={() => void saveDataset()}>{busy === 'dataset' ? text('Saving…', '保存中…') : text('Save dataset', 'データセットを保存')}</button></div></div>
          <div className="agent-fields">
            {/* aria-label は英語のまま据え置く（テストの参照キー）。表示ラベルだけを翻訳する。 */}
            <label>{text('Internal ID', '内部ID')}<input aria-label="Dataset internal ID" value={internalId} onChange={(event) => setInternalId(event.target.value)} /></label>
            <label>{text('Working name', '作業名')}<input aria-label="Dataset working name" value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
            <label>{text('Display name', '表示名')}<input aria-label="Dataset display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label>{text('Publish name', '公開名')}<input aria-label="Dataset publish name" value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
            <label>{text('Owner', '所有者')}<input aria-label="Dataset owner" placeholder={text('Optional (defaults to you)', '省略可（空欄なら自分の名前）')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          </div>
          <div className="panel-title"><h2>{text('Cases', '評価ケース')} <small>{cases.length}</small></h2><div className="save-actions"><button type="button" className="secondary" onClick={() => setCases((items) => [...items, newTurnCase(items.length + 1)])}>{text('Add turn', 'turnを追加')}</button><button type="button" className="secondary" disabled={scenarios.length === 0} onClick={() => { const scenario = scenarios[0]; if (scenario !== undefined) setCases((items) => [...items, { id: `case-${items.length + 1}`, kind: 'scenario', scenario: { id: scenario.internalId, version: scenario.latestVersion }, tags: [], source: 'manual' }]); }}>{text('Add scenario', 'scenarioを追加')}</button></div></div>
          <div className="evaluation-cases">{cases.map((entry, index) => <div className="evaluation-case" key={index}>
            <div className="evaluation-case-head"><input aria-label={`Case ${index + 1} ID`} value={entry.id} onChange={(event) => updateCase(index, { ...entry, id: event.target.value })} /><select aria-label={`Case ${index + 1} kind`} value={entry.kind} onChange={(event) => { const kind = event.target.value; updateCase(index, kind === 'turn' ? newTurnCase(index + 1) : { id: entry.id, kind: 'scenario', scenario: { id: scenarios[0]?.internalId ?? '', version: scenarios[0]?.latestVersion ?? '' }, tags: entry.tags, source: entry.source }); }}><option value="turn">{text('turn', 'ターン事例')}</option><option value="scenario">{text('scenario', 'シナリオ事例')}</option></select><button type="button" className="secondary" aria-label={`Remove case ${index + 1}`} disabled={cases.length === 1} onClick={() => setCases((items) => items.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>
            {entry.kind === 'turn' ? <><label>{text('Input', '入力')}<textarea aria-label={`Case ${index + 1} input`} rows={2} value={entry.input} onChange={(event) => updateCase(index, { ...entry, input: event.target.value })} /></label><label>{text('Reference', '参照解答')}<textarea aria-label={`Case ${index + 1} reference`} rows={2} value={entry.reference ?? ''} onChange={(event) => updateCase(index, { ...entry, ...(event.target.value === '' ? { reference: undefined } : { reference: event.target.value }) })} /></label><label>{text('Expected tools', '期待するツール')}<input aria-label={`Case ${index + 1} expected tools`} value={caseListInputs[index]?.expectedTools ?? (entry.expectedTools ?? []).join(', ')} onChange={(event) => { const value = event.target.value; setCaseListInputs((items) => ({ ...items, [index]: { ...items[index], expectedTools: value } })); updateCase(index, { ...entry, expectedTools: commaList(value) }); }} /></label></>
              : <label>{text('Scenario', 'シナリオ')}<select aria-label={`Case ${index + 1} scenario`} value={`${entry.scenario.id}@${entry.scenario.version}`} onChange={(event) => { const selected = scenarios.find((item) => `${item.internalId}@${item.latestVersion}` === event.target.value); if (selected !== undefined) updateCase(index, { ...entry, scenario: { id: selected.internalId, version: selected.latestVersion } }); }}>{!scenarios.some((item) => `${item.internalId}@${item.latestVersion}` === `${entry.scenario.id}@${entry.scenario.version}`) && <option value={`${entry.scenario.id}@${entry.scenario.version}`}>{entry.scenario.id}@{entry.scenario.version}</option>}{scenarios.map((item) => <option key={item.internalId} value={`${item.internalId}@${item.latestVersion}`}>{item.displayName}@{item.latestVersion}</option>)}</select></label>}
            <label>{text('Tags', 'タグ')}<input aria-label={`Case ${index + 1} tags`} value={caseListInputs[index]?.tags ?? entry.tags.join(', ')} onChange={(event) => { const value = event.target.value; setCaseListInputs((items) => ({ ...items, [index]: { ...items[index], tags: value } })); updateCase(index, { ...entry, tags: commaList(value) }); }} /></label>
          </div>)}</div>
          {!casesValid && <p className="field-error">{text('Case ids must be unique and each case needs its required input or scenario.', 'ケースIDは一意で、inputまたはscenarioの必須値が必要です。')}</p>}
          <h2>{text('Import / export', 'インポート／エクスポート')}</h2><div className="transfer-actions"><select aria-label="Dataset transfer format" value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="json">JSON</option><option value="csv">CSV (turn only)</option></select><button type="button" className="secondary" disabled={busy !== undefined || transfer.trim() === ''} onClick={() => void importCases()}>{text('Import cases', 'ケースを読込')}</button><button type="button" className="secondary" disabled={busy !== undefined || savedVersion === undefined} onClick={() => void exportDataset()}>{text('Export saved version', '保存版を出力')}</button></div><textarea aria-label="Dataset transfer content" rows={8} value={transfer} onChange={(event) => setTransfer(event.target.value)} />
        </section>

        <section className="workspace-card" aria-label={text('Evaluator profile editor', '評価プロファイル編集')}>
          <div className="panel-title"><h2>{text('Evaluator profile', '評価プロファイル')}</h2><div className="save-actions">{profileSavedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {profileSavedVersion}</span>}<select aria-label="Evaluator profile version bump" value={profileBump} onChange={(event) => setProfileBump(event.target.value as typeof profileBump)}><option value="patch">{text('patch', 'パッチ')}</option><option value="minor">{text('minor', 'マイナー')}</option><option value="major">{text('major', 'メジャー')}</option></select><button type="button" className="primary" disabled={busy !== undefined || !profileValid} onClick={() => void saveProfile()}>{busy === 'profile' ? text('Saving…', '保存中…') : text('Save profile', 'プロファイルを保存')}</button></div></div>
          <div className="agent-fields"><label>{text('Internal ID', '内部ID')}<input aria-label="Evaluator profile internal ID" value={profileId} onChange={(event) => setProfileId(event.target.value)} /></label><label>{text('Working name', '作業名')}<input aria-label="Evaluator profile working name" value={profileWorkingName} onChange={(event) => setProfileWorkingName(event.target.value)} /></label><label>{text('Display name', '表示名')}<input aria-label="Evaluator profile display name" value={profileDisplayName} onChange={(event) => setProfileDisplayName(event.target.value)} /></label><label>{text('Publish name', '公開名')}<input aria-label="Evaluator profile publish name" value={profilePublishName} onChange={(event) => setProfilePublishName(event.target.value)} /></label><label>{text('Owner', '所有者')}<input aria-label="Evaluator profile owner" placeholder={text('Optional (defaults to you)', '省略可（空欄なら自分の名前）')} value={profileOwner} onChange={(event) => setProfileOwner(event.target.value)} /></label></div>
          <div className="metric-editor">{metrics.map((metric, index) => <div className="metric-row" key={index}><input aria-label={`Metric ${index + 1} ID`} value={metric.id} onChange={(event) => setMetrics((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} /><select aria-label={`Metric ${index + 1} kind`} value={metric.kind} onChange={(event) => setMetrics((items) => items.map((item, itemIndex) => itemIndex !== index ? item : event.target.value === 'code' ? { id: item.id, kind: 'code', scorer: 'completeness', weight: item.weight, required: item.required } : { id: item.id, kind: 'judge', rubric: { id: rubrics[0]?.internalId ?? '', version: rubrics[0]?.latestVersion ?? '' }, weight: item.weight, required: item.required }))}><option value="code">{text('code', 'コード採点')}</option><option value="judge">{text('judge', 'LLM判定')}</option></select>{metric.kind === 'code' ? <select aria-label={`Metric ${index + 1} scorer`} value={metric.scorer} onChange={(event) => setMetrics((items) => items.map((item, itemIndex) => itemIndex === index && item.kind === 'code' ? { ...item, scorer: event.target.value as CodeScorerDto } : item))}>{SCORERS.map((scorer) => <option key={scorer}>{scorer}</option>)}</select> : <select aria-label={`Metric ${index + 1} rubric`} value={`${metric.rubric.id}@${metric.rubric.version}`} onChange={(event) => { const selected = rubrics.find((item) => `${item.internalId}@${item.latestVersion}` === event.target.value); if (selected !== undefined) setMetrics((items) => items.map((item, itemIndex) => itemIndex === index && item.kind === 'judge' ? { ...item, rubric: { id: selected.internalId, version: selected.latestVersion } } : item)); }}>{!rubrics.some((item) => `${item.internalId}@${item.latestVersion}` === `${metric.rubric.id}@${metric.rubric.version}`) && <option value={`${metric.rubric.id}@${metric.rubric.version}`}>{metric.rubric.id}@{metric.rubric.version}</option>}{rubrics.map((item) => <option key={item.internalId} value={`${item.internalId}@${item.latestVersion}`}>{item.displayName}@{item.latestVersion}</option>)}</select>}<input aria-label={`Metric ${index + 1} weight`} type="number" min="0.1" step="0.1" value={metric.weight} onChange={(event) => setMetrics((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, weight: Number(event.target.value) } : item))} /><label className="inline-check"><input aria-label={`Metric ${index + 1} required`} type="checkbox" checked={metric.required} onChange={(event) => setMetrics((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />{text('required', '必須')}</label><button type="button" className="secondary" aria-label={`Remove metric ${index + 1}`} disabled={metrics.length === 1} onClick={() => setMetrics((items) => items.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>
          <button type="button" className="secondary" onClick={() => setMetrics((items) => [...items, { id: `metric-${items.length + 1}`, kind: 'code', scorer: 'completeness', weight: 1, required: false }])}>{text('Add metric', 'メトリクスを追加')}</button>
        </section>

        <section className="workspace-card" id="judge-rubric-editor" aria-label={text('Judge rubric editor', '審査ルーブリック編集')}>
          <div className="panel-title"><h2>{text('Judge rubric', '審査ルーブリック')}</h2><div className="save-actions">{rubricSavedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {rubricSavedVersion}</span>}<select aria-label={text('Judge rubric version bump', '審査ルーブリックのバージョン更新種別')} value={rubricBump} onChange={(event) => setRubricBump(event.target.value as typeof rubricBump)}><option value="patch">{text('patch', 'パッチ')}</option><option value="minor">{text('minor', 'マイナー')}</option><option value="major">{text('major', 'メジャー')}</option></select><button type="button" className="primary" disabled={busy !== undefined || !rubricValid} onClick={() => void saveRubric()}>{busy === 'rubric' ? text('Saving…', '保存中…') : text('Save rubric', 'ルーブリックを保存')}</button></div></div>
          <div className="agent-fields"><label>{text('Internal ID', '内部ID')}<input aria-label={text('Judge rubric internal ID', '審査ルーブリック内部ID')} value={rubricId} onChange={(event) => setRubricId(event.target.value)} /></label><label>{text('Working name', '作業名')}<input aria-label={text('Judge rubric working name', '審査ルーブリック作業名')} value={rubricWorkingName} onChange={(event) => setRubricWorkingName(event.target.value)} /></label><label>{text('Display name', '表示名')}<input aria-label={text('Judge rubric display name', '審査ルーブリック表示名')} value={rubricDisplayName} onChange={(event) => setRubricDisplayName(event.target.value)} /></label><label>{text('Publish name', '公開名')}<input aria-label={text('Judge rubric publish name', '審査ルーブリック公開名')} value={rubricPublishName} onChange={(event) => setRubricPublishName(event.target.value)} /></label><label>{text('Owner', '所有者')}<input aria-label={text('Judge rubric owner', '審査ルーブリック所有者')} placeholder={text('Optional (defaults to you)', '省略可（空欄なら自分の名前）')} value={rubricOwner} onChange={(event) => setRubricOwner(event.target.value)} /></label><label>{text('Reference policy', '参照ポリシー')}<select aria-label={text('Judge reference policy', '判定参照ポリシー')} value={referencePolicy} onChange={(event) => setReferencePolicy(event.target.value as typeof referencePolicy)}><option value="optional">{text('optional', '任意')}</option><option value="required">{text('required', '必須')}</option><option value="forbidden">{text('forbidden', '禁止')}</option></select></label><label>{text('Trace shown to the judge', '判定者に見せる実行履歴')}<select aria-label={text('Judge trace policy', '判定実行履歴ポリシー')} data-field="trace-policy" value={tracePolicy} onChange={(event) => setTracePolicy(event.target.value as JudgePolicy)}><option value="optional">{text('optional: include the tool trace when available', '任意: ツール呼び出し列があれば見せる')}</option><option value="required">{text('required: fail the judgement when there is no trace', '必須: 実行履歴が無ければ判定を失敗にする')}</option><option value="forbidden">{text('forbidden: never show the trace', '禁止: 実行履歴は見せない')}</option></select></label></div>
          {/* required はターン事例だけで成立する: シナリオ事例（疑似ユーザー会話）はツール呼び出しの軌跡を残さないので、起票が JUDGE_TRACE_UNAVAILABLE で拒否される。 */}
          {tracePolicy === 'required' && <p className="inline-issue warning" role="note" data-hint="trace-required">{text('"required" works with turn cases only. Scenario cases never produce a tool trace, so the judgement fails for them.', '「必須」はターン事例だけで使えます。シナリオ事例では軌跡が得られず判定が失敗します')}</p>}
          {/* 実行履歴ポリシーは省略時 optional。required は「ツールを使わない事例」で JUDGE_INPUT になるので、その先読みを一行で添える。 */}
          <p className="judge-hint">{text('Trace policy: optional = show the tool calls and conversation when the run has them (default); required = the judgement fails for cases without a trace; forbidden = judge the answer only.', '実行履歴ポリシー: 任意 = 実行にツール呼び出しや会話履歴があれば判定者に見せる（既定）／必須 = 履歴の無い事例は判定失敗になる／禁止 = 回答だけで判定する。')}</p>
          <label>{text('Instructions', '指示文')}<textarea aria-label={text('Judge rubric instructions', '審査ルーブリック指示文')} rows={3} value={rubricInstructions} onChange={(event) => setRubricInstructions(event.target.value)} /></label>
          {/* 合成スコアの式を見せる: 重みの意味が分からないと「重み 2 で 2 倍のスコア」と誤解される。判定不能（null）の基準は分母からも外れる。 */}
          <p className="judge-hint"><span>{text('Composite score = Σ weight × level ÷ Σ weight (criteria the judge could not assess are excluded).', '合成スコア = Σ 重み×水準 / Σ 重み（判定不能の基準は除外）')}</span><span>{text('Binary 0 / 1 levels are recommended for each criterion (research shows higher agreement than ordinal scales).', '基準は 0 / 1 の二値を推奨（研究では順序尺度より一致率が高い）')}</span></p>
          <div className="evaluation-cases">{criteria.map((criterion, index) => <div className="evaluation-case" key={index}><div className="evaluation-case-head judge-criterion-head"><input aria-label={`${text('Criterion', '基準')} ${index + 1} ID`} value={criterion.id} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} /><input aria-label={`${text('Criterion', '基準')} ${index + 1} ${text('label', 'ラベル')}`} value={criterion.label} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><input aria-label={`${text('Criterion', '基準')} ${index + 1} ${text('weight', '重み')}`} type="number" min="0.1" step="0.1" value={criterion.weight} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, weight: Number(event.target.value) } : item))} /><button type="button" className="secondary" aria-label={`${text('Make criterion', '基準')} ${index + 1} ${text('binary', 'を二値にする')}`} title={text('Replace the levels with 0 = not met / 1 = met', '水準を 0 = 未達 / 1 = 達成 の二値に置き換えます')} onClick={() => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, levels: binaryLevels(language) } : item))}>{text('Make binary', '二値にする')}</button><button type="button" className="secondary" aria-label={`${text('Remove criterion', '基準を削除')} ${index + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((items) => items.filter((_, itemIndex) => itemIndex !== index))}>×</button></div><label>{text('Description', '説明')}<textarea aria-label={`${text('Criterion', '基準')} ${index + 1} ${text('description', '説明')}`} value={criterion.description} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /></label>{criterion.levels.map((level, levelIndex) => <div className="metric-row" key={levelIndex}><input aria-label={`${text('Criterion', '基準')} ${index + 1} ${text('level', 'レベル')} ${levelIndex + 1} ${text('score', 'スコア')}`} type="number" min="0" max="1" step="0.1" value={level.score} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, levels: item.levels.map((entry, entryIndex) => entryIndex === levelIndex ? { ...entry, score: Number(event.target.value) } : entry) } : item))} /><input aria-label={`${text('Criterion', '基準')} ${index + 1} ${text('level', 'レベル')} ${levelIndex + 1} ${text('label', 'ラベル')}`} value={level.label} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, levels: item.levels.map((entry, entryIndex) => entryIndex === levelIndex ? { ...entry, label: event.target.value } : entry) } : item))} /><input aria-label={`${text('Criterion', '基準')} ${index + 1} ${text('level', 'レベル')} ${levelIndex + 1} ${text('description', '説明')}`} value={level.description} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, levels: item.levels.map((entry, entryIndex) => entryIndex === levelIndex ? { ...entry, description: event.target.value } : entry) } : item))} /></div>)}</div>)}</div>
          <button type="button" className="secondary" onClick={() => setCriteria((items) => [...items, newCriterion(items.length + 1)])}>{text('Add criterion', '基準を追加')}</button>
        </section>
      </div>
    </div>
    <ConfirmDialog
      open={pendingDelete !== undefined}
      title={pendingDelete?.kind === 'dataset' ? text('Delete dataset', 'データセットを削除') : pendingDelete?.kind === 'profile' ? text('Delete evaluator profile', '評価プロファイルを削除') : text('Delete judge rubric', '審査ルーブリックを削除')}
      message={text(`Delete "${pendingDelete?.name ?? ''}"? This cannot be undone.`, `"${pendingDelete?.name ?? ''}" を削除しますか？この操作は元に戻せません。`)}
      confirmLabel={text('Delete', '削除')}
      cancelLabel={text('Cancel', 'キャンセル')}
      danger
      busy={busy !== undefined}
      onConfirm={() => {
        if (pendingDelete === undefined) return;
        const action = pendingDelete.kind === 'dataset' ? removeDataset(pendingDelete.id) : pendingDelete.kind === 'profile' ? removeProfile(pendingDelete.id) : removeRubric(pendingDelete.id);
        void action.then(() => setPendingDelete(undefined));
      }}
      onCancel={() => setPendingDelete(undefined)}
    />
  </>;
}
