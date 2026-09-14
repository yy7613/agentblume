import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError, type ToolApiClient } from '../api/tool-api';
import { localizeRunTraceError } from '../api/error-messages';
import type { AgentDiagnosticsDto, AgentKindDto, AgentPreviewRunDto, AgentSummaryDto, McpServerDto, RunTraceEventDto, SaveAgentDto, SerializedAgentDto, SideEffectDto, SkillSummaryDto, StructuredOutputFieldDto, StructuredOutputTypeDto, ToolSummaryDto, WikiSpaceSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AGENT_SECTION, DiagnosticsPanel, diagnosticCheckLabel, topIssue, type LocalTarget } from '../components/DiagnosticsPanel';
import { localizeDiagnosticDetail } from '../api/error-messages';
import { DraftRestoreBanner } from '../components/DraftRestoreBanner';
import { InlineFeedback } from '../components/InlineFeedback';
import { draftKey, useDraftPersistence } from '../hooks/useDraftPersistence';
import { useReportUnsavedChanges } from '../unsaved-changes';
import { ScreenLink, usePendingOpen, type OpenTarget } from '../navigation';
import { useI18n, type Language } from '../i18n';
import { DEFAULT_HARNESS, HarnessSettingsDialog, countEnabledHarness, type AgentHarnessValue } from './HarnessSettingsDialog';
import { scope } from '../scope';

type Translate = (english: string, japanese: string) => string;

/**
 * 下書きへ退避する編集内容。保存対象の定義だけを持ち、実行結果やプレビュー入力のような
 * 一時状態は含めない（秘密情報を持つ項目もこの画面には無い）。
 */
interface AgentDraft {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly kind: AgentKindDto;
  readonly systemPrompt: string;
  readonly structuredOutput: boolean;
  readonly outputFields: readonly StructuredOutputFieldDto[];
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly wikis: readonly string[];
  readonly mcpServers: readonly string[];
  readonly subAgents: readonly (readonly [string, string])[];
  readonly harness?: AgentHarnessValue;
}
/** サーバー側 createAgent と同じ上限（超えると保存が400になるためUIで止める）。 */
const MAX_MCP_SERVERS = 8;
/**
 * モデルへ公開できる function 名の形。サブエージェント委譲は `ask_<publishName>` を function 名として
 * 公開するため、publishName がこの形を外れると他のエージェントから委譲できない（保存自体は通る）。
 */
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 診断を起こした契機。manual = 「組み込みチェック」ボタン、auto = 選択変更に追従する自動実行、
 * saved = 保存直後（保存版に対する diagnoseAgent）。要約の文言と、失敗時の目立たせ方が変わる。
 */
type DiagnosticsOrigin = 'manual' | 'auto' | 'saved';
/** プリフライト診断の状態。failed は取得失敗であって診断結果そのものではない。 */
type DiagnosticsState =
  | { readonly status: 'loading'; readonly origin: DiagnosticsOrigin }
  | { readonly status: 'failed'; readonly origin: DiagnosticsOrigin; readonly message: string }
  | { readonly status: 'done'; readonly origin: DiagnosticsOrigin; readonly result: AgentDiagnosticsDto };
/** 選択変更から自動診断までの待ち時間。連続クリックで要求を連発しないための余裕。 */
const AUTO_DIAGNOSE_DELAY_MS = 600;

/** 診断結果の問題数（エージェント検査 + 全ツール検査の error / warning）。 */
function countDiagnosticIssues(result: AgentDiagnosticsDto): number {
  return [...result.checks, ...result.tools.flatMap((tool) => tool.checks)].filter((check) => check.status !== 'ok').length;
}

export function AgentBuilder({ client }: { readonly client: ToolApiClient }) {
  // Layer 1: 保存済みAgent一覧。'list'が既定viewで、new/openでLayer 2（editor）へ遷移する。
  const [view, setView] = useState<'list' | 'editor'>('list');
  // editing=true は一覧からOpenした既存Agent。internalIdは別資産を分岐させてしまうため編集不可にする。
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [skills, setSkills] = useState<readonly SkillSummaryDto[]>([]);
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [wikis, setWikis] = useState<readonly WikiSpaceSummaryDto[]>([]);
  const [selectedWikis, setSelectedWikis] = useState<ReadonlySet<string>>(new Set());
  // MCPサーバーはname（保存済み設定のキー）で選択する。versionを持たないためSetで十分。
  const [mcpServers, setMcpServers] = useState<readonly McpServerDto[]>([]);
  const [selectedMcpServers, setSelectedMcpServers] = useState<ReadonlySet<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<ReadonlySet<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(new Set());
  const [subAgents, setSubAgents] = useState<ReadonlyMap<string, string>>(new Map());
  const [subDefs, setSubDefs] = useState<ReadonlyMap<string, SerializedAgentDto>>(new Map());
  const [internalId, setInternalId] = useState('');
  const [workingName, setWorkingName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [publishName, setPublishName] = useState('');
  const [owner, setOwner] = useState('');
  const [kind, setKind] = useState<AgentKindDto>('normal');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [structuredOutput, setStructuredOutput] = useState(false);
  const [outputFields, setOutputFields] = useState<StructuredOutputFieldDto[]>([{ name: '', type: 'string', required: true }]);
  // ランタイムハーネス設定。undefined は未設定＝保存ペイロードへ harness キーを載せない（従来動作）。
  const [harness, setHarness] = useState<AgentHarnessValue>();
  const [harnessOpen, setHarnessOpen] = useState(false);
  const [savedVersion, setSavedVersion] = useState<string>();
  const [chatMessage, setChatMessage] = useState('');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [busy, setBusy] = useState<'load' | 'generate' | 'save' | 'run'>();
  const [error, setError] = useState<string>();
  // 保存成功フィードバック（savedVersionはpreview実行のために残るため、通知は別stateで自動消去する）。
  const [saveNotice, setSaveNotice] = useState<string>();
  // 削除確認ダイアログの対象（対象名を文言へ入れるためsummaryごと保持する）。
  const [pendingDelete, setPendingDelete] = useState<AgentSummaryDto>();
  // プリフライト診断（組み込みチェック / 選択変更への自動追従 / 保存直後）。パネルの開閉は別に持ち、
  // 自動実行では勝手に開かない（ツール行のバッジと要約行で見せる）。
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // 他画面の「エージェントを開く（区画つき）」の依頼。editor が描画されてから区画へ移るため effect で消費する。
  const [focusSection, setFocusSection] = useState<string>();
  // 対象エージェントを替えたら前の診断結果は無効。進行中の要求も中断する（遅れて届いた結果が復活しないように）。
  const diagnoseAborter = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => diagnoseAborter.current?.abort(), []);
  const { text, language } = useI18n();
  const dismissSaveNotice = useCallback(() => setSaveNotice(undefined), []);

  // 下書きの自動保存。キーは「編集中の既存Agent」または新規（internalIdは編集途中で変わるためキーにしない）。
  const draftValue = useMemo<AgentDraft>(() => ({
    internalId, workingName, displayName, publishName, owner, kind, systemPrompt, structuredOutput, outputFields,
    tools: [...selectedTools], skills: [...selectedSkills], wikis: [...selectedWikis], mcpServers: [...selectedMcpServers],
    subAgents: [...subAgents].map(([id, usage]) => [id, usage] as const), harness,
  }), [internalId, workingName, displayName, publishName, owner, kind, systemPrompt, structuredOutput, outputFields, selectedTools, selectedSkills, selectedWikis, selectedMcpServers, subAgents, harness]);
  const draft = useDraftPersistence<AgentDraft>({ key: draftKey('agent-builder', scope, editing ? internalId : undefined), value: draftValue, enabled: view === 'editor' });
  useReportUnsavedChanges('agent-builder', draft.dirty);
  function applyDraft(value: AgentDraft): void {
    setInternalId(value.internalId); setWorkingName(value.workingName); setDisplayName(value.displayName);
    setPublishName(value.publishName); setOwner(value.owner); setKind(value.kind); setSystemPrompt(value.systemPrompt);
    setStructuredOutput(value.structuredOutput); setOutputFields([...value.outputFields]);
    setSelectedTools(new Set(value.tools)); setSelectedSkills(new Set(value.skills));
    setSelectedWikis(new Set(value.wikis)); setSelectedMcpServers(new Set(value.mcpServers));
    setSubAgents(new Map(value.subAgents));
    setHarness(value.harness === undefined ? undefined : { ...value.harness });
  }

  useEffect(() => {
    let active = true;
    setBusy('load');
    const wikiItems = typeof client.listWikis === 'function' ? client.listWikis(scope) : Promise.resolve([]);
    const mcpRequest = typeof client.listMcpServers === 'function' ? client.listMcpServers(scope) : Promise.resolve([]);
    void Promise.all([client.listTools(scope), client.listSkills(scope), wikiItems, mcpRequest]).then(([toolItems, skillItems, wikiSpaces, mcpItems]) => { if (active) { setTools(toolItems); setSkills(skillItems); setWikis(wikiSpaces); setMcpServers(mcpItems); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, text)); })
      .finally(() => { if (active) setBusy(undefined); });
    return () => { active = false; };
  }, [client, text]);

  // 保存済みAgent一覧（Layer 1の一覧表示 兼 サブエージェント委譲候補）を読み込む。
  useEffect(() => {
    let active = true;
    void client.listAgents(scope).then((items) => { if (active) setAgents(items); }).catch((cause: unknown) => { if (active) setError(message(cause, text)); });
    return () => { active = false; };
  }, [client, text]);
  async function refreshAgents(): Promise<void> {
    try { setAgents(await client.listAgents(scope)); }
    catch (cause) { setError(message(cause, text)); }
  }

  const refs = useMemo(() => tools.filter((tool) => selectedTools.has(tool.internalId)).map((tool) => ({ internalId: tool.internalId, version: tool.latestVersion })), [selectedTools, tools]);
  const skillRefs = useMemo(() => skills.filter((skill) => selectedSkills.has(skill.internalId)).map((skill) => ({ internalId: skill.internalId, version: skill.latestVersion })), [selectedSkills, skills]);
  // 委譲候補は自分自身を除外する。usage は各サブ必須。
  const selectableAgents = useMemo(() => agents.filter((agent) => agent.internalId !== internalId), [agents, internalId]);
  const subAgentRefs = useMemo(() => selectableAgents.filter((agent) => subAgents.has(agent.internalId))
    .map((agent) => ({ internalId: agent.internalId, version: agent.latestVersion, usage: (subAgents.get(agent.internalId) ?? '').trim() })), [selectableAgents, subAgents]);
  const subAgentsValid = subAgentRefs.every((ref) => ref.usage !== '');

  // 実効副作用バッジ用: 選択サブから到達可能なAgent定義を取得する（近似・厳密値は保存時にサーバ検証）。
  useEffect(() => {
    if (subAgentRefs.length === 0) { setSubDefs(new Map()); return; }
    let active = true;
    void (async () => {
      const defs = new Map<string, SerializedAgentDto>();
      const queue = subAgentRefs.map((ref) => ref.internalId);
      const seen = new Set<string>();
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        try {
          const def = await client.getAgent(id, scope);
          defs.set(id, def);
          for (const sub of def.agents) if (!seen.has(sub.internalId)) queue.push(sub.internalId);
        } catch { /* 近似バッジ用途のため取得失敗は無視 */ }
      }
      if (active) setSubDefs(defs);
    })();
    return () => { active = false; };
  }, [subAgentRefs, client]);

  const effectiveSideEffect = useMemo<SideEffectDto | 'unknown'>(() => {
    const rank: Record<SideEffectDto, number> = { 'read-only': 0, 'session-write': 1, write: 2, 'external-action': 3 };
    const higher = (a: SideEffectDto, b: SideEffectDto): SideEffectDto => rank[a] >= rank[b] ? a : b;
    const toolEffect = (id: string): SideEffectDto => tools.find((tool) => tool.internalId === id)?.sideEffect ?? 'read-only';
    const visited = new Set<string>();
    const effectOf = (toolRefs: readonly { internalId: string }[], subRefs: readonly { internalId: string }[], depth: number): SideEffectDto | 'unknown' => {
      let effect: SideEffectDto = 'read-only';
      for (const ref of toolRefs) effect = higher(effect, toolEffect(ref.internalId));
      if (depth > 3) return effect;
      for (const ref of subRefs) {
        if (visited.has(ref.internalId)) continue;
        visited.add(ref.internalId);
        const def = subDefs.get(ref.internalId);
        if (def === undefined) return 'unknown';
        const nested = effectOf(def.tools, def.agents, depth + 1);
        if (nested === 'unknown') return 'unknown';
        effect = higher(effect, nested);
      }
      return effect;
    };
    return effectOf(refs, subAgentRefs, 0);
  }, [refs, subAgentRefs, tools, subDefs]);
  const output = useMemo(() => structuredOutput ? { name: responseFormatName(publishName), fields: outputFields } : undefined, [outputFields, publishName, structuredOutput]);
  const outputValid = !structuredOutput || (outputFields.length > 0 && outputFields.every((field) => field.name.trim() !== '') && new Set(outputFields.map((field) => field.name)).size === outputFields.length);
  // saveAgentのサーバー必須項目（min(1)）と保存ボタンの活性条件を一致させる。未充足項目はそのまま理由ヒントへ出す。
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (internalId.trim() === '') missing.push(text('Internal ID', '内部ID'));
    if (workingName.trim() === '') missing.push(text('Working name', '作業名'));
    if (displayName.trim() === '') missing.push(text('Display name', '表示名'));
    if (publishName.trim() === '') missing.push(text('Publish name', '公開名'));
    if (owner.trim() === '') missing.push(text('Owner', '所有者'));
    if (systemPrompt.trim() === '') missing.push(text('System prompt', 'システムプロンプト'));
    return missing;
  }, [internalId, workingName, displayName, publishName, owner, systemPrompt, text]);
  const missingRequiredLabel = missingRequired.join(language === 'ja' ? '、' : ', ');
  const saveBlocked = missingRequired.length > 0 || !outputValid || !subAgentsValid;
  // 委譲用 function 名 `ask_<publishName>` が無効になる publishName。保存は止めず注意だけ出す（未入力は必須項目側で伝える）。
  // サーバーの sub-agents 検査と同じく、接頭辞 ask_ を含めた長さ（64文字）で判定する。
  const publishNameInvalid = publishName.trim() !== '' && !FUNCTION_NAME_PATTERN.test(`ask_${publishName}`);
  // 読み込んだエージェントが参照しているが、もう登録されていないMCPサーバー名。実行時は静かにスキップされるため、ここで見せて外せるようにする。
  const unregisteredMcpServers = useMemo(() => [...selectedMcpServers].filter((name) => !mcpServers.some((server) => server.name === name)), [selectedMcpServers, mcpServers]);
  // ツール選択行のバッジ用: 直近の診断結果をツールIDで引く（直付けを優先し、無ければスキル経由の結果）。
  const toolDiagnosticsById = useMemo(() => {
    const map = new Map<string, AgentDiagnosticsDto['tools'][number]>();
    if (diagnostics?.status !== 'done') return map;
    for (const tool of diagnostics.result.tools) {
      const current = map.get(tool.internalId);
      if (current === undefined || (current.source === 'skill' && tool.source === 'direct')) map.set(tool.internalId, tool);
    }
    return map;
  }, [diagnostics]);

  function toggle(tool: ToolSummaryDto): void {
    const id = tool.internalId;
    setSelectedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSkill(skill: SkillSummaryDto): void {
    const id = skill.internalId;
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleWiki(wikiId: string): void {
    setSelectedWikis((current) => { const next = new Set(current); if (next.has(wikiId)) next.delete(wikiId); else next.add(wikiId); return next; });
  }

  // 上限に達したら未選択行のチェックだけを止める（選択済みの解除は常に可能）。
  function toggleMcpServer(name: string): void {
    setSelectedMcpServers((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else if (next.size < MAX_MCP_SERVERS) next.add(name);
      return next;
    });
  }

  function toggleSubAgent(agent: AgentSummaryDto): void {
    setSubAgents((current) => {
      const next = new Map(current);
      if (next.has(agent.internalId)) next.delete(agent.internalId); else next.set(agent.internalId, '');
      return next;
    });
  }

  function setSubAgentUsage(id: string, usage: string): void {
    setSubAgents((current) => { const next = new Map(current); next.set(id, usage); return next; });
  }

  async function generate(): Promise<void> {
    setBusy('generate'); setError(undefined);
    try {
      const draft = await client.generateAgentPrompt({ scope, displayName, kind, skills: skillRefs, tools: refs, agents: subAgentRefs, ...(output !== undefined ? { output } : {}) });
      setSystemPrompt(draft.systemPromptDraft);
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }

  /** 保存と組み込みチェックが同じ内容を送るための唯一の組み立て口。 */
  function buildSaveDto(): SaveAgentDto {
    return {
      scope, internalId, workingName, displayName, publishName, owner, kind, systemPrompt,
      skills: skillRefs, tools: refs, agents: subAgentRefs,
      wikis: kind === 'pseudo-user' ? [] : [...selectedWikis].map((wikiId) => ({ wikiId })),
      ...(selectedMcpServers.size > 0 ? { mcpServers: [...selectedMcpServers] } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }

  function resetDiagnostics(): void {
    diagnoseAborter.current?.abort(); diagnoseAborter.current = undefined;
    setDiagnostics(undefined); setDiagnosticsOpen(false);
  }

  function beginDiagnose(): AbortController {
    const controller = new AbortController();
    diagnoseAborter.current?.abort();
    diagnoseAborter.current = controller;
    return controller;
  }

  // 保存せずに「組み込んだら呼び出せるか」を確かめる。保存と同じ DTO を送るので結果は保存後と一致する。
  // manual（ボタン）は結果のパネルを開く。auto（選択変更への追従）はバッジと要約行だけを更新する。
  async function checkIntegration(origin: 'manual' | 'auto'): Promise<void> {
    // 自動診断は、利用者が読んでいる「手動 / 保存時の失敗表示」を上書きしない。
    // beginDiagnose() は進行中の要求を中断するため、ここで抜けないと手動の結果ごと消える。
    // 成功結果（done）は新しい内容へ差し替えてよいので、失敗のときだけ譲る。
    const shown = diagnosticsRef.current;
    if (origin === 'auto' && shown?.status === 'failed' && shown.origin !== 'auto') return;
    const controller = beginDiagnose();
    setDiagnostics({ status: 'loading', origin });
    if (origin === 'manual') setError(undefined);
    try {
      const result = await client.diagnoseAgentDraft(buildSaveDto(), controller.signal);
      if (controller.signal.aborted) return;
      setDiagnostics({ status: 'done', origin, result });
      if (origin === 'manual') setDiagnosticsOpen(true);
    } catch (cause) {
      // 中断は失敗ではない（エージェント切替時のリセットや次の要求を上書きしない）。
      if (!controller.signal.aborted && !isAbortError(cause)) setDiagnostics({ status: 'failed', origin, message: message(cause, text) });
    }
  }

  // ツール・スキル・サブエージェント・MCP・実行オプション・構造化出力の選択が変わったら、少し待って自動で診断する。
  // 選択の同一性だけをキーにするので、プロンプトや名前の入力では再実行しない（サーバー負荷を抑える）。
  /**
   * 自動診断のタイマーから呼ぶ「常に最新の」checkIntegration。
   *
   * タイマーは必須項目が揃った瞬間（saveBlocked の変化）に仕掛かるが、その後の本文入力では
   * 再スケジュールしない（入力のたびに診断を投げない、という設計）。素直に checkIntegration を
   * 閉じ込めると、発火時に**仕掛けた時点の下書き**を送ってしまい、書き換えた後のプロンプトが
   * 反映されない（実測: 1 文字だけ入力された時点の systemPrompt が送られた）。
   * ref 経由にすれば、依存を増やさずに発火時点の状態で診断できる。
   */
  const checkIntegrationRef = useRef(checkIntegration);
  /** 自動診断が割り込んでよいかの判断に使う、最新の診断状態。 */
  const diagnosticsRef = useRef(diagnostics);
  useEffect(() => { diagnosticsRef.current = diagnostics; });
  useEffect(() => { checkIntegrationRef.current = checkIntegration; });

  const autoDiagnoseKey = useMemo(() => JSON.stringify({
    tools: [...selectedTools].sort(), skills: [...selectedSkills].sort(), subAgents: [...subAgents.keys()].sort(),
    mcp: [...selectedMcpServers].sort(), harness, output,
  }), [selectedTools, selectedSkills, subAgents, selectedMcpServers, harness, output]);
  useEffect(() => {
    if (view !== 'editor' || saveBlocked || typeof (client as Partial<ToolApiClient>).diagnoseAgentDraft !== 'function') return;
    const timer = window.setTimeout(() => { void checkIntegrationRef.current('auto'); }, AUTO_DIAGNOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // checkIntegration は毎描画で作り直されるため依存に入れない（キーが変わったときだけ走らせる）。
  }, [autoDiagnoseKey, view, saveBlocked, client]);

  // 保存直後の自動診断（保存版に対して）。失敗しても保存は成功しているので、エラーではなく「取得できなかった」として出す。
  async function runPostSaveDiagnostics(savedId: string, version: string): Promise<void> {
    if (typeof (client as Partial<ToolApiClient>).diagnoseAgent !== 'function') return;
    const controller = beginDiagnose();
    setDiagnostics({ status: 'loading', origin: 'saved' });
    try {
      const result = await client.diagnoseAgent(savedId, scope, version, controller.signal);
      if (!controller.signal.aborted) setDiagnostics({ status: 'done', origin: 'saved', result });
    } catch (cause) {
      if (!controller.signal.aborted && !isAbortError(cause)) setDiagnostics({ status: 'failed', origin: 'saved', message: message(cause, text) });
    }
  }

  async function save(): Promise<void> {
    setBusy('save'); setError(undefined); setSaveNotice(undefined);
    try {
      const agent = await client.saveAgent(buildSaveDto());
      setSavedVersion(agent.metadata.version);
      setSaveNotice(text(`Saved · version ${agent.metadata.version}`, `保存しました バージョン ${agent.metadata.version}`));
      draft.clear();
      void runPostSaveDiagnostics(internalId, agent.metadata.version);
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }

  /** 診断の修正ボタン・他画面からの依頼で、編集画面内の区画へ移る。harness はダイアログ、それ以外は見出しへスクロールしてフォーカス。 */
  function focusAgentSection(target: LocalTarget): void {
    if (target.section === AGENT_SECTION.harness) { setHarnessOpen(true); return; }
    const heading = target.section === undefined ? null : document.getElementById(`agent-section-${target.section}`);
    // jsdom には scrollIntoView が無いので任意呼び出しにする。
    heading?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    heading?.focus();
  }

  function updateOutputField(index: number, patch: Partial<StructuredOutputFieldDto>): void {
    setOutputFields((fields) => fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  }

  async function runSaved(): Promise<void> {
    if (savedVersion === undefined || chatMessage.trim() === '') return;
    setBusy('run'); setError(undefined); setRun(undefined);
    try {
      setRun(await client.runSavedAgent({
        scope,
        agent: { internalId, version: savedVersion },
        message: chatMessage,
        mode: 'preview',
      }));
    } catch (cause) { setError(message(cause, text)); }
    finally { setBusy(undefined); }
  }

  function resetEditorState(): void {
    setInternalId(''); setWorkingName(''); setDisplayName(''); setPublishName(''); setOwner('');
    setKind('normal'); setSystemPrompt('');
    setSelectedTools(new Set()); setSelectedSkills(new Set()); setSelectedWikis(new Set()); setSelectedMcpServers(new Set()); setSubAgents(new Map());
    setStructuredOutput(false); setOutputFields([{ name: '', type: 'string', required: true }]);
    setHarness(undefined); setHarnessOpen(false);
    setSavedVersion(undefined); setChatMessage(''); setRun(undefined); setSaveNotice(undefined);
    resetDiagnostics();
    setEditing(false);
  }
  function startNewAgent(): void { resetEditorState(); setError(undefined); setView('editor'); }
  async function backToList(): Promise<void> { setView('list'); resetDiagnostics(); await refreshAgents(); }
  /** 一覧・他画面からの依頼で保存済みAgentを開く。開けたら true（失敗は一覧にエラーを出して false）。 */
  async function openAgent(target: string): Promise<boolean> {
    setBusy('load'); setError(undefined);
    try {
      const agent = await client.getAgent(target, scope);
      populateEditorFromAgent(agent);
      setView('editor');
      return true;
    } catch (cause) { setError(message(cause, text)); return false; }
    finally { setBusy(undefined); }
  }
  // 削除はConfirmDialogの確認後だけ実行する（一覧行のDeleteはpendingDeleteを立てるだけ）。
  async function removeAgent(target: string): Promise<void> {
    setBusy('load'); setError(undefined);
    try { await client.deleteAgent(target, scope); setPendingDelete(undefined); await refreshAgents(); }
    catch (cause) { setError(message(cause, text)); setPendingDelete(undefined); }
    finally { setBusy(undefined); }
  }
  // 一覧からOpenした保存済みAgentをeditor stateへ復元する。tool/skillの選択はinternalId基準で、
  // saveAgent実行時は常に現在のlatestVersionへ再pinされる（保存済みrefのversionをそのまま保持しない）。
  function populateEditorFromAgent(agent: SerializedAgentDto): void {
    setInternalId(agent.metadata.internalId);
    setWorkingName(agent.metadata.workingName);
    setDisplayName(agent.metadata.displayName);
    setPublishName(agent.metadata.publishName);
    setOwner(agent.metadata.owner);
    setKind(agent.kind);
    setSystemPrompt(agent.systemPrompt);
    setSelectedTools(new Set(agent.tools.map((ref) => ref.internalId)));
    setSelectedSkills(new Set(agent.skills.map((ref) => ref.internalId)));
    setSelectedWikis(new Set((agent.wikis ?? []).map((ref) => ref.wikiId)));
    setSelectedMcpServers(new Set(agent.mcpServers ?? []));
    setSubAgents(new Map(agent.agents.map((ref) => [ref.internalId, ref.usage])));
    setHarness(agent.harness === undefined ? undefined : { ...agent.harness });
    setHarnessOpen(false);
    if (agent.output !== undefined) { setStructuredOutput(true); setOutputFields([...agent.output.fields]); }
    else { setStructuredOutput(false); setOutputFields([{ name: '', type: 'string', required: true }]); }
    setSavedVersion(agent.metadata.version);
    setChatMessage(''); setRun(undefined); setSaveNotice(undefined);
    resetDiagnostics();
    setEditing(true);
  }

  // 診断結果や他画面の「エージェントを開く」からの依頼。mount 時と表示中の両方で受け、開いたら区画（tools / harness …）へ移る。
  usePendingOpen('Agent', (target) => void openAgentAt(target));
  async function openAgentAt(target: OpenTarget): Promise<void> {
    // 開けなかった依頼の区画指定は残さない（残すと、次に開いた別のエージェントの編集画面でその区画へ飛んでしまう）。
    if (await openAgent(target.internalId) && target.section !== undefined) setFocusSection(target.section);
  }
  useEffect(() => {
    if (focusSection === undefined || view !== 'editor' || busy === 'load') return;
    focusAgentSection({ section: focusSection });
    setFocusSection(undefined);
  }, [focusSection, view, busy]);

  if (view === 'list') {
    return <main className="agent-builder agent-list-page">
      <header className="agent-builder-header">
        <div><span className="eyebrow">{text('Agent Builder', 'エージェントビルダー')}</span><h1>{text('Agents', 'エージェント一覧')}</h1><p>{text('Generate a system prompt from Skill and Tool metadata, then save the reviewed definition as a new version.', 'スキルとツールのメタデータからシステムプロンプトを生成し、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
        <div className="save-actions"><button type="button" className="primary" onClick={startNewAgent}>{text('New agent', '新規作成')}</button></div>
      </header>
      {error !== undefined && <div className="api-error">{error}</div>}
      <section className="workspace-card agent-list">
        {agents.length === 0 ? <p className="empty-state"><span>{text('No agents yet.', 'エージェントはまだありません。')}</span> <ScreenLink to="Factory">{text('Generate one automatically (Factory)', '自動生成で作る (Factory)')}</ScreenLink></p> : <div className="agent-list-rows">{agents.map((item) => <article className="agent-list-row" key={item.internalId}>
          <div><strong>{item.displayName}</strong><code>{item.publishName}@{item.latestVersion}</code><small>{item.kind} · {item.state}</small></div>
          <div className="agent-list-actions">
            <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void openAgent(item.internalId)}>{text('Open', '開く')}</button>
            <button type="button" className="secondary danger" disabled={busy !== undefined} onClick={() => setPendingDelete(item)}>{text('Delete', '削除')}</button>
          </div>
        </article>)}</div>}
      </section>
      <ConfirmDialog open={pendingDelete !== undefined} title={text('Delete agent', 'エージェントを削除')}
        message={text(`Delete "${pendingDelete?.displayName ?? ''}"? It disappears from this list. Saved versions are kept in history.`, `「${pendingDelete?.displayName ?? ''}」を削除しますか？一覧から表示されなくなります（保存済みバージョンは履歴に残ります）。`)}
        confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} danger busy={busy !== undefined}
        onConfirm={() => { if (pendingDelete !== undefined) void removeAgent(pendingDelete.internalId); }} onCancel={() => setPendingDelete(undefined)} />
    </main>;
  }
  return <main className="agent-builder">
    <header className="agent-builder-header">
      <div><button type="button" className="secondary agent-back-button" onClick={() => void backToList()}>{text('Back to list', '一覧へ戻る')}</button><span className="eyebrow">{text('Agent Builder', 'エージェントビルダー')}</span><h1>{displayName || text('New Agent', '新しいエージェント')}</h1><p>{text('Generate a system prompt from Skill and Tool metadata, then save the reviewed definition as a new version.', 'スキルとツールのメタデータからシステムプロンプトを生成し、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
      <div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <button type="button" className="secondary" onClick={() => setHarnessOpen(true)}>{text('Runtime options', '実行オプション')}{harness === undefined ? '' : ` (${countEnabledHarness(harness)})`}</button>
        <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void generate()}>{busy === 'generate' ? text('Generating…', '生成中…') : text('Generate draft', '草案を生成')}</button>
        {/* 保存と同じ活性条件・同じ DTO で、保存せずにツール呼び出しの前提を検査する。 */}
        {/* 自動診断（origin: auto）の進行中でも手動チェックは押せる（押すと自動側の要求を中断して置き換える）。
            止まったサーバーを待ち続けてボタンが死ぬ状態を作らない。 */}
        <button type="button" className="secondary" disabled={busy !== undefined || saveBlocked || (diagnostics?.status === 'loading' && diagnostics.origin !== 'auto')} title={missingRequired.length > 0 ? text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`) : text('Check whether the attached tools can be called, without saving.', '保存せずに、割り当てたツールを呼び出せるか検査します。')} onClick={() => void checkIntegration('manual')}>{diagnostics?.status === 'loading' && diagnostics.origin !== 'auto' ? text('Checking…', 'チェック中…') : text('Check integration', '組み込みチェック')}</button>
        <button type="button" className="primary" disabled={busy !== undefined || saveBlocked} title={missingRequired.length > 0 ? text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`) : undefined} onClick={() => void save()}>{busy === 'save' ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
      </div>
    </header>
    {draft.pending !== undefined && <DraftRestoreBanner savedAt={draft.pending.savedAt}
      onRestore={() => { const value = draft.restore(); if (value !== undefined) applyDraft(value); }}
      onDiscard={draft.discard} />}
    {/* 保存ボタン近傍のフィードバック: 未充足の必須項目・Tool未選択の注意・保存成功。 */}
    <div className="agent-save-feedback">
      {missingRequired.length > 0 && <InlineFeedback kind="info">{text(`Required fields are empty: ${missingRequiredLabel}.`, `${missingRequiredLabel}が未入力です。`)}</InlineFeedback>}
      {!subAgentsValid && <InlineFeedback kind="info">{text('Every selected sub-agent needs a delegation usage.', '選択したサブエージェントには委譲基準の入力が必要です。')}</InlineFeedback>}
      {refs.length === 0 && <InlineFeedback kind="info">{text('No Tool is selected. This Agent cannot answer questions that need data.', 'ツールが選択されていません。データに関する質問には答えられません。')}</InlineFeedback>}
      {saveNotice !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={dismissSaveNotice}>{saveNotice}</InlineFeedback>}
      {/* 診断の一行要約（問題数）と詳細（DiagnosticsPanel）の開閉。保存直後は「保存しました。」から始める。 */}
      {diagnostics !== undefined && <DiagnosticsSummary diagnostics={diagnostics} open={diagnosticsOpen} onToggle={() => setDiagnosticsOpen((open) => !open)} text={text} />}
    </div>
    {error !== undefined && <div className="api-error">{error}</div>}
    {diagnostics?.status === 'done' && diagnosticsOpen && <DiagnosticsPanel diagnostics={diagnostics.result} context="agent-editor" agentId={internalId} onOpenHarness={() => setHarnessOpen(true)} onOpenLocal={focusAgentSection} onClose={() => setDiagnosticsOpen(false)} />}
    <div className="agent-builder-grid">
      <section className="agent-definition-card">
        <h2>{text('Definition', '定義')}</h2>
        <div className="agent-fields">
          <label>{text('Internal ID', '内部ID')}<span className="required-mark">*</span><input aria-label={text('Agent internal ID', 'エージェント内部ID')} placeholder={text('e.g. support-agent', '例: support-agent')} value={internalId} readOnly={editing} title={editing ? text('Internal ID cannot change once saved (it would fork a new asset).', '保存済みの内部IDは変更できません（変更すると別資産になります）。') : undefined} onChange={(event) => { if (editing) return; setInternalId(event.target.value); }} /></label>
          <label>{text('Working name', '作業名')}<span className="required-mark">*</span><input aria-label={text('Working name', '作業名')} placeholder={text('e.g. Support agent draft', '例: サポートエージェントの下書き')} value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
          <label>{text('Display name', '表示名')}<span className="required-mark">*</span><input aria-label={text('Agent display name', 'エージェント表示名')} placeholder={text('e.g. Support Agent', '例: サポートエージェント')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label>{text('Publish name', '公開名')}<span className="required-mark">*</span><input aria-label={text('Publish name', '公開名')} placeholder={text('e.g. support_agent', '例: support_agent')} value={publishName} onChange={(event) => setPublishName(event.target.value)} />
            {publishNameInvalid && <small className="field-warning">{text(`Other agents cannot delegate to this agent: ask_${publishName} is not a valid function name (use 1–64 ASCII letters, digits, _ or -)`, `他のエージェントから委譲できません: ask_${publishName} は function 名として無効です（英数字・_・- の1〜64文字にしてください）`)}</small>}</label>
          <label>{text('Owner', '所有者')}<span className="required-mark">*</span><input aria-label={text('Owner', '所有者')} placeholder={text('e.g. team@example.com', '例: team@example.com')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <label>{text('Kind', '種別')}<select aria-label={text('Agent kind', 'エージェント種別')} value={kind} onChange={(event) => setKind(event.target.value as AgentKindDto)}><option value="normal">{text('Normal', '通常')}</option><option value="pseudo-user">{text('Pseudo user', '疑似ユーザー')}</option><option value="evaluator">{text('Evaluator', '評価者')}</option></select></label>
        </div>
        <h2 id="agent-section-skills" tabIndex={-1}>{text('Skills', 'スキル')} <small>{skillRefs.length} {text('selected', '件選択')}</small></h2>
        {/* 選択行の種別バッジ: Skill / Tool / サブエージェント / Wiki を取り違えないようにする。 */}
        <div className="agent-tool-list">
          {busy !== 'load' && skills.length === 0 && <p className="empty-state"><span>{text('No saved Skills yet.', '保存済みスキルがありません。')}</span> <ScreenLink to="Skill">{text('Open the Skill screen', 'スキル画面を開く')}</ScreenLink></p>}
          {skills.map((skill) => <label key={key(skill)} className="agent-tool-option"><input type="checkbox" checked={selectedSkills.has(skill.internalId)} onChange={() => toggleSkill(skill)} /><span><strong>{skill.displayName}</strong><code>{skill.publishName}@{skill.latestVersion}</code></span><small className="validation-status">{text('Skill', 'スキル')}</small><small>{skill.state}</small></label>)}
        </div>
        <h2 id="agent-section-tools" tabIndex={-1}>{text('Tools', 'ツール')} <small>{refs.length} {text('selected', '件選択')}</small></h2>
        <div className="agent-tool-list">
          {busy === 'load' && <p className="empty-state">{text('Loading tools…', 'ツールを読み込み中…')}</p>}
          {busy !== 'load' && tools.length === 0 && <p className="empty-state"><span>{text('No saved Tools yet.', '保存済みツールがありません。')}</span> <ScreenLink to="Tool">{text('Open the Tool screen', 'ツール画面を開く')}</ScreenLink></p>}
          {tools.map((tool) => {
            // 選んだ瞬間に壊れたツールが分かるよう、直近の診断結果をバッジで添える（一番目の問題を title に）。
            const diagnosed = selectedTools.has(tool.internalId) ? toolDiagnosticsById.get(tool.internalId) : undefined;
            const issue = diagnosed === undefined ? undefined : topIssue(diagnosed.checks);
            const issueText = issue === undefined ? undefined : `${diagnosticCheckLabel(issue.id, text)}${issue.detail === undefined ? '' : `: ${localizeDiagnosticDetail(issue.detail, language)}`}`;
            return <label key={key(tool)} className="agent-tool-option"><input type="checkbox" checked={selectedTools.has(tool.internalId)} onChange={() => toggle(tool)} /><span><strong>{tool.displayName}{diagnosed !== undefined && <span className={`diag-badge ${diagnosed.status}`} role="img" aria-label={diagnosed.status === 'ok' ? text('Tool diagnostics: no blockers', 'ツール診断: 問題なし') : text(`Tool diagnostics: ${diagnosed.status}`, `ツール診断: ${diagnosed.status === 'error' ? 'エラー' : '警告'}`)} title={issueText ?? text('Tool diagnostics: no blockers', 'ツール診断: 問題なし')}>{diagnosed.status === 'ok' ? '✓' : diagnosed.status === 'warning' ? '!' : '✕'}</span>}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small className="validation-status">{text('Tool', 'ツール')}</small><small>{tool.state}</small></label>;
          })}
        </div>
        <h2 id="agent-section-sub-agents" tabIndex={-1}>{text('Sub-agents', 'サブエージェント')} <small>{subAgentRefs.length} {text('selected', '件選択')}</small></h2>
        <p className="agent-subagent-hint">{text('Delegated as an ask_<name> tool. The effective side-effect is validated on save.', 'ask_<名前> ツールとして委譲されます。実効副作用は保存時に検証されます。')}</p>
        {subAgentRefs.length > 0 && <p className="agent-effect">{text('Effective side-effect', '実効副作用')}: <span className={`validation-status ${effectiveSideEffect === 'read-only' ? 'good' : effectiveSideEffect === 'unknown' ? '' : 'bad'}`}>{effectiveSideEffect === 'unknown' ? text('estimating…', '推定中…') : effectiveSideEffect}</span> <small>{text('approx · preview requires read-only', '概算・previewはread-only必須')}</small></p>}
        <div className="agent-tool-list">
          {selectableAgents.length === 0 && <p className="empty-state">{text('No other saved Agents to delegate to.', '委譲できる他の保存済みエージェントがありません。')}</p>}
          {selectableAgents.map((agent) => {
            const selected = subAgents.has(agent.internalId);
            return <div key={agent.internalId} className="agent-subagent-option">
              <label className="agent-tool-option"><input type="checkbox" checked={selected} onChange={() => toggleSubAgent(agent)} /><span><strong>{agent.displayName}</strong><code>ask_{agent.publishName}@{agent.latestVersion}</code></span><small className="validation-status">{text('Sub-agent', 'サブエージェント')}</small><small>{agent.kind}</small></label>
              {selected && <input className="subagent-usage" aria-label={`${text('Delegation usage for', '委譲基準:')} ${agent.displayName}`} placeholder={text('When should work be delegated here?', 'どんな時にここへ委譲する？')} value={subAgents.get(agent.internalId) ?? ''} onChange={(event) => setSubAgentUsage(agent.internalId, event.target.value)} />}
            </div>;
          })}
        </div>
        <h2>{text('Wikis', 'Wiki')} <small>{selectedWikis.size} {text('selected', '件選択')}</small></h2>
        <p className="agent-subagent-hint">{text('Only pages from the selected Wikis can be retrieved during execution.', '実行時に参照できるのは選択したWiki内のページだけです。')}</p>
        <div className="agent-tool-list">
          {wikis.length === 0 && <p className="empty-state"><span>{text('Create Wikis in Memory first.', '先に記憶画面でWikiを作成してください。')}</span> <ScreenLink to="Memory">{text('Open the Memory screen', '記憶画面を開く')}</ScreenLink></p>}
          {wikis.map((wiki) => <label key={wiki.id} className="agent-tool-option"><input aria-label={`${text('Use wiki', 'Wikiを使用')} ${wiki.name}`} type="checkbox" disabled={kind === 'pseudo-user'} checked={selectedWikis.has(wiki.id)} onChange={() => toggleWiki(wiki.id)} /><span><strong>{wiki.name}</strong><code>{wiki.id}</code></span><small className="validation-status">Wiki</small><small>{wiki.description}</small></label>)}
        </div>
        <h2 id="agent-section-mcp" tabIndex={-1}>{text('MCP servers', 'MCPサーバー')} <small>{selectedMcpServers.size} {text('selected', '件選択')}</small></h2>
        <p className="agent-subagent-hint">{text('Tools from the selected servers are injected as mcp__<server>__<tool>.', '選択したサーバーのツールが mcp__<サーバー名>__<ツール名> として注入されます。')}</p>
        <div className="agent-tool-list">
          {mcpServers.length === 0 && <p className="empty-state"><span>{text('No MCP servers configured. Add them on the MCP page.', 'MCPサーバーが未設定です。MCP画面で追加してください。')}</span> <ScreenLink to="MCP">{text('Open the MCP screen', 'MCP画面を開く')}</ScreenLink></p>}
          {mcpServers.map((server) => {
            const selected = selectedMcpServers.has(server.name);
            return <label key={server.name} className="agent-tool-option">
              <input aria-label={`${text('Use MCP server', 'MCPサーバーを使用')} ${server.name}`} type="checkbox" checked={selected} disabled={!selected && selectedMcpServers.size >= MAX_MCP_SERVERS} onChange={() => toggleMcpServer(server.name)} />
              <span><strong>{server.name}</strong><code>{server.transport.kind}</code></span>
              <small className="validation-status">MCP</small>
              {server.disabled && <small>{text('skipped at run time', '実行時はスキップ')}</small>}
            </label>;
          })}
          {/* 参照先が消えたサーバー。チェックを外して保存すれば参照を落とせる。 */}
          {busy !== 'load' && unregisteredMcpServers.map((name) => <label key={`unregistered-${name}`} className="agent-tool-option unregistered">
            <input aria-label={`${text('Use MCP server', 'MCPサーバーを使用')} ${name}`} type="checkbox" checked onChange={() => toggleMcpServer(name)} />
            <span><strong>{name}</strong><code>{text('This server is no longer registered; its tools are skipped at run time.', 'このサーバーは登録されていないため、実行時にツールは注入されません。')}</code></span>
            <small className="validation-status bad">{text('not registered', '未登録')}</small>
          </label>)}
          {selectedMcpServers.size >= MAX_MCP_SERVERS && <p className="field-error">{text(`At most ${MAX_MCP_SERVERS} MCP servers can be selected.`, `MCPサーバーは最大${MAX_MCP_SERVERS}件まで選択できます。`)}</p>}
        </div>
        <h2>{text('Structured output', '構造化出力')}</h2>
        <label className="structured-output-toggle"><input aria-label={text('Enable structured output', '構造化出力を有効化')} type="checkbox" checked={structuredOutput} onChange={(event) => setStructuredOutput(event.target.checked)} /> {text('Require a validated JSON response', '検証済みJSON応答を必須にする')}</label>
        {structuredOutput && <div className="structured-output-fields">
          {outputFields.map((field, index) => <div className="structured-output-field" key={index}>
            <input aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('name', '名前')}`} placeholder={text('e.g. answer', '例: answer')} value={field.name} onChange={(event) => updateOutputField(index, { name: event.target.value })} />
            <select aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('type', '型')}`} value={field.type} onChange={(event) => updateOutputField(index, { type: event.target.value as StructuredOutputTypeDto })}><option>string</option><option>number</option><option>integer</option><option>boolean</option></select>
            <label><input aria-label={`${text('Output field', '出力フィールド')} ${index + 1} ${text('required', '必須')}`} type="checkbox" checked={field.required} onChange={(event) => updateOutputField(index, { required: event.target.checked })} /> {text('required', '必須')}</label>
            <button aria-label={`${text('Remove output field', '出力フィールドを削除')} ${index + 1}`} type="button" className="secondary" disabled={outputFields.length === 1} onClick={() => setOutputFields((fields) => fields.filter((_, fieldIndex) => fieldIndex !== index))}>×</button>
          </div>)}
          <button type="button" className="secondary" onClick={() => setOutputFields((fields) => [...fields, { name: `field_${fields.length + 1}`, type: 'string', required: true }])}>{text('Add output field', '出力フィールドを追加')}</button>
          {!outputValid && <p className="field-error">{text('Field names must be non-empty and unique.', 'フィールド名は空にできず、重複も許可されません。')}</p>}
        </div>}
      </section>
      <section className="prompt-editor-card">
        <div className="panel-title"><div><span className="eyebrow">{text('Editable escape hatch', '編集可能')}</span><h2>{text('System prompt', 'システムプロンプト')}<span className="required-mark">*</span></h2></div><span className="version-chip">{systemPrompt.length} {text('chars', '文字')}</span></div>
        <textarea aria-label={text('System prompt', 'システムプロンプト')} rows={28} placeholder={text('Describe the Agent role, boundaries, and response style.', 'エージェントの役割、制約、応答スタイルを記述します。')} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
        <p>{text('Generating a draft does not save it. Review and edit the draft before saving a version.', '草案の生成だけでは保存されません。内容をレビュー・編集してからバージョンを保存してください。')}</p>
        <div className="agent-run-panel">
          <div className="panel-title"><div><span className="eyebrow">{text('Saved Agent preview', '保存済みエージェントのプレビュー')}</span><h2>{text('Chat', 'チャット')}</h2></div><span className="version-chip">{savedVersion === undefined ? text('Save first', '先に保存してください') : `Agent v${savedVersion}`}</span></div>
          <div className="chat-compose"><textarea aria-label={text('Agent chat message', 'エージェントへのメッセージ')} rows={2} placeholder={text('Ask the saved Agent…', '保存済みエージェントに質問…')} value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} /><button type="button" className="primary" disabled={savedVersion === undefined || busy !== undefined || chatMessage.trim() === ''} onClick={() => void runSaved()}>{busy === 'run' ? text('Running…', '実行中…') : text('Run saved agent', '保存済みエージェントを実行')}</button></div>
          {run !== undefined && <><div className="chat-response"><span>{text('Assistant', 'アシスタント')}</span>{run.structuredResponse === undefined ? <p>{run.response}</p> : <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>}</div><div className="trace-list"><strong>{text('Trace', 'トレース')} · {run.runId}</strong>{run.trace.map((event) => {
            // 種別だけでは原因が分からないため、error/tool/委譲イベントは実メッセージも併記する。
            const detail = traceDetail(event, text, language);
            return <div className={`trace-event ${event.kind === 'tool-call' || event.kind === 'tool-result' ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind}</p>{detail !== undefined && <small className={event.kind === 'error' ? 'field-error' : undefined}>{detail}</small>}</div>;
          })}</div></>}
        </div>
      </section>
    </div>
    {harnessOpen && <HarnessSettingsDialog initial={harness ?? DEFAULT_HARNESS}
      onCancel={() => setHarnessOpen(false)}
      onClear={() => { setHarness(undefined); setHarnessOpen(false); }}
      onApply={(next) => { setHarness(next); setHarnessOpen(false); }} />}
  </main>;
}

function key(item: ToolSummaryDto | SkillSummaryDto): string { return `${item.internalId}@${item.latestVersion}`; }
function message(cause: unknown, text: Translate): string { return cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'); }
// トレース行の詳細文言。model-request/model-responseは本文をチャット側で表示するため重複させない。
function traceDetail(event: RunTraceEventDto, text: Translate, language: Language): string | undefined {
  switch (event.kind) {
    // 実行エラーの定型文は次の一手が分かる文言へ直す（変換できなければ原文のまま）。
    case 'error': return `${event.code}: ${localizeRunTraceError(event, language)}`;
    case 'tool-call': return `${text('tool', 'ツール')}: ${event.name}`;
    case 'tool-result': return `${text('tool', 'ツール')}: ${event.name}`;
    case 'agent_call': return `${event.toolName}${event.summary === '' ? '' : ` · ${event.summary}`}`;
    default: return undefined;
  }
}
/**
 * 診断の一行要約。保存直後は「保存しました。」から始め、それ以外は「組み込みチェック」として出す。
 * 取得失敗は、保存直後なら保存成功を損なわない控えめな文言、自動実行なら静かな注記、手動ならアラート。
 */
function DiagnosticsSummary({ diagnostics, open, onToggle, text }: { readonly diagnostics: DiagnosticsState; readonly open: boolean; readonly onToggle: () => void; readonly text: Translate }) {
  const saved = diagnostics.origin === 'saved';
  if (diagnostics.status === 'loading') {
    return saved ? <InlineFeedback kind="info">{text('Saved. Running tool diagnostics…', '保存しました。ツール診断を実行中…')}</InlineFeedback> : null;
  }
  if (diagnostics.status === 'failed') {
    if (saved) return <InlineFeedback kind="info">{text('Diagnostics unavailable', '診断を取得できませんでした')}</InlineFeedback>;
    if (diagnostics.origin === 'auto') return <p className="empty-state">{text('Integration check unavailable', '組み込みチェックを取得できませんでした')}</p>;
    return <div className="api-error" role="alert">{text('Diagnostics failed: ', '診断に失敗しました: ')}{diagnostics.message}</div>;
  }
  const issues = countDiagnosticIssues(diagnostics.result);
  const summary = saved
    ? (issues === 0
      ? text('Saved. Tool diagnostics: no blockers', '保存しました。ツール診断: 問題なし')
      : text(`Saved. Tool diagnostics found ${issues} issue(s)`, `保存しました。ツール診断で ${issues} 件の問題があります`))
    : (issues === 0
      ? text('Integration check: no blockers', '組み込みチェック: 問題なし')
      : text(`Integration check found ${issues} issue(s)`, `組み込みチェックで ${issues} 件の問題があります`));
  return <InlineFeedback kind={issues === 0 ? 'success' : diagnostics.result.status === 'error' ? 'error' : 'info'}>
    {summary} <button type="button" className="ghost diag-toggle-btn" onClick={onToggle}>{open ? text('Hide details', '詳細を隠す') : text('Show details', '詳細を表示')}</button>
  </InlineFeedback>;
}
function responseFormatName(publishName: string): string {
  const normalized = `${publishName}_response`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return normalized === '' ? 'agent_response' : normalized;
}
