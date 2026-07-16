import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, HarnessPatternDto, HarnessPoliciesDto, HarnessRunDto, HarnessSlotDto, HarnessTopologyDto, HarnessValidationDto, SaveHarnessDto } from '../api/types';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
const patterns: readonly { readonly id: HarnessPatternDto; readonly label: string; readonly note: string }[] = [
  { id: 'agent-as-tools', label: 'Agent as tools', note: 'Coordinator delegates on demand' },
  { id: 'sequential', label: 'Sequential', note: 'Pass work through an ordered chain' },
  { id: 'concurrent', label: 'Concurrent', note: 'Run independent branches, then collect' },
  { id: 'handoff', label: 'Handoff', note: 'Interactive runtime — planned next' },
  { id: 'group-chat', label: 'Group Chat', note: 'Interactive runtime — planned next' },
  { id: 'magentic', label: 'Magentic', note: 'Planner runtime — planned next' },
];
const policy: HarnessPoliciesDto = { budget: { maxDurationMs: 120000, maxParticipantRuns: 20, maxModelRounds: 40, maxToolCalls: 100, maxParallelism: 4 }, context: 'task-only', planning: { enabled: false, requireApproval: false }, memory: { wikiIds: [], sessionWorkspace: true }, approvals: { mode: 'inherit-agent' }, failure: { mode: 'fail-fast' } };

function initialSlots(): HarnessSlotDto[] {
  return [
    { id: 'author', label: 'Author', purpose: 'Create a first result.', assignment: { internalId: '', version: '' } },
    { id: 'reviewer', label: 'Reviewer', purpose: 'Check and improve the result.', assignment: { internalId: '', version: '' } },
    { id: 'publisher', label: 'Publisher', purpose: 'Prepare the final response.', assignment: { internalId: '', version: '' } },
  ];
}
function topology(pattern: HarnessPatternDto, slots: readonly HarnessSlotDto[]): HarnessTopologyDto {
  const ids = slots.map((slot) => slot.id); const first = ids[0] ?? ''; const rest = ids.slice(1);
  switch (pattern) {
    case 'sequential': return { pattern, orderedSlotIds: ids, contextMode: 'full-conversation' };
    case 'concurrent': return { pattern, participantSlotIds: ids, aggregation: 'collect' };
    case 'agent-as-tools': return { pattern, coordinatorSlotId: first, participantSlotIds: rest };
    case 'handoff': return { pattern, startSlotId: first, transitions: rest.map((id) => ({ fromSlotId: first, toSlotId: id, condition: `Route work to ${id}` })), autonomous: false };
    case 'group-chat': return { pattern, participantSlotIds: ids, selector: 'round-robin', maxRounds: 3 };
    case 'magentic': return { pattern, managerSlotId: first, participantSlotIds: rest, maxRounds: 6, maxStalls: 2, maxResets: 1, requirePlanSignoff: false };
  }
}

export function HarnessBuilder({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [pattern, setPattern] = useState<HarnessPatternDto>('sequential');
  const [slots, setSlots] = useState<HarnessSlotDto[]>(initialSlots);
  const [internalId, setInternalId] = useState(''); const [displayName, setDisplayName] = useState(''); const [owner, setOwner] = useState('');
  const [savedVersion, setSavedVersion] = useState<string>(); const [validation, setValidation] = useState<HarnessValidationDto>(); const [runMessage, setRunMessage] = useState(''); const [run, setRun] = useState<HarnessRunDto>();
  const [busy, setBusy] = useState<'load' | 'validate' | 'save' | 'run'>(); const [error, setError] = useState<string>();
  useEffect(() => { let active = true; setBusy('load'); void client.listAgents(scope).then((items) => { if (active) setAgents(items); }).catch((cause: unknown) => { if (active) setError(message(cause)); }).finally(() => { if (active) setBusy(undefined); }); return () => { active = false; }; }, [client]);
  const selected = useMemo(() => patterns.find((item) => item.id === pattern), [pattern]);
  const ready = internalId.trim() !== '' && displayName.trim() !== '' && owner.trim() !== '' && slots.every((slot) => slot.assignment.internalId !== '');
  const input = useMemo<SaveHarnessDto>(() => ({ scope, internalId, workingName: `${displayName || internalId} draft`, displayName, publishName: internalId.replace(/[^A-Za-z0-9_-]/g, '_'), owner, pattern, slots, topology: topology(pattern, slots), policies: policy, output: { format: 'text' } }), [internalId, displayName, owner, pattern, slots]);
  function choosePattern(next: HarnessPatternDto): void { setPattern(next); setValidation(undefined); setSavedVersion(undefined); }
  function assign(slotId: string, agentId: string): void {
    const agent = agents.find((item) => item.internalId === agentId);
    setSlots((current) => current.map((slot) => slot.id !== slotId ? slot : { ...slot, assignment: agent === undefined ? { internalId: '', version: '' } : { internalId: agent.internalId, version: agent.latestVersion } }));
    setValidation(undefined); setSavedVersion(undefined);
  }
  async function validate(): Promise<void> { if (!ready) { setValidation({ valid: false, issues: [{ path: '(definition)', message: 'Fill names and assign every slot to a saved Agent version.' }] }); return; } setBusy('validate'); setError(undefined); try { setValidation(await client.validateHarness(input)); } catch (cause) { setError(message(cause)); } finally { setBusy(undefined); } }
  async function save(): Promise<void> { if (!ready) return; setBusy('save'); setError(undefined); try { const harness = await client.saveHarness(input); setSavedVersion(harness.metadata.version); setValidation({ valid: true, issues: [] }); } catch (cause) { setError(message(cause)); } finally { setBusy(undefined); } }
  async function preview(): Promise<void> { if (savedVersion === undefined || runMessage.trim() === '') return; setBusy('run'); setError(undefined); try { setRun(await client.runHarness({ scope, harness: { internalId, version: savedVersion }, message: runMessage, mode: 'preview' })); } catch (cause) { setError(message(cause)); } finally { setBusy(undefined); } }
  return <main className="harness-builder">
    <header className="harness-builder-header"><div><span className="eyebrow">{text('Agent Harness Builder', 'Agent Harness Builder')}</span><h1>{displayName || text('New Harness', '新しいHarness')}</h1><p>{text('Assign saved Agent versions to a typed orchestration pattern.', '保存済みAgentのversionを、型付きオーケストレーションのslotへ割り当てます。')}</p></div><div className="save-actions"><button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void validate()}>{busy === 'validate' ? text('Validating…', '検証中…') : text('Validate', '検証')}</button><button type="button" className="primary" disabled={!ready || busy !== undefined} onClick={() => void save()}>{busy === 'save' ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button></div></header>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="harness-layout"><aside className="harness-presets"><h2>{text('Patterns', 'パターン')}</h2>{patterns.map((item) => <button key={item.id} type="button" className={pattern === item.id ? 'active' : ''} onClick={() => choosePattern(item.id)}><strong>{item.label}</strong><small>{item.note}</small></button>)}</aside>
      <section className="harness-workspace"><div className="harness-fields"><label>{text('Internal ID', '内部ID')}<input value={internalId} onChange={(event) => { setInternalId(event.target.value); setSavedVersion(undefined); }} placeholder="content-review" /></label><label>{text('Display name', '表示名')}<input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSavedVersion(undefined); }} placeholder="Content Review" /></label><label>{text('Owner', '所有者')}<input value={owner} onChange={(event) => { setOwner(event.target.value); setSavedVersion(undefined); }} placeholder="team@example.com" /></label></div>
        <div className="harness-canvas" aria-label={text('Harness canvas', 'Harnessキャンバス')}><div className="harness-input-node">Input</div>{slots.map((slot, index) => <div className="harness-slot" key={slot.id}><span className="harness-arrow">{index === 0 ? '↓' : '→'}</span><strong>{slot.label}</strong><small>{slot.purpose}</small><select aria-label={`${text('Assign agent to', 'Agentを割り当て')} ${slot.label}`} value={slot.assignment.internalId} onChange={(event) => assign(slot.id, event.target.value)}><option value="">{text('Assign saved Agent…', '保存済みAgentを割り当て…')}</option>{agents.map((agent) => <option key={agent.internalId} value={agent.internalId}>{agent.displayName}@{agent.latestVersion}</option>)}</select><code>{slot.assignment.internalId === '' ? text('unassigned', '未割当') : `${slot.assignment.internalId}@${slot.assignment.version}`}</code></div>)}<div className="harness-output-node">Output</div></div>
        <div className="harness-inspector"><div><span className="eyebrow">{text('Pattern inspector', 'パターン設定')}</span><h2>{selected?.label}</h2><p>{selected?.note}</p></div><label>{text('Failure policy', '失敗時の方針')}<select value={policy.failure.mode} disabled><option>fail-fast</option></select></label><label>{text('Max parallelism', '最大並列数')}<input value={policy.budget.maxParallelism} disabled /></label><p className={pattern === 'sequential' || pattern === 'concurrent' ? 'validation-status good' : 'validation-status'}>{pattern === 'sequential' || pattern === 'concurrent' ? text('Executable in preview', 'previewで実行可能') : text('Definition can be saved; interactive runtime follows next.', '定義は保存可能です。対話型runtimeは次の段階で追加します。')}</p></div>
        {validation !== undefined && <div className={validation.valid ? 'harness-validation good' : 'harness-validation bad'}><strong>{validation.valid ? text('Definition is valid', '定義は有効です') : text('Validation issues', '検証エラー')}</strong>{validation.issues.map((issue) => <p key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</p>)}</div>}
        <div className="harness-preview"><div><span className="eyebrow">{text('Saved Harness preview', '保存済みHarnessのプレビュー')}</span><h2>{savedVersion === undefined ? text('Save to run', '保存後に実行') : `${internalId}@${savedVersion}`}</h2></div><textarea aria-label={text('Harness chat message', 'Harnessへのメッセージ')} value={runMessage} onChange={(event) => setRunMessage(event.target.value)} placeholder={text('Ask the Harness…', 'Harnessへ依頼…')} /><button type="button" className="primary" disabled={savedVersion === undefined || runMessage.trim() === '' || busy !== undefined || (pattern !== 'sequential' && pattern !== 'concurrent')} onClick={() => void preview()}>{busy === 'run' ? text('Running…', '実行中…') : text('Run preview', 'previewを実行')}</button>{run !== undefined && <div className={`harness-run ${run.status}`}><strong>{run.status}</strong><p>{run.response ?? run.failure?.message}</p><small>{run.events.filter((event) => event.kind === 'participant_completed').length} {text('participant runs', '参加Agent実行')}</small></div>}</div>
      </section></div>
  </main>;
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
