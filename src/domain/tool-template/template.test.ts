import { describe, expect, it } from 'vitest';
import {
  TOOL_TEMPLATE_DIRECTIVES,
  TOOL_TEMPLATE_SLOT_KINDS,
  collectReferences,
  interpolationNamesOf,
  parseProfileExpression,
  parseToolTemplate,
  whenSlotNames,
} from './template';

/** 最小の妥当なテンプレート（各検査はここから 1 か所だけ壊して確かめる）。 */
function baseTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'top-rows',
    version: '1.0.0',
    title: { ja: '上位 N 件', en: 'Top rows' },
    summary: { ja: '値の大きい順に返す。', en: 'Largest first.' },
    whenToUse: { ja: ['ランキングが要る'], en: ['A ranking is needed'] },
    tags: ['ranking'],
    sources: { min: 1, max: 1 },
    slots: [
      { name: 'source', kind: 'dataSource', label: { ja: 'データソース', en: 'Data source' } },
      { name: 'value', kind: 'column', source: 'source', role: 'value', label: { ja: '値の列', en: 'Value column' } },
      { name: 'limit', kind: 'number', min: 1, max: 100, integer: true, default: 10, label: { ja: '件数', en: 'Rows' } },
    ],
    arguments: [],
    nodes: [
      { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
      { id: 'sort', type: 'sort', config: { keys: [{ column: { $slot: 'value' }, direction: 'desc' }] } },
      { id: 'limit', type: 'limit', config: { count: { $slot: 'limit' } } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: { $slot: 'limit' }, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [
      { from: 'src', to: 'sort' },
      { from: 'sort', to: 'limit' },
      { from: 'limit', to: 'out' },
    ],
    description: { ja: '{{value}} の大きい順に {{limit}} 件。', en: 'Top {{limit}} rows by {{value}}.' },
    ...overrides,
  };
}

/** 問題文の一覧（受理されてしまったら空配列ではなく失敗させる）。 */
function problemsOf(json: unknown): readonly string[] {
  const parsed = parseToolTemplate(json);
  if (parsed.ok) throw new Error('expected the template to be rejected, but it was accepted');
  return parsed.problems;
}

/** どの問題文も「何が悪いか」と「どう直すか」を含む（直し方の語のどれかを含む）。 */
function everyProblemSaysHowToFix(problems: readonly string[]): boolean {
  const fixWords = /add |use |remove |rename |delete |fix |choose |set |give |pick |write |change |move |put |swap |shorten |raise |keep |make |restrict |split |check |replace |build /i;
  return problems.every((problem) => fixWords.test(problem));
}

describe('parseToolTemplate', () => {
  it('正常: 最小のテンプレートを受理し、そのまま使える形で返す', () => {
    const parsed = parseToolTemplate(baseTemplate());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.template.id).toBe('top-rows');
    expect(parsed.template.nodes).toHaveLength(4);
    expect(parsed.template.arguments).toEqual([]);
  });

  it('正常: `$schema` と任意の notes / implementationNotes を受理する（実行時は無視される値）', () => {
    const parsed = parseToolTemplate(baseTemplate({ $schema: './tool-template.schema.json', notes: 'メモ', implementationNotes: '申し送り' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.template.notes).toBe('メモ');
    expect((parsed.template as { $schema?: unknown }).$schema).toBeUndefined();
  });

  describe('引数の lock（v46 §B）', () => {
    /** 引数 1 つを filter に束縛したテンプレート（lock の有無だけを変えて確かめる）。 */
    const withArgument = (argument: Record<string, unknown>) => baseTemplate({
      arguments: [{ name: 'minimum', type: 'number', nullable: false, description: { ja: '下限', en: 'Minimum' }, sample: 0, ...argument }],
      nodes: [
        ...(baseTemplate().nodes as unknown[]),
        { id: 'f', type: 'filter', config: { column: { $slot: 'value' }, op: 'gte', value: 0, valueBinding: { $argument: 'minimum' } } },
      ],
      edges: [{ from: 'src', to: 'f' }, { from: 'f', to: 'sort' }, { from: 'sort', to: 'limit' }, { from: 'limit', to: 'out' }],
    });

    it('正常: 日英の理由つきの lock を受理し、引数にそのまま載せる', () => {
      const lock = { ja: '省略できると混ざるため、必須に固定しています', en: 'Required: omitting it would mix rows' };
      const parsed = parseToolTemplate(withArgument({ lock }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.template.arguments[0]?.lock).toEqual(lock);
    });

    it('異常: lock に英語が無ければ、その項目と schema の場所を示して直させる', () => {
      const problems = problemsOf(withArgument({ lock: { ja: '固定' } }));
      expect(problems.join('\n')).toContain('arguments.0.lock.en');
      expect(everyProblemSaysHowToFix(problems)).toBe(true);
    });
  });

  it('異常: 形式（zod）に合わないときは、どの項目をどう直すかを言う', () => {
    const problems = problemsOf(baseTemplate({ formatVersion: 2 }));
    expect(problems.join('\n')).toContain('formatVersion');
    expect(problems.join('\n')).toContain('tool-template.schema.json');
  });

  it('異常: id の形が違えば、使える文字と例を添えて直し方を言う', () => {
    const problems = problemsOf(baseTemplate({ id: 'Top_Rows' }));
    expect(problems.join('\n')).toContain("id 'Top_Rows'");
    expect(problems.join('\n')).toContain('period-series');
  });

  it('異常: スロット名が重複していれば、名前を言って重複を消すよう言う', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'value', kind: 'text', maxLength: 10, default: 'x', label: { ja: 'a', en: 'a' } }];
    const problems = problemsOf(baseTemplate({ slots }));
    expect(problems.join('\n')).toContain("slot 'value' is declared twice");
  });

  it('異常: 引数名が snake_case でなければ、形と例を添えて直し方を言う', () => {
    const problems = problemsOf(baseTemplate({
      arguments: [{ name: 'periodFrom', type: 'date', nullable: true, description: { ja: 'a', en: 'a' }, sample: '2020-01-01' }],
    }));
    expect(problems.join('\n')).toContain('snake_case');
  });

  it('異常: エッジの端点が存在しないノードなら、どちら側をどう直すかを言う', () => {
    const edges = [{ from: 'src', to: 'sort' }, { from: 'sort', to: 'nope' }, { from: 'limit', to: 'out' }];
    const problems = problemsOf(baseTemplate({ edges }));
    expect(problems).toContain(`edge 'sort' -> 'nope': node 'nope' does not exist; add a node with id "nope" or fix the edge's "to"`);
  });

  it('異常: エッジが循環していれば、循環の経路を示して 1 本消すよう言う', () => {
    const edges = [...(baseTemplate().edges as unknown[]), { from: 'out', to: 'sort' }];
    const problems = problemsOf(baseTemplate({ edges }));
    expect(problems.join('\n')).toMatch(/cycle \(sort -> limit -> out -> sort\)/);
  });

  it('異常: agent-output が 0 個なら、ちょうど 1 つ書くよう言う', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).filter((node) => node.id !== 'out');
    const problems = problemsOf(baseTemplate({ nodes, edges: [{ from: 'src', to: 'sort' }, { from: 'sort', to: 'limit' }] }));
    expect(problems.join('\n')).toContain("0 'agent-output' node(s); write exactly one");
  });

  it('異常: agent-output が 2 個なら、ちょうど 1 つ書くよう言う', () => {
    const nodes = [...(baseTemplate().nodes as unknown[]), { id: 'out2', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 1, maxBytes: 1024, overflow: 'error' } }];
    const problems = problemsOf(baseTemplate({ nodes, edges: [...(baseTemplate().edges as unknown[]), { from: 'limit', to: 'out2' }] }));
    expect(problems.join('\n')).toContain("2 'agent-output' node(s)");
  });

  it('異常: agent-input をテンプレートに書いたら、arguments から生成されることを言う', () => {
    const nodes = [...(baseTemplate().nodes as unknown[]), { id: 'my_args', type: 'agent-input', config: { schema: { columns: [] }, sample: {} } }];
    const problems = problemsOf(baseTemplate({ nodes }));
    expect(problems.join('\n')).toContain('generated from them');
  });

  it('異常: 予約された id `args` のノードは、名前を変えるよう言う', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) => (node.id === 'sort' ? { ...node, id: 'args' } : node));
    const edges = [{ from: 'src', to: 'args' }, { from: 'args', to: 'limit' }, { from: 'limit', to: 'out' }];
    const problems = problemsOf(baseTemplate({ nodes, edges }));
    expect(problems.join('\n')).toContain("node id 'args' is reserved");
  });

  it('異常: dataSource スロットの数と sources.max が合わなければ、どちらを直すか言う', () => {
    const problems = problemsOf(baseTemplate({ sources: { min: 1, max: 2 } }));
    expect(problems.join('\n')).toContain("declares 1 'dataSource' slot(s) but sources.max is 2");
  });

  it('異常: dataSource スロットを読むノードが無ければ、source ノードの書き方を示す', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) => (node.id === 'src' ? { id: 'src', type: 'json-source', config: { rows: [] } } : node));
    const problems = problemsOf(baseTemplate({ nodes }));
    expect(problems.join('\n')).toContain(`{ "dataSourceId": { "$slot": "source" } }`);
  });

  it('異常: 存在しないスロットを `{{ }}` で参照したら、宣言済みのスロット名を挙げる', () => {
    const problems = problemsOf(baseTemplate({ description: { ja: '{{missing}}', en: '{{missing}}' } }));
    expect(problems.join('\n')).toContain("refers to the slot 'missing'");
    expect(problems.join('\n')).toContain('source, value, limit');
  });

  it('異常: 宣言の無い引数を valueBinding で参照したら、宣言するか既存の引数を使うよう言う', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) =>
      node.id === 'limit' ? { id: 'limit', type: 'filter', config: { column: 'x', op: 'eq', value: 'a', valueBinding: { $argument: 'ghost' } } } : node);
    const problems = problemsOf(baseTemplate({ nodes }));
    expect(problems.join('\n')).toContain("binds the argument 'ghost'");
    expect(problems.join('\n')).toContain('add it to "arguments"');
  });

  it('異常: 宣言したのに一度も使われない引数は、束縛するか消すよう言う', () => {
    const problems = problemsOf(baseTemplate({
      arguments: [{ name: 'unused', type: 'string', nullable: true, description: { ja: 'a', en: 'a' }, sample: 'x' }],
    }));
    expect(problems.join('\n')).toContain(`argument 'unused' is declared but never used`);
  });

  it('異常: $intent を calculate の expression 以外に書いたら、正しい書き方を示す', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'intent', kind: 'intent', maxLength: 100, label: { ja: 'a', en: 'a' } }];
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) =>
      node.id === 'sort' ? { id: 'sort', type: 'sort', config: { keys: [{ column: { $intent: 'intent' }, direction: 'desc' }] } } : node);
    const problems = problemsOf(baseTemplate({ slots, nodes }));
    expect(problems.join('\n')).toContain("$intent only fills the \"expression\" of a 'calculate' node");
  });

  it('異常: $intent が calculate の別のキーにあれば、expression へ移すよう言う', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'intent', kind: 'intent', maxLength: 100, label: { ja: 'a', en: 'a' } }];
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) =>
      node.id === 'sort' ? { id: 'sort', type: 'calculate', config: { outputColumn: { $intent: 'intent' }, expression: '1' } } : node);
    const problems = problemsOf(baseTemplate({ slots, nodes }));
    expect(problems.join('\n')).toContain('write { "expression": { "$intent": "intent" } } instead');
  });

  it('異常: 未知の $profile 関数は、使える 4 つの書き方を示す', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) =>
      node.id === 'limit' ? { id: 'limit', type: 'limit', config: { count: 10, offset: { $profile: 'periodAverage:value' } } } : node);
    const problems = problemsOf(baseTemplate({ nodes }));
    expect(problems.join('\n')).toContain('firstValuesCsv:<slot>:<n>');
  });

  it('境界: firstValues の件数が 0 なら受け付けず、1〜100 の範囲を示す', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) =>
      node.id === 'limit' ? { id: 'limit', type: 'limit', config: { count: 10, offset: { $profile: 'firstValues:value:0' } } } : node);
    expect(problemsOf(baseTemplate({ nodes })).join('\n')).toContain('n between 1 and 100');
  });

  it('異常: when が付いたノードの入出力が 1 本ずつでなければ、橋渡しできない理由を言う', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'flag', kind: 'text', maxLength: 5, default: '', optional: true, label: { ja: 'a', en: 'a' } }];
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) => (node.id === 'src' ? { ...node, when: 'flag' } : node));
    const problems = problemsOf(baseTemplate({ slots, nodes }));
    expect(problems.join('\n')).toContain('0 incoming and 1 outgoing edge(s)');
    expect(problems.join('\n')).toContain('single-input, single-output');
  });

  it('異常: agent-output に when を付けたら、必ず何かを返す必要があると言う', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'flag', kind: 'text', maxLength: 5, default: '', optional: true, label: { ja: 'a', en: 'a' } }];
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) => (node.id === 'out' ? { ...node, when: 'flag' } : node));
    expect(problemsOf(baseTemplate({ slots, nodes })).join('\n')).toContain('the tool must always return something');
  });

  it('異常: 任意スロットの値を when 無しで参照したら、when を足すか必須にするよう言う', () => {
    const slots = (baseTemplate().slots as { name: string }[]).map((slot) => (slot.name === 'value' ? { ...slot, optional: true } : slot));
    const problems = problemsOf(baseTemplate({ slots }));
    expect(problems.join('\n')).toContain('add "when": "value"');
  });

  it('異常: choice に options と optionsFrom の両方（あるいはどちらも無い）なら、どちらか一方にするよう言う', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'g', kind: 'choice', label: { ja: 'a', en: 'a' } }];
    expect(problemsOf(baseTemplate({ slots })).join('\n')).toContain('must have either "options" or "optionsFrom"');
  });

  it('異常: optionsFrom が期間列でないスロットを指していたら、期間列スロットを指すよう言う', () => {
    const slots = [...(baseTemplate().slots as unknown[]), { name: 'g', kind: 'choice', optionsFrom: 'granularities:value', label: { ja: 'a', en: 'a' } }];
    expect(problemsOf(baseTemplate({ slots })).join('\n')).toContain('"role": "period"');
  });

  it('異常: column スロットの source が dataSource スロットでなければ、候補を挙げて直し方を言う', () => {
    const slots = (baseTemplate().slots as { name: string }[]).map((slot) => (slot.name === 'value' ? { ...slot, source: 'limit' } : slot));
    expect(problemsOf(baseTemplate({ slots })).join('\n')).toContain('which is not a \'dataSource\' slot');
  });

  it('境界: number スロットの既定が範囲外なら、範囲内の既定を選ぶよう言う', () => {
    const slots = (baseTemplate().slots as { name: string }[]).map((slot) => (slot.name === 'limit' ? { ...slot, default: 500 } : slot));
    expect(problemsOf(baseTemplate({ slots })).join('\n')).toContain('outside 1..100');
  });

  it('異常: ディレクティブを 2 つ同じオブジェクトに書いたら、1 つにするよう言う', () => {
    const nodes = (baseTemplate().nodes as { id: string }[]).map((node) =>
      node.id === 'limit' ? { id: 'limit', type: 'limit', config: { count: { $slot: 'limit', $number: 'limit' } } } : node);
    expect(problemsOf(baseTemplate({ nodes })).join('\n')).toContain('write one directive per object');
  });

  it('例外: テンプレートでない値（null / 配列 / 文字列）でも例外を投げずに問題として返す', () => {
    for (const value of [null, [], 'テンプレート', 42]) {
      const parsed = parseToolTemplate(value);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problems.length).toBeGreaterThan(0);
    }
  });

  it('正常: どの問題文も「どう直すか」を含む（この規律を全検査で保つ）', () => {
    const samples: unknown[] = [
      baseTemplate({ id: 'BAD' }),
      baseTemplate({ sources: { min: 1, max: 2 } }),
      baseTemplate({ description: { ja: '{{missing}}', en: '{{missing}}' } }),
      baseTemplate({ arguments: [{ name: 'unused', type: 'string', nullable: true, description: { ja: 'a', en: 'a' }, sample: 'x' }] }),
    ];
    for (const sample of samples) {
      expect(everyProblemSaysHowToFix(problemsOf(sample))).toBe(true);
    }
  });
});

describe('走査のヘルパー', () => {
  it('正常: interpolationNamesOf が文字列の中の `{{ }}` をすべて拾う', () => {
    expect(interpolationNamesOf('[{{a}}] / [{{b}}] * {{a}}')).toEqual(['a', 'b', 'a']);
    expect(interpolationNamesOf('{{ spaced }}')).toEqual(['spaced']);
  });

  it('境界: `{{}}` や `{{1bad}}` はスロット参照として拾わない', () => {
    expect(interpolationNamesOf('{{}} {{1bad}} {{_x}}')).toEqual([]);
  });

  it('正常: collectReferences が $each の中のループ変数を scope として持ち回る', () => {
    const references = collectReferences({ keys: { $each: 'joinKeys', as: 'k', item: { left: '{{k}}' } } }, 'config');
    expect(references.map((reference) => reference.name)).toEqual(['joinKeys', 'k']);
    expect(references[1]?.scope.has('k')).toBe(true);
  });

  it('正常: parseProfileExpression が 4 つの関数を読み分ける', () => {
    expect(parseProfileExpression('periodMin:p')).toEqual({ fn: 'periodMin', slot: 'p' });
    expect(parseProfileExpression('firstValues:c:3')).toEqual({ fn: 'firstValues', slot: 'c', count: 3 });
    expect(parseProfileExpression('firstValuesCsv:c:2')).toEqual({ fn: 'firstValuesCsv', slot: 'c', count: 2 });
  });

  it('異常: parseProfileExpression は形の違う文字列を undefined にする', () => {
    for (const text of ['periodMin', 'periodMin:p:1', 'firstValues:c', 'unknown:c:1', 'firstValues:c:x']) {
      expect(parseProfileExpression(text)).toBeUndefined();
    }
  });

  it('正常: whenSlotNames が not の入れ子まで辿る', () => {
    expect(whenSlotNames({ not: { slot: 'a', equals: 'x' } })).toEqual(['a']);
    expect(whenSlotNames('b')).toEqual(['b']);
    expect(whenSlotNames(undefined)).toEqual([]);
  });

  it('従来どおり: 語彙（スロットの種類・ディレクティブ）を固定する', () => {
    expect([...TOOL_TEMPLATE_SLOT_KINDS]).toEqual(['dataSource', 'column', 'joinKeys', 'choice', 'number', 'text', 'intent']);
    expect([...TOOL_TEMPLATE_DIRECTIVES]).toEqual(['$slot', '$each', '$intent', '$profile', '$argument', '$number', '$concat', '$sourceType']);
  });
});
