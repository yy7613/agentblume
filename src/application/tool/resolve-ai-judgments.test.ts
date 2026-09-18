import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { ConfigError } from '../../domain/etl/errors';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { AI_JUDGE_UNCLEAR, aiJudgeItemKey, type AiJudgeVerdict } from '../../domain/etl/nodes/ai-judge';
import { EtlEngine } from '../etl/engine';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { ModelProviderError } from '../model/model-provider';
import { AI_JUDGE_PROMPT_TEMPLATE_VERSION, ResolveAiJudgmentsUseCase, ancestorSubgraph, parseAiJudgeVerdicts } from './resolve-ai-judgments';

const engine = (): EtlEngine => new EtlEngine(createDefaultRegistry());

const AGENT_OUTPUT = { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } as const;

/** `json-source → ai-judge → agent-output`。ai-judge の設定だけ差し替えて使う。 */
function graphOf(rows: readonly Record<string, unknown>[], judge: Record<string, unknown> = {}): ToolGraph {
  return {
    nodes: [
      { id: 'source', type: 'json-source', config: { rows } },
      { id: 'judge', type: 'ai-judge', config: { question: 'これはクレームですか？', ...judge } },
      { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
    ],
    edges: [{ from: 'source', to: 'judge' }, { from: 'judge', to: 'out' }],
  };
}

function completion(verdicts: readonly { id: string; answer: string; reason?: string }[]): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify({ verdicts: verdicts.map((verdict) => ({ reason: '', ...verdict })) }) }, finishReason: 'stop' };
}

function raw(content: string | null): ModelCompletion {
  return { message: { role: 'assistant', content }, finishReason: 'stop' };
}

/** 注入された verdicts を読む（ノードは差し替えられて返るので、返ったグラフから取る）。 */
function verdictsOf(graph: ToolGraph, nodeId = 'judge'): Record<string, AiJudgeVerdict> {
  const config = graph.nodes.find((node) => node.id === nodeId)?.config as { resolved?: { verdicts?: Record<string, AiJudgeVerdict> } };
  return config.resolved?.verdicts ?? {};
}

/** responseFormat の answer enum（判定値の許容集合）。 */
function answerEnum(request: ModelCompletionRequest): readonly string[] {
  const schema = request.responseFormat?.schema as unknown as { properties: { verdicts: { items: { properties: { answer: { enum: string[] } } } } } };
  return schema.properties.verdicts.items.properties.answer.enum;
}

/** user メッセージの本文（テキスト前提）。 */
function userContent(request: ModelCompletionRequest): string {
  const content = request.messages[1]?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** <untrusted-rows> に包まれた判定対象（モデルへ実際に渡した件数を数えるため）。 */
function sentItems(request: ModelCompletionRequest): readonly unknown[] {
  // 本文中では「<untrusted-rows> の中は…」という説明にも同じ語が出るので、最後に開くタグを取る。
  const content = userContent(request);
  const open = content.lastIndexOf('<untrusted-rows>') + '<untrusted-rows>'.length;
  const close = content.lastIndexOf('</untrusted-rows>');
  return JSON.parse(content.slice(open, close)) as readonly unknown[];
}

describe('ResolveAiJudgmentsUseCase: ai-judge が無いグラフ', () => {
  it('グラフをそのまま返し、モデルには一切触れない（無効なモデル設定でも通る）', async () => {
    const model = new ScriptedModelProvider();
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => false);
    const graph: ToolGraph = { nodes: [{ id: 'source', type: 'json-source', config: { rows: [{ a: 1 }] } }], edges: [] };
    await expect(usecase.execute(graph)).resolves.toBe(graph);
    expect(model.requests).toHaveLength(0);
  });
});

describe('ResolveAiJudgmentsUseCase: available / モデルが使えないとき', () => {
  it('available はモデル設定と構造化出力の両方を見る', async () => {
    const model = new ScriptedModelProvider();
    expect(await new ResolveAiJudgmentsUseCase(engine(), model, () => true).available()).toBe(true);
    expect(await new ResolveAiJudgmentsUseCase(engine(), model, () => false).available()).toBe(false);
    const noStructured: ModelProviderPort = { complete: model.complete.bind(model), capabilities: (): readonly ModelCapability[] => ['chat'] };
    expect(await new ResolveAiJudgmentsUseCase(engine(), noStructured, () => true).available()).toBe(false);
  });

  it('available は enabled が投げても false を返す（機能フラグの取得で画面を落とさない）', async () => {
    const usecase = new ResolveAiJudgmentsUseCase(engine(), new ScriptedModelProvider(), () => { throw new Error('settings unreadable'); });
    expect(await usecase.available()).toBe(false);
  });

  it('モデル未設定なら ai-judge ノードの id つき ConfigError で止まり、設定画面へ導線を出す', async () => {
    const model = new ScriptedModelProvider();
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => false);
    const error = await usecase.execute(graphOf([{ body: 'x' }])).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error & { nodeId?: string }).nodeId).toBe('judge');
    expect((error as Error).message).toContain('Settings > Models');
    // 黙って全行 unclear にしない＝モデルは呼ばれない。
    expect(model.requests).toHaveLength(0);
  });

  it('構造化出力の無いモデルなら、別モデルを選ぶよう促す ConfigError（nodeId つき）', async () => {
    const model = new ScriptedModelProvider();
    const noStructured: ModelProviderPort = { complete: model.complete.bind(model), capabilities: (): readonly ModelCapability[] => ['chat', 'tool-calling'] };
    const usecase = new ResolveAiJudgmentsUseCase(engine(), noStructured, () => true);
    const error = await usecase.execute(graphOf([{ body: 'x' }])).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error & { nodeId?: string }).nodeId).toBe('judge');
    expect((error as Error).message).toContain('structured output');
  });
});

describe('ResolveAiJudgmentsUseCase: 正常系（はい/いいえ）', () => {
  const rows = [{ body: '商品が壊れていました' }, { body: '発送はいつですか' }];

  async function resolveHappyPath(): Promise<{ readonly model: ScriptedModelProvider; readonly graph: ToolGraph }> {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes', reason: '破損の申告' }, { id: 'r2', answer: 'no', reason: '納期の質問' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    return { model, graph: await usecase.execute(graphOf(rows)) };
  }

  it('要求は temperature 0 と strict な responseFormat（enum は yes / no / unclear）で組む', async () => {
    const { model } = await resolveHappyPath();
    expect(model.requests).toHaveLength(1);
    const request = model.requests[0] as ModelCompletionRequest;
    expect(request.temperature).toBe(0);
    expect(request.responseFormat).toMatchObject({ name: 'ai_judge_verdicts', strict: true });
    expect(answerEnum(request)).toEqual(['yes', 'no', AI_JUDGE_UNCLEAR]);
  });

  it('system prompt は行を「引用データ」として扱うよう指示し、user は行を <untrusted-rows> で包む', async () => {
    const { model } = await resolveHappyPath();
    const request = model.requests[0] as ModelCompletionRequest;
    const system = request.messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('引用されたデータ');
    const user = userContent(request);
    expect(user).toContain('<untrusted-rows>');
    expect(user).toContain('</untrusted-rows>');
    expect(user).toContain('商品が壊れていました');
    // プロンプトの版は文脈に載せる（判定の再現・比較のため）。
    expect(user).toContain(AI_JUDGE_PROMPT_TEMPLATE_VERSION);
  });

  it('判定は aiJudgeItemKey をキーにして注入される', async () => {
    const { graph } = await resolveHappyPath();
    const verdicts = verdictsOf(graph);
    expect(verdicts[aiJudgeItemKey({ body: '商品が壊れていました' }, ['body'])]).toEqual({ value: 'yes', reason: '破損の申告' });
    expect(verdicts[aiJudgeItemKey({ body: '発送はいつですか' }, ['body'])]).toEqual({ value: 'no', reason: '納期の質問' });
  });

  it('返ったグラフを engine.preview に流すと判定列と理由列が付く', async () => {
    const { graph } = await resolveHappyPath();
    const output = engine().preview(graph).fullOutput;
    expect(output.schema.columns.map((column) => column.name)).toEqual(['body', 'aiVerdict', 'aiReason']);
    expect(output.rows).toEqual([
      { body: '商品が壊れていました', aiVerdict: 'yes', aiReason: '破損の申告' },
      { body: '発送はいつですか', aiVerdict: 'no', aiReason: '納期の質問' },
    ]);
  });

  it('入力グラフは書き換えない（resolved は保存済み Tool に混ざらない）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }, { id: 'r2', answer: 'no' }]));
    const input = graphOf(rows);
    const resolved = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(input);
    expect((input.nodes[1]?.config as { resolved?: unknown }).resolved).toBeUndefined();
    expect(input.nodes[1]).not.toBe(resolved.nodes[1]);
    // そのままの入力グラフは（解決を通していないので）実行できない。
    expect(() => engine().preview(input)).toThrowError(/verdicts are not resolved/);
  });
});

describe('ResolveAiJudgmentsUseCase: 分類モード', () => {
  it('enum はカテゴリ名 + unclear で、カテゴリの説明も文脈に載る', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'クレーム', reason: '破損' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    const graph = await usecase.execute(graphOf([{ body: '壊れていた' }], {
      categories: [{ name: 'クレーム', description: '不満・苦情' }, { name: '問い合わせ' }],
    }));
    const request = model.requests[0] as ModelCompletionRequest;
    expect(answerEnum(request)).toEqual(['クレーム', '問い合わせ', AI_JUDGE_UNCLEAR]);
    expect(userContent(request)).toContain('不満・苦情');
    expect(engine().preview(graph).fullOutput.rows[0]).toMatchObject({ aiVerdict: 'クレーム' });
  });
});

describe('ResolveAiJudgmentsUseCase: 重複除外・件数上限・バッチ', () => {
  it('同じ内容の行はまとめて 1 件だけ問う', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes', reason: '同一' }]));
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true)
      .execute(graphOf([{ body: '同じ' }, { body: '同じ' }, { body: '同じ' }]));
    expect(model.requests).toHaveLength(1);
    expect(sentItems(model.requests[0] as ModelCompletionRequest)).toHaveLength(1);
    // 3 行とも同じ判定になる。
    expect(engine().preview(graph).fullOutput.rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'yes', 'yes']);
  });

  it('batchSize ごとに分けて問う（5 件を 2 件ずつなら 3 回）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(
      completion([{ id: 'r1', answer: 'yes' }, { id: 'r2', answer: 'no' }]),
      completion([{ id: 'r1', answer: 'yes' }, { id: 'r2', answer: 'no' }]),
      completion([{ id: 'r1', answer: 'yes' }]),
    );
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true, { batchSize: 2 });
    const graph = await usecase.execute(graphOf([1, 2, 3, 4, 5].map((n) => ({ body: `b${n}` }))));
    expect(model.requests).toHaveLength(3);
    expect(Object.keys(verdictsOf(graph))).toHaveLength(5);
    expect(engine().preview(graph).fullOutput.rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'no', 'yes', 'no', 'yes']);
  });

  it('id は各バッチで振り直され、バッチごとにその行だけを送る', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]), completion([{ id: 'r1', answer: 'no' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true, { batchSize: 1 });
    const graph = await usecase.execute(graphOf([{ body: 'a' }, { body: 'b' }]));
    expect(userContent(model.requests[0] as ModelCompletionRequest)).toContain('"a"');
    expect(userContent(model.requests[1] as ModelCompletionRequest)).toContain('"b"');
    expect(engine().preview(graph).fullOutput.rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'no']);
  });

  it('重複除外後の件数が maxItems を超えたら nodeId と上限つきの ConfigError で止める', async () => {
    const model = new ScriptedModelProvider();
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    const rows = [1, 2, 3, 4].map((n) => ({ body: `b${n}` }));
    const error = await usecase.execute(graphOf(rows, { maxItems: 3 })).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error & { nodeId?: string }).nodeId).toBe('judge');
    expect((error as Error).message).toContain('4 distinct rows');
    expect((error as Error).message).toContain('limit of 3');
    // 上限判定は問い合わせの前に行う（超過したぶんをモデルに投げない）。
    expect(model.requests).toHaveLength(0);
  });

  it('重複を除いた件数で上限を測る（同じ行が並んでいるだけなら通る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    await expect(usecase.execute(graphOf([{ body: 'x' }, { body: 'x' }, { body: 'x' }], { maxItems: 1 }))).resolves.toBeDefined();
  });
});

describe('ResolveAiJudgmentsUseCase: 判定の再利用（キャッシュ）', () => {
  it('同じ行・同じ設定なら 2 回目はモデルを呼ばない', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes', reason: '初回' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    await usecase.execute(graphOf([{ body: 'x' }]));
    const second = await usecase.execute(graphOf([{ body: 'x' }]));
    expect(model.requests).toHaveLength(1);
    expect(engine().preview(second).fullOutput.rows[0]).toMatchObject({ aiVerdict: 'yes', aiReason: '初回' });
  });

  it('判定基準（question）が変われば問い直す', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]), completion([{ id: 'r1', answer: 'no' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    await usecase.execute(graphOf([{ body: 'x' }]));
    const second = await usecase.execute(graphOf([{ body: 'x' }], { question: '別の基準ですか？' }));
    expect(model.requests).toHaveLength(2);
    expect(engine().preview(second).fullOutput.rows[0]).toMatchObject({ aiVerdict: 'no' });
  });

  it('カテゴリや見る列が変われば問い直す', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]), completion([{ id: 'r1', answer: 'A' }]), completion([{ id: 'r1', answer: 'yes' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    await usecase.execute(graphOf([{ body: 'x', note: 'n' }]));
    await usecase.execute(graphOf([{ body: 'x', note: 'n' }], { categories: [{ name: 'A' }] }));
    await usecase.execute(graphOf([{ body: 'x', note: 'n' }], { columns: ['body'] }));
    expect(model.requests).toHaveLength(3);
  });

  it('モデルが切り替われば問い直す（判定はモデルごとに持つ）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]), completion([{ id: 'r1', answer: 'no' }]));
    let provider = 'lm-studio';
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true, { snapshot: async () => ({ provider, model: 'm' }) });
    await usecase.execute(graphOf([{ body: 'x' }]));
    provider = 'openai';
    await usecase.execute(graphOf([{ body: 'x' }]));
    expect(model.requests).toHaveLength(2);
  });

  it('cacheSize 0 なら再利用しない（毎回問い直す）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]), completion([{ id: 'r1', answer: 'yes' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true, { cacheSize: 0 });
    await usecase.execute(graphOf([{ body: 'x' }]));
    await usecase.execute(graphOf([{ body: 'x' }]));
    expect(model.requests).toHaveLength(2);
  });
});

describe('ResolveAiJudgmentsUseCase: 応答の検証', () => {
  it('答えの無い行は unclear と「答えなかった」理由になる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes', reason: 'ok' }]));
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }, { body: 'b' }]));
    const rows = engine().preview(graph).fullOutput.rows;
    expect(rows[1]).toMatchObject({ aiVerdict: AI_JUDGE_UNCLEAR, aiReason: 'the model did not answer this row' });
  });

  it('答えの無かった行は再利用せず、次回は問い直す', async () => {
    const model = new ScriptedModelProvider();
    // 2 回目は「答えの無かった b」だけを問うので、id は r1 から振り直される。
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]), completion([{ id: 'r1', answer: 'no' }]));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    await usecase.execute(graphOf([{ body: 'a' }, { body: 'b' }]));
    const second = await usecase.execute(graphOf([{ body: 'a' }, { body: 'b' }]));
    expect(model.requests).toHaveLength(2);
    // 2 回目に問うのは答えの無かった行だけ。
    expect(userContent(model.requests[1] as ModelCompletionRequest)).not.toContain('"a"');
    expect(engine().preview(second).fullOutput.rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'no']);
  });

  it('渡していない id への答えは捨てる（行の中の指示で他の行を書き換えさせない）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes', reason: 'ok' }, { id: 'r99', answer: 'yes', reason: 'injected' }]));
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }, { body: 'b' }]));
    expect(Object.keys(verdictsOf(graph))).toHaveLength(2);
    const rows = engine().preview(graph).fullOutput.rows;
    expect(rows.map((row) => row['aiVerdict'])).toEqual(['yes', AI_JUDGE_UNCLEAR]);
    expect(JSON.stringify(rows)).not.toContain('injected');
  });

  it('許容外の answer は捨てて unclear にする', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'maybe', reason: 'r' }]));
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }]));
    expect(engine().preview(graph).fullOutput.rows[0]).toMatchObject({ aiVerdict: AI_JUDGE_UNCLEAR });
  });

  it('壊れた JSON は 1 度だけ修復を求め、直れば成功する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(raw('ここに JSON ではない文章'), completion([{ id: 'r1', answer: 'yes', reason: '修復後' }]));
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }]));
    expect(model.requests).toHaveLength(2);
    // 修復要求には前回の応答と不備の説明を添える。
    const repair = model.requests[1] as ModelCompletionRequest;
    expect(repair.messages.at(-2)?.role).toBe('assistant');
    expect(repair.messages.at(-1)?.content).toContain('JSON として読めなかった');
    expect(engine().preview(graph).fullOutput.rows[0]).toMatchObject({ aiVerdict: 'yes', aiReason: '修復後' });
  });

  it('修復しても直らなければ ModelProviderError（ノード id つき）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(raw('壊れ 1'), raw('壊れ 2'));
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    const error = await usecase.execute(graphOf([{ body: 'a' }])).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect((error as Error).message).toContain('ai-judge (judge)');
    expect((error as Error).message).toContain('even after one repair');
    expect(model.requests).toHaveLength(2);
  });

  it('モデル呼び出しが落ちたら ModelProviderError にノード id と原因を載せる', async () => {
    const model = new ScriptedModelProvider(); // enqueue しない = 呼び出しで落ちる
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    const error = await usecase.execute(graphOf([{ body: 'a' }])).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect((error as Error).message).toContain('ai-judge (judge)');
    expect((error as Error).message).toContain('no scripted completion available');
  });

  it('中断（AbortSignal）は ModelProviderError に包まずそのまま伝える', async () => {
    const model = new ScriptedModelProvider();
    const controller = new AbortController();
    controller.abort();
    const usecase = new ResolveAiJudgmentsUseCase(engine(), model, () => true);
    const error = await usecase.execute(graphOf([{ body: 'a' }]), controller.signal).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe('scripted request aborted');
  });
});

describe('ResolveAiJudgmentsUseCase: 設定に不備のあるノード', () => {
  it('question が空なら注入せずに返す（実行時に ai-judge が同じ不備を報告する）', async () => {
    const model = new ScriptedModelProvider();
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }], { question: '' }));
    expect(model.requests).toHaveLength(0);
    expect(verdictsOf(graph)).toEqual({});
    expect(() => engine().preview(graph)).toThrowError(/question is required/);
  });

  it('存在しない列を見る設定なら注入しない（実行時に SchemaError で報告される）', async () => {
    const model = new ScriptedModelProvider();
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }], { columns: ['missing'] }));
    expect(model.requests).toHaveLength(0);
    expect(() => engine().preview(graph)).toThrowError(/column not found: missing/);
  });

  it('上流が繋がっていない ai-judge は飛ばす（伝播検査が未接続として報告する）', async () => {
    const model = new ScriptedModelProvider();
    const graph: ToolGraph = {
      nodes: [{ id: 'source', type: 'json-source', config: { rows: [{ body: 'a' }] } }, { id: 'judge', type: 'ai-judge', config: { question: 'q' } }],
      edges: [],
    };
    const resolved = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graph);
    expect(model.requests).toHaveLength(0);
    expect(verdictsOf(resolved)).toEqual({});
  });

  it('既に resolved を持つノードは問い直さない（注入済みの判定を上書きしない）', async () => {
    const model = new ScriptedModelProvider();
    const preset = { [aiJudgeItemKey({ body: 'a' }, ['body'])]: { value: 'no', reason: '既存' } };
    const graph = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graphOf([{ body: 'a' }], { resolved: { verdicts: preset } }));
    expect(model.requests).toHaveLength(0);
    expect(engine().preview(graph).fullOutput.rows[0]).toMatchObject({ aiVerdict: 'no', aiReason: '既存' });
  });
});

describe('ResolveAiJudgmentsUseCase: 上流の計算と連鎖', () => {
  it('上流の filter を通った行だけを判定する（祖先サブグラフを実際に計算する）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }]));
    const graph: ToolGraph = {
      nodes: [
        { id: 'source', type: 'json-source', config: { rows: [{ body: 'a', keep: true }, { body: 'b', keep: false }] } },
        { id: 'only', type: 'filter', config: { column: 'keep', op: 'eq', value: true } },
        { id: 'judge', type: 'ai-judge', config: { question: 'q', columns: ['body'] } },
        { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
      ],
      edges: [{ from: 'source', to: 'only' }, { from: 'only', to: 'judge' }, { from: 'judge', to: 'out' }],
    };
    await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graph);
    const user = userContent(model.requests[0] as ModelCompletionRequest);
    expect(user).toContain('"a"');
    expect(user).not.toContain('"b"');
  });

  it('ai-judge が連なるとき、下流は上流の判定結果を見て判定する（トポロジカル順に解く）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(
      completion([{ id: 'r1', answer: 'yes', reason: '一段目' }]),
      completion([{ id: 'r1', answer: 'no', reason: '二段目' }]),
    );
    const graph: ToolGraph = {
      nodes: [
        { id: 'source', type: 'json-source', config: { rows: [{ body: 'a' }] } },
        { id: 'first', type: 'ai-judge', config: { question: '一段目の基準', columns: ['body'] } },
        { id: 'second', type: 'ai-judge', config: { question: '二段目の基準', outputColumn: 'aiVerdict2', reasonColumn: 'aiReason2' } },
        { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
      ],
      edges: [{ from: 'source', to: 'first' }, { from: 'first', to: 'second' }, { from: 'second', to: 'out' }],
    };
    const resolved = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graph);
    expect(model.requests).toHaveLength(2);
    // 二段目は一段目の判定列を含む行を見ている。
    expect(userContent(model.requests[1] as ModelCompletionRequest)).toContain('一段目');
    expect(engine().preview(resolved).fullOutput.rows[0]).toMatchObject({ aiVerdict: 'yes', aiVerdict2: 'no', aiReason2: '二段目' });
  });

  it('後段の filter で aiVerdict を見れば Dify 風の分岐になる（判定 → 条件分岐が端から端まで通る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes', reason: 'クレーム' }, { id: 'r2', answer: 'no', reason: '質問' }]));
    const graph: ToolGraph = {
      nodes: [
        { id: 'source', type: 'json-source', config: { rows: [{ body: '壊れていた' }, { body: 'いつ届く' }] } },
        { id: 'judge', type: 'ai-judge', config: { question: 'クレームですか？', columns: ['body'] } },
        { id: 'claims', type: 'filter', config: { column: 'aiVerdict', op: 'eq', value: 'yes' } },
        { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
      ],
      edges: [{ from: 'source', to: 'judge' }, { from: 'judge', to: 'claims' }, { from: 'claims', to: 'out' }],
    };
    const resolved = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graph);
    expect(engine().preview(resolved).fullOutput.rows).toEqual([{ body: '壊れていた', aiVerdict: 'yes', aiReason: 'クレーム' }]);
  });

  it('keep モードは判定に合う行だけを下流へ流す', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue(completion([{ id: 'r1', answer: 'yes' }, { id: 'r2', answer: 'no' }]));
    const graph = graphOf([{ body: 'a' }, { body: 'b' }], { action: 'keep', matchValues: ['yes'] });
    const resolved = await new ResolveAiJudgmentsUseCase(engine(), model, () => true).execute(graph);
    expect(engine().preview(resolved).fullOutput.rows).toEqual([{ body: 'a' }]);
  });
});

describe('ancestorSubgraph', () => {
  const graph: ToolGraph = {
    nodes: [
      { id: 'a', type: 'json-source', config: {} },
      { id: 'b', type: 'json-source', config: {} },
      { id: 'c', type: 'union', config: {} },
      { id: 'd', type: 'select', config: {} },
    ],
    edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }],
  };

  it('終端とその祖先だけを残す（下流は落とす）', () => {
    const sub = ancestorSubgraph(graph, 'c');
    expect(sub.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'c']);
    expect(sub.edges).toEqual([{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }]);
  });

  it('祖先の無いノードは自分だけになる', () => {
    expect(ancestorSubgraph(graph, 'a')).toEqual({ nodes: [{ id: 'a', type: 'json-source', config: {} }], edges: [] });
  });
});

describe('parseAiJudgeVerdicts', () => {
  const ids = ['r1', 'r2'];
  const allowed = ['yes', 'no', AI_JUDGE_UNCLEAR];

  it('空・非 JSON・verdicts が配列でない応答は不備として報告する', () => {
    expect(parseAiJudgeVerdicts(null, ids, allowed)).toMatchObject({ ok: false });
    expect(parseAiJudgeVerdicts('   ', ids, allowed)).toMatchObject({ ok: false });
    expect(parseAiJudgeVerdicts('not json', ids, allowed)).toMatchObject({ ok: false, issues: ['応答が JSON として読めなかった'] });
    expect(parseAiJudgeVerdicts('{"verdicts":{}}', ids, allowed)).toMatchObject({ ok: false, issues: ['verdicts が配列ではない'] });
  });

  it('未知の id・許容外の answer・型違いは捨て、残りを返す', () => {
    const parsed = parseAiJudgeVerdicts(JSON.stringify({ verdicts: [
      { id: 'r1', answer: 'yes', reason: 'ok' },
      { id: 'r9', answer: 'yes', reason: 'unknown id' },
      { id: 'r2', answer: 'maybe', reason: 'bad answer' },
      { id: 5, answer: 'yes' },
      null,
    ] }), ids, allowed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.verdicts.keys()]).toEqual(['r1']);
    expect(parsed.verdicts.get('r1')).toEqual({ value: 'yes', reason: 'ok' });
  });

  it('reason が無い／文字列でなければ空文字にし、長すぎれば 100 文字で切る', () => {
    const parsed = parseAiJudgeVerdicts(JSON.stringify({ verdicts: [{ id: 'r1', answer: 'yes' }, { id: 'r2', answer: 'no', reason: 'あ'.repeat(200) }] }), ids, allowed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdicts.get('r1')?.reason).toBe('');
    expect(parsed.verdicts.get('r2')?.reason).toHaveLength(100);
  });

  it('同じ id が 2 度来たら後勝ち（重複で壊れない）', () => {
    const parsed = parseAiJudgeVerdicts(JSON.stringify({ verdicts: [{ id: 'r1', answer: 'yes' }, { id: 'r1', answer: 'no' }] }), ids, allowed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdicts.get('r1')?.value).toBe('no');
  });
});
