/**
 * テンプレート経路の 2 つのタスク（v43 §4）の単体テスト。
 *
 * 見るのは 3 点だけ:
 * 1. **材料が最小か**（プロファイル全体・サンプル行を渡していないか）。
 * 2. **選択肢が閉じているか**（スロットごとの enum・件数・範囲）。
 * 3. **スキーマで言えないことを `parse` が言うか**（候補外の列・依存する候補の違反を、
 *    そのままモデルへ差し戻せる文で返すか）。
 *
 * テンプレートは**同梱の実ファイル**を `FsToolTemplateCatalog` で読み、候補は実データの
 * プロファイルから作る（作り物のテンプレートで固めると、同梱テンプレートが壊れても気づけない）。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsToolTemplateCatalog } from '../../../adapters/templates/fs-tool-template-catalog';
import { InMemoryDataSourceRepository } from '../../../adapters/storage/in-memory-data-source-repository';
import { createDefaultRegistry } from '../../../domain/etl/nodes';
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../../domain/factory/factory-run';
import type { ToolTemplate } from '../../../domain/tool-template/template';
import { ResolveDataSourceGraphUseCase } from '../../data-source/resolve-data-source-graph';
import { EtlEngine } from '../../etl/engine';
import { templateContextOf } from '../../tool-template/template-context';
import { ProfileDataSourcesUseCase, type DataProfile } from '../profile-data-sources';
import { NO_TEMPLATE, fillSlotsTask, selectTemplateTask, type FillSlotsInput, type SelectTemplateInput } from './template-tasks';

const scope = { tenantId: 't', workspaceId: 'w' };
const goal: FactoryGoalInput = { goal: '地域別の売上の推移を答えられるようにしたい。', language: 'ja' };

/** 年次 × 2 地域。カテゴリ列の実在値が 8 件より多いことも見たいので地域を 9 件にする。 */
const REGION_CSV = [
  '時点,地域,売上',
  ...['北海道', '東京都', '大阪府', '福岡県', '愛知県', '京都府', '兵庫県', '宮城県', '広島県']
    .map((region, index) => [`2023年,${region},${100 + index}`, `2022年,${region},${90 + index}`].join('\n')),
].join('\n');

/** 同じ形（時点・地域コード・値）で結合できる 2 つの表。 */
function joinableCsv(values: readonly number[]): string {
  return [
    '時点,地域コード,値',
    `2023年,01000,${values[0]}`,
    `2023年,13000,${values[1]}`,
    `2022年,01000,${values[2]}`,
    `2022年,13000,${values[3]}`,
  ].join('\n');
}

const plan: FactoryToolPlan = {
  key: 'sales_series',
  displayName: '売上の推移',
  purpose: '地域別の売上を、指定した粒度・期間で新しい順に返す。',
  dataSourceId: 'ds-sales',
  sideEffect: 'read-only',
};

interface Harness {
  readonly profiles: DataProfile[];
}

async function setup(sources: readonly { readonly id: string; readonly csv: string }[]): Promise<Harness> {
  const dataSources = new InMemoryDataSourceRepository();
  for (const source of sources) {
    await dataSources.save(
      { id: source.id, tenant: scope, name: source.id, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: source.csv.length, createdAt: '', updatedAt: '' },
      source.csv,
    );
  }
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  return { profiles: await profiler.executeAll(scope, sources.map((source) => source.id)) };
}

let cached: Promise<readonly ToolTemplate[]> | undefined;

async function templateById(id: string): Promise<ToolTemplate> {
  cached ??= (async () => {
    const catalog = await new FsToolTemplateCatalog({ directories: [join(process.cwd(), 'templates', 'tools')], registry: createDefaultRegistry() }).list();
    expect(catalog.invalid).toEqual([]);
    return catalog.templates;
  })();
  const template = (await cached).find((candidate) => candidate.id === id);
  if (template === undefined) throw new Error(`templates/tools does not ship a template with id '${id}'`);
  return template;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** `period-series` を `ds-sales` に当てる `fill-slots` の入力。 */
async function salesInput(harness: Harness): Promise<FillSlotsInput> {
  const template = await templateById('period-series');
  return {
    template,
    context: templateContextOf({ dataSourceIds: ['ds-sales'] }, harness.profiles),
    profiles: harness.profiles,
    plan,
    goal,
    dataSources: { source: 'ds-sales' },
  };
}

// ---------------------------------------------------------------------------

describe('select-template タスク', () => {
  async function input(): Promise<SelectTemplateInput> {
    return { plan, goal, templates: [await templateById('period-series'), await templateById('period-change')] };
  }

  it('正常: 材料は候補の id・要約・使いどころだけで、ノードやスロットの中身は渡さない', async () => {
    const payload = selectTemplateTask.payload(await input()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['goal', 'language', 'purpose', 'templates']);
    const templates = payload['templates'] as Record<string, unknown>[];
    expect(templates.map((template) => Object.keys(template).sort())).toEqual([
      ['id', 'notFor', 'summary', 'whenToUse'],
      ['id', 'notFor', 'summary', 'whenToUse'],
    ]);
    // 要約・使いどころは目標の言語（ja）で渡す。
    expect(templates[0]?.['summary']).toContain('期間の範囲');
    expect(json(payload)).not.toContain('sampleRows');
    expect(json(payload)).not.toContain('nodes');
  });

  it('正常: スキーマの enum は候補の id と "none" だけ', async () => {
    const schema = selectTemplateTask.schema(await input());
    expect(schema.properties['templateId']?.enum).toEqual(['period-series', 'period-change', NO_TEMPLATE]);
    expect(schema.required).toEqual(['templateId', 'reason']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('正常: 選んだ id からテンプレートを解決して返す', async () => {
    const parsed = selectTemplateTask.parse(json({ templateId: 'period-change', reason: '前年比が要るから' }), await input());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.template?.id).toBe('period-change');
    expect(parsed.value.reason).toBe('前年比が要るから');
  });

  it('境界: "none" はテンプレート未選択として通す（失敗ではない）', async () => {
    const parsed = selectTemplateTask.parse(json({ templateId: NO_TEMPLATE, reason: 'どれも合わない' }), await input());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.template).toBeUndefined();
  });

  it('異常: 候補に無い id は選べる id を挙げて差し戻す', async () => {
    const parsed = selectTemplateTask.parse(json({ templateId: 'made-up', reason: 'なんとなく' }), await input());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toContain('period-series, period-change, none');
  });

  it('異常: 理由が空なら差し戻す（何を根拠に選んだか分からない選択は採らない）', async () => {
    const parsed = selectTemplateTask.parse(json({ templateId: 'period-series', reason: '   ' }), await input());
    expect(parsed.ok).toBe(false);
  });

  it('例外: JSON として読めない応答は「JSON だけ返せ」と差し戻す', async () => {
    const parsed = selectTemplateTask.parse('not json at all', await input());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toContain('not valid JSON');
  });
});

describe('fill-slots タスク', () => {
  it('正常: 材料はスロットと候補だけで、プロファイルのサンプル行や全列は渡さない', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const payload = fillSlotsTask.payload(await salesInput(harness)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['goal', 'language', 'purpose', 'slots', 'template']);
    expect(json(payload)).not.toContain('sampleRows');
    expect(json(payload)).not.toContain('joinCandidates');
  });

  it('正常: dataSource スロットは訊かない（どのソースを読むかは計画が決めている）', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const input = await salesInput(harness);
    const names = (fillSlotsTask.payload(input) as { slots: { name: string }[] }).slots.map((slot) => slot.name);
    expect(names).toEqual(['periodColumn', 'valueColumns', 'categoryColumn', 'defaultGranularity', 'limit']);
    expect(Object.keys(fillSlotsTask.schema(input).properties)).toEqual(names);

    const parsed = fillSlotsTask.parse(
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: '地域', defaultGranularity: 'year', limit: 20 }),
      input,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 割り当ては決定的（主ソースが先頭の dataSource スロットへ入る）。
    expect(parsed.value['source']).toBe('ds-sales');
  });

  it('正常: カテゴリ列の候補には実在値が 8 件まで付く（全値は渡さない）', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const payload = fillSlotsTask.payload(await salesInput(harness)) as { slots: Record<string, unknown>[] };
    const slot = payload.slots.find((entry) => entry['name'] === 'categoryColumn');
    const candidates = slot?.['candidates'] as { column: string; values: string[] }[];
    const region = candidates.find((candidate) => candidate.column === '地域');
    expect(region?.values).toHaveLength(8);
    expect(region?.values[0]).toBe('北海道');
    expect(slot?.['optional']).toBe(true);
  });

  it('正常: 期間列の候補には粒度ごとの件数と実測の範囲が付く', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const payload = fillSlotsTask.payload(await salesInput(harness)) as { slots: Record<string, unknown>[] };
    const slot = payload.slots.find((entry) => entry['name'] === 'periodColumn');
    const candidates = slot?.['candidates'] as { column: string; granularities: Record<string, number>; minStart?: string; maxStart?: string }[];
    const period = candidates.find((candidate) => candidate.column === '時点');
    expect(period?.granularities['year']).toBe(18);
    expect(period?.minStart).toBe('2022-01-01');
    expect(period?.maxStart).toBe('2023-01-01');
  });

  it('正常: 複数選ぶ列は enum の配列で、件数の下限・上限がスキーマに付く', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const schema = fillSlotsTask.schema(await salesInput(harness));
    const values = schema.properties['valueColumns'];
    expect(values?.type).toBe('array');
    expect(values?.items?.enum).toEqual(['売上']);
    expect([values?.minItems, values?.maxItems]).toEqual([1, 5]);
    // 数値スロットは min/max、選択肢スロットはデータに在る粒度だけ。
    expect([schema.properties['limit']?.type, schema.properties['limit']?.minimum, schema.properties['limit']?.maximum]).toEqual(['integer', 1, 100]);
    expect(schema.properties['defaultGranularity']?.enum).toEqual(['year']);
  });

  it('境界: 任意スロットは null も選べる（埋めない選択を構造で許す）', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const input = await salesInput(harness);
    expect(fillSlotsTask.schema(input).properties['categoryColumn']?.type).toEqual(['string', 'null']);

    const parsed = fillSlotsTask.parse(
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: null, defaultGranularity: 'year', limit: 20 }),
      input,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value['categoryColumn']).toBeUndefined();
  });

  it('境界: 既定のあるスロットを空で返しても、既定値が入った値になる', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const parsed = fillSlotsTask.parse(
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: null, defaultGranularity: 'year', limit: null }),
      await salesInput(harness),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value['limit']).toBe(36);
  });

  it('異常: 候補に無い列は「どれを選べばよいか」つきでそのまま差し戻す', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const parsed = fillSlotsTask.parse(
      json({ periodColumn: '時点', valueColumns: ['存在しない列'], categoryColumn: null, defaultGranularity: 'year', limit: 20 }),
      await salesInput(harness),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toContain("slot 'valueColumns' is set to '存在しない列'");
    expect(parsed.issues[0]).toContain('売上');
  });

  it('異常: 依存する候補（その期間列に無い粒度）も parse の時点で差し戻す', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const parsed = fillSlotsTask.parse(
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: null, defaultGranularity: 'month', limit: 20 }),
      await salesInput(harness),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toContain("slot 'defaultGranularity' is set to 'month'");
  });

  it('異常: 必須スロットを埋めないと、候補を挙げて差し戻す', async () => {
    const harness = await setup([{ id: 'ds-sales', csv: REGION_CSV }]);
    const parsed = fillSlotsTask.parse(
      json({ periodColumn: null, valueColumns: ['売上'], categoryColumn: null, defaultGranularity: 'year', limit: 20 }),
      await salesInput(harness),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(' ')).toContain("slot 'periodColumn'");
  });

  it('正常: 結合キーの候補には値の重なりと一意性が付く（2 ソースのテンプレート）', async () => {
    const harness = await setup([
      { id: 'ds-wage', csv: joinableCsv([300, 400, 280, 390]) },
      { id: 'ds-hours', csv: joinableCsv([150, 160, 140, 156]) },
    ]);
    const template = await templateById('ratio-of-two-sources');
    const input: FillSlotsInput = {
      template,
      context: templateContextOf({ dataSourceIds: ['ds-wage', 'ds-hours'] }, harness.profiles),
      profiles: harness.profiles,
      plan: { ...plan, dataSourceId: 'ds-wage', additionalDataSourceIds: ['ds-hours'] },
      goal,
      dataSources: { numeratorSource: 'ds-wage', denominatorSource: 'ds-hours' },
    };
    const payload = fillSlotsTask.payload(input) as { slots: Record<string, unknown>[] };
    const slot = payload.slots.find((entry) => entry['name'] === 'joinKeys');
    expect(slot?.['choose']).toEqual({ min: 1, max: 3 });
    expect((slot?.['candidates'] as { column: string; overlap?: number }[]).map((entry) => entry.column)).toEqual(['時点', '地域コード']);
    expect(slot?.['uniqueLeft']).toBe(true);
    expect(slot?.['uniqueRight']).toBe(true);

    const schema = fillSlotsTask.schema(input);
    expect([schema.properties['joinKeys']?.minItems, schema.properties['joinKeys']?.maxItems]).toEqual([1, 3]);
    // 自由記述スロットは長さの上限つきの文字列（列名を書かせる場所）。
    expect([schema.properties['ratioColumn']?.type, schema.properties['ratioColumn']?.maxLength]).toEqual(['string', 40]);
  });
});
