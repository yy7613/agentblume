import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_MAX_CHARS, DEFAULT_LEGAL_SETTINGS, DEFAULT_STAMP_DUTY, DEFAULT_TEMPLATE_ID, ELECTRONIC_CONTRACT_SOURCE_URL, findPlaybookTemplate, PLAYBOOK_TEMPLATES, playbookFromTemplate } from './playbook-templates';

const tenant = { tenantId: 't1', workspaceId: 'w1' };
const NOW = '2026-09-15T00:00:00.000Z';

describe('playbook-templates: 同梱テンプレート', () => {
  it.each(PLAYBOOK_TEMPLATES.map((template) => [template.id, template] as const))('正常: %s は createPlaybook の検証を通る', (_id, template) => {
    const playbook = playbookFromTemplate(template, { tenant, id: 'pb', isDefault: false, now: NOW });
    expect(playbook).toMatchObject({ name: template.name, ourRole: template.ourRole, templateId: template.id, ourCompanyNames: [], createdAt: NOW, updatedAt: NOW, extraction: { scanAllArticles: false, chunkMaxChars: DEFAULT_CHUNK_MAX_CHARS } });
    expect(playbook.topics).toHaveLength(template.topics.length);
    expect(playbook.criteria).toHaveLength(template.criteria.length);
    // テンプレートの定数を利用者の編集が汚さない（写しを渡している）。
    expect(playbook.topics).not.toBe(template.topics);
    expect(playbook.legal).not.toBe(DEFAULT_LEGAL_SETTINGS);
  });

  it('正常: 名前と自社名は上書きできる', () => {
    const playbook = playbookFromTemplate(findPlaybookTemplate('nda-mutual')!, { tenant, id: 'pb', name: 'NDA（当社版）', isDefault: true, now: NOW, ourCompanyNames: ['サンプル商事'] });
    expect([playbook.name, playbook.ourCompanyNames, playbook.isDefault]).toEqual(['NDA（当社版）', ['サンプル商事'], true]);
  });

  it('正常: 業務委託（発注者側）は §2.2 の 8 トピックと §4.7 の基準', () => {
    const template = findPlaybookTemplate(DEFAULT_TEMPLATE_ID)!;
    expect(template.id).toBe('outsourcing-client');
    expect(template.ourRole).toBe('client');
    expect(template.topics.map((topic) => [topic.id, topic.valueKind])).toEqual([
      ['term', 'term'], ['auto_renewal', 'auto_renewal'], ['renewal_notice', 'notice'], ['payment', 'payment_terms'],
      ['liability_cap', 'liability_cap'], ['subcontracting', 'permission'], ['ip_ownership', 'ip_ownership'], ['jurisdiction', 'jurisdiction'],
    ]);
    expect(template.criteria.map((criterion) => [criterion.id, criterion.check, criterion.onFail])).toEqual([
      ['term-required', { type: 'required' }, 'reject'],
      ['renewal-months', { type: 'condition', conditions: [{ field: 'renewal.months', op: 'lte', value: 12 }] }, 'negotiate'],
      ['notice-days', { type: 'condition', conditions: [{ field: 'notice.days', op: 'lte', value: 90 }] }, 'negotiate'],
      ['payment-max-days', { type: 'legal', rule: 'payment-max-days' }, 'reject'],
      ['payment-method', { type: 'legal', rule: 'prohibited-payment-method' }, 'reject'],
      ['liability-cap', { type: 'llm', question: expect.stringContaining('委託料相当額以下') as string, passWhen: 'no' }, 'negotiate'],
      ['subcontract-consent', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'in', value: ['prior_consent', 'prohibited'] }] }, 'negotiate'],
      ['ip-ours', { type: 'condition', conditions: [{ field: 'ip.owner', op: 'equals', value: 'us' }] }, 'negotiate'],
      ['court-exclusive', { type: 'condition', conditions: [{ field: 'jurisdiction.exclusive', op: 'isTrue' }] }, 'negotiate'],
    ]);
    expect(template.criteria.find((criterion) => criterion.id === 'subcontract-consent')?.recommendedText).toBe('乙は、事前に甲の書面による承諾を得た場合に限り、本業務の全部又は一部を第三者に委託することができる。');
  });

  it('正常: 秘密保持契約（双方向）は 6 トピックと §4.7 の基準', () => {
    const template = findPlaybookTemplate('nda-mutual')!;
    expect(template.ourRole).toBe('mutual');
    expect(template.topics.map((topic) => [topic.id, topic.valueKind])).toEqual([
      ['term', 'term'], ['definition', 'text'], ['purpose_limit', 'text'], ['return_destroy', 'text'], ['survival', 'term'], ['jurisdiction', 'jurisdiction'],
    ]);
    expect(template.criteria.map((criterion) => [criterion.id, criterion.check.type, criterion.onFail])).toEqual([
      ['definition-oral', 'llm', 'negotiate'], ['return-required', 'required', 'negotiate'], ['survival-months', 'condition', 'negotiate'], ['court-exclusive', 'condition', 'negotiate'],
    ]);
    expect(template.criteria.find((criterion) => criterion.id === 'survival-months')?.check).toEqual({ type: 'condition', conditions: [{ field: 'term.months', op: 'lte', value: 60 }] });
  });

  it('異常: 未知のテンプレート id は undefined', () => {
    expect(findPlaybookTemplate('vendor')).toBeUndefined();
  });
});

describe('playbook-templates: 法令設定と印紙税表の初期値', () => {
  it('正常: 法令設定の初期値（docs/23 §2.1）と出典はすべて https', () => {
    const { sources, ...values } = DEFAULT_LEGAL_SETTINGS;
    expect(values).toEqual({ paymentMaxDays: 60, freelancePaymentMaxDays: 60, freelanceRedelegationMaxDays: 30, prohibitedPaymentMethods: ['promissory_note'], allowMonthEndNextMonthEnd: true, dueSoonDays: 60 });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.url.startsWith('https://'))).toBe(true);
    expect(ELECTRONIC_CONTRACT_SOURCE_URL).toMatch(/^https:\/\/www\.nta\.go\.jp\//u);
  });

  it('正常: 第 2 号文書の税額表（docs/23 §4.4）', () => {
    const no2 = DEFAULT_STAMP_DUTY.documentTypes.find((type) => type.code === 'no2')!;
    expect(DEFAULT_STAMP_DUTY.enabled).toBe(true);
    expect(no2.natures).toEqual(['ukeoi']);
    expect(no2.noAmountStated).toBe(200);
    expect(no2.tiers).toEqual([
      { upTo: 9_999, amount: 0 }, { upTo: 1_000_000, amount: 200 }, { upTo: 2_000_000, amount: 400 }, { upTo: 3_000_000, amount: 1_000 },
      { upTo: 5_000_000, amount: 2_000 }, { upTo: 10_000_000, amount: 10_000 }, { upTo: 50_000_000, amount: 20_000 }, { upTo: 100_000_000, amount: 60_000 },
      { upTo: 500_000_000, amount: 100_000 }, { upTo: 1_000_000_000, amount: 200_000 }, { upTo: 5_000_000_000, amount: 400_000 }, { upTo: null, amount: 600_000 },
    ]);
  });

  it('正常: 第 7 号文書は 4,000 円・3 か月以内かつ更新なしを除く', () => {
    expect(DEFAULT_STAMP_DUTY.documentTypes.find((type) => type.code === 'no7')).toMatchObject({
      natures: ['basic_transaction', 'ukeoi', 'jun_inin'], fixedAmount: 4_000, condition: { excludeTermMonthsAtMost: 3, unlessRenewal: true },
    });
  });
});
