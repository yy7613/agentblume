// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { RunTraceEventDto } from '../api/types';
import { I18nProvider, type Language } from '../i18n';
import { consumePendingOpen } from '../navigation';
import { ExperimentsTab, clampJudgeSamples } from './ExperimentsTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

// 完了済みにしておく（queued / running は 750ms ポーリングが走る）。
const experiment = {
  id: 'exp-1', scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' },
  repetitions: 1, status: 'completed', snapshot: { provider: 'scripted', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 1, total: 1 }, createdAt: 'now', finishedAt: 'done',
};
const caseResult = {
  experimentId: 'exp-1', scope, caseId: 'case', caseKind: 'turn', repetition: 1, status: 'failed', runIds: ['run-1'], output: '', scores: [], latencyMs: 15, usage: {},
  error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: year' },
};

function makeClient(trace: readonly RunTraceEventDto[], overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listAgents: vi.fn().mockResolvedValue([]),
    listEvaluationDatasets: vi.fn().mockResolvedValue([]),
    listEvaluatorProfiles: vi.fn().mockResolvedValue([]),
    listExperiments: vi.fn().mockResolvedValue([experiment]),
    listExperimentResults: vi.fn().mockResolvedValue([caseResult]),
    getRunTrace: vi.fn().mockResolvedValue({ runId: 'run-1', scope, status: 'failed', mode: 'test', startedAt: 'now', trace }),
    ...overrides,
  } as unknown as ToolApiClient;
}

async function openTrace(client: ToolApiClient, language?: Language): Promise<void> {
  const tab = <ExperimentsTab client={client} scope={scope} />;
  render(language === undefined ? tab : <I18nProvider initialLanguage={language}>{tab}</I18nProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /agent@1\.0\.0/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'run-1' }));
  await waitFor(() => expect(client.getRunTrace).toHaveBeenCalledWith('run-1', scope));
}

const mixedTrace: readonly RunTraceEventDto[] = [
  { sequence: 1, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: year (retrying 1/1)' },
  { sequence: 2, kind: 'mcp-server-skipped', server: 'files', reason: 'not-found' },
  { sequence: 3, kind: 'model-response', content: 'answer' },
];

describe('ExperimentsTab のトレース表示', () => {
  it('error / mcp-server-skipped の行は言語化し、それ以外は種別名だけ（従来どおり）', async () => {
    await openTrace(makeClient(mixedTrace));
    expect(await screen.findByText("1 · TOOL_ARGUMENTS: the model omitted the required tool argument 'year'. Describe that argument more concretely in the tool, or state its value in your request (retrying 1/1)")).toBeTruthy();
    expect(screen.getByText("2 · The tools of MCP server 'files' were not loaded (server not registered). Register and enable the server in MCP settings, then test the connection")).toBeTruthy();
    expect(screen.getByText('3 · model-response')).toBeTruthy();
    expect(screen.queryByText(/required argument missing: year/)).toBeNull();
  });

  it('空のトレースは見出しだけを出し、行は描かない', async () => {
    await openTrace(makeClient([]));
    expect(await screen.findByText('Run trace · run-1')).toBeTruthy();
    expect(document.querySelectorAll('.trace-event')).toHaveLength(0);
  });

  it('トレースの取得失敗はアラートで出す', async () => {
    await openTrace(makeClient([], { getRunTrace: vi.fn().mockRejectedValue(new Error('trace unavailable')) }));
    expect((await screen.findByRole('alert')).textContent).toBe('trace unavailable');
    expect(screen.queryByText(/Run trace/)).toBeNull();
  });

  it('日本語UIでは error / mcp-server-skipped の行が日本語になる', async () => {
    await openTrace(makeClient(mixedTrace), 'ja');
    expect(await screen.findByText('1 · TOOL_ARGUMENTS: モデルがツールの必須引数「year」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください（再試行 1/1）')).toBeTruthy();
    expect(screen.getByText('2 · MCPサーバー「files」のツールを読み込めませんでした（未登録）。MCP設定画面でサーバーを登録・有効化し、接続をテストしてください')).toBeTruthy();
    expect(screen.getByText('3 · model-response')).toBeTruthy();
  });
});

describe('ExperimentsTab の実行/実験の状態語', () => {
  it('正常: 日本語表示では実験一覧・詳細・ケース結果の状態語が日本語になり、英語の値のままは出ない', async () => {
    const client = makeClient([]);
    render(<I18nProvider initialLanguage="ja"><ExperimentsTab client={client} scope={scope} /></I18nProvider>);
    // 一覧の状態バッジ（experiment.status = 'completed'）。
    expect(await screen.findByText('完了')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /agent@1\.0\.0/ }));
    // 詳細の状態（同じく 'completed'）とケース結果の状態（caseResult.status = 'failed'）。
    expect(screen.getAllByText('完了').length).toBeGreaterThan(0);
    expect(await screen.findByText('失敗')).toBeTruthy();
    expect(screen.queryByText('completed')).toBeNull();
    expect(screen.queryByText('failed')).toBeNull();
  });

  it('境界: 英語表示（既定）ではこれまでどおり状態語の値をそのまま出す', async () => {
    const client = makeClient([]);
    render(<ExperimentsTab client={client} scope={scope} />);
    expect(await screen.findByText('completed')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /agent@1\.0\.0/ }));
    expect(await screen.findByText('failed')).toBeTruthy();
  });
});

// ---- 判定サンプル数（P4）の入力と DTO ----

const catalog = {
  listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }]),
  listEvaluationDatasets: vi.fn().mockResolvedValue([{ internalId: 'set', displayName: 'Set', publishName: 'set', latestVersion: '1.0.0', state: 'draft', caseCount: 1 }]),
  listEvaluatorProfiles: vi.fn().mockResolvedValue([{ internalId: 'profile', displayName: 'Profile', publishName: 'profile', latestVersion: '1.0.0', state: 'draft', metricCount: 1 }]),
};
const baseDto = { scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 1 };

async function submitWithJudgeSamples(raw: string | undefined): Promise<{ readonly createExperiment: ReturnType<typeof vi.fn>; readonly input: HTMLInputElement }> {
  const createExperiment = vi.fn().mockResolvedValue({ ...experiment, judgeSamples: raw === undefined ? undefined : Number(raw) });
  render(<ExperimentsTab client={makeClient([], { ...catalog, createExperiment, listExperiments: vi.fn().mockResolvedValue([]) })} scope={scope} />);
  const input = await screen.findByRole('spinbutton', { name: 'Experiment judge samples' }) as HTMLInputElement;
  if (raw !== undefined) fireEvent.change(input, { target: { value: raw } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run experiment' }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole('button', { name: 'Run experiment' }));
  await waitFor(() => expect(createExperiment).toHaveBeenCalled());
  return { createExperiment, input };
}

describe('clampJudgeSamples（判定サンプル数の丸め）', () => {
  it('1〜5 はそのまま、小数は切り捨て', () => {
    expect(clampJudgeSamples('1', 3)).toBe(1); expect(clampJudgeSamples('5', 3)).toBe(5); expect(clampJudgeSamples('3.7', 1)).toBe(3);
  });
  it('境界: 0 は 1 へ、6 は 5 へ丸める', () => {
    expect(clampJudgeSamples('0', 3)).toBe(1); expect(clampJudgeSamples('6', 3)).toBe(5); expect(clampJudgeSamples('-2', 3)).toBe(1);
  });
  it('異常: 数値でない・空の入力は直前の値を保つ', () => {
    expect(clampJudgeSamples('abc', 4)).toBe(4); expect(clampJudgeSamples('', 4)).toBe(4); expect(clampJudgeSamples('Infinity', 4)).toBe(4);
  });
});

describe('ExperimentsTab の判定サンプル数', () => {
  it('既定は 1 で、DTO に judgeSamples を含めない（サーバー既定・旧サーバー互換）', async () => {
    const { createExperiment, input } = await submitWithJudgeSamples(undefined);
    expect(input.value).toBe('1');
    expect(createExperiment).toHaveBeenCalledWith(baseDto);
    expect(screen.getByText(/Judge samples: 2 or more judges the same case/)).toBeTruthy();
  });

  it('5 を入れると judgeSamples: 5 を DTO に含め、実験ヘッダーに「judge samples ×5」を出す', async () => {
    const { createExperiment } = await submitWithJudgeSamples('5');
    expect(createExperiment).toHaveBeenCalledWith({ ...baseDto, judgeSamples: 5 });
    expect((await screen.findByText(/judge samples/)).textContent).toBe('judge samples ×5');
  });

  it('境界: 6 は 5 に、0 は 1 に丸める（1 のときは DTO から省く）', async () => {
    const first = await submitWithJudgeSamples('6');
    expect(first.input.value).toBe('5'); expect(first.createExperiment).toHaveBeenCalledWith({ ...baseDto, judgeSamples: 5 });
    cleanup();
    const second = await submitWithJudgeSamples('0');
    expect(second.input.value).toBe('1'); expect(second.createExperiment).toHaveBeenCalledWith(baseDto);
  });

  it('異常: 数値でない入力は無視して直前の値を保つ', async () => {
    const { input } = await submitWithJudgeSamples('3');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input.value).toBe('3');
  });

  it('例外: 起票が失敗すると原因をアラートで出し、判定サンプル数の入力は保持する', async () => {
    const createExperiment = vi.fn().mockRejectedValue(new Error('experiment rejected'));
    render(<ExperimentsTab client={makeClient([], { ...catalog, createExperiment, listExperiments: vi.fn().mockResolvedValue([]) })} scope={scope} />);
    const input = await screen.findByRole('spinbutton', { name: 'Experiment judge samples' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run experiment' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'Run experiment' }));
    expect((await screen.findByRole('alert')).textContent).toBe('experiment rejected');
    expect(input.value).toBe('4');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('[回帰固定] judgeSamples が 1 または未設定の実験はヘッダーにサンプル数を出さない', async () => {
    render(<ExperimentsTab client={makeClient([], { listExperiments: vi.fn().mockResolvedValue([{ ...experiment, judgeSamples: 1 }]) })} scope={scope} />);
    await userEvent.click(await screen.findByRole('button', { name: /agent@1\.0\.0/ }));
    await screen.findByRole('progressbar', { name: 'Experiment progress' });
    expect(screen.queryByText(/judge samples/)).toBeNull();
  });
});

// ---- 判定記録（P1/P2/P4）の表示 ----

const judgeBase = { scorer: 'llm-as-judge', metricId: 'judge', rubric: { id: 'rubric', version: '1.2.0' }, required: true, model: { provider: 'judge', model: 'judge-model', modelConfigHash: 'hash' } };
const richJudge = {
  ...judgeBase, status: 'succeeded', score: 0.75, reason: 'mostly right',
  criteria: [{ id: 'accuracy', score: 1, reason: 'matches the reference' }, { id: 'tone', score: null, reason: 'no conversation to assess tone' }, { id: 'safety', score: 0.5, reason: 'hedged' }],
  samples: 3, dispersion: { min: 0.5, max: 0.9, stddev: 0.16 }, uncertain: true,
  usage: { promptTokens: 900, completionTokens: 300, totalTokens: 1200 }, contract: { promptHash: 'abcdef0123456789', rubricId: 'rubric', rubricVersion: '1.2.0' },
};

async function openResultWith(judges: readonly unknown[], language?: Language): Promise<HTMLElement> {
  const result = { ...caseResult, status: 'succeeded', error: undefined, scores: [{ metric: 'judge', score: 0.75 }, { metric: 'judge:accuracy', score: 1 }], judgeEvaluations: judges };
  const client = makeClient([], { listExperimentResults: vi.fn().mockResolvedValue([result]) });
  const tab = <ExperimentsTab client={client} scope={scope} />;
  render(language === undefined ? tab : <I18nProvider initialLanguage={language}>{tab}</I18nProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /agent@1\.0\.0/ }));
  // status語は言語で変わるため、metricId・rubric参照だけで1行目を見つける。
  const line = await screen.findByText(/^judge · .+ · rubric@1\.2\.0/);
  return line.closest('.judge-record') as HTMLElement;
}

describe('ExperimentsTab の判定記録', () => {
  it('合成スコア・基準別チップ（null は「判定不能」+ 理由の title）・ばらつき大・samples/tokens/prompt の行を出す', async () => {
    const record = await openResultWith([richJudge]);
    expect(within(record).getByText('composite 0.75').className).toContain('composite');
    expect(within(record).getByText('accuracy: 1').getAttribute('title')).toBe('matches the reference');
    const unassessable = within(record).getByText('tone: cannot assess');
    expect(unassessable.className).toContain('unassessable'); expect(unassessable.getAttribute('title')).toBe('no conversation to assess tone');
    expect(within(record).getByText('safety: 0.5')).toBeTruthy();
    expect(within(record).getByText('high dispersion (0.50–0.90)').className).toContain('uncertain');
    expect(within(record).getByText('samples 3')).toBeTruthy();
    expect(within(record).getByText('judge 1200 tokens')).toBeTruthy();
    const contract = within(record).getByText('prompt abcdef01');
    expect(contract.getAttribute('title')).toBe('rubric@1.2.0');
    // 1 行目は従来の形のまま（既存テストの参照キー）。
    expect(within(record).getByText(/judge · succeeded · rubric@1\.2\.0 · judge\/judge-model · mostly right/)).toBeTruthy();
    // 基準別の派生指標はスコア列にそのまま並ぶ。
    expect(screen.getByText(/judge:accuracy 1\.00/)).toBeTruthy();
  });

  it('uncertain が false ならばらつきのチップを出さない（dispersion があっても）', async () => {
    const record = await openResultWith([{ ...richJudge, uncertain: false }]);
    expect(within(record).queryByText(/high dispersion/)).toBeNull();
    expect(within(record).getByText('samples 3')).toBeTruthy();
  });

  it('旧実験の記録（criteria / samples / usage / contract なし）は 1 行 + 合成スコアだけで、チップ行や meta 行は無い', async () => {
    const record = await openResultWith([{ ...judgeBase, status: 'succeeded', score: 0.9, reason: 'correct' }]);
    expect(within(record).getByText('composite 0.90')).toBeTruthy();
    expect(record.querySelectorAll('.judge-chip.criterion')).toHaveLength(0);
    expect(record.querySelector('.judge-meta')).toBeNull();
    expect(record.querySelector('.judge-failure')).toBeNull();
  });

  it('境界: dispersion の無い uncertain は範囲なしの「ばらつき大」、usage に totalTokens が無ければ tokens を出さない', async () => {
    const record = await openResultWith([{ ...richJudge, dispersion: undefined, usage: { promptTokens: 10 }, contract: undefined }]);
    expect(within(record).getByText('high dispersion')).toBeTruthy();
    expect(within(record).queryByText(/tokens/)).toBeNull();
    expect(within(record).queryByText(/prompt /)).toBeNull();
    expect(within(record).getByText('samples 3')).toBeTruthy();
  });

  it('失敗した判定は code ごとに原因と次の一手を言語化する（JUDGE_INPUT / JUDGE_UNASSESSABLE / JUDGE_SCHEMA / JUDGE_PROVIDER）', async () => {
    const failed = (metricId: string, code: string, message: string) => ({ ...judgeBase, metricId, status: 'failed', error: { code, message } });
    const result = { ...caseResult, judgeEvaluations: [failed('judge', 'JUDGE_INPUT', 'rubric requires a trace but the run has none'), failed('j2', 'JUDGE_UNASSESSABLE', 'no criterion could be assessed'), failed('j3', 'JUDGE_SCHEMA', 'invalid output after repair'), failed('j4', 'JUDGE_PROVIDER', 'fetch failed')] };
    render(<ExperimentsTab client={makeClient([], { listExperimentResults: vi.fn().mockResolvedValue([result]) })} scope={scope} />);
    await userEvent.click(await screen.findByRole('button', { name: /agent@1\.0\.0/ }));
    const notes = await screen.findAllByRole('note');
    expect(notes.map((note) => note.textContent)).toEqual([
      "JUDGE_INPUT: The rubric requires a tool trace but this case has none (rubric requires a trace but the run has none). Set the rubric's trace policy to optional, or run cases that use tools",
      'JUDGE_UNASSESSABLE: The judge could not assess any criterion (no criterion could be assessed). Make the criterion descriptions more concrete, or give the judge the reference answer or trace it needs',
      'JUDGE_SCHEMA: The judge output did not match the expected shape even after one repair (invalid output after repair). In Settings, switch the judge slot to a model that is strong at structured output',
      'JUDGE_PROVIDER: Could not reach the model server. Check the model settings and endpoint (if you use a local LM Studio, check that it is running).',
    ]);
    // 生のメッセージだけの行（従来の ` · CODE: message`）は残さない。
    expect(screen.queryByText(/· JUDGE_INPUT:/)).toBeNull();
  });

  it('日本語 UI では判定不能・ばらつき大・失敗の案内が日本語になる', async () => {
    const record = await openResultWith([richJudge, { ...judgeBase, metricId: 'j2', status: 'failed', error: { code: 'JUDGE_INPUT', message: 'trace missing' } }], 'ja');
    expect(within(record).getByText('tone: 判定不能')).toBeTruthy();
    expect(within(record).getByText('ばらつき大 (0.50–0.90)')).toBeTruthy();
    expect(within(record).getByText('判定 1200 tokens')).toBeTruthy();
    expect((await screen.findByRole('note')).textContent).toBe('JUDGE_INPUT: ルーブリックが必須にしている実行履歴がこの事例にありません（trace missing）。ルーブリックの実行履歴ポリシーを「任意」にするか、ツールを使う事例で実行してください');
  });
});

// ---- 判定モデルの準備状況（judge スロット未設定の先回り案内と 409 の導線） ----

const judgeProfile = { metadata: { internalId: 'profile', version: '1.0.0' }, metrics: [{ id: 'judge', kind: 'judge', weight: 1, required: true, rubric: { id: 'rubric', version: '1.0.0' } }] };
const codeProfile = { metadata: { internalId: 'profile', version: '1.0.0' }, metrics: [{ id: 'coverage', kind: 'code', weight: 1, required: true, scorer: 'keyword-coverage' }] };
const NOT_CONFIGURED_TITLE = 'The judge model is not configured';
const SETTINGS_BUTTON = 'Set the judge model in Settings';

function judgeClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return makeClient([], {
    ...catalog,
    listExperiments: vi.fn().mockResolvedValue([]),
    runtimeCapabilities: vi.fn().mockResolvedValue({ analysisAssistant: { enabled: false }, judge: { configured: false } }),
    getEvaluatorProfile: vi.fn().mockResolvedValue(judgeProfile),
    ...overrides,
  });
}

async function clickRun(): Promise<void> {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run experiment' }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole('button', { name: 'Run experiment' }));
}

describe('ExperimentsTab の判定モデル準備状況', () => {
  // ApiError の文言は構築時に localStorage の言語で決まる。前の日本語 UI テストが残した 'ja' を引きずらない。
  beforeEach(() => { localStorage.removeItem('agentcontext.language'); });
  afterEach(() => { consumePendingOpen('Settings'); consumePendingOpen('Validation'); });

  it('judge 指標を含むプロファイルで判定モデルが未設定なら、開始ボタンの上に原因・次の一手・設定画面へのボタンを出す（開始ボタンは塞がない）', async () => {
    const client = judgeClient();
    render(<ExperimentsTab client={client} scope={scope} />);
    const notice = await screen.findByRole('status');
    expect(notice.getAttribute('data-judge-notice')).toBe('preflight');
    expect(within(notice).getByText(NOT_CONFIGURED_TITLE)).toBeTruthy();
    expect(within(notice).getByText(/rejected until a model is set in the judge slot/)).toBeTruthy();
    await waitFor(() => expect(client.getEvaluatorProfile).toHaveBeenCalledWith('profile', scope, '1.0.0'));
    expect((screen.getByRole('button', { name: 'Run experiment' }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(within(notice).getByRole('button', { name: SETTINGS_BUTTON }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'judge', section: 'model-slot' });
  });

  it('[回帰固定] 判定モデルが設定済みなら警告を出さない', async () => {
    render(<ExperimentsTab client={judgeClient({ runtimeCapabilities: vi.fn().mockResolvedValue({ analysisAssistant: { enabled: false }, judge: { configured: true, provider: 'openai', model: 'gpt-4o' } }) })} scope={scope} />);
    await screen.findByRole('button', { name: 'Run experiment' });
    await waitFor(() => expect(screen.queryByText(NOT_CONFIGURED_TITLE)).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('境界: プロファイルに judge 指標が無ければ未設定でも警告を出さない', async () => {
    const client = judgeClient({ getEvaluatorProfile: vi.fn().mockResolvedValue(codeProfile) });
    render(<ExperimentsTab client={client} scope={scope} />);
    await waitFor(() => expect(client.getEvaluatorProfile).toHaveBeenCalled());
    expect(screen.queryByText(NOT_CONFIGURED_TITLE)).toBeNull();
  });

  it('境界: judge を返さない旧サーバー（configured 不明）では警告を出さない', async () => {
    const client = judgeClient({ runtimeCapabilities: vi.fn().mockResolvedValue({ analysisAssistant: { enabled: false } }) });
    render(<ExperimentsTab client={client} scope={scope} />);
    await waitFor(() => expect(client.runtimeCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(client.getEvaluatorProfile).toHaveBeenCalled());
    expect(screen.queryByText(NOT_CONFIGURED_TITLE)).toBeNull();
  });

  it('例外: 準備状況の取得が失敗しても画面は落ちず、警告も出さない（プロファイル取得の失敗も同様）', async () => {
    const client = judgeClient({ runtimeCapabilities: vi.fn().mockRejectedValue(new Error('offline')), getEvaluatorProfile: vi.fn().mockRejectedValue(new Error('gone')) });
    render(<ExperimentsTab client={client} scope={scope} />);
    await waitFor(() => expect(client.runtimeCapabilities).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Run experiment' })).toBeTruthy();
    expect(screen.queryByText(NOT_CONFIGURED_TITLE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[回帰固定] 例外: runtimeCapabilities を持たない旧クライアントでも落ちない', async () => {
    render(<ExperimentsTab client={makeClient([], { ...catalog, listExperiments: vi.fn().mockResolvedValue([]) })} scope={scope} />);
    expect(await screen.findByRole('button', { name: 'Run experiment' })).toBeTruthy();
    expect(screen.queryByText(NOT_CONFIGURED_TITLE)).toBeNull();
  });

  it('起票が 409 JUDGE_MODEL_NOT_CONFIGURED で拒否されたら、同じ内容を失敗として出し、設定画面へのボタンで遷移できる', async () => {
    const createExperiment = vi.fn().mockRejectedValue(new ApiError(409, 'JUDGE_MODEL_NOT_CONFIGURED', 'judge model is not configured'));
    const client = judgeClient({ runtimeCapabilities: vi.fn().mockResolvedValue({ analysisAssistant: { enabled: false }, judge: { configured: true } }), createExperiment });
    render(<ExperimentsTab client={client} scope={scope} />);
    await clickRun();
    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('data-judge-notice')).toBe('rejected');
    expect(within(alert).getByText(NOT_CONFIGURED_TITLE)).toBeTruthy();
    expect(within(alert).getByText(/The experiment was rejected/)).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: SETTINGS_BUTTON }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'judge', section: 'model-slot' });
    // 先回りの注意（status）と拒否の通知（alert）を二重に出さない。
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('起票が 409 JUDGE_TRACE_UNAVAILABLE で拒否されたら、ルーブリック ID 入りの文言と「ルーブリックを開く」ボタンを出す', async () => {
    const createExperiment = vi.fn().mockRejectedValue(new ApiError(409, 'JUDGE_TRACE_UNAVAILABLE', 'rubric requires a trace', undefined, { rubric: { id: 'quality-rubric', version: '1.2.0' } }));
    render(<ExperimentsTab client={judgeClient({ createExperiment })} scope={scope} />);
    await clickRun();
    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('data-judge-notice')).toBe('trace-unavailable');
    expect(within(alert).getByText("Rubric 'quality-rubric' requires a tool trace, but scenario cases never produce one. Set its trace policy to optional, or use a dataset with turn cases only")).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the rubric' }));
    expect(consumePendingOpen('Validation')).toEqual({ internalId: 'quality-rubric', version: '1.2.0', section: 'rubric' });
  });

  it('境界: JUDGE_TRACE_UNAVAILABLE に rubric が無ければ文言だけを出し、開くボタンは出さない', async () => {
    const createExperiment = vi.fn().mockRejectedValue(new ApiError(409, 'JUDGE_TRACE_UNAVAILABLE', 'rubric requires a trace'));
    render(<ExperimentsTab client={judgeClient({ createExperiment })} scope={scope} />);
    await clickRun();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/The rubric requires a tool trace, but scenario cases never produce one/)).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'Open the rubric' })).toBeNull();
  });

  it('[回帰固定] 判定以外の ApiError は従来どおり文字列のアラートで出す', async () => {
    const createExperiment = vi.fn().mockRejectedValue(new ApiError(409, 'EXPERIMENT_CONFLICT', 'busy'));
    render(<ExperimentsTab client={judgeClient({ createExperiment })} scope={scope} />);
    await clickRun();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The experiment is not in a state that allows this operation (busy)');
    expect(alert.getAttribute('data-judge-notice')).toBeNull();
  });

  it('失敗した判定が「判定モデル未設定」（JUDGE_PROVIDER + not configured）なら、理由の横に設定画面へのボタンを出す', async () => {
    const result = { ...caseResult, judgeEvaluations: [{ ...judgeBase, status: 'failed', error: { code: 'JUDGE_PROVIDER', message: 'Judge model is not configured; set the judge slot in Settings' } }, { ...judgeBase, metricId: 'j2', status: 'failed', error: { code: 'JUDGE_PROVIDER', message: 'fetch failed' } }] };
    render(<ExperimentsTab client={makeClient([], { listExperimentResults: vi.fn().mockResolvedValue([result]) })} scope={scope} />);
    await userEvent.click(await screen.findByRole('button', { name: /agent@1\.0\.0/ }));
    const notes = await screen.findAllByRole('note');
    expect(notes[0]?.textContent).toContain('JUDGE_PROVIDER: The judge model is not configured. Set the judge slot in Settings before running experiments that use a judge rubric');
    const button = within(notes[0] as HTMLElement).getByRole('button', { name: SETTINGS_BUTTON });
    expect(button.className).toContain('judge-fix');
    await userEvent.click(button);
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'judge', section: 'model-slot' });
    // 接続失敗など他の JUDGE_PROVIDER にはボタンを出さない（境界）。
    expect(within(notes[1] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('日本語 UI では先回りの注意・ボタンが日本語になる', async () => {
    render(<I18nProvider initialLanguage="ja"><ExperimentsTab client={judgeClient()} scope={scope} /></I18nProvider>);
    const notice = await screen.findByRole('status');
    expect(within(notice).getByText('判定モデルが未設定です')).toBeTruthy();
    expect(within(notice).getByRole('button', { name: '設定で判定モデルを設定' })).toBeTruthy();
  });
});
