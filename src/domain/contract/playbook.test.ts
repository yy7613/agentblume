import { describe, expect, it } from 'vitest';
import { ContractDomainError } from './errors';
import { createPlaybook, enabledTopics, expandRecommendedText, toPlaybookSummary, unknownPlaceholders, type Playbook, type PlaybookCriterion } from './playbook';
import { findPlaybookTemplate, playbookFromTemplate } from './playbook-templates';

const tenant = { tenantId: 't1', workspaceId: 'w1' };
const NOW = '2026-09-15T00:00:00.000Z';

/** 同梱テンプレート（業務委託・発注者側）を土台に、1 か所ずつ壊して検証を確かめる。 */
const base = (): Playbook => playbookFromTemplate(findPlaybookTemplate('outsourcing-client')!, { tenant, id: 'pb1', isDefault: true, now: NOW });

type Mutable = Record<string, unknown> & { topics: Record<string, unknown>[]; criteria: Record<string, unknown>[]; legal: Record<string, unknown>; stampDuty: Record<string, unknown> & { documentTypes: Record<string, unknown>[] }; extraction: Record<string, unknown> };
const mutate = (change: (props: Mutable) => void): unknown => {
  const props = structuredClone(base()) as unknown as Mutable;
  change(props);
  return props;
};
/** 型の上では書けない値（null や配列でない値）を入れるための逃げ道。 */
const loose = (props: Mutable): Record<string, unknown> => props;
const criterionFor =(props: Mutable, id: string) => props.criteria.find((criterion) => criterion['id'] === id)!;

function expectRejected(props: unknown, message: RegExp): void {
  let caught: unknown;
  try { createPlaybook(props as Playbook); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ContractDomainError);
  expect((caught as Error).message).toMatch(message);
}

describe('playbook: createPlaybook（正常・境界）', () => {
  it('正常: テンプレートからの審査基準はそのまま保存でき、再検証しても同じ', () => {
    const playbook = base();
    expect(createPlaybook(playbook)).toEqual(playbook);
  });

  it('境界: 空の推奨文案は持たない・禁止手段の重複を除く・余分なキーを落とす', () => {
    const playbook = createPlaybook(mutate((props) => {
      criterionFor(props, 'term-required')['recommendedText'] = '';
      criterionFor(props, 'term-required')['check'] = { type: 'required', extra: 1 };
      props.legal['prohibitedPaymentMethods'] = ['promissory_note', 'promissory_note', 'electronic_record'];
    }) as Playbook);
    const criterion = playbook.criteria.find((entry) => entry.id === 'term-required')!;
    expect(criterion).not.toHaveProperty('recommendedText');
    expect(criterion.check).toEqual({ type: 'required' });
    expect(playbook.legal.prohibitedPaymentMethods).toEqual(['promissory_note', 'electronic_record']);
  });

  it.each([1000, 20_000])('境界: chunkMaxChars %i は受け付ける', (chunkMaxChars) => {
    expect(createPlaybook(mutate((props) => { props.extraction['chunkMaxChars'] = chunkMaxChars; }) as Playbook).extraction.chunkMaxChars).toBe(chunkMaxChars);
  });

  it('境界: dueSoonDays 0・印紙税表の空配列・templateId なしも受け付ける', () => {
    const playbook = createPlaybook(mutate((props) => { props.legal['dueSoonDays'] = 0; props.stampDuty.documentTypes = []; delete props['templateId']; }) as Playbook);
    expect(playbook.legal.dueSoonDays).toBe(0);
    expect(playbook.stampDuty.documentTypes).toEqual([]);
    expect(playbook).not.toHaveProperty('templateId');
  });

  it('境界: トピック 50 件・基準 200 件まで', () => {
    const topics = Array.from({ length: 50 }, (_, index) => ({ id: `t${index}`, label: `T${index}`, valueKind: 'text', keywords: [], guidance: '', enabled: true, sortOrder: index }));
    const criteria = Array.from({ length: 200 }, (_, index) => ({ id: `c${index}`, topicId: 't0', check: { type: 'required' }, onFail: 'negotiate', rationale: '', enabled: true, sortOrder: index }));
    const playbook = createPlaybook(mutate((props) => { props.topics = topics; props.criteria = criteria; }) as Playbook);
    expect([playbook.topics.length, playbook.criteria.length]).toEqual([50, 200]);
  });
});

describe('playbook: createPlaybook（異常: 保存時の検証で 400）', () => {
  const tooManyTopics = Array.from({ length: 51 }, (_, index) => ({ id: `t${index}`, label: 'x', valueKind: 'text', keywords: [], guidance: '', enabled: true, sortOrder: 0 }));
  const cases: readonly [string, unknown, RegExp][] = [
    ['props が null', null, /props must be an object/u],
    ['tenant なし', mutate((props) => { delete props['tenant']; }), /tenant is required/u],
    ['tenantId が空', mutate((props) => { props['tenant'] = { tenantId: '', workspaceId: 'w' }; }), /tenant\.tenantId must be a non-empty string/u],
    ['ourRole が語彙外', mutate((props) => { props['ourRole'] = 'owner'; }), /ourRole must be client, vendor or mutual/u],
    ['トピック 0 件', mutate((props) => { props.topics = []; }), /topics must have 1 to 50/u],
    ['トピック 51 件', mutate((props) => { props.topics = tooManyTopics; }), /topics must have 1 to 50/u],
    ['基準が配列でない', mutate((props) => { loose(props)['criteria'] = {}; }), /criteria must be an array of at most 200/u],
    ['基準 201 件', mutate((props) => { props.criteria = Array.from({ length: 201 }, () => props.criteria[0]!); }), /criteria must be an array of at most 200/u],
    ['トピック id が大文字', mutate((props) => { props.topics[0]!['id'] = 'Term'; }), /topics\[0\]\.id must be lower-case/u],
    ['valueKind が未対応', mutate((props) => { props.topics[0]!['valueKind'] = 'date'; }), /topics\[0\]\.valueKind is not supported: date/u],
    ['ラベルが空', mutate((props) => { props.topics[0]!['label'] = ' '; }), /topics\[0\]\.label must be a non-empty string/u],
    ['ラベルが 101 文字', mutate((props) => { props.topics[0]!['label'] = 'x'.repeat(101); }), /topics\[0\]\.label must be at most 100 characters/u],
    ['キーワード 31 件', mutate((props) => { props.topics[0]!['keywords'] = Array.from({ length: 31 }, () => 'x'); }), /keywords must be an array of at most 30/u],
    ['キーワードが空文字', mutate((props) => { props.topics[0]!['keywords'] = ['']; }), /keywords\[0\] must be a non-empty string/u],
    ['guidance が 1001 文字', mutate((props) => { props.topics[0]!['guidance'] = 'x'.repeat(1001); }), /guidance must be a string of at most 1000/u],
    ['enabled が文字列', mutate((props) => { props.topics[0]!['enabled'] = 'yes'; }), /topics\[0\]\.enabled must be a boolean/u],
    ['sortOrder が小数', mutate((props) => { props.topics[0]!['sortOrder'] = 1.5; }), /sortOrder must be an integer/u],
    ['トピック id の重複', mutate((props) => { props.topics[1]!['id'] = 'term'; }), /topic id "term" is used twice/u],
    ['基準 id の重複', mutate((props) => { props.criteria[1]!['id'] = 'term-required'; }), /criterion id "term-required" is used twice/u],
    ['基準 id が空', mutate((props) => { props.criteria[0]!['id'] = ''; }), /criteria\[0\]\.id must be a non-empty string/u],
    ['未知の topicId', mutate((props) => { props.criteria[0]!['topicId'] = 'nope'; }), /criteria\[0\]\.topicId "nope" does not match any clause type/u],
    ['appliesToRoles が空', mutate((props) => { props.criteria[0]!['appliesToRoles'] = []; }), /appliesToRoles must list/u],
    ['appliesToRoles が語彙外', mutate((props) => { props.criteria[0]!['appliesToRoles'] = ['owner']; }), /appliesToRoles must list/u],
    ['onFail が語彙外', mutate((props) => { props.criteria[0]!['onFail'] = 'warn'; }), /onFail must be negotiate or reject/u],
    ['未知の置換子', mutate((props) => { props.criteria[0]!['recommendedText'] = '{us}は{company}と{ counterparty }'; }), /unknown placeholders: \{company\}, \{ counterparty \}/u],
    ['推奨文案が 2001 文字', mutate((props) => { props.criteria[0]!['recommendedText'] = 'x'.repeat(2001); }), /recommendedText must be at most 2000/u],
    ['rationale が文字列でない', mutate((props) => { props.criteria[0]!['rationale'] = 1; }), /rationale must be a string/u],
    ['check の種類が未知', mutate((props) => { props.criteria[0]!['check'] = { type: 'regex' }; }), /check\.type must be required, condition, legal or llm/u],
    ['check が無い', mutate((props) => { delete props.criteria[0]!['check']; }), /check\.type must be/u],
    ['condition が 0 件', mutate((props) => { criterionFor(props, 'renewal-months')['check'] = { type: 'condition', conditions: [] }; }), /conditions must have 1 to 10/u],
    ['condition が 11 件', mutate((props) => { criterionFor(props, 'renewal-months')['check'] = { type: 'condition', conditions: Array.from({ length: 11 }, () => ({ field: 'present', op: 'isTrue' })) }; }), /conditions must have 1 to 10/u],
    ['valueKind に無いパス', mutate((props) => { criterionFor(props, 'renewal-months')['check'] = { type: 'condition', conditions: [{ field: 'term.months', op: 'lte', value: 12 }] }; }), /field "term\.months" is not a field of the clause type "auto_renewal" \(auto_renewal\)/u],
    ['未対応の演算子', mutate((props) => { criterionFor(props, 'renewal-months')['check'] = { type: 'condition', conditions: [{ field: 'renewal.months', op: 'startsWith', value: 1 }] }; }), /op is not supported: startsWith/u],
    ['演算子と値の形が合わない', mutate((props) => { criterionFor(props, 'renewal-months')['check'] = { type: 'condition', conditions: [{ field: 'renewal.months', op: 'lte', value: '12' }] }; }), /lte needs a number/u],
    ['legal の rule が未知', mutate((props) => { criterionFor(props, 'payment-max-days')['check'] = { type: 'legal', rule: 'late-fee' }; }), /rule is not supported: late-fee/u],
    ['legal は payment_terms だけ', mutate((props) => { criterionFor(props, 'term-required')['check'] = { type: 'legal', rule: 'payment-max-days' }; }), /legal checks need a clause type of payment_terms \(topic "term" is term\)/u],
    ['llm の passWhen が語彙外', mutate((props) => { criterionFor(props, 'liability-cap')['check'] = { type: 'llm', question: 'q', passWhen: 'maybe' }; }), /passWhen must be yes or no/u],
    ['llm の質問が空', mutate((props) => { criterionFor(props, 'liability-cap')['check'] = { type: 'llm', question: '', passWhen: 'yes' }; }), /question must be a non-empty string/u],
    ['legal が null', mutate((props) => { loose(props)['legal'] = null; }), /legal must be an object/u],
    ['禁止手段が語彙外', mutate((props) => { props.legal['prohibitedPaymentMethods'] = ['check']; }), /legal\.prohibitedPaymentMethods must list/u],
    ['出典が配列でない', mutate((props) => { props.legal['sources'] = 'x'; }), /legal\.sources must be an array of at most 20/u],
    ['出典 21 件', mutate((props) => { props.legal['sources'] = Array.from({ length: 21 }, () => ({ label: 'a', url: 'https://a' })); }), /legal\.sources must be an array of at most 20/u],
    ['出典 URL が http(s) でない', mutate((props) => { props.legal['sources'] = [{ label: 'a', url: 'ftp://example.com' }]; }), /legal\.sources\[0\]\.url must be an http\(s\) URL/u],
    ['出典 URL が空', mutate((props) => { props.legal['sources'] = [{ label: 'a', url: '' }]; }), /legal\.sources\[0\]\.url must be a non-empty string/u],
    ['出典ラベルが空', mutate((props) => { props.legal['sources'] = [{ label: '', url: 'https://a' }]; }), /legal\.sources\[0\]\.label must be a non-empty string/u],
    ['支払日数 0', mutate((props) => { props.legal['paymentMaxDays'] = 0; }), /legal\.paymentMaxDays must be an integer between 1 and 365/u],
    ['支払日数 366', mutate((props) => { props.legal['paymentMaxDays'] = 366; }), /legal\.paymentMaxDays must be an integer between 1 and 365/u],
    ['フリーランス日数 0', mutate((props) => { props.legal['freelancePaymentMaxDays'] = 0; }), /legal\.freelancePaymentMaxDays/u],
    ['再委託日数 0', mutate((props) => { props.legal['freelanceRedelegationMaxDays'] = 0; }), /legal\.freelanceRedelegationMaxDays/u],
    ['月締めの許容が文字列', mutate((props) => { props.legal['allowMonthEndNextMonthEnd'] = 'yes'; }), /legal\.allowMonthEndNextMonthEnd must be a boolean/u],
    ['dueSoonDays -1', mutate((props) => { props.legal['dueSoonDays'] = -1; }), /legal\.dueSoonDays must be an integer between 0 and 365/u],
    ['印紙税表が null', mutate((props) => { loose(props)['stampDuty'] = null; }), /stampDuty\.documentTypes must be an array of at most 30/u],
    ['印紙税表 31 件', mutate((props) => { props.stampDuty.documentTypes = Array.from({ length: 31 }, () => props.stampDuty.documentTypes[1]!); }), /at most 30 document types/u],
    ['印紙税の enabled が文字列', mutate((props) => { props.stampDuty['enabled'] = 'yes'; }), /stampDuty\.enabled must be a boolean/u],
    ['印紙税 code が空', mutate((props) => { props.stampDuty.documentTypes[0]!['code'] = ''; }), /documentTypes\[0\]\.code must be a non-empty string/u],
    ['印紙税 code の重複', mutate((props) => { props.stampDuty.documentTypes[1]!['code'] = 'no2'; }), /documentTypes\[1\]\.code "no2" is used twice/u],
    ['性質が空', mutate((props) => { props.stampDuty.documentTypes[0]!['natures'] = []; }), /natures must list contract natures/u],
    ['性質が語彙外', mutate((props) => { props.stampDuty.documentTypes[0]!['natures'] = ['lease']; }), /natures must list contract natures/u],
    ['階層の upTo が負', mutate((props) => { props.stampDuty.documentTypes[0]!['tiers'] = [{ upTo: -1, amount: 0 }]; }), /tiers\[0\]\.upTo must be an integer/u],
    ['階層の税額が負', mutate((props) => { props.stampDuty.documentTypes[0]!['tiers'] = [{ upTo: null, amount: -1 }]; }), /tiers\[0\]\.amount must be an integer/u],
    ['上限なしの階層が途中', mutate((props) => { props.stampDuty.documentTypes[0]!['tiers'] = [{ upTo: null, amount: 1 }, { upTo: 10, amount: 2 }]; }), /only the last tier may have no upper bound/u],
    ['定額も階層も無い', mutate((props) => { delete props.stampDuty.documentTypes[0]!['tiers']; }), /documentTypes\[0\] needs either fixedAmount or tiers/u],
    ['階層が空で定額も無い', mutate((props) => { props.stampDuty.documentTypes[0]!['tiers'] = []; }), /needs either fixedAmount or tiers/u],
    ['除外月数 0', mutate((props) => { props.stampDuty.documentTypes[1]!['condition'] = { excludeTermMonthsAtMost: 0 }; }), /condition\.excludeTermMonthsAtMost must be an integer/u],
    ['unlessRenewal が文字列', mutate((props) => { props.stampDuty.documentTypes[1]!['condition'] = { unlessRenewal: 'yes' }; }), /condition\.unlessRenewal must be a boolean/u],
    ['定額が負', mutate((props) => { props.stampDuty.documentTypes[1]!['fixedAmount'] = -1; }), /fixedAmount must be an integer/u],
    ['記載なしの税額が負', mutate((props) => { props.stampDuty.documentTypes[0]!['noAmountStated'] = -1; }), /noAmountStated must be an integer/u],
    ['印紙税の名前が空', mutate((props) => { props.stampDuty.documentTypes[0]!['name'] = ''; }), /documentTypes\[0\]\.name must be a non-empty string/u],
    ['出典 URL が 501 文字', mutate((props) => { props.stampDuty.documentTypes[0]!['sourceUrl'] = 'x'.repeat(501); }), /sourceUrl must be a string/u],
    ['注記が 501 文字', mutate((props) => { props.stampDuty.documentTypes[0]!['note'] = 'x'.repeat(501); }), /note must be a string of at most 500/u],
    ['extraction が null', mutate((props) => { loose(props)['extraction'] = null; }), /extraction must be an object/u],
    ['chunkMaxChars 999', mutate((props) => { props.extraction['chunkMaxChars'] = 999; }), /extraction\.chunkMaxChars must be an integer between 1000 and 20000/u],
    ['chunkMaxChars 20001', mutate((props) => { props.extraction['chunkMaxChars'] = 20_001; }), /extraction\.chunkMaxChars must be an integer between 1000 and 20000/u],
    ['scanAllArticles が文字列', mutate((props) => { props.extraction['scanAllArticles'] = 'no'; }), /extraction\.scanAllArticles must be a boolean/u],
    ['id が空', mutate((props) => { props['id'] = ''; }), /createPlaybook: id must be a non-empty string/u],
    ['名前が空', mutate((props) => { props['name'] = ''; }), /createPlaybook: name must be a non-empty string/u],
    ['isDefault が文字列', mutate((props) => { props['isDefault'] = 'yes'; }), /isDefault must be a boolean/u],
    ['自社名が空文字', mutate((props) => { props['ourCompanyNames'] = ['']; }), /ourCompanyNames\[0\] must be a non-empty string/u],
    ['templateId が空', mutate((props) => { props['templateId'] = ''; }), /templateId must be a non-empty string/u],
    ['createdAt が空', mutate((props) => { props['createdAt'] = ''; }), /createdAt must be a non-empty string/u],
  ];

  it.each(cases)('異常: %s', (_label, props, message) => {
    expectRejected(props, message);
  });
});

describe('playbook: 置換子', () => {
  it.each([
    ['{us}と{counterparty}と{paymentMaxDays}と{articleRef}', []],
    ['{us}と{foo}と{}', ['foo', '']],
    ['置換子なし', []],
  ])('正常/異常: unknownPlaceholders(%s) = %o', (text, expected) => {
    expect(unknownPlaceholders(text)).toEqual(expected);
  });

  it('正常: expandRecommendedText は既知の置換子だけを（複数回でも）展開する', () => {
    const values = { counterparty: '株式会社テスト', us: '株式会社サンプル', paymentMaxDays: '60', articleRef: '第5条' };
    expect(expandRecommendedText('{us}は{counterparty}へ{paymentMaxDays}日以内に払う（{articleRef}）。{us}{unknown}', values)).toBe('株式会社サンプルは株式会社テストへ60日以内に払う（第5条）。株式会社サンプル{unknown}');
  });
});

describe('playbook: toPlaybookSummary / enabledTopics', () => {
  it('正常: 要約は件数と templateId を持つ（無ければ省く）', () => {
    const playbook = base();
    expect(toPlaybookSummary(playbook)).toEqual({ id: 'pb1', name: '業務委託（発注者側）', isDefault: true, ourRole: 'client', topicCount: 8, criterionCount: 9, templateId: 'outsourcing-client', updatedAt: NOW });
    const { templateId: _omit, ...withoutTemplate } = playbook;
    expect(toPlaybookSummary(withoutTemplate)).not.toHaveProperty('templateId');
  });

  it('正常: 有効なトピックを sortOrder 順に返す', () => {
    const topics = base().topics.map((topic, index) => ({ ...topic, sortOrder: -index, enabled: topic.id !== 'payment' }));
    expect(enabledTopics({ topics }).map((topic) => topic.id)).toEqual(['jurisdiction', 'ip_ownership', 'subcontracting', 'liability_cap', 'renewal_notice', 'auto_renewal', 'term']);
  });

  it('正常: 検証済みの基準は入力と別のオブジェクト（呼び出し側の変更が漏れない）', () => {
    const input = base();
    const criteria = input.criteria as PlaybookCriterion[];
    const created = createPlaybook(input);
    expect(created.criteria[0]).not.toBe(criteria[0]);
  });
});
