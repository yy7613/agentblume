import { describe, expect, it } from 'vitest';
import { AT, claimFixture, itemFixture, policyFixture } from '../../adapters/storage/expense-repository.fixtures';
import { checkClaim } from '../../domain/expense/check';
import { claimFingerprint, withJudgment, type ExpenseClaim } from '../../domain/expense/claim';
import type { ReasonParamValue } from '../../domain/expense/judgment';
import { APPROVAL_UNRESOLVED_CAUSES } from '../../domain/expense/approval';
import { INPUT_REASON_CODES, MONEY_REASON_CODES, PEOPLE_REASON_CODES, REASON_CATALOG, REASON_CODES, type ExpenseReasonCode } from '../../domain/expense/reason-codes';
import { applicantText, buildReturnMessage, REASON_MESSAGES, reasonText } from './reason-messages';

type Params = Readonly<Record<string, ReasonParamValue>>;

/** 判定で実際に出る差し込み値に近いもの（空の params でも文が崩れないことは別に見る）。 */
const SAMPLE_PARAMS: Params = {
  description: 'タクシー代', category: 'タクシー', categoryText: 'タク', categoryId: 'transport.taxi', amount: 12500, issueDate: null, documentKind: 'receipt', readerHint: false,
  exemptBelow: null, warnings: '注意', count: 2, sum: 12000, diff: 500, tolerance: 1, date: '2026-09-10', today: '2026-09-14', from: '2026-09-01', to: '2026-09-30',
  days: 100, limitDays: 90, paymentMethod: 'cash', deductionRate: 80, raw: null, digits: null, limit: 10000, over: 2500, perPerson: 12000, basis: 'tax-included',
  basisFallback: false, missingNames: true, missingRelation: false, unitLabel: '泊', unitCount: 1, perUnit: 13000, ruleId: 'r', ruleName: '高額', otherItemId: 'item-2',
  otherDescription: '別の明細', weak: false, otherClaimId: 'claim-2', otherStatus: 'approved', claimantName: '山田', total: 60000,
  // 実用化の 16 コード（§20.4）の差し込み値。
  claimant: '山田 太郎', candidates: '山田 太郎（E001）', missing: '出発駅', advanceId: 'adv-1', advanceEmployee: '佐藤', advanceStatus: 'approved', settledOn: '2026-09-01',
  routeName: '高額', stepName: '部門長', cause: 'manager-missing', manager: '鈴木', department: '営業部', group: '経理', employee: '高橋',
  disagreements: '登録番号: 仕訳の読取「T1234567890123」/ 追加の読取「T123456789012（数字 12 桁）」', fields: '参加人数・区間',
  route: '新宿 > 霞ケ関', passRoute: '新宿 > 東京', validTo: '2027-03-31', overlapFrom: '新宿', overlapTo: '四ツ谷', restRoute: '四ツ谷 > 霞ケ関', suggestedAmount: 180,
  fareType: 'ic', fare: 199, trips: 2, expected: 398, candidateCount: 1,
  cardLabel: '法人カード A', usedOn: '2026-09-10', merchant: 'タクシー会社', cardAmount: 12500, dateDiffDays: 0, coverage: '2026-08-01〜2026-09-30',
};

function checked(claim: ExpenseClaim, policySaved = false): ExpenseClaim {
  const policy = policyFixture();
  const judgment = checkClaim({ claim, policy, policySaved, duplicateCandidates: [], today: '2026-09-14' });
  return withJudgment(claim, { ...judgment, policyUpdatedAt: policy.updatedAt, itemsFingerprint: claimFingerprint(claim), checkedAt: AT }, AT, 'checker');
}

describe('REASON_MESSAGES / reasonText', () => {
  it('正常: 全 43 コードに文言があり、余計なコードも無い', () => {
    expect(REASON_CODES).toHaveLength(43);
    expect(Object.keys(REASON_MESSAGES).sort()).toEqual([...REASON_CODES].sort());
  });

  it('正常: 実用化の 16 コード（3 系統の和）はどれも差し込み値の漏れ（undefined / null の文字列）を出さない', () => {
    const added = [...PEOPLE_REASON_CODES, ...MONEY_REASON_CODES, ...INPUT_REASON_CODES];
    expect(added).toHaveLength(16);
    for (const code of added) {
      const { cause, fix } = reasonText({ code, params: SAMPLE_PARAMS });
      for (const sentence of [cause, fix, applicantText({ code, params: SAMPLE_PARAMS }) ?? '']) {
        expect(sentence, code).not.toMatch(/undefined|null|\{[a-zA-Z]+\}/u);
      }
    }
  });

  it.each(REASON_CODES.map((code) => [code]))('正常: %s の原因と直し方は空でない日本語の文', (code) => {
    for (const params of [SAMPLE_PARAMS, {}]) {
      const { cause, fix } = reasonText({ code, params });
      expect(cause.trim()).not.toBe('');
      expect(fix.trim()).not.toBe('');
      expect(cause).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(fix).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
    }
  });
});

describe('applicantText', () => {
  it.each(REASON_CODES.map((code) => [code, REASON_CATALOG[code].applicantFacing]))('正常: %s（申請者向け=%s）は申請者向けのときだけ文を返す', (code, facing) => {
    const sentence = applicantText({ code: code as ExpenseReasonCode, params: SAMPLE_PARAMS });
    if (facing) {
      expect(typeof sentence).toBe('string');
      expect(sentence?.trim()).not.toBe('');
    } else {
      // 経理側の問題（規程が未保存・読取の注意点・費目が規程に無い）は差し戻し文言に出さない。
      expect(sentence).toBeUndefined();
    }
    // 文言表の applicant の有無もカタログと一致する（片方だけ直して食い違うのを防ぐ）。
    expect(REASON_MESSAGES[code as ExpenseReasonCode].applicant !== undefined).toBe(facing);
  });
});

describe('差し込み値', () => {
  const cause = (code: ExpenseReasonCode, params: Params): string => reasonText({ code, params }).cause;

  it('正常: 金額は桁区切り、数値でない値はそのまま出す', () => {
    expect(cause('per-item-limit-exceeded', { category: 'タクシー', limit: 10000, over: 2500, amount: 12500 })).toBe('費目「タクシー」の 1 件上限 10,000 円を 2,500 円超えています（12,500 円）');
    expect(cause('per-item-limit-exceeded', { category: 'タクシー', limit: '一万', over: null, amount: 12500 })).toContain('1 件上限 一万 円を  円超えています');
    expect(cause('receipt-amount-mismatch', { sum: 1100, amount: 1210, diff: 110, tolerance: 1 })).toBe('税率別の内訳の合計 1,100 円が金額 1,210 円と 110 円ずれています（許容 1 円）');
  });

  it('境界: 弱い鍵の重複は照合の根拠を注記し、強い鍵では注記しない', () => {
    const note = '（支払先が空のため、取引日・金額・費目だけで照合しています）';
    expect(cause('duplicate-in-claim', { otherDescription: '昼食', weak: true })).toContain(note);
    expect(cause('duplicate-in-claim', { otherDescription: '昼食', weak: false })).not.toContain(note);
    expect(cause('duplicate-across-claims', { claimantName: '山田', otherClaimId: 'claim-2', otherStatus: 'approved', weak: true })).toBe(`山田 さんの申請 claim-2（approved）の明細と支払先・取引日・金額が同じです${note}`);
  });

  it('境界: 登録番号の生の文字列（rawNote）と経過措置の割合、取引日が無いときの言い方', () => {
    const withRaw = cause('registration-number-missing', { category: 'タクシー', raw: 'T12345', digits: 5, date: '2026-09-10', deductionRate: 80 });
    expect(withRaw).toContain('（読み取った「T12345」は数字 5 桁のため採用していません）');
    expect(withRaw).toContain('取引日 2026-09-10 時点の経過措置（80%）になります');
    const withoutDate = cause('registration-number-missing', { category: 'タクシー', raw: null, digits: null, date: null, deductionRate: null });
    expect(withoutDate).not.toContain('読み取った');
    expect(withoutDate).toContain('取引日が無いため経過措置の割合は決まりません');
  });

  it('境界: 1 人あたりの基準は税込 / 税抜を言い分け、内訳が無く税込で判定したとき（basisFallback）はそう注記する', () => {
    const fallback = cause('per-person-limit-exceeded', { perPerson: 12000, basis: 'tax-included', count: 2, category: '交際費', limit: 10000, basisFallback: true });
    expect(fallback).toBe('1 人あたり 12,000 円（税込、2 人）が費目「交際費」の基準 10,000 円を超えています（税率別の内訳が無く税抜にできないため、税込で判定しました）');
    const excluded = cause('per-person-limit-exceeded', { perPerson: 11000, basis: 'tax-excluded', count: 3, category: '交際費', limit: 10000, basisFallback: false });
    expect(excluded).toContain('（税抜、3 人）');
    expect(excluded).not.toContain('税込で判定しました');
  });

  it('境界: 取引日が無く発行日があるとき（issueDateNote）だけ発行日を添える', () => {
    expect(cause('date-missing', { issueDate: '2026-09-01' })).toContain('（発行日 2026-09-01 はあります）');
    expect(cause('date-missing', { issueDate: null })).not.toContain('（発行日');
  });

  it('境界: 精算書・伝票の読取で支払先が空のとき（readerHint）は元の領収書を見るよう添える', () => {
    expect(cause('payee-missing', { readerHint: true })).toContain('精算書・伝票の読取では支払先が空になりやすいため');
    expect(cause('payee-missing', { readerHint: false })).not.toContain('精算書・伝票');
  });

  it('境界: 領収書の免除の閾値がある費目は金額の条件を言う', () => {
    expect(cause('receipt-missing', { category: '電車・バス', exemptBelow: 30000 })).toBe('費目「電車・バス」は 30,000 円以上で領収書が必要ですが、添付がありません');
    expect(cause('receipt-missing', { category: 'タクシー', exemptBelow: null })).toBe('費目「タクシー」は領収書が必要ですが、添付がありません');
  });

  it('正常: 支払方法は日本語の名前に、知らない値はそのまま出す', () => {
    expect(cause('payment-not-reimbursable', { paymentMethod: 'credit_card' })).toContain('支払方法「クレジットカード」');
    expect(cause('payment-not-reimbursable', { paymentMethod: 'corporate' })).toContain('支払方法「会社払い」');
    expect(cause('payment-not-reimbursable', { paymentMethod: 'voucher' })).toContain('支払方法「voucher」');
  });

  it('境界: 参加者の不足は足りない項目だけを並べる', () => {
    expect(cause('attendee-details-missing', { category: '交際費', missingNames: true, missingRelation: true })).toContain('参加者の氏名と関係がありません');
    expect(cause('attendee-details-missing', { category: '交際費', missingNames: false, missingRelation: true })).toContain('、関係がありません');
  });

  it('境界: 申請者の紐付け候補は、候補があるときだけ名前を添える', () => {
    expect(cause('claimant-unlinked', { claimant: '山田', candidates: '山田 太郎（E001）、山田 次郎（E002）' })).toBe('申請者「山田」が従業員マスタの誰にも紐付いていません（同じ名前の従業員: 山田 太郎（E001）、山田 次郎（E002））');
    expect(cause('claimant-unlinked', { claimant: '山田', candidates: null })).toBe('申請者「山田」が従業員マスタの誰にも紐付いていません');
    expect(cause('claimant-unlinked', { claimant: '山田', candidates: '' })).not.toContain('同じ名前');
  });

  it('境界: 申請者の従業員は、見つからない（missing）と無効を言い分ける', () => {
    expect(cause('claimant-employee-disabled', { claimant: '山田', missing: true })).toBe('申請者「山田」は従業員マスタで見つかりません（削除されたデータの可能性があります）');
    expect(cause('claimant-employee-disabled', { claimant: '山田', missing: false })).toBe('申請者「山田」は従業員マスタで無効になっています');
  });

  it('正常: 仮払の 3 コードは仮払の id と状態・精算日を差し込み、状態は日本語の名前にする', () => {
    expect(cause('advance-employee-mismatch', { advanceId: 'adv-1', advanceEmployee: '佐藤' })).toBe('紐付けた仮払 adv-1（佐藤 さん）は、この申請の申請者のものではありません');
    expect(cause('advance-not-paid', { advanceId: 'adv-1', advanceStatus: 'approved' })).toBe('紐付けた仮払 adv-1 はまだ支払済みではありません（状態: 承認済み）');
    expect(cause('advance-not-paid', { advanceId: 'adv-1', advanceStatus: 'mystery' })).toContain('（状態: mystery）');
    expect(cause('advance-already-settled', { advanceId: 'adv-1', settledOn: '2026-09-01' })).toBe('紐付けた仮払 adv-1 は 2026-09-01 に精算済みです');
  });

  it.each([
    ['manager-missing', '山田 さんの上長が未設定です', '従業員マスタで上長を設定してください'],
    ['manager-disabled', '上長 鈴木 さんが無効です', '上長を設定し直してください'],
    ['department-head-missing', '部門「営業部」とその上位の部門に部門長がいません', '組織で部門長を設定してください'],
    ['group-empty', '承認グループ「経理」に有効なメンバーがいません', '組織でメンバーを足してください'],
    ['employee-disabled', '指定の承認者 高橋 さんが無効です', '規程の承認経路で承認者を選び直してください'],
    ['only-claimant', '承認者が申請者本人しかいません', '別の承認者を足すか、規程の承認経路を見直してください'],
  ])('境界: 承認者が決まらない原因 %s の原因の文と直し方', (reason, causeText, causeFix) => {
    const params = { routeName: '高額', stepName: '部門長', cause: reason, claimant: '山田', manager: '鈴木', department: '営業部', group: '経理', employee: '高橋' };
    expect(reasonText({ code: 'approval-route-unresolved', params })).toEqual({
      cause: `承認経路「高額」の段「部門長」の承認者が決まりません（${causeText}）`,
      fix: `${causeFix}。直すまでこの申請は承認できません`,
    });
  });

  it('異常: 承認者が決まらない原因が §20.4 の 6 件以外（申請者の未紐付け・未知の値）でも文が崩れない', () => {
    // APPROVAL_UNRESOLVED_CAUSES には claimant-unlinked もある（上長・部門長の経路は申請者から辿るため）。
    for (const reason of APPROVAL_UNRESOLVED_CAUSES) expect(cause('approval-route-unresolved', { routeName: 'r', stepName: 's', cause: reason })).not.toContain('（）');
    expect(cause('approval-route-unresolved', { routeName: 'r', stepName: 's', cause: 'claimant-unlinked' })).toContain('（申請者が従業員マスタに紐付いていません）');
    expect(reasonText({ code: 'approval-route-unresolved', params: { cause: 'mystery' } }).fix).toBe('従業員マスタ・組織・規程の承認経路を確認してください。直すまでこの申請は承認できません');
  });

  it('正常: 読取の 3 コードは整形済みの文字列をそのまま差し込む', () => {
    expect(cause('date-substituted-by-issue-date', { date: '2026-09-01' })).toBe('取引日 2026-09-01 は、読取で利用日が見つからず発行日を使った値です');
    expect(cause('receipt-reads-disagree', { disagreements: '登録番号: 仕訳の読取「T1」/ 追加の読取「T2」' })).toBe('2 回の読取で値が食い違っています: 登録番号: 仕訳の読取「T1」/ 追加の読取「T2」');
    expect(cause('read-values-unconfirmed', { fields: '参加人数・区間・支払先' })).toBe('参加人数・区間・支払先は読取で入れた候補のままで、人が確認していません');
  });

  it('境界: 通勤定期は有効期限（validTo）があるときだけ「まで」を添える', () => {
    expect(cause('commuter-pass-overlap', { route: '新宿 > 霞ケ関', claimant: '山田', passRoute: '新宿 > 東京', validTo: '2027-03-31' })).toBe('区間 新宿 > 霞ケ関 は 山田 さんの通勤定期（新宿 > 東京、2027-03-31 まで）の範囲内です');
    expect(cause('commuter-pass-overlap', { route: '新宿 > 霞ケ関', claimant: '山田', passRoute: '新宿 > 東京', validTo: null })).toBe('区間 新宿 > 霞ケ関 は 山田 さんの通勤定期（新宿 > 東京）の範囲内です');
    expect(cause('route-missing', { category: '電車・バス', missing: '到着駅' })).toBe('費目「電車・バス」は区間（出発駅・到着駅）の記入が必要ですが、到着駅がありません');
  });

  it('境界: 定期との一部重複は、定期の外の区間と金額が両方あるときだけ金額を提案する', () => {
    const base = { route: '新宿 > 霞ケ関', overlapFrom: '新宿', overlapTo: '四ツ谷' };
    expect(cause('commuter-pass-partial-overlap', { ...base, restRoute: '四ツ谷 > 霞ケ関', suggestedAmount: 1180 })).toBe('区間 新宿 > 霞ケ関 のうち 新宿〜四ツ谷 が通勤定期と重なります（運賃マスタでは定期の外の 四ツ谷 > 霞ケ関 が 1,180 円です）');
    expect(cause('commuter-pass-partial-overlap', { ...base, restRoute: null, suggestedAmount: null })).toBe('区間 新宿 > 霞ケ関 のうち 新宿〜四ツ谷 が通勤定期と重なります');
    expect(cause('commuter-pass-partial-overlap', { ...base, restRoute: '四ツ谷 > 霞ケ関', suggestedAmount: null })).not.toContain('運賃マスタでは');
  });

  it('境界: 運賃超過は同じ区間の登録が 2 件以上のときだけ比べ方を注記し、券種は IC / 切符の名前にする', () => {
    const base = { amount: 1500, route: '新宿 > 霞ケ関', fareType: 'ticket', fare: 200, trips: 2, expected: 400, over: 1100, tolerance: 10 };
    expect(cause('fare-exceeds-table', { ...base, candidateCount: 2 })).toBe('金額 1,500 円が運賃マスタの 新宿 > 霞ケ関（切符）200 円 × 2 回 = 400 円を 1,100 円超えています（許容 10 円、同じ区間の登録 2 件のうち最も高い運賃で比べています）');
    expect(cause('fare-exceeds-table', { ...base, candidateCount: 1 })).toBe('金額 1,500 円が運賃マスタの 新宿 > 霞ケ関（切符）200 円 × 2 回 = 400 円を 1,100 円超えています（許容 10 円）');
    expect(cause('fare-route-unknown', { route: '新宿 > 霞ケ関', fareType: 'ic' })).toBe('区間 新宿 > 霞ケ関（IC）は運賃マスタに登録がありません');
    expect(cause('fare-route-unknown', { route: '新宿 > 霞ケ関', fareType: 'bus' })).toContain('（bus）');
  });

  it('境界: カードの一致は弱い一致と日付のずれをそれぞれ注記し、どちらも無ければ注記しない', () => {
    const base = { cardLabel: '法人カード A', usedOn: '2026-09-10', merchant: 'タクシー会社', cardAmount: 12500 };
    const tail = '。立替として精算すると二重払いになります';
    expect(cause('card-charge-claimed', { ...base, weak: false, dateDiffDays: 0 })).toBe(`法人カード「法人カード A」の 2026-09-10 タクシー会社 12,500 円の利用と一致します${tail}`);
    expect(cause('card-charge-claimed', { ...base, weak: true, dateDiffDays: 0 })).toBe(`法人カード「法人カード A」の 2026-09-10 タクシー会社 12,500 円の利用と一致します（加盟店名が一致しないため、日付と金額だけで照合しています）${tail}`);
    expect(cause('card-charge-claimed', { ...base, weak: false, dateDiffDays: -2 })).toContain(`（利用日と 2 日ずれ）${tail}`);
    expect(cause('card-charge-claimed', { ...base, weak: true, dateDiffDays: 1 })).toContain('照合しています）（利用日と 1 日ずれ）');
    expect(cause('corporate-payment-unmatched', { coverage: '2026-08-01〜2026-09-30' })).toBe('会社払いの明細ですが、取り込んだ法人カード明細（2026-08-01〜2026-09-30）に一致する利用がありません');
  });

  it('正常: 実用化の申請者向けの文は明細の摘要（骨格が足す description）を差し込む', () => {
    expect(applicantText({ code: 'route-missing', params: { description: '客先訪問' } })).toBe('明細「客先訪問」の区間（出発駅・到着駅）を記入してください');
    expect(applicantText({ code: 'commuter-pass-overlap', params: { description: '客先訪問', route: '新宿 > 東京' } })).toBe('明細「客先訪問」の区間 新宿 > 東京 は通勤定期の範囲内のため精算できません。範囲外の移動であれば区間を訂正してください');
    // 経理側で紐付け・マスタを直すコードは差し戻し文言に出さない。
    for (const code of ['claimant-unlinked', 'advance-not-paid', 'approval-route-unresolved', 'fare-route-unknown', 'receipt-reads-disagree'] as const) expect(applicantText({ code, params: SAMPLE_PARAMS })).toBeUndefined();
  });

  it('正常: 直し方にも差し込み値が入る（別名の提案・単位名）', () => {
    expect(reasonText({ code: 'category-missing', params: { categoryText: 'タク' } }).fix).toContain('「別名」に「タク」を足すと');
    expect(reasonText({ code: 'unit-count-missing', params: { unitLabel: '泊' } }).fix).toBe('泊数を入力してください');
    expect(reasonText({ code: 'per-unit-limit-exceeded', params: { unitLabel: '日' } }).fix).toBe('日数の入力と規程の上限を確認してください');
  });
});

describe('buildReturnMessage', () => {
  it('正常: 申請単位の申請者向けの理由は「申請全体」として番号付きで並べ、経理側の問題（policy-unreviewed）は含めない', () => {
    const message = buildReturnMessage(checked(claimFixture('claim-9', { items: [] })));
    expect(message).toBe([
      'テスト太郎 さん',
      '2026-09-01〜2026-09-30 の経費精算（claim-9）を差し戻します。次の点を直して、もう一度提出してください。',
      '',
      '1. 申請全体: 明細が 1 件もありません。精算する領収書を添付してください',
    ].join('\n'));
  });

  it('境界: 申請者向けの理由が無ければ、書き足しを促す 1 行を置く（読取の注意点だけの申請など）', () => {
    const item = itemFixture('item-1', { registrationNumber: 'T1234567890123' }, { receiptId: 'receipt-1', extraction: { method: 'llm', warnings: ['金額が薄い'] } });
    const message = buildReturnMessage(checked(claimFixture('claim-1', { items: [item] })));
    expect(message.split('\n').at(-1)).toBe('（差し戻しの理由として挙げる項目がありません。直してほしい点を書き足してください）');
    expect(message).not.toContain('金額が薄い');
  });

  it('境界: 判定の無い申請でも落ちずに既定形を返す', () => {
    expect(buildReturnMessage(claimFixture('claim-1'))).toContain('（差し戻しの理由として挙げる項目がありません');
  });

  it('正常: 明細の順に並べ、明細の呼び名は摘要 → 支払先 → 何件目の順で決める', () => {
    const items = [
      itemFixture('item-1', { description: undefined, payeeName: undefined, amount: 1000 }),
      itemFixture('item-2', { description: undefined, payeeName: '喫茶店', amount: 2000 }),
    ];
    const lines = buildReturnMessage(checked(claimFixture('claim-1', { items }), true)).split('\n').slice(3);
    expect(lines[0]).toMatch(/^1\. 明細「明細 1」: /u);
    expect(lines.some((line) => line.startsWith('2. 明細「明細 1」: ') || line.includes('明細「喫茶店」'))).toBe(true);
    // 同じ明細・同じ文は 1 度だけ。
    expect(new Set(lines).size).toBe(lines.length);
  });
});
