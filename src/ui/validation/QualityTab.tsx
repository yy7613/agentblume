import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ExperimentComparisonDto, ExperimentDto, GatePolicySummaryDto, GateReportDto, GateRuleDto, MetricComparisonDto, PromotionRequestDto, TenantScopeDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : 'Request failed';
const number = (value: number | undefined): string => value === undefined ? '—' : value.toFixed(3);

type Translate = (english: string, japanese: string) => string;
/** 比較結果の向き。CSSクラスは生の値のまま使い、表示だけを訳す。 */
function directionLabel(direction: MetricComparisonDto['direction'], text: Translate): string {
  switch (direction) {
    case 'improved': return text('improved', '改善');
    case 'regressed': return text('regressed', '悪化');
    case 'unchanged': return text('unchanged', '変化なし');
    case 'incomparable': return text('incomparable', '比較不可');
  }
}

export function QualityTab({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  const [experiments, setExperiments] = useState<readonly ExperimentDto[]>([]); const [policies, setPolicies] = useState<readonly GatePolicySummaryDto[]>([]);
  const [baselineId, setBaselineId] = useState(''); const [candidateId, setCandidateId] = useState(''); const [policyId, setPolicyId] = useState(''); const [policyVersion, setPolicyVersion] = useState('');
  const [comparison, setComparison] = useState<ExperimentComparisonDto>(); const [report, setReport] = useState<GateReportDto>(); const [promotions, setPromotions] = useState<readonly PromotionRequestDto[]>([]);
  const [regressionsOnly, setRegressionsOnly] = useState(false); const [reviewer, setReviewer] = useState('reviewer');
  const [newPolicyId, setNewPolicyId] = useState('release-gate'); const [metric, setMetric] = useState('case-success-rate'); const [operator, setOperator] = useState<'gte' | 'lte'>('gte'); const [threshold, setThreshold] = useState(0.8); const [maxRegression, setMaxRegression] = useState(0.05); const [requiredTags, setRequiredTags] = useState('critical');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [pendingPolicyDelete, setPendingPolicyDelete] = useState<{ readonly id: string; readonly name: string }>();
  const [pendingDecision, setPendingDecision] = useState<{ readonly request: PromotionRequestDto; readonly decision: 'approve' | 'reject' }>();

  async function refresh(): Promise<void> {
    const [experimentItems, policyItems, promotionItems] = await Promise.all([client.listExperiments(scope, 'completed'), client.listGatePolicies(scope), client.listPromotionRequests(scope)]);
    setExperiments(experimentItems); setPolicies(policyItems); setPromotions(promotionItems);
    if (candidateId === '' && experimentItems[0] !== undefined) setCandidateId(experimentItems[0].id);
    if (baselineId === '' && experimentItems[1] !== undefined) setBaselineId(experimentItems[1].id);
    if (policyId === '' && policyItems[0] !== undefined) {
      setPolicyId(policyItems[0].internalId); setPolicyVersion(policyItems[0].latestVersion);
      await applyPolicyRules(policyItems[0].internalId, policyItems[0].latestVersion);
    }
  }

  // 保存済みポリシーの定義を取得し、ルール編集フィールドへ復元する（Openと同等の役割）。
  async function applyPolicyRules(id: string, version: string): Promise<void> {
    if (id === '' || version === '') return;
    setError(undefined);
    try {
      const policy = await client.getGatePolicy(id, scope, version);
      setNewPolicyId(policy.metadata.internalId);
      const thresholdRule = policy.rules.find((rule): rule is Extract<GateRuleDto, { kind: 'metric-threshold' }> => rule.kind === 'metric-threshold');
      const regressionRule = policy.rules.find((rule): rule is Extract<GateRuleDto, { kind: 'max-regression' }> => rule.kind === 'max-regression');
      const tagsRule = policy.rules.find((rule): rule is Extract<GateRuleDto, { kind: 'required-case-pass' }> => rule.kind === 'required-case-pass');
      if (thresholdRule !== undefined) { setMetric(thresholdRule.metric); setOperator(thresholdRule.operator); setThreshold(thresholdRule.threshold); }
      if (regressionRule !== undefined) { setMetric(regressionRule.metric); setMaxRegression(regressionRule.maxRegression); }
      setRequiredTags(tagsRule !== undefined ? tagsRule.tags.join(', ') : '');
    } catch (cause) { setError(errorMessage(cause)); }
  }
  useEffect(() => { let active = true; void refresh().catch((cause) => { if (active) setError(errorMessage(cause)); }); return () => { active = false; }; }, [client, scope]);

  async function run(action: () => Promise<void>): Promise<void> { setBusy(true); setError(undefined); try { await action(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  async function compare(): Promise<void> { await run(async () => { setComparison(await client.compareExperiments(scope, baselineId, candidateId)); }); }
  async function savePolicy(): Promise<void> {
    await run(async () => {
      const tags = requiredTags.split(',').map((value) => value.trim()).filter(Boolean);
      const policy = await client.saveGatePolicy({ scope, internalId: newPolicyId, workingName: newPolicyId, displayName: newPolicyId, publishName: newPolicyId.replaceAll('-', '_'), owner: reviewer, rules: [{ id: 'threshold', kind: 'metric-threshold', metric, operator, threshold }, { id: 'regression', kind: 'max-regression', metric, maxRegression }, ...(tags.length > 0 ? [{ id: 'required-tags', kind: 'required-case-pass' as const, tags }] : [])] });
      await refresh(); setPolicyId(policy.metadata.internalId); setPolicyVersion(policy.metadata.version);
    });
  }
  async function evaluate(): Promise<void> { await run(async () => { const next = await client.evaluateGate(scope, { id: policyId, version: policyVersion }, candidateId, baselineId || undefined); setReport(next); }); }
  async function promote(): Promise<void> { const candidate = experiments.find((item) => item.id === candidateId); if (candidate === undefined || report === undefined) return; await run(async () => { await client.requestPromotion(candidate.target.agentId, candidate.target.version, scope, report.id, reviewer); await refresh(); }); }
  async function decide(request: PromotionRequestDto, decision: 'approve' | 'reject'): Promise<void> { await run(async () => { await client.decidePromotion(request.id, decision, scope, reviewer); await refresh(); }); }
  async function selectPolicy(id: string): Promise<void> {
    setPolicyId(id);
    const version = policies.find((item) => item.internalId === id)?.latestVersion ?? '';
    setPolicyVersion(version);
    await applyPolicyRules(id, version);
  }
  async function removePolicy(id: string): Promise<void> {
    await run(async () => {
      await client.deleteGatePolicy(id, scope);
      if (policyId === id) { setPolicyId(''); setPolicyVersion(''); }
      await refresh();
    });
  }

  const visibleCases = useMemo(() => comparison?.cases.filter((item) => !regressionsOnly || item.direction === 'regressed') ?? [], [comparison, regressionsOnly]);
  const candidate = experiments.find((item) => item.id === candidateId); const pending = promotions.filter((item) => item.status === 'pending');
  const decisionTitle = pendingDecision === undefined ? '' : pendingDecision.decision === 'approve' ? text('Approve promotion', '昇格を承認') : text('Return promotion request', '昇格申請を差し戻し');
  const decisionMessage = pendingDecision === undefined ? '' : pendingDecision.decision === 'approve'
    ? text(`Approve promoting "${pendingDecision.request.agent.id}@${pendingDecision.request.agent.version}"?`, `"${pendingDecision.request.agent.id}@${pendingDecision.request.agent.version}" の昇格を承認しますか？`)
    : text(`Return the promotion request for "${pendingDecision.request.agent.id}@${pendingDecision.request.agent.version}"?`, `"${pendingDecision.request.agent.id}@${pendingDecision.request.agent.version}" の昇格申請を差し戻しますか？`);
  const decisionConfirmLabel = pendingDecision === undefined ? '' : pendingDecision.decision === 'approve' ? text('Approve', '承認') : text('Return', '差し戻し');
  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <section className="workspace-card" aria-label={text('Quality comparison', '品質比較')}>
      <div className="panel-title"><h2>{text('Baseline comparison', 'ベースライン比較')}</h2><button type="button" className="primary" disabled={busy || baselineId === '' || candidateId === '' || baselineId === candidateId} onClick={() => void compare()}>{text('Compare', '比較')}</button></div>
      {/* aria-label は英語のまま据え置く（テストの参照キー）。表示ラベルだけを翻訳する。 */}
      <div className="experiment-fields"><label>{text('Baseline', 'ベースライン')}<select aria-label="Quality baseline" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">—</option>{experiments.map((item) => <option key={item.id} value={item.id}>{item.target.agentId}@{item.target.version} · {item.id}</option>)}</select></label><label>{text('Candidate', '候補')}<select aria-label="Quality candidate" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">—</option>{experiments.map((item) => <option key={item.id} value={item.id}>{item.target.agentId}@{item.target.version} · {item.id}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={regressionsOnly} onChange={(event) => setRegressionsOnly(event.target.checked)} />{text('Regressions only', '悪化のみ')}</label></div>
      {comparison !== undefined && <><div className="table-wrap"><table><thead><tr><th>{text('Metric', '指標')}</th><th>{text('Baseline mean', 'ベースライン平均')}</th><th>{text('Candidate mean', '候補平均')}</th><th>{text('Delta', '差分')}</th><th>{text('p50 / p95', 'p50 / p95')}</th><th>{text('Stddev / n', '標準偏差 / 件数')}</th><th>{text('Result', '判定')}</th></tr></thead><tbody>{comparison.metrics.map((item) => <tr key={item.metric}><td>{item.metric}</td><td>{number(item.baseline?.mean)}</td><td>{number(item.candidate?.mean)}</td><td>{number(item.delta)}</td><td>{number(item.candidate?.p50)} / {number(item.candidate?.p95)}</td><td>{number(item.candidate?.stddev)} / {item.candidate?.count ?? '—'}</td><td><span className={`comparison-${item.direction}`}>{directionLabel(item.direction, text)}</span></td></tr>)}</tbody></table></div><div className="table-wrap"><table><thead><tr><th>{text('Case', 'ケース')}</th><th>{text('Baseline', 'ベースライン')}</th><th>{text('Candidate', '候補')}</th><th>{text('Delta', '差分')}</th><th>{text('Result', '判定')}</th></tr></thead><tbody>{visibleCases.map((item) => <tr key={`${item.caseId}-${item.repetition}`}><td>{item.caseId} #{item.repetition}</td><td>{item.baselineStatus} · {number(item.baselineScore)}</td><td>{item.candidateStatus} · {number(item.candidateScore)}</td><td>{number(item.delta)}</td><td>{directionLabel(item.direction, text)}</td></tr>)}</tbody></table></div></>}
    </section>
    <div className="two-column-workspace">
      <section className="workspace-card" aria-label={text('Gate policy', 'ゲートポリシー')}><h2>{text('Gate policy', 'ゲートポリシー')}</h2><div className="form-grid"><label>{text('ID', 'ポリシーID')}<input aria-label="Gate policy ID" value={newPolicyId} onChange={(event) => setNewPolicyId(event.target.value)} /></label><label>{text('Metric', '指標')}<input aria-label="Gate metric" value={metric} onChange={(event) => setMetric(event.target.value)} /></label><label>{text('Threshold operator', '閾値演算子')}<select aria-label="Gate threshold operator" value={operator} onChange={(event) => setOperator(event.target.value as 'gte' | 'lte')}><option value="gte">≥</option><option value="lte">≤</option></select></label><label>{text('Threshold', '閾値')}<input type="number" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label><label>{text('Maximum regression', '最大回帰')}<input type="number" step="0.01" value={maxRegression} onChange={(event) => setMaxRegression(Number(event.target.value))} /></label><label>{text('Required tags (comma-separated)', '必須タグ（カンマ区切り）')}<input value={requiredTags} onChange={(event) => setRequiredTags(event.target.value)} /></label></div><button type="button" className="secondary" disabled={busy || newPolicyId === '' || metric === ''} onClick={() => void savePolicy()}>{text('Save policy version', 'ポリシー版を保存')}</button></section>
      <section className="workspace-card" aria-label={text('Gate evaluation', 'ゲート判定')}><div className="panel-title"><h2>{text('Gate report', 'ゲート判定レポート')}</h2><button type="button" className="primary" disabled={busy || policyId === '' || policyVersion === '' || candidateId === ''} onClick={() => void evaluate()}>{text('Evaluate gate', 'ゲート判定')}</button></div><div className="experiment-fields"><label>{text('Policy', 'ポリシー')}<select aria-label="Gate policy" value={policyId} onChange={(event) => void selectPolicy(event.target.value)}><option value="">—</option>{policies.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label><label>{text('Version', 'バージョン')}<input aria-label="Gate policy version" value={policyVersion} readOnly /></label><label>{text('Reviewer', 'レビュー担当')}<input aria-label="Promotion reviewer" value={reviewer} onChange={(event) => setReviewer(event.target.value)} /></label><button type="button" className="secondary danger" disabled={busy || policyId === ''} onClick={() => setPendingPolicyDelete({ id: policyId, name: policies.find((item) => item.internalId === policyId)?.displayName ?? policyId })}>{text('Delete policy', 'ポリシーを削除')}</button></div>{report !== undefined && <div className={`gate-report ${report.status}`}><strong>{report.status.toUpperCase()}</strong>{report.ruleResults.map((item) => <p key={item.ruleId}>{item.passed ? '✓' : '×'} {item.message}</p>)}{report.status === 'pass' && candidate !== undefined && <button type="button" className="primary" disabled={busy} onClick={() => void promote()}>{text('Request promotion', '昇格申請')}</button>}</div>}</section>
    </div>
    <section className="workspace-card" aria-label={text('Promotion approvals', '昇格承認')}><h2>{text('Promotion approvals', '昇格承認')}</h2>{pending.length === 0 ? <p className="empty-state">{text('No pending requests.', '承認待ちはありません。')}</p> : <div className="validation-list">{pending.map((item) => <div className="promotion-row" key={item.id}><span><strong>{item.agent.id}@{item.agent.version}</strong> · {item.requestedBy}</span><div className="save-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setPendingDecision({ request: item, decision: 'reject' })}>{text('Return', '差し戻し')}</button><button type="button" className="primary" disabled={busy} onClick={() => setPendingDecision({ request: item, decision: 'approve' })}>{text('Approve', '承認')}</button></div></div>)}</div>}</section>
    <ConfirmDialog
      open={pendingPolicyDelete !== undefined}
      title={text('Delete gate policy', 'ゲートポリシーを削除')}
      message={text(`Delete "${pendingPolicyDelete?.name ?? ''}"? This cannot be undone.`, `"${pendingPolicyDelete?.name ?? ''}" を削除しますか？この操作は元に戻せません。`)}
      confirmLabel={text('Delete', '削除')}
      cancelLabel={text('Cancel', 'キャンセル')}
      danger
      busy={busy}
      onConfirm={() => { if (pendingPolicyDelete === undefined) return; void removePolicy(pendingPolicyDelete.id).then(() => setPendingPolicyDelete(undefined)); }}
      onCancel={() => setPendingPolicyDelete(undefined)}
    />
    <ConfirmDialog
      open={pendingDecision !== undefined}
      title={decisionTitle}
      message={decisionMessage}
      confirmLabel={decisionConfirmLabel}
      cancelLabel={text('Cancel', 'キャンセル')}
      busy={busy}
      onConfirm={() => { if (pendingDecision === undefined) return; void decide(pendingDecision.request, pendingDecision.decision).then(() => setPendingDecision(undefined)); }}
      onCancel={() => setPendingDecision(undefined)}
    />
  </>;
}
