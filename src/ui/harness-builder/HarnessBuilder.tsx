import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, HarnessPatternDto, HarnessPoliciesDto, HarnessRunDto, HarnessSlotDto, HarnessSummaryDto, HarnessTopologyDto, HarnessValidationDto, SaveHarnessDto, SerializedAgentHarnessDto } from '../api/types';
import { useI18n } from '../i18n';

type Translate = (english: string, japanese: string) => string;

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
const patterns: readonly { readonly id: HarnessPatternDto; readonly label: string; readonly noteEn: string; readonly noteJa: string }[] = [
  { id: 'agent-as-tools', label: 'Agent as tools', noteEn: 'Coordinator delegates on demand', noteJa: '調整役が必要時だけ委譲する' },
  { id: 'sequential', label: 'Sequential', noteEn: 'Pass work through an ordered chain', noteJa: '順番に受け渡して仕上げる' },
  { id: 'concurrent', label: 'Concurrent', noteEn: 'Run independent branches, then collect', noteJa: '独立に並列実行して集約する' },
  { id: 'handoff', label: 'Handoff', noteEn: 'Transfer ownership through allowed routes', noteJa: '許可された経路で担当を移譲する' },
  { id: 'group-chat', label: 'Group Chat', noteEn: 'Select speakers across bounded rounds', noteJa: '上限roundの中で発話者を選ぶ' },
  { id: 'magentic', label: 'Magentic', noteEn: 'Manager plans, delegates, and synthesizes', noteJa: 'Managerが計画・委譲・統合する' },
];
const policy: HarnessPoliciesDto = { budget: { maxDurationMs: 120000, maxParticipantRuns: 20, maxModelRounds: 40, maxToolCalls: 100, maxParallelism: 4 }, context: 'task-only', planning: { enabled: false, requireApproval: false }, memory: { wikiIds: [], sessionWorkspace: true }, approvals: { mode: 'inherit-agent' }, failure: { mode: 'fail-fast' } };

interface SlotPreset { readonly id: string; readonly labelEn: string; readonly labelJa: string; readonly purposeEn: string; readonly purposeJa: string }
// presetIdが未設定のslotはユーザーが追加したparticipant（customLabel/customPurposeを必ず持つ）。idはtopologyの安定性のため編集では変化しない。
interface SlotState { readonly id: string; readonly presetId?: string; readonly customLabel?: string; readonly customPurpose?: string; readonly assignment: HarnessSlotDto['assignment'] }
type AggregationMode = 'collect' | 'vote' | 'agent';

// Presetのslot id/label/purposeはpattern単位で固定する。sequentialのidはe2e保存アサーションと一致させるため author/reviewer/publisher のまま変更しない。
const slotPresets: Readonly<Record<HarnessPatternDto, readonly SlotPreset[]>> = {
  sequential: [
    { id: 'author', labelEn: 'Author', labelJa: '作成者', purposeEn: 'Create a first result.', purposeJa: '最初の成果物を作成する。' },
    { id: 'reviewer', labelEn: 'Reviewer', labelJa: 'レビュアー', purposeEn: 'Check and improve the result.', purposeJa: '成果物を確認して改善する。' },
    { id: 'publisher', labelEn: 'Publisher', labelJa: '公開担当', purposeEn: 'Prepare the final response.', purposeJa: '最終応答に仕上げる。' },
  ],
  'agent-as-tools': [
    { id: 'coordinator', labelEn: 'Coordinator', labelJa: '調整役', purposeEn: 'Delegate to specialists on demand.', purposeJa: '必要時だけ専門家へ委譲する。' },
    { id: 'researcher', labelEn: 'Researcher', labelJa: '調査役', purposeEn: 'Investigate the requested topic.', purposeJa: '依頼された内容を調査する。' },
    { id: 'analyst', labelEn: 'Analyst', labelJa: '分析役', purposeEn: 'Analyze findings and summarize.', purposeJa: '調査結果を分析して要約する。' },
  ],
  concurrent: [
    { id: 'research', labelEn: 'Research', labelJa: '調査', purposeEn: 'Analyze the input independently.', purposeJa: '入力を独立に分析する。' },
    { id: 'legal', labelEn: 'Legal', labelJa: '法務', purposeEn: 'Review the input for legal risk.', purposeJa: '入力を法務の観点で確認する。' },
    { id: 'marketing', labelEn: 'Marketing', labelJa: 'マーケティング', purposeEn: 'Assess the input for messaging fit.', purposeJa: '入力をメッセージ適合の観点で評価する。' },
  ],
  handoff: [
    { id: 'triage', labelEn: 'Triage', labelJa: '受付', purposeEn: 'Understand the request and route it.', purposeJa: '依頼内容を把握して振り分ける。' },
    { id: 'order', labelEn: 'Order', labelJa: '注文対応', purposeEn: 'Handle order-related requests.', purposeJa: '注文に関する依頼へ対応する。' },
    { id: 'returns', labelEn: 'Returns', labelJa: '返品対応', purposeEn: 'Handle return-related requests.', purposeJa: '返品に関する依頼へ対応する。' },
  ],
  'group-chat': [
    { id: 'writer', labelEn: 'Writer', labelJa: '執筆役', purposeEn: 'Draft the content.', purposeJa: '内容を執筆する。' },
    { id: 'reviewer', labelEn: 'Reviewer', labelJa: 'レビュアー', purposeEn: 'Check and improve the result.', purposeJa: '成果物を確認して改善する。' },
    { id: 'expert', labelEn: 'Expert', labelJa: '専門家', purposeEn: 'Provide domain expertise.', purposeJa: '専門知識を提供する。' },
  ],
  magentic: [
    { id: 'manager', labelEn: 'Manager', labelJa: 'マネージャ', purposeEn: 'Plan, delegate, and synthesize.', purposeJa: '計画・委譲・統合を行う。' },
    { id: 'researcher', labelEn: 'Researcher', labelJa: '調査役', purposeEn: 'Investigate the requested topic.', purposeJa: '依頼された内容を調査する。' },
    { id: 'coder', labelEn: 'Coder', labelJa: '実装役', purposeEn: 'Implement the requested change.', purposeJa: '依頼された変更を実装する。' },
  ],
};

function findPreset(pattern: HarnessPatternDto, id: string): SlotPreset {
  return slotPresets[pattern].find((preset) => preset.id === id) ?? { id, labelEn: id, labelJa: id, purposeEn: '', purposeJa: '' };
}
function initialSlotStates(pattern: HarnessPatternDto): SlotState[] {
  return slotPresets[pattern].map((preset) => ({ id: preset.id, presetId: preset.id, assignment: { internalId: '', version: '' } }));
}
function resolveSlots(pattern: HarnessPatternDto, states: readonly SlotState[], text: Translate): HarnessSlotDto[] {
  return states.map((state) => {
    const preset = findPreset(pattern, state.presetId ?? state.id);
    const label = state.customLabel ?? text(preset.labelEn, preset.labelJa);
    const purpose = state.customPurpose ?? text(preset.purposeEn, preset.purposeJa);
    return { id: state.id, label, purpose, assignment: state.assignment };
  });
}
// concurrent + aggregation:'agent' の時だけ、末尾にaggregator用のslot（id:'aggregator'）を付加してDTOへ渡す。
function topology(pattern: HarnessPatternDto, slots: readonly HarnessSlotDto[], aggregation: AggregationMode): HarnessTopologyDto {
  const ids = slots.map((slot) => slot.id); const first = ids[0] ?? ''; const rest = ids.slice(1);
  switch (pattern) {
    case 'sequential': return { pattern, orderedSlotIds: ids, contextMode: 'full-conversation' };
    case 'concurrent': {
      const participantSlotIds = ids.filter((id) => id !== 'aggregator');
      return aggregation === 'agent'
        ? { pattern, participantSlotIds, aggregation, aggregatorSlotId: 'aggregator' }
        : { pattern, participantSlotIds, aggregation };
    }
    case 'agent-as-tools': return { pattern, coordinatorSlotId: first, participantSlotIds: rest };
    case 'handoff': return { pattern, startSlotId: first, transitions: rest.map((id) => ({ fromSlotId: first, toSlotId: id, condition: `Route work to ${id}` })), autonomous: false };
    case 'group-chat': return { pattern, participantSlotIds: ids, selector: 'round-robin', maxRounds: 3 };
    case 'magentic': return { pattern, managerSlotId: first, participantSlotIds: rest, maxRounds: 6, maxStalls: 2, maxResets: 1, requirePlanSignoff: false };
  }
}
// topology()の逆変換: 保存済みHarnessを編集で開いた時、canvasに描くparticipant系slotをtopology順に並べる。
// concurrentのaggregatorSlotIdはparticipantSlotIdsに含まれないため、ここでは常に除外済み。
function orderedParticipantIds(topology: HarnessTopologyDto): readonly string[] {
  switch (topology.pattern) {
    case 'sequential': return topology.orderedSlotIds;
    case 'concurrent': return topology.participantSlotIds;
    case 'agent-as-tools': return [topology.coordinatorSlotId, ...topology.participantSlotIds];
    case 'handoff': return [topology.startSlotId, ...topology.transitions.map((transition) => transition.toSlotId)];
    case 'group-chat': return topology.participantSlotIds;
    case 'magentic': return [topology.managerSlotId, ...topology.participantSlotIds];
  }
}
// slotの追加id生成: 'slot-2', 'slot-3', … の中から既存idと衝突しない最小のものを使う。
function nextSlotId(existingIds: readonly string[]): string {
  let n = 2;
  while (existingIds.includes(`slot-${n}`)) n += 1;
  return `slot-${n}`;
}
// coordinator/start/managerのような固定先頭slotを持つpatternでは、参加者数は全slot数-1になる。
function hasFixedFirstSlot(pattern: HarnessPatternDto): boolean {
  return pattern === 'agent-as-tools' || pattern === 'handoff' || pattern === 'magentic';
}
function participantSlotCount(pattern: HarnessPatternDto, totalSlots: number): number {
  return hasFixedFirstSlot(pattern) ? Math.max(totalSlots - 1, 0) : totalSlots;
}
// domainのvalidateTopology最小件数から導出: sequential/concurrent/group-chatは全slotで2、agent-as-tools/handoffは固定先頭+参加者1で2、magenticは固定先頭+参加者2で3。
function slotCountMinimum(pattern: HarnessPatternDto): number {
  return pattern === 'magentic' ? 3 : 2;
}
function canRemoveSlot(pattern: HarnessPatternDto, index: number, total: number): boolean {
  if (hasFixedFirstSlot(pattern) && index === 0) return false;
  return total > slotCountMinimum(pattern);
}

// Canvasはpatternごとに専用のCSS grid/flex構造で描画し、slotを見ただけでtopologyの違いが分かるようにする（横並び1行には統一しない）。
// label/purposeは常にinput要素として編集可能にする。ただしAssign selectのaria-labelは表示中のlabelを使い続け、既存e2eのセレクタ（preset既定値）を壊さない。
function SlotCard({ slot, badge, agents, text, onAssign, removable, onRemove, onLabelChange, onPurposeChange }: {
  readonly slot: HarnessSlotDto; readonly badge?: string; readonly agents: readonly AgentSummaryDto[]; readonly text: Translate;
  readonly onAssign: (agentId: string) => void; readonly removable: boolean; readonly onRemove: () => void;
  readonly onLabelChange: (label: string) => void; readonly onPurposeChange: (purpose: string) => void;
}) {
  return <div className="harness-slot">
    {badge !== undefined && <span className="harness-role-badge">{badge}</span>}
    {removable && <button type="button" className="harness-slot-remove" aria-label={`${text('Remove slot', 'Slotを削除')} ${slot.label}`} onClick={onRemove}>×</button>}
    <input className="harness-slot-label-input" aria-label={`${text('Slot label', 'Slot名')} ${slot.id}`} value={slot.label} onChange={(event) => onLabelChange(event.target.value)} />
    <input className="harness-slot-purpose-input" aria-label={`${text('Slot purpose', 'Slotの目的')} ${slot.id}`} value={slot.purpose} onChange={(event) => onPurposeChange(event.target.value)} />
    <select aria-label={`${text('Assign agent to', 'Agentを割り当て')} ${slot.label}`} value={slot.assignment.internalId} onChange={(event) => onAssign(event.target.value)}>
      <option value="">{text('Assign saved Agent…', '保存済みAgentを割り当て…')}</option>
      {agents.map((agent) => <option key={agent.internalId} value={agent.internalId}>{agent.displayName}@{agent.latestVersion}</option>)}
    </select>
    <code>{slot.assignment.internalId === '' ? text('unassigned', '未割当') : `${slot.assignment.internalId}@${slot.assignment.version}`}</code>
  </div>;
}
// concurrent + aggregation:'agent' の時、fan-in位置に置くaggregator専用card。参加者columnには属さず、label/purposeは固定（編集UIなし）。
function AggregatorCard({ label, purpose, assignment, agents, text, onAssign }: {
  readonly label: string; readonly purpose: string; readonly assignment: HarnessSlotDto['assignment']; readonly agents: readonly AgentSummaryDto[];
  readonly text: Translate; readonly onAssign: (agentId: string) => void;
}) {
  return <div className="harness-slot harness-slot--aggregator">
    <span className="harness-role-badge">{text('Aggregator', '集約役')}</span>
    <strong>{label}</strong>
    <small>{purpose}</small>
    <select aria-label={`${text('Assign agent to', 'Agentを割り当て')} ${label}`} value={assignment.internalId} onChange={(event) => onAssign(event.target.value)}>
      <option value="">{text('Assign saved Agent…', '保存済みAgentを割り当て…')}</option>
      {agents.map((agent) => <option key={agent.internalId} value={agent.internalId}>{agent.displayName}@{agent.latestVersion}</option>)}
    </select>
    <code>{assignment.internalId === '' ? text('unassigned', '未割当') : `${assignment.internalId}@${assignment.version}`}</code>
  </div>;
}
function AddParticipantButton({ text, onAdd }: { readonly text: Translate; readonly onAdd: () => void }) {
  return <button type="button" className="harness-add-slot" onClick={onAdd}>{text('+ Add participant', '+ 参加者を追加')}</button>;
}
function aggregationChipLabel(aggregation: 'collect' | 'vote', text: Translate): string {
  return aggregation === 'collect' ? text('Aggregation: collect', '集約: collect') : text('Aggregation: vote', '集約: vote');
}
function Connector({ symbol, label, dashed, vertical }: { readonly symbol: string; readonly label?: string; readonly dashed?: boolean; readonly vertical?: boolean }) {
  const className = ['harness-connector', vertical === true ? 'harness-connector--vertical' : undefined, dashed === true ? 'harness-connector--dashed' : undefined].filter((part) => part !== undefined).join(' ');
  return <div className={className}>{label !== undefined && <span className="harness-connector-label">{label}</span>}<span className="harness-connector-glyph" aria-hidden="true">{symbol}</span></div>;
}
function InputNode({ text }: { readonly text: Translate }) { return <div className="harness-input-node">{text('Input', '入力')}</div>; }
function OutputNode({ text }: { readonly text: Translate }) { return <div className="harness-output-node">{text('Output', '出力')}</div>; }
function HubChip({ label }: { readonly label: string }) { return <div className="harness-flow-chip harness-hub-chip">{label}</div>; }
function branchGlyph(index: number, total: number): string {
  if (total <= 1) return '→';
  if (index === 0) return '↗';
  if (index === total - 1) return '↘';
  return '→';
}
// patternごとの2D構造（sequentialのみ自然に横一列、他は分岐・hub&spoke・fan outをgrid/flexで表現する）。
// `slots`はparticipant系のみ（concurrentのaggregatorは含まない）。追加/削除/label編集は全pattern共通のhandlerで扱う。
function HarnessCanvasBody({ pattern, slots, agents, text, assign, badge, onRemoveSlot, onLabelChange, onPurposeChange, onAddParticipant, aggregation, aggregatorSlot, onAggregatorAssign }: {
  readonly pattern: HarnessPatternDto; readonly slots: readonly HarnessSlotDto[]; readonly agents: readonly AgentSummaryDto[]; readonly text: Translate;
  readonly assign: (slotId: string, agentId: string) => void; readonly badge: string | undefined;
  readonly onRemoveSlot: (slotId: string) => void; readonly onLabelChange: (slotId: string, label: string) => void; readonly onPurposeChange: (slotId: string, purpose: string) => void;
  readonly onAddParticipant: () => void; readonly aggregation: AggregationMode; readonly aggregatorSlot: HarnessSlotDto; readonly onAggregatorAssign: (agentId: string) => void;
}) {
  const card = (slot: HarnessSlotDto, index: number, withBadge?: boolean) => <SlotCard key={slot.id} slot={slot} badge={withBadge === true ? badge : undefined} agents={agents} text={text}
    onAssign={(agentId) => assign(slot.id, agentId)} removable={canRemoveSlot(pattern, index, slots.length)} onRemove={() => onRemoveSlot(slot.id)}
    onLabelChange={(label) => onLabelChange(slot.id, label)} onPurposeChange={(purpose) => onPurposeChange(slot.id, purpose)} />;
  const addButton = <AddParticipantButton key="add" text={text} onAdd={onAddParticipant} />;
  switch (pattern) {
    case 'sequential':
      return <div className="harness-chain"><InputNode text={text} />{slots.map((slot, index) => <Fragment key={slot.id}><Connector symbol="→" />{card(slot, index)}</Fragment>)}<Connector symbol="→" />{addButton}<Connector symbol="→" /><OutputNode text={text} /></div>;
    case 'concurrent':
      return <div className="harness-fanout"><InputNode text={text} /><div className="harness-branches">{slots.map((slot, index) => <div className="harness-branch" key={slot.id}><Connector symbol={branchGlyph(index, slots.length)} />{card(slot, index)}</div>)}{addButton}</div><div className="harness-collect"><Connector symbol="→" />{aggregation === 'agent' ? <AggregatorCard label={aggregatorSlot.label} purpose={aggregatorSlot.purpose} assignment={aggregatorSlot.assignment} agents={agents} text={text} onAssign={onAggregatorAssign} /> : <HubChip label={aggregationChipLabel(aggregation, text)} />}</div><Connector symbol="→" /><OutputNode text={text} /></div>;
    case 'agent-as-tools': {
      const [coordinator, ...participants] = slots;
      if (coordinator === undefined) return null;
      return <div className="harness-hub-layout"><div className="harness-main-row"><InputNode text={text} /><Connector symbol="→" />{card(coordinator, 0, true)}<Connector symbol="→" /><OutputNode text={text} /></div><div className="harness-spokes">{participants.map((slot, index) => <div className="harness-spoke" key={slot.id}><Connector symbol="┆" label={text('ask', 'ask')} dashed vertical />{card(slot, index + 1)}</div>)}{addButton}</div></div>;
    }
    case 'handoff': {
      const [start, ...targets] = slots;
      if (start === undefined) return null;
      return <div className="harness-handoff-row"><InputNode text={text} /><Connector symbol="→" />{card(start, 0, true)}<div className="harness-handoff-routes">{targets.map((slot, index) => <div className="harness-handoff-route" key={slot.id}><Connector symbol="→" label={text('handoff', '移譲')} />{card(slot, index + 1)}</div>)}{addButton}</div><Connector symbol="→" /><OutputNode text={text} /></div>;
    }
    case 'group-chat':
      return <div className="harness-hub-layout"><div className="harness-main-row"><InputNode text={text} /><Connector symbol="→" /><HubChip label={text('Round-robin · max 3 rounds', '回覧 round-robin · 最大3round')} /><Connector symbol="→" /><OutputNode text={text} /></div><div className="harness-spokes">{slots.map((slot, index) => <div className="harness-spoke" key={slot.id}><Connector symbol="⇅" vertical />{card(slot, index)}</div>)}{addButton}</div></div>;
    case 'magentic': {
      const [manager, ...participants] = slots;
      if (manager === undefined) return null;
      return <div className="harness-hub-layout"><div className="harness-main-row"><InputNode text={text} /><Connector symbol="→" />{card(manager, 0, true)}<Connector symbol="→" /><OutputNode text={text} /></div><div className="harness-ledger-chip">{text('Plan / Progress ledger · max 6 rounds', '計画・進捗台帳 · 最大6round')}</div><div className="harness-spokes">{participants.map((slot, index) => <div className="harness-spoke" key={slot.id}><Connector symbol="⇅" label={text('delegate', '委譲')} dashed vertical />{card(slot, index + 1)}</div>)}{addButton}</div></div>;
    }
  }
}
function roleBadge(pattern: HarnessPatternDto, text: Translate): string | undefined {
  switch (pattern) {
    case 'agent-as-tools': return text('Coordinator', '調整役');
    case 'handoff': return text('Start', '開始');
    case 'magentic': return text('Manager', 'マネージャ');
    default: return undefined;
  }
}
function topologySummaryRows(current: HarnessTopologyDto, text: Translate, aggregatorAssignment: HarnessSlotDto['assignment']): readonly { readonly key: string; readonly label: string; readonly value: string }[] {
  switch (current.pattern) {
    case 'sequential': return [{ key: 'contextMode', label: text('Context mode', 'コンテキストmode'), value: current.contextMode }];
    case 'concurrent': {
      const rows: { readonly key: string; readonly label: string; readonly value: string }[] = [{ key: 'aggregation', label: text('Aggregation', '集約'), value: current.aggregation }];
      if (current.aggregation === 'agent') {
        const value = aggregatorAssignment.internalId === '' ? text('unassigned', '未割当') : `${aggregatorAssignment.internalId}@${aggregatorAssignment.version}`;
        rows.push({ key: 'aggregator', label: text('Aggregator', '集約役'), value });
      }
      return rows;
    }
    case 'agent-as-tools': return [
      { key: 'coordinator', label: text('Coordinator', '調整役'), value: current.coordinatorSlotId },
      { key: 'participants', label: text('Participants', '参加者数'), value: String(current.participantSlotIds.length) },
    ];
    case 'handoff': return [
      { key: 'start', label: text('Start slot', '開始slot'), value: current.startSlotId },
      { key: 'transitions', label: text('Transitions', '移譲経路数'), value: String(current.transitions.length) },
    ];
    case 'group-chat': return [
      { key: 'selector', label: text('Selector', '話者選択'), value: current.selector },
      { key: 'maxRounds', label: text('Max rounds', '最大round'), value: String(current.maxRounds) },
    ];
    case 'magentic': return [
      { key: 'maxRounds', label: text('Max rounds', '最大round'), value: String(current.maxRounds) },
      { key: 'maxStalls', label: text('Max stalls', '最大stall'), value: String(current.maxStalls) },
      { key: 'maxResets', label: text('Max resets', '最大reset'), value: String(current.maxResets) },
      { key: 'requirePlanSignoff', label: text('Plan sign-off', 'Plan承認'), value: current.requirePlanSignoff ? text('required', '必須') : text('not required', '不要') },
    ];
  }
}
function message(cause: unknown, text: Translate): string { return cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'); }

export function HarnessBuilder({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  // Layer 1: 保存済みHarness一覧。'list'が既定viewで、new/openでLayer 2（editor）へ遷移する。
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [harnesses, setHarnesses] = useState<readonly HarnessSummaryDto[]>([]);
  // editing=true は一覧からOpenした既存Harness。internalIdは別資産を分岐させてしまうため編集不可にする。
  const [editing, setEditing] = useState(false);
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [pattern, setPattern] = useState<HarnessPatternDto>('sequential');
  const [slotStates, setSlotStates] = useState<SlotState[]>(() => initialSlotStates('sequential'));
  const [internalId, setInternalId] = useState(''); const [displayName, setDisplayName] = useState(''); const [owner, setOwner] = useState('');
  const [savedVersion, setSavedVersion] = useState<string>(); const [validation, setValidation] = useState<HarnessValidationDto>(); const [runMessage, setRunMessage] = useState(''); const [run, setRun] = useState<HarnessRunDto>();
  const [busy, setBusy] = useState<'load' | 'validate' | 'save' | 'run'>(); const [error, setError] = useState<string>();
  const [aggregation, setAggregation] = useState<AggregationMode>('collect');
  const [aggregatorAssignment, setAggregatorAssignment] = useState<HarnessSlotDto['assignment']>({ internalId: '', version: '' });
  useEffect(() => { let active = true; setBusy('load'); void client.listAgents(scope).then((items) => { if (active) setAgents(items); }).catch((cause: unknown) => { if (active) setError(message(cause, text)); }).finally(() => { if (active) setBusy(undefined); }); return () => { active = false; }; }, [client, text]);
  useEffect(() => { let active = true; void client.listHarnesses(scope).then((items) => { if (active) setHarnesses(items); }).catch((cause: unknown) => { if (active) setError(message(cause, text)); }); return () => { active = false; }; }, [client, text]);
  async function refreshHarnesses(): Promise<void> {
    try { setHarnesses(await client.listHarnesses(scope)); }
    catch (cause) { setError(message(cause, text)); }
  }
  function resetEditorState(): void {
    setPattern('sequential'); setSlotStates(initialSlotStates('sequential'));
    setInternalId(''); setDisplayName(''); setOwner('');
    setSavedVersion(undefined); setValidation(undefined); setRunMessage(''); setRun(undefined);
    setAggregation('collect'); setAggregatorAssignment({ internalId: '', version: '' });
    setEditing(false);
  }
  function startNewHarness(): void { resetEditorState(); setError(undefined); setView('editor'); }
  async function backToList(): Promise<void> { setView('list'); await refreshHarnesses(); }
  async function openHarness(target: string): Promise<void> {
    setBusy('load'); setError(undefined);
    try {
      const harness = await client.getHarness(target, scope);
      populateEditorFromHarness(harness);
      setView('editor');
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }
  async function removeHarness(target: string): Promise<void> {
    setBusy('load'); setError(undefined);
    try { await client.deleteHarness(target, scope); await refreshHarnesses(); }
    catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }
  // 一覧からOpenした保存済みHarnessをeditor stateへ復元する。slotはtopology順（agent-as-tools/handoff/magenticは固定先頭slotが先頭）。
  function populateEditorFromHarness(harness: SerializedAgentHarnessDto): void {
    const ids = orderedParticipantIds(harness.topology);
    const states: SlotState[] = ids.map((id) => {
      const slot = harness.slots.find((item) => item.id === id);
      return { id, customLabel: slot?.label ?? id, customPurpose: slot?.purpose ?? '', assignment: slot?.assignment ?? { internalId: '', version: '' } };
    });
    setPattern(harness.pattern);
    setSlotStates(states);
    setInternalId(harness.metadata.internalId);
    setDisplayName(harness.metadata.displayName);
    setOwner(harness.metadata.owner);
    const topologyForAggregator = harness.topology;
    if (topologyForAggregator.pattern === 'concurrent' && topologyForAggregator.aggregation === 'agent' && topologyForAggregator.aggregatorSlotId !== undefined) {
      const aggregatorSlot = harness.slots.find((item) => item.id === topologyForAggregator.aggregatorSlotId);
      setAggregation('agent');
      setAggregatorAssignment(aggregatorSlot?.assignment ?? { internalId: '', version: '' });
    } else {
      setAggregation(harness.topology.pattern === 'concurrent' ? harness.topology.aggregation : 'collect');
      setAggregatorAssignment({ internalId: '', version: '' });
    }
    setSavedVersion(harness.metadata.version);
    setValidation(undefined); setRun(undefined); setRunMessage('');
    setEditing(true);
  }
  const selected = useMemo(() => patterns.find((item) => item.id === pattern), [pattern]);
  // resolvedSlots はcanvasに描くparticipant系slotのみ。concurrent+agentのaggregatorはaggregatorSlotとして別管理し、保存時だけsaveSlotsへ合流する。
  const resolvedSlots = useMemo(() => resolveSlots(pattern, slotStates, text), [pattern, slotStates, text]);
  const aggregatorSlot = useMemo<HarnessSlotDto>(() => ({ id: 'aggregator', label: text('Aggregator', '集約役'), purpose: text('Synthesize branch results into one response.', 'branch結果を1つの応答へ統合する。'), assignment: aggregatorAssignment }), [text, aggregatorAssignment]);
  const saveSlots = useMemo(() => pattern === 'concurrent' && aggregation === 'agent' ? [...resolvedSlots, aggregatorSlot] : resolvedSlots, [pattern, aggregation, resolvedSlots, aggregatorSlot]);
  const currentTopology = useMemo(() => topology(pattern, saveSlots, aggregation), [pattern, saveSlots, aggregation]);
  const aggregatorReady = pattern !== 'concurrent' || aggregation !== 'agent' || aggregatorAssignment.internalId !== '';
  const ready = internalId.trim() !== '' && displayName.trim() !== '' && owner.trim() !== '' && slotStates.every((slot) => slot.assignment.internalId !== '') && aggregatorReady;
  const input = useMemo<SaveHarnessDto>(() => ({ scope, internalId, workingName: `${displayName || internalId} draft`, displayName, publishName: internalId.replace(/[^A-Za-z0-9_-]/g, '_'), owner, pattern, slots: saveSlots, topology: currentTopology, policies: policy, output: { format: 'text' } }), [internalId, displayName, owner, pattern, saveSlots, currentTopology]);
  function choosePattern(next: HarnessPatternDto): void {
    const nextPreset = slotPresets[next];
    setSlotStates((current) => {
      const base: SlotState[] = nextPreset.map((preset, index) => ({ id: preset.id, presetId: preset.id, assignment: current[index]?.assignment ?? { internalId: '', version: '' } }));
      // 直前のpatternの方がslot数が多い場合、はみ出したユーザー追加slotをそのまま維持して総数を保つ。
      return [...base, ...current.slice(nextPreset.length)];
    });
    setPattern(next); setValidation(undefined); setSavedVersion(undefined); setRun(undefined);
  }
  function assign(slotId: string, agentId: string): void {
    const agent = agents.find((item) => item.internalId === agentId);
    setSlotStates((current) => current.map((slot) => slot.id !== slotId ? slot : { ...slot, assignment: agent === undefined ? { internalId: '', version: '' } : { internalId: agent.internalId, version: agent.latestVersion } }));
    setValidation(undefined); setSavedVersion(undefined);
  }
  function assignAggregator(agentId: string): void {
    const agent = agents.find((item) => item.internalId === agentId);
    setAggregatorAssignment(agent === undefined ? { internalId: '', version: '' } : { internalId: agent.internalId, version: agent.latestVersion });
    setValidation(undefined); setSavedVersion(undefined);
  }
  function chooseAggregation(next: AggregationMode): void {
    setAggregation(next); setValidation(undefined); setSavedVersion(undefined);
  }
  function addParticipant(): void {
    setSlotStates((current) => {
      const id = nextSlotId(current.map((slot) => slot.id));
      const n = participantSlotCount(pattern, current.length) + 1;
      const newSlot: SlotState = { id, customLabel: text(`Participant ${n}`, `参加者${n}`), customPurpose: text("Describe this participant's responsibility.", 'この参加者の責務を記述する。'), assignment: { internalId: '', version: '' } };
      return [...current, newSlot];
    });
    setValidation(undefined); setSavedVersion(undefined);
  }
  function removeSlot(slotId: string): void {
    setSlotStates((current) => current.filter((slot) => slot.id !== slotId));
    setValidation(undefined); setSavedVersion(undefined);
  }
  function editSlotLabel(slotId: string, label: string): void {
    setSlotStates((current) => current.map((slot) => slot.id === slotId ? { ...slot, customLabel: label } : slot));
    setValidation(undefined); setSavedVersion(undefined);
  }
  function editSlotPurpose(slotId: string, purpose: string): void {
    setSlotStates((current) => current.map((slot) => slot.id === slotId ? { ...slot, customPurpose: purpose } : slot));
    setValidation(undefined); setSavedVersion(undefined);
  }
  async function validate(): Promise<void> { if (!ready) { setValidation({ valid: false, issues: [{ path: '(definition)', message: text('Fill names and assign every slot to a saved Agent version.', '名前を入力し、全slotへ保存済みAgent versionを割り当ててください。') }] }); return; } setBusy('validate'); setError(undefined); try { setValidation(await client.validateHarness(input)); } catch (cause) { setError(message(cause, text)); } finally { setBusy(undefined); } }
  async function save(): Promise<void> { if (!ready) return; setBusy('save'); setError(undefined); try { const harness = await client.saveHarness(input); setSavedVersion(harness.metadata.version); setValidation({ valid: true, issues: [] }); } catch (cause) { setError(message(cause, text)); } finally { setBusy(undefined); } }
  async function preview(): Promise<void> { if (savedVersion === undefined || runMessage.trim() === '') return; setBusy('run'); setError(undefined); try { setRun(await client.runHarness({ scope, harness: { internalId, version: savedVersion }, message: runMessage, mode: 'preview' })); } catch (cause) { setError(message(cause, text)); } finally { setBusy(undefined); } }
  const badge = roleBadge(pattern, text);
  if (view === 'list') {
    return <main className="harness-builder harness-list-page">
      <header className="harness-builder-header"><div><span className="eyebrow">{text('Agent Harness Builder', 'Agent Harness Builder')}</span><h1>{text('Harnesses', 'Harness一覧')}</h1><p>{text('Compose saved Agent versions into a typed orchestration pattern.', '保存済みAgentのversionを型付きオーケストレーションへ組み立てます。')}</p></div><div className="save-actions"><button type="button" className="primary" onClick={startNewHarness}>{text('New harness', '新規作成')}</button></div></header>
      {error !== undefined && <div className="api-error">{error}</div>}
      <section className="workspace-card harness-list">
        {harnesses.length === 0 ? <p className="empty-state">{text('No harnesses yet.', 'Harnessはまだありません。')}</p> : <div className="harness-list-rows">{harnesses.map((item) => <article className="harness-list-row" key={item.internalId}>
          <div><strong>{item.displayName}</strong><code>{item.publishName}@{item.latestVersion}</code><small>{item.pattern} · {item.state}</small></div>
          <div className="harness-list-actions">
            <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void openHarness(item.internalId)}>{text('Open', '開く')}</button>
            <button type="button" className="secondary danger" disabled={busy !== undefined} onClick={() => void removeHarness(item.internalId)}>{text('Delete', '削除')}</button>
          </div>
        </article>)}</div>}
      </section>
    </main>;
  }
  return <main className="harness-builder">
    <header className="harness-builder-header"><div><button type="button" className="secondary harness-back-button" onClick={() => void backToList()}>{text('Back to list', '一覧へ戻る')}</button><span className="eyebrow">{text('Agent Harness Builder', 'Agent Harness Builder')}</span><h1>{displayName || text('New Harness', '新しいHarness')}</h1><p>{text('Assign saved Agent versions to a typed orchestration pattern.', '保存済みAgentのversionを、型付きオーケストレーションのslotへ割り当てます。')}</p></div><div className="save-actions"><button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void validate()}>{busy === 'validate' ? text('Validating…', '検証中…') : text('Validate', '検証')}</button><button type="button" className="primary" disabled={!ready || busy !== undefined} onClick={() => void save()}>{busy === 'save' ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button></div></header>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="harness-layout"><aside className="harness-presets"><h2>{text('Patterns', 'パターン')}</h2>{patterns.map((item) => <button key={item.id} type="button" className={pattern === item.id ? 'active' : ''} onClick={() => choosePattern(item.id)}><strong>{item.label}</strong><small>{text(item.noteEn, item.noteJa)}</small></button>)}</aside>
      <section className="harness-workspace"><div className="harness-fields"><label>{text('Internal ID', '内部ID')}<input value={internalId} readOnly={editing} title={editing ? text('Internal ID cannot change once saved (it would fork a new asset).', '保存済みの内部IDは変更できません（変更すると別資産になります）。') : undefined} onChange={(event) => { if (editing) return; setInternalId(event.target.value); setSavedVersion(undefined); }} placeholder="content-review" /></label><label>{text('Display name', '表示名')}<input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSavedVersion(undefined); }} placeholder="Content Review" /></label><label>{text('Owner', '所有者')}<input value={owner} onChange={(event) => { setOwner(event.target.value); setSavedVersion(undefined); }} placeholder="team@example.com" /></label></div>
        <div className={`harness-canvas harness-canvas--${pattern}`} aria-label={text('Harness canvas', 'Harnessキャンバス')}><HarnessCanvasBody pattern={pattern} slots={resolvedSlots} agents={agents} text={text} assign={assign} badge={badge} onRemoveSlot={removeSlot} onLabelChange={editSlotLabel} onPurposeChange={editSlotPurpose} onAddParticipant={addParticipant} aggregation={aggregation} aggregatorSlot={aggregatorSlot} onAggregatorAssign={assignAggregator} /></div>
        <div className={`harness-inspector${pattern === 'concurrent' ? ' harness-inspector--concurrent' : ''}`}><div><span className="eyebrow">{text('Pattern inspector', 'パターン設定')}</span><h2>{selected?.label}</h2><p>{selected !== undefined ? text(selected.noteEn, selected.noteJa) : ''}</p></div><label>{text('Failure policy', '失敗時の方針')}<select value={policy.failure.mode} disabled><option>fail-fast</option></select></label><label>{text('Max parallelism', '最大並列数')}<input value={policy.budget.maxParallelism} disabled /></label>{pattern === 'concurrent' && <label>{text('Aggregation', '集約方法')}<select value={aggregation} onChange={(event) => chooseAggregation(event.target.value as AggregationMode)}><option value="collect">{text('Concatenate mechanically (collect)', '機械的に連結 (collect)')}</option><option value="vote">{text('Majority vote (vote)', '投票で決定 (vote)')}</option><option value="agent">{text('Synthesize with an Agent (agent)', 'Agentで統合 (agent)')}</option></select></label>}<p className="validation-status good">{text('Executable in preview', 'previewで実行可能')}</p><div className="harness-topology-summary">{topologySummaryRows(currentTopology, text, aggregatorAssignment).map((row) => <span key={row.key} className="harness-topology-row">{row.label}: {row.value}</span>)}</div></div>
        {validation !== undefined && <div className={validation.valid ? 'harness-validation good' : 'harness-validation bad'}><strong>{validation.valid ? text('Definition is valid', '定義は有効です') : text('Validation issues', '検証エラー')}</strong>{validation.issues.map((issue) => <p key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</p>)}</div>}
        <div className="harness-preview"><div><span className="eyebrow">{text('Saved Harness preview', '保存済みHarnessのプレビュー')}</span><h2>{savedVersion === undefined ? text('Save to run', '保存後に実行') : `${internalId}@${savedVersion}`}</h2></div><textarea aria-label={text('Harness chat message', 'Harnessへのメッセージ')} value={runMessage} onChange={(event) => setRunMessage(event.target.value)} placeholder={text('Ask the Harness…', 'Harnessへ依頼…')} /><button type="button" className="primary" disabled={savedVersion === undefined || runMessage.trim() === '' || busy !== undefined} onClick={() => void preview()}>{busy === 'run' ? text('Running…', '実行中…') : text('Run preview', 'previewを実行')}</button>{run !== undefined && <div className={`harness-run ${run.status}`}><strong>{run.status}</strong><p>{run.response ?? run.failure?.message}</p><small>{run.events.filter((event) => event.kind === 'participant_completed').length} {text('participant runs', '参加Agent実行')}</small></div>}</div>
      </section></div>
  </main>;
}
