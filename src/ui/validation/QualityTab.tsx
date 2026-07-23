import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ExperimentComparisonDto, ExperimentDto, GatePolicySummaryDto, GateReportDto, GateRuleDto, PromotionRequestDto, TenantScopeDto } from '../api/types';
import { useI18n } from '../i18n';

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : 'Request failed';
const number = (value: number | undefined): string => value === undefined ? '—' : value.toFixed(3);

export function QualityTab({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  const [experiments, setExperiments] = useState<readonly ExperimentDto[]>([]); const [policies, setPolicies] = useState<readonly GatePolicySummaryDto[]>([]);
  const [baselineId, setBaselineId] = useState(''); const [candidateId, setCandidateId] = useState(''); const [policyId, setPolicyId] = useState(''); const [policyVersion, setPolicyVersion] = useState('');
  const [comparison, setComparison] = useState<ExperimentComparisonDto>(); const [report, setReport] = useState<GateReportDto>(); const [promotions, setPromotions] = useState<readonly PromotionRequestDto[]>([]);
  const [regressionsOnly, setRegressionsOnly] = useState(false); const [reviewer, setReviewer] = useState('reviewer');
  const [newPolicyId, setNewPolicyId] = useState('release-gate'); const [metric, setMetric] = useState('case-success-rate'); const [operator, setOperator] = useState<'gte' | 'lte'>('gte'); const [threshold, setThreshold] = useState(0.8); const [maxRegression, setMaxRegression] = useState(0.05); const [requiredTags, setRequiredTags] = useState('critical');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();

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
  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <section className="workspace-card" aria-label={text('Quality comparison', '品質比較')}>
      <div className="panel-title"><h2>{text('Baseline comparison', 'ベースライン比較')}</h2><button type="button" className="primary" disabled={busy || baselineId === '' || candidateId === '' || baselineId === candidateId} onClick={() => void compare()}>{text('Compare', '比較')}</button></div>
      <div className="experiment-fields"><label>Baseline<select aria-label="Quality baseline" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">—</option>{experiments.map((item) => <option key={item.id} value={item.id}>{item.target.agentId}@{item.target.version} · {item.id}</option>)}</select></label><label>Candidate<select aria-label="Quality candidate" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">—</option>{experiments.map((item) => <option key={item.id} value={item.id}>{item.target.agentId}@{item.target.version} · {item.id}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={regressionsOnly} onChange={(event) => setRegressionsOnly(event.target.checked)} />{text('Regressions only', '悪化のみ')}</label></div>
      {comparison !== undefined && <><div className="table-wrap"><table><thead><tr><th>Metric</th><th>Baseline mean</th><th>Candidate mean</th><th>Delta</th><th>p50 / p95</th><th>Stddev / n</th><th>Result</th></tr></thead><tbody>{comparison.metrics.map((item) => <tr key={item.metric}><td>{item.metric}</td><td>{number(item.baseline?.mean)}</td><td>{number(item.candidate?.mean)}</td><td>{number(item.delta)}</td><td>{number(item.candidate?.p50)} / {number(item.candidate?.p95)}</td><td>{number(item.candidate?.stddev)} / {item.candidate?.count ?? '—'}</td><td><span className={`comparison-${item.direction}`}>{item.direction}</span></td></tr>)}</tbody></table></div><div className="table-wrap"><table><thead><tr><th>Case</th><th>Baseline</th><th>Candidate</th><th>Delta</th><th>Result</th></tr></thead><tbody>{visibleCases.map((item) => <tr key={`${item.caseId}-${item.repetition}`}><td>{item.caseId} #{item.repetition}</td><td>{item.baselineStatus} · {number(item.baselineScore)}</td><td>{item.candidateStatus} · {number(item.candidateScore)}</td><td>{number(item.delta)}</td><td>{item.direction}</td></tr>)}</tbody></table></div></>}
    </section>
    <div className="two-column-workspace">
      <section className="workspace-card" aria-label={text('Gate policy', 'ゲートポリシー')}><h2>GatePolicy</h2><div className="form-grid"><label>ID<input aria-label="Gate policy ID" value={newPolicyId} onChange={(event) => setNewPolicyId(event.target.value)} /></label><label>Metric<input aria-label="Gate metric" value={metric} onChange={(event) => setMetric(event.target.value)} /></label><label>{text('Threshold operator', '閾値演算子')}<select aria-label="Gate threshold operator" value={operator} onChange={(event) => setOperator(event.target.value as 'gte' | 'lte')}><option value="gte">≥</option><option value="lte">≤</option></select></label><label>{text('Threshold', '閾値')}<input type="number" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label><label>{text('Maximum regression', '最大回帰')}<input type="number" step="0.01" value={maxRegression} onChange={(event) => setMaxRegression(Number(event.target.value))} /></label><label>{text('Required tags (comma-separated)', '必須タグ（カンマ区切り）')}<input value={requiredTags} onChange={(event) => setRequiredTags(event.target.value)} /></label></div><button type="button" className="secondary" disabled={busy || newPolicyId === '' || metric === ''} onClick={() => void savePolicy()}>{text('Save policy version', 'ポリシー版を保存')}</button></section>
      <section className="workspace-card" aria-label={text('Gate evaluation', 'ゲート判定')}><div className="panel-title"><h2>GateReport</h2><button type="button" className="primary" disabled={busy || policyId === '' || policyVersion === '' || candidateId === ''} onClick={() => void evaluate()}>{text('Evaluate gate', 'ゲート判定')}</button></div><div className="experiment-fields"><label>Policy<select aria-label="Gate policy" value={policyId} onChange={(event) => void selectPolicy(event.target.value)}><option value="">—</option>{policies.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label><label>Version<input aria-label="Gate policy version" value={policyVersion} readOnly /></label><label>Reviewer<input aria-label="Promotion reviewer" value={reviewer} onChange={(event) => setReviewer(event.target.value)} /></label><button type="button" className="secondary danger" disabled={busy || policyId === ''} onClick={() => void removePolicy(policyId)}>{text('Delete policy', 'ポリシーを削除')}</button></div>{report !== undefined && <div className={`gate-report ${report.status}`}><strong>{report.status.toUpperCase()}</strong>{report.ruleResults.map((item) => <p key={item.ruleId}>{item.passed ? '✓' : '×'} {item.message}</p>)}{report.status === 'pass' && candidate !== undefined && <button type="button" className="primary" disabled={busy} onClick={() => void promote()}>{text('Request promotion', '昇格申請')}</button>}</div>}</section>
    </div>
    <section className="workspace-card" aria-label={text('Promotion approvals', '昇格承認')}><h2>{text('Promotion approvals', '昇格承認')}</h2>{pending.length === 0 ? <p className="empty-state">{text('No pending requests.', '承認待ちはありません。')}</p> : <div className="validation-list">{pending.map((item) => <div className="promotion-row" key={item.id}><span><strong>{item.agent.id}@{item.agent.version}</strong> · {item.requestedBy}</span><div className="save-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void decide(item, 'reject')}>{text('Return', '差し戻し')}</button><button type="button" className="primary" disabled={busy} onClick={() => void decide(item, 'approve')}>{text('Approve', '承認')}</button></div></div>)}</div>}</section>
  </>;
}
