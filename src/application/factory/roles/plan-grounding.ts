/**
 * application層: Agent Factory Stage 1 計画の接地検査（v44 実装契約 §4 / ADR-0050）。
 *
 * 決定的・LLM不使用。Plannerの構造化出力（`FactoryPlan`）のシナリオが、Stage 0のプロファイルが
 * 持つ期間の外の年を `goal` / `context` で名指ししていないかを検査する。データの期間はStage 0が
 * 既に全行から測っている（`profile-data-sources.ts`）ので、ここでも確率的な推論に頼らず決定的に
 * 照合する（ADR-0047 で通した判断と同じ）。
 *
 * 対象のデータソースを決める規則（v44 §3.2）は `scenario-grounding.ts`（Stage 5 の前提ブロック）と
 * 同じだが、実装は共有しない（ファイルの所有を分けるため）。規則が同じであることは
 * `plan-grounding.test.ts` で固定する。
 */
import type { FactoryPlan, FactoryScenarioPlan } from '../../../domain/factory/factory-plan';
import type { DataProfile } from '../profile-data-sources';

/**
 * 年の抽出パターン（v44 §4.1）。西暦4桁（19xx/20xx）を、年・年度・日付区切り・語境界の直前でだけ拾う。
 * 和暦や「過去5年」のような相対表現は対象にしない（決定的に見分けられないため）。
 */
const YEAR_PATTERN = /(?<!\d)(19|20)\d{2}(?=年度|年|\/|-|\b)/gu;

/** ハイフンでつながった数字の並び（日付・電話番号どちらも一旦ここで拾う）。 */
const DIGIT_RUN_PATTERN = /[\d-]+/gu;

/**
 * 「日付」とみなせる数字列の桁数の上限（`2015-01-01` = 8桁まで）。電話番号（`090-1234-5678` = 11桁）
 * のようなそれより長い数字列は、途中に西暦らしい4桁を含んでいても年とはみなさない。
 */
const MAX_DATE_LIKE_DIGIT_COUNT = 8;

/** 電話番号のような長い数字列を、年の抽出前に潰す（桁数だけを保った `#` へ置き換え、位置はずらさない）。 */
function maskLongDigitRuns(text: string): string {
  return text.replace(DIGIT_RUN_PATTERN, (run) => {
    const digitCount = (run.match(/\d/gu) ?? []).length;
    return digitCount > MAX_DATE_LIKE_DIGIT_COUNT ? run.replace(/\d/gu, '#') : run;
  });
}

/** 1つの文字列から西暦らしい4桁をすべて抜き出す（重複あり・出現順）。 */
function extractYears(text: string): readonly number[] {
  const masked = maskLongDigitRuns(text);
  return [...masked.matchAll(YEAR_PATTERN)].map((match) => Number(match[0]));
}

/**
 * そのシナリオが対象にするデータソースの id（宣言順 = `plan.tools` の並び順・重複なし）。v44 §3.2。
 * 再利用Tool（`reuse` あり、`dataSourceId` が空）は数えない。
 */
function targetDataSourceIds(plan: FactoryPlan, scenario: FactoryScenarioPlan): readonly string[] {
  const expected = new Set(scenario.expectedToolKeys);
  const ids: string[] = [];
  const push = (id: string): void => {
    if (id !== '' && !ids.includes(id)) ids.push(id);
  };
  for (const tool of plan.tools) {
    if (!expected.has(tool.key)) continue;
    if (tool.reuse !== undefined && tool.dataSourceId === '') continue;
    push(tool.dataSourceId);
    for (const additional of tool.additionalDataSourceIds ?? []) push(additional);
  }
  return ids;
}

/** そのシナリオが対象にするプロファイル。1件も解決できなければRunの全プロファイルへフォールバックする（v44 §3.2）。 */
function targetProfilesOf(plan: FactoryPlan, scenario: FactoryScenarioPlan, profiles: readonly DataProfile[]): readonly DataProfile[] {
  const ids = targetDataSourceIds(plan, scenario);
  const byId = new Map(profiles.map((profile) => [profile.dataSourceId, profile] as const));
  const resolved = ids.map((id) => byId.get(id)).filter((profile): profile is DataProfile => profile !== undefined);
  return resolved.length > 0 ? resolved : profiles;
}

/**
 * 対象プロファイルの全期間列から、範囲（`minStart` の最小年 〜 `maxStart` の最大年）を出す。
 * 期間列が1つも無ければ（どのプロファイルにも periodColumns が無い、または開始日が1件も無い）検査しない。
 */
function yearRangeOf(profiles: readonly DataProfile[]): { readonly minYear: number; readonly maxYear: number } | undefined {
  let minYear: number | undefined;
  let maxYear: number | undefined;
  for (const profile of profiles) {
    for (const column of profile.periodColumns) {
      if (column.minStart !== undefined) {
        const year = Number(column.minStart.slice(0, 4));
        if (minYear === undefined || year < minYear) minYear = year;
      }
      if (column.maxStart !== undefined) {
        const year = Number(column.maxStart.slice(0, 4));
        if (maxYear === undefined || year > maxYear) maxYear = year;
      }
    }
  }
  return minYear === undefined || maxYear === undefined ? undefined : { minYear, maxYear };
}

/**
 * データの期間外の年を名指しするシナリオを、直し方つきで列挙する（v44 §4.1）。無ければ空配列。
 *
 * 対象の文字列は `scenario.goal` と `scenario.context`。範囲は年度表記のずれを吸収するため、
 * 下限 −1 年までは許す（上限は許さない: 未来のデータは無いことが確実なため）。
 */
export function describeScenarioGroundingViolations(plan: FactoryPlan, profiles: readonly DataProfile[]): readonly string[] {
  const violations: string[] = [];
  plan.scenarios.forEach((scenario, index) => {
    const range = yearRangeOf(targetProfilesOf(plan, scenario, profiles));
    if (range === undefined) return;
    const years = new Set([...extractYears(scenario.goal), ...extractYears(scenario.context ?? '')]);
    const lowerBound = range.minYear - 1;
    for (const year of years) {
      if (year >= lowerBound && year <= range.maxYear) continue;
      violations.push(`scenarios.${index} ('${scenario.key}') mentions ${year}, but the data covers ${range.minYear}–${range.maxYear}; use a period inside the data or do not name a year`);
    }
  });
  return violations;
}
