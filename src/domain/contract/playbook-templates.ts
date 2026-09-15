/**
 * ドメイン: 同梱の審査基準テンプレート（docs/23 §4.7）。**ここ以外に条項名・基準文言をハードコードしない。**
 *
 * テンプレートは初期値に過ぎず、利用者は画面で自由に編集する（トピック・基準・推奨文案・日数・税額表）。
 * 法令の日数と印紙税の税額表は 2026-09-14 に次の公表物で確かめた値で、改正で古くなるので画面に出典を出す:
 * - 取適法（令和 8 年 1 月 1 日施行）の支払期日 60 日・手形払の禁止: 公正取引委員会の特設ページとテキスト
 * - フリーランス法の支払期日 60 日・再委託 30 日: 公正取引委員会の Q&A（Q44〜Q57）
 * - 月単位の締切制度（受領後 2 か月以内として運用）: 取適法テキスト p.62 / フリーランス法 Q&A Q48
 * - 印紙税 第 2 号文書の税額表（本則）: 国税庁タックスアンサー No.7102、建設工事の軽減措置（令和 9 年 3 月 31 日まで）: No.7108
 * - 第 7 号文書 4,000 円（契約期間 3 か月以内かつ更新の定めのないものを除く）: No.7104
 * - 電磁的記録は課税文書に当たらない: 国税庁 質疑応答事例（印紙税 02/10）
 *
 * 受注者側（vendor）のテンプレートは MVP では同梱しない（発注者側を複製して基準を反転する手順を画面に書く）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { LegalSettings } from './legal-checks';
import { createPlaybook, type ClauseTopic, type Playbook, type PlaybookCriterion } from './playbook';
import type { StampDutySettings } from './stamp-duty';
import type { OurRole } from './vocabulary';

export const DEFAULT_LEGAL_SETTINGS: LegalSettings = {
  paymentMaxDays: 60,
  freelancePaymentMaxDays: 60,
  freelanceRedelegationMaxDays: 30,
  prohibitedPaymentMethods: ['promissory_note'],
  allowMonthEndNextMonthEnd: true,
  dueSoonDays: 60,
  sources: [
    { label: '公正取引委員会: 取適法（中小受託取引適正化法）特設ページ', url: 'https://www.jftc.go.jp/toriteki_2025/' },
    { label: '公正取引委員会・中小企業庁: 取適法テキスト（支払期日 60 日・月単位の締切制度）', url: 'https://www.jftc.go.jp/toriteki/r7text.pdf' },
    { label: '公正取引委員会: 取適法の運用基準', url: 'https://www.jftc.go.jp/toriteki/legislation/unyou.html' },
    { label: '公正取引委員会: フリーランス法 Q&A（支払期日 60 日・再委託 30 日）', url: 'https://www.jftc.go.jp/fllaw_limited/fllaw_qa.html' },
    { label: 'e-Gov 法令検索: 民法（第 140 条〜第 143 条 期間の計算）', url: 'https://laws.e-gov.go.jp/law/129AC0000000089' },
  ],
};

export const DEFAULT_STAMP_DUTY: StampDutySettings = {
  enabled: true,
  documentTypes: [
    {
      code: 'no2',
      name: '第2号文書（請負に関する契約書）',
      natures: ['ukeoi'],
      tiers: [
        { upTo: 9_999, amount: 0 },
        { upTo: 1_000_000, amount: 200 },
        { upTo: 2_000_000, amount: 400 },
        { upTo: 3_000_000, amount: 1_000 },
        { upTo: 5_000_000, amount: 2_000 },
        { upTo: 10_000_000, amount: 10_000 },
        { upTo: 50_000_000, amount: 20_000 },
        { upTo: 100_000_000, amount: 60_000 },
        { upTo: 500_000_000, amount: 100_000 },
        { upTo: 1_000_000_000, amount: 200_000 },
        { upTo: 5_000_000_000, amount: 400_000 },
        { upTo: null, amount: 600_000 },
      ],
      noAmountStated: 200,
      sourceUrl: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/inshi/7102.htm',
      note: '本則の税額（1万円未満は非課税）。建設工事の請負契約書は令和9年3月31日までの作成分に軽減措置があるので、該当するなら国税庁 No.7108 の表で行を足す。',
    },
    {
      code: 'no7',
      name: '第7号文書（継続的取引の基本となる契約書）',
      natures: ['basic_transaction', 'ukeoi', 'jun_inin'],
      condition: { excludeTermMonthsAtMost: 3, unlessRenewal: true },
      fixedAmount: 4_000,
      sourceUrl: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/inshi/7104.htm',
      note: '契約期間が3か月以内で、かつ、更新の定めのないものは除く。第2号文書にも当たるときの所属は通則に従って確かめる。',
    },
  ],
};

/** 電磁的記録（電子契約）は課税文書に当たらないとする国税庁の見解（画面の案内に出す）。 */
export const ELECTRONIC_CONTRACT_SOURCE_URL = 'https://www.nta.go.jp/law/shitsugi/inshi/02/10.htm';

export const DEFAULT_CHUNK_MAX_CHARS = 4_000;

export interface PlaybookTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ourRole: OurRole;
  readonly topics: readonly ClauseTopic[];
  readonly criteria: readonly PlaybookCriterion[];
}

const topic = (id: string, label: string, valueKind: ClauseTopic['valueKind'], keywords: readonly string[], guidance: string, sortOrder: number): ClauseTopic =>
  ({ id, label, valueKind, keywords, guidance, enabled: true, sortOrder });

const OUTSOURCING_CLIENT: PlaybookTemplate = {
  id: 'outsourcing-client',
  name: '業務委託（発注者側）',
  description: '業務委託契約・請負契約を発注者（委託者）の立場で確認する一般的な論点。支払期日の照合は相手方の区分（取適法・フリーランス法）の申告が要ります。',
  ourRole: 'client',
  topics: [
    topic('term', '契約期間', 'term', ['契約期間', '有効期間', '本契約の期間'], '契約の始期・満了日・期間の月数。締結日から始まるなら starts_on_signing を true にする。', 10),
    topic('auto_renewal', '自動更新', 'auto_renewal', ['更新', '延長', '同一条件'], '満了時に自動で更新されるか、更新後の期間（「同一条件」なら初回と同じ）。', 20),
    topic('renewal_notice', '更新拒絶の通知期限', 'notice', ['更新しない', '更新拒絶', '申し出', '申出', '通知', '満了'], '更新しない旨を「満了の何か月前 / 何日前まで」に通知するか。営業日なら notice_business_days を true にする。', 30),
    topic('payment', '支払条件', 'payment_terms', ['支払', '委託料', '報酬', '代金', '締め', '締切'], '支払の基準日（納品 / 検収 / 請求）、締め日、何か月後の何日に払うか、支払手段（振込・手形・電子記録債権など）。', 40),
    topic('liability_cap', '損害賠償の上限', 'liability_cap', ['損害賠償', '賠償', '責任の制限', '責任限度'], '賠償額の上限の有無と算定方法（支払済み委託料の総額など）、故意・重過失を上限の対象から除いているか。', 50),
    topic('subcontracting', '再委託', 'permission', ['再委託', '第三者に委託', '下請'], '受託者が第三者へ再委託できるか（自由 / 事前承諾 / 通知 / 禁止）。', 60),
    topic('ip_ownership', '成果物の知的財産権', 'ip_ownership', ['知的財産', '著作権', '成果物', '権利の帰属'], '成果物の権利が甲乙どちらに帰属するか、移転の時期、著作者人格権の不行使。', 70),
    topic('jurisdiction', '合意管轄', 'jurisdiction', ['管轄', '裁判所', '紛争'], '合意した裁判所と、それが専属的か。', 80),
  ],
  criteria: [
    { id: 'term-required', topicId: 'term', check: { type: 'required' }, onFail: 'reject', rationale: '期間の定めが無いと、いつまで義務を負うかが決まらない。', enabled: true, sortOrder: 10 },
    { id: 'renewal-months', topicId: 'auto_renewal', check: { type: 'condition', conditions: [{ field: 'renewal.months', op: 'lte', value: 12 }] }, onFail: 'negotiate', recommendedText: '本契約は、期間満了の3か月前までにいずれの当事者からも書面による別段の申出がないときは、同一条件でさらに1年間更新されるものとし、以後も同様とする。', rationale: '1 年を超える自動更新は見直しの機会を失う。', enabled: true, sortOrder: 20 },
    { id: 'notice-days', topicId: 'renewal_notice', check: { type: 'condition', conditions: [{ field: 'notice.days', op: 'lte', value: 90 }] }, onFail: 'negotiate', recommendedText: '更新を希望しない当事者は、期間満了の3か月前までに相手方へ書面で通知する。', rationale: '通知期限が早すぎると更新拒絶の判断が間に合わない（月は 30 日換算の目安）。', enabled: true, sortOrder: 30 },
    { id: 'payment-max-days', topicId: 'payment', appliesToRoles: ['client'], check: { type: 'legal', rule: 'payment-max-days' }, onFail: 'reject', recommendedText: '{us}は、{counterparty}から給付を受領した日から起算して{paymentMaxDays}日以内のできる限り短い期間内に定める支払期日までに、委託料を支払う。', rationale: '取適法・フリーランス法の支払期日（設定値）を超える定めは受けられない。', enabled: true, sortOrder: 40 },
    { id: 'payment-method', topicId: 'payment', appliesToRoles: ['client'], check: { type: 'legal', rule: 'prohibited-payment-method' }, onFail: 'reject', recommendedText: '委託料の支払は、{counterparty}の指定する銀行口座への振込により行う。', rationale: '取適法では手形払いが禁止されている（設定値で手段を足せる）。', enabled: true, sortOrder: 50 },
    { id: 'liability-cap', topicId: 'liability_cap', check: { type: 'llm', question: '受託者の損害賠償責任が、委託料相当額以下に制限されていますか。', passWhen: 'no' }, onFail: 'negotiate', recommendedText: '前項の規定にかかわらず、{counterparty}の故意又は重大な過失による損害については、賠償額を制限しない。', rationale: '受託者の賠償が委託料までに制限されると、発注者の損害を回収できない。', enabled: true, sortOrder: 60 },
    { id: 'subcontract-consent', topicId: 'subcontracting', check: { type: 'condition', conditions: [{ field: 'permission.policy', op: 'in', value: ['prior_consent', 'prohibited'] }] }, onFail: 'negotiate', recommendedText: '乙は、事前に甲の書面による承諾を得た場合に限り、本業務の全部又は一部を第三者に委託することができる。', rationale: '無断の再委託は情報管理と品質の責任の所在を曖昧にする。', enabled: true, sortOrder: 70 },
    { id: 'ip-ours', topicId: 'ip_ownership', check: { type: 'condition', conditions: [{ field: 'ip.owner', op: 'equals', value: 'us' }] }, onFail: 'negotiate', recommendedText: '本業務により生じた成果物に係る著作権（著作権法第27条及び第28条に定める権利を含む。）その他の知的財産権は、委託料の支払完了時に{counterparty}から{us}へ移転する。', rationale: '発注者が成果物を自由に使えなくなる。', enabled: true, sortOrder: 80 },
    { id: 'court-exclusive', topicId: 'jurisdiction', check: { type: 'condition', conditions: [{ field: 'jurisdiction.exclusive', op: 'isTrue' }] }, onFail: 'negotiate', recommendedText: '本契約に関する一切の紛争については、{us}の本店所在地を管轄する地方裁判所を第一審の専属的合意管轄裁判所とする。', rationale: '管轄が専属でないと遠方で応訴を強いられうる（裁判所名は自社所在地で基準を足す）。', enabled: true, sortOrder: 90 },
  ],
};

const NDA_MUTUAL: PlaybookTemplate = {
  id: 'nda-mutual',
  name: '秘密保持契約（双方向）',
  description: '双方が秘密情報を開示する秘密保持契約の一般的な論点。',
  ourRole: 'mutual',
  topics: [
    topic('term', '契約期間', 'term', ['有効期間', '契約期間'], '契約の始期・満了日・期間の月数。', 10),
    topic('definition', '秘密情報の定義', 'text', ['秘密情報', '定義'], '何が秘密情報になるか。口頭で開示した情報の扱い（書面での特定が必要か）を要約する。', 20),
    topic('purpose_limit', '目的外使用の禁止', 'text', ['目的外', '本目的', '使用してはならない'], '秘密情報を開示の目的以外に使うことを禁じているか。', 30),
    topic('return_destroy', '返還・破棄', 'text', ['返還', '破棄', '消去'], '契約終了時や求めがあったときに秘密情報を返還・破棄するか。', 40),
    topic('survival', '存続期間', 'term', ['存続', '終了後', '失効後'], '契約終了後も秘密保持義務が続く期間（月数）。', 50),
    topic('jurisdiction', '合意管轄', 'jurisdiction', ['管轄', '裁判所'], '合意した裁判所と、それが専属的か。', 60),
  ],
  criteria: [
    { id: 'definition-oral', topicId: 'definition', check: { type: 'llm', question: '口頭で開示した情報を秘密情報とするのに、書面での特定が要件になっていますか。', passWhen: 'no' }, onFail: 'negotiate', recommendedText: '口頭その他の有形でない方法により開示された情報は、開示後30日以内に書面で秘密である旨を特定したものに限らず、開示の際に秘密である旨を告げたものを含む。', rationale: '書面での特定を要件にすると、打合せで伝えた情報が守られない。', enabled: true, sortOrder: 10 },
    { id: 'return-required', topicId: 'return_destroy', check: { type: 'required' }, onFail: 'negotiate', recommendedText: '受領者は、開示者の求めがあったとき又は本契約が終了したときは、秘密情報を速やかに返還又は破棄する。', rationale: '返還・破棄の定めが無いと、終了後も情報が手元に残る。', enabled: true, sortOrder: 20 },
    { id: 'survival-months', topicId: 'survival', check: { type: 'condition', conditions: [{ field: 'term.months', op: 'lte', value: 60 }] }, onFail: 'negotiate', recommendedText: '本契約の終了後も、{articleRef}の義務は5年間存続する。', rationale: '長すぎる存続期間は管理の負担が重い。', enabled: true, sortOrder: 30 },
    { id: 'court-exclusive', topicId: 'jurisdiction', check: { type: 'condition', conditions: [{ field: 'jurisdiction.exclusive', op: 'isTrue' }] }, onFail: 'negotiate', recommendedText: '本契約に関する一切の紛争については、{us}の本店所在地を管轄する地方裁判所を第一審の専属的合意管轄裁判所とする。', rationale: '管轄が専属でないと遠方で応訴を強いられうる。', enabled: true, sortOrder: 40 },
  ],
};

export const PLAYBOOK_TEMPLATES: readonly PlaybookTemplate[] = [OUTSOURCING_CLIENT, NDA_MUTUAL];
export const DEFAULT_TEMPLATE_ID = OUTSOURCING_CLIENT.id;

export function findPlaybookTemplate(templateId: string): PlaybookTemplate | undefined {
  return PLAYBOOK_TEMPLATES.find((template) => template.id === templateId);
}

export interface PlaybookFromTemplateOptions {
  readonly tenant: TenantScope;
  readonly id: string;
  readonly name?: string;
  readonly isDefault: boolean;
  readonly now: string;
  readonly ourCompanyNames?: readonly string[];
}

/** テンプレート → 審査基準（保存はしない。0 件のときの既定表示にも使う）。 */
export function playbookFromTemplate(template: PlaybookTemplate, options: PlaybookFromTemplateOptions): Playbook {
  return createPlaybook({
    tenant: options.tenant,
    id: options.id,
    name: options.name ?? template.name,
    isDefault: options.isDefault,
    ourRole: template.ourRole,
    ourCompanyNames: options.ourCompanyNames ?? [],
    topics: structuredClone(template.topics),
    criteria: structuredClone(template.criteria),
    legal: structuredClone(DEFAULT_LEGAL_SETTINGS),
    stampDuty: structuredClone(DEFAULT_STAMP_DUTY),
    extraction: { scanAllArticles: false, chunkMaxChars: DEFAULT_CHUNK_MAX_CHARS },
    templateId: template.id,
    createdAt: options.now,
    updatedAt: options.now,
  });
}
