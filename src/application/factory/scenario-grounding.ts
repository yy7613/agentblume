/**
 * application層: 検証シナリオの「前提ブロック」を決定的に合成する（v44 実装契約 §3 / ADR-0050）。
 *
 * 純関数のみ（I/O・時刻・乱数なし）。Stage 0 のプロファイルから「アシスタントが何のデータを持っているか」を
 * 組み立て、Stage 5 で `Scenario.context` の後ろへ付ける。LLM には書かせない（ADR-0047 決定7と同じ判断:
 * 決定的に分かることを確率的な推論へ委ねると、揺れるか消える）。
 *
 * 実測（ADR-0050）: 擬似ユーザー（12B）は「10月の総支給額 320,000円・165時間で時間当たり給与を算出して」と
 * **自分で数値を作って渡し**、統計データしか持たないエージェントと噛み合わず max-turns で終わった。正しい回答を
 * 自作の試算と比べて誤りだと言い張った回もある。擬似ユーザーに渡っていたのは人物設定と目標の1行だけで、
 * 相手が何のデータを持つエージェントなのかを誰も教えていなかった。
 */
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import { CODE_LIKE_COLUMN, type CategoricalColumnProfile, type DataProfile, type PeriodColumnProfile } from './profile-data-sources';

/** 前提ブロックの見出し（合成済みかの判定にも使うので、1文字も変えない）。 */
export const SCENARIO_GROUNDING_HEADING = '# Validation premises / 検証の前提 (factory-managed)';

export interface ScenarioGroundingInput {
  readonly plan: FactoryPlan;
  readonly scenario: FactoryPlan['scenarios'][number];
  readonly profiles: readonly DataProfile[];
  readonly language: 'ja' | 'en';
}

/** 1ブロックに載せるデータソースの件数上限（超えた分は「ほか N 件のデータ」で数だけ伝える）。 */
const MAX_DATA_SOURCES = 3;
/** 期間列は先頭1列だけ（複数あっても、質問の範囲を決めるのは主たる時点列ひとつで足りる）。 */
const MAX_PERIOD_COLUMNS = 1;
/** カテゴリ列は先頭2列だけ（地域・産業のような「絞り込みに使う軸」を伝えるのが目的）。 */
const MAX_CATEGORICAL_COLUMNS = 2;

/**
 * カテゴリの例に出す値の最大長（空白を畳んだ後の文字数）。これを超える値を持つ列は自由記述とみなし、
 * コードらしい列と同じ段で飛ばす（§5b.3実測）: e-Stat の `注記` 列（「標本設計改正（1952年末～1953年初）の
 * 影響があり…」のような長文）が distinct 60 以下だったためカテゴリ列として前提ブロックへ載り、
 * 「絞り込みに使う軸」を伝えるという目的に無関係に長くしていた。
 */
const MAX_CATEGORICAL_VALUE_LENGTH = 30;

/** 擬似ユーザーの毎ターンの入力へ載る長さの上限（ADR-0050 結果・影響）。 */
const MAX_BLOCK_CHARS = 1800;

interface GroundingLimits {
  readonly valueColumns: number;
  readonly categoricalValues: number;
}

/**
 * 長すぎたときの作り直し（決定的・最大2回）。まず「カテゴリの値の例」、次に「値の列」の上限を半分にする:
 * 値の例は同じ形の文字列が並ぶだけで削っても意味が減りにくく、列名は何を聞けるかの手掛かりなので後に回す。
 */
const GROUNDING_ATTEMPTS: readonly GroundingLimits[] = [
  { valueColumns: 6, categoricalValues: 8 },
  { valueColumns: 6, categoricalValues: 4 },
  { valueColumns: 3, categoricalValues: 4 },
];

interface GroundingWords {
  readonly noOwnData: string;
  readonly dataListLead: string;
  readonly stayInRange: string;
  readonly trustValues: string;
  readonly goalAchievedOnAnswer: string;
  readonly rows: (count: number) => string;
  readonly valueColumnsLabel: string;
  readonly noNumericColumns: string;
  readonly periodLabel: (column: string) => string;
  /** 期間列の見出しと範囲の間（全角の「」で閉じる日本語は空白を足さない）。 */
  readonly periodAssign: string;
  readonly rangeSeparator: string;
  readonly granularities: (parts: readonly string[]) => string;
  readonly listSeparator: string;
  readonly moreColumns: (count: number) => string;
  readonly moreValues: (count: number) => string;
  readonly moreSources: (count: number) => string;
}

const WORDS: Readonly<Record<'ja' | 'en', GroundingWords>> = {
  ja: {
    noOwnData: 'あなたは自分のデータを持っていない。アシスタントが持つ下記のデータについて質問する。金額・件数などの数値を自分で作って渡したり、その数値での計算を頼んだりしない。',
    dataListLead: 'アシスタントが持つデータ:',
    stayInRange: '質問は上の期間とカテゴリの範囲内にする。データに無い指標（別の業種・別の統計・個別の会社や従業員）は尋ねない。目標が範囲外の質問を明示的に求めている場合だけ例外とする。',
    trustValues: 'アシスタントがデータの値を時点と単位つきで答えたら、その数値は正しいものとして扱う。自分で作った試算と比べて誤りだと主張しない。',
    goalAchievedOnAnswer: '目標に書かれた内容に、アシスタントがデータの値で答えたら、その時点で目標は達成である（goalAchieved と endConversation を true にする）。目標に無い追加の分析（要因の考察・示唆・別の比較・追加の計算）を求めて会話を延ばさない。',
    rows: (count) => `（${count} 行）`,
    valueColumnsLabel: '値の列',
    noNumericColumns: '（数値の列なし）',
    periodLabel: (column) => `期間の列「${column}」`,
    periodAssign: '= ',
    rangeSeparator: ' 〜 ',
    granularities: (parts) => `（${parts.join('・')}）`,
    listSeparator: '、',
    moreColumns: (count) => `ほか ${count} 列`,
    moreValues: (count) => `ほか ${count} 種類`,
    moreSources: (count) => `ほか ${count} 件のデータ`,
  },
  en: {
    noOwnData: 'You have no data of your own. Ask about the data the assistant holds, listed below. Never make up figures (amounts, counts) and hand them over, and never ask for a calculation on figures you supplied.',
    dataListLead: 'Data the assistant holds:',
    stayInRange: 'Keep your questions inside the periods and categories above. Do not ask for indicators that are not in the data (another industry, another statistic, an individual company or employee). The only exception is when your goal explicitly asks for something outside that range.',
    trustValues: 'When the assistant answers with a value from the data, with its period and unit, treat that number as correct. Do not claim it is wrong by comparing it with an estimate of your own.',
    goalAchievedOnAnswer: 'Once the assistant answers what the goal asks for with a value from the data, the goal is achieved at that point (set goalAchieved and endConversation to true). Do not extend the conversation by asking for analysis the goal does not call for (root-cause discussion, implications, another comparison, additional calculations).',
    rows: (count) => ` (${count} rows)`,
    valueColumnsLabel: 'value columns',
    noNumericColumns: '(no numeric columns)',
    periodLabel: (column) => `period column "${column}"`,
    periodAssign: ' = ',
    rangeSeparator: ' to ',
    granularities: (parts) => ` (${parts.join(', ')})`,
    listSeparator: ', ',
    moreColumns: (count) => `and ${count} more`,
    moreValues: (count) => `and ${count} more`,
    moreSources: (count) => `and ${count} more data sources`,
  },
};

/**
 * そのシナリオが対象にするデータソースのプロファイル（宣言順・重複なし）。
 *
 * `expectedToolKeys` が指す Tool の主データソースと結合先を集める。再利用Tool（`reuse` あり・
 * `dataSourceId` が空）は読むデータが分からないので数えない。1件も解決できなければ Run の全プロファイル
 * へ落とす: 前提が「無い」より「Runのデータ全部」の方が、擬似ユーザーの質問はデータへ寄る。
 */
export function groundingProfilesOf(input: Omit<ScenarioGroundingInput, 'language'>): readonly DataProfile[] {
  const toolsByKey = new Map(input.plan.tools.map((tool) => [tool.key, tool] as const));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const key of input.scenario.expectedToolKeys) {
    const tool = toolsByKey.get(key);
    if (tool === undefined) continue; // 未知のキーは計画側の欠落。ここでは黙って飛ばす（検証は validateFactoryPlan の仕事）。
    for (const id of [tool.dataSourceId, ...(tool.additionalDataSourceIds ?? [])]) {
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  const byId = new Map(input.profiles.map((profile) => [profile.dataSourceId, profile] as const));
  // プロファイルに無い id は黙って飛ばす（プロファイル失敗のソースを「行数0の表」として語らない）。
  const resolved = ids.map((id) => byId.get(id)).filter((profile): profile is DataProfile => profile !== undefined);
  return resolved.length > 0 ? resolved : input.profiles;
}

/** 前提ブロック。対象のプロファイルが1件も無ければ `undefined`（ブロックを付けない）。 */
export function describeScenarioGrounding(input: ScenarioGroundingInput): string | undefined {
  const profiles = groundingProfilesOf(input);
  if (profiles.length === 0) return undefined;
  const words = WORDS[input.language];
  let block = '';
  for (const limits of GROUNDING_ATTEMPTS) {
    block = renderBlock(profiles, words, limits);
    if (block.length <= MAX_BLOCK_CHARS) return block;
  }
  // 最小の上限でも超える（列名が極端に長い等）。切り詰めると文が壊れて前提が読めなくなるので、そのまま返す。
  return block;
}

/**
 * 計画の context（あれば）の後ろへ前提ブロックを連結する。どちらも無ければ `undefined`。
 * 既に見出しを含む context には二重に付けない（再開・再試行で同じ計画をもう一度通っても冪等）。
 */
export function composeScenarioContext(planned: string | undefined, grounding: string | undefined): string | undefined {
  const base = planned !== undefined && planned.trim() !== '' ? planned : undefined;
  if (grounding === undefined) return base;
  if (base === undefined) return grounding;
  if (base.includes(SCENARIO_GROUNDING_HEADING)) return base;
  return `${base.trimEnd()}\n\n${grounding}`;
}

function renderBlock(profiles: readonly DataProfile[], words: GroundingWords, limits: GroundingLimits): string {
  const shown = profiles.slice(0, MAX_DATA_SOURCES);
  const lines = [SCENARIO_GROUNDING_HEADING, `- ${words.noOwnData}`, `- ${words.dataListLead}`];
  for (const profile of shown) lines.push(`  - ${describeProfile(profile, words, limits)}`);
  if (profiles.length > shown.length) lines.push(`  - ${words.moreSources(profiles.length - shown.length)}`);
  lines.push(`- ${words.stayInRange}`, `- ${words.trustValues}`, `- ${words.goalAchievedOnAnswer}`);
  return lines.join('\n');
}

/** 1データソース1行。要素（値の列 / 期間 / カテゴリ）は ` / ` で連ね、materialが無い要素はまるごと省く。 */
function describeProfile(profile: DataProfile, words: GroundingWords, limits: GroundingLimits): string {
  const elements = [
    describeValueColumns(profile, words, limits),
    ...profile.periodColumns.slice(0, MAX_PERIOD_COLUMNS).map((period) => describePeriodColumn(period, words)),
    ...profile.categoricalColumns
      .filter((column) => !CODE_LIKE_COLUMN.test(column.column) && !isFreeTextColumn(column))
      .slice(0, MAX_CATEGORICAL_COLUMNS)
      .map((column) => describeCategoricalColumn(column, words, limits)),
  ];
  return `${sanitize(profile.name)}${words.rows(profile.rowCount)}: ${elements.join(' / ')}`;
}

/**
 * 値の列 = 数値列のうち期間列・カテゴリ列でないもの。1つも無い表も行ごと消さずに「（数値の列なし）」と書く:
 * 「そのデータでは数を尋ねられない」こと自体が、擬似ユーザーが知るべき前提である。
 */
function describeValueColumns(profile: DataProfile, words: GroundingWords, limits: GroundingLimits): string {
  const excluded = new Set([...profile.periodColumns.map((column) => column.column), ...profile.categoricalColumns.map((column) => column.column)]);
  const names = profile.columns.filter((column) => column.type === 'number' && !excluded.has(column.name)).map((column) => sanitize(column.name));
  if (names.length === 0) return `${words.valueColumnsLabel} = ${words.noNumericColumns}`;
  return `${words.valueColumnsLabel} = ${joinWithOverflow(names, limits.valueColumns, words.moreColumns, words.listSeparator)}`;
}

/** 期間の列「時点」= 2012-01-01 〜 2025-11-01（粒度別の件数を多い順）。開始日が読めていなければ範囲は書かない。 */
function describePeriodColumn(period: PeriodColumnProfile, words: GroundingWords): string {
  const label = words.periodLabel(sanitize(period.column));
  const range = period.minStart !== undefined && period.maxStart !== undefined
    ? `${words.periodAssign}${period.minStart.slice(0, 10)}${words.rangeSeparator}${period.maxStart.slice(0, 10)}`
    : '';
  // 件数の多い順（同数なら粒度の出現順のまま）。どの粒度が主なのかが分かれば、質問の粒度がデータへ寄る。
  const parts = Object.entries(period.granularities)
    .sort(([, left], [, right]) => right - left)
    .map(([granularity, count]) => `${granularity} ${count}`);
  return `${label}${range}${parts.length === 0 ? '' : words.granularities(parts)}`;
}

/**
 * 値の最大長（空白を畳んだ後）が `MAX_CATEGORICAL_VALUE_LENGTH` を超える列は自由記述とみなし、
 * カテゴリの例から飛ばす（§5b.3実測）。
 */
function isFreeTextColumn(column: CategoricalColumnProfile): boolean {
  return column.values.some((value) => sanitize(value).length > MAX_CATEGORICAL_VALUE_LENGTH);
}

/** 地域 = 全国、東京都、… （コードらしい列は呼び出し側で既に外してある）。 */
function describeCategoricalColumn(column: CategoricalColumnProfile, words: GroundingWords, limits: GroundingLimits): string {
  const values = column.values.map((value) => sanitize(value));
  // `detectCategoricalColumn` は列挙できた値だけを持つ（distinct が上限超なら列ごと落ちる）ので、
  // 「ほか N 種類」は実際に書ける値の件数から数える。distinctCount の方が大きければそちらを総数とする。
  const total = Math.max(column.distinctCount, values.length);
  const shown = values.slice(0, limits.categoricalValues);
  const parts = total > shown.length ? [...shown, words.moreValues(total - shown.length)] : shown;
  return `${sanitize(column.column)} = ${parts.join(words.listSeparator)}`;
}

function joinWithOverflow(items: readonly string[], limit: number, more: (count: number) => string, separator: string): string {
  const shown = items.slice(0, limit);
  const parts = items.length > shown.length ? [...shown, more(items.length - shown.length)] : shown;
  return parts.join(separator);
}

/**
 * 列名・値は利用者のデータ由来（既存の `context` と同じ扱いで、新しい信頼境界は作らない）。ただし
 * 1行1データソースの構造だけは守る: 改行・連続空白は空白1つへ畳み、見出し行を名乗る値からは `#` を外す
 * （ブロックの偽装を防ぐ。値は行頭には来ないが、見出しの文字列が本文に混ざると読む側が境目を見失う）。
 */
function sanitize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().replace(/#+\s*(?=Validation premises)/gu, '');
}
