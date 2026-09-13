/**
 * ヒアリング提案の検証（純関数）のテスト。
 *
 * ここを通ったものだけが「登録」ボタンの向こうへ行く。**壊れた提案が通らないこと**と、
 * **なぜ駄目かが利用者に伝わる文言で返ること**の両方を固定する。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { isWellFormedFactPath, knownChartIds, validateHearingProposal, validateProposedEntry, validateProposedRule } from './hearing-proposal';

const scope = { tenantId: 't', workspaceId: 'w' };
const chart = DEFAULT_CHART_OF_ACCOUNTS;
const context = { scope, chart };

function rule(overrides: Record<string, unknown> = {}) {
  return {
    name: 'カフェは会議費',
    enabled: true,
    mode: 'auto',
    priority: 100,
    scope: { direction: 'out' },
    conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
    outcome: { lines: [
      { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 'total' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ] },
    askIf: [],
    requiredFacts: [],
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-10',
    lines: [
      { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 1100 },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
    ],
    description: 'カフェ 打合せ',
    invoiceStatus: 'transitional',
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    rule: rule(), entry: entry(),
    newAccounts: [], newDimensionValues: [], newTaxCategories: [],
    rationale: '社内打合せの飲食は会議費。',
    ...overrides,
  };
}

describe('validateHearingProposal（正常系）', () => {
  it('正常: マスタの id だけを使った提案は通り、rule / entry がドメインの形になる', () => {
    const result = validateHearingProposal(proposal(), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rule.name).toBe('カフェは会議費');
    expect(result.value.entry.lines).toHaveLength(2);
    expect(result.value.rationale).toContain('会議費');
  });

  it('正常: accountName はモデルの申告ではなくマスタの名前で埋め直す', () => {
    const result = validateHearingProposal(proposal({
      entry: entry({ lines: [
        { side: 'debit', accountId: 'expense.meetings', accountName: 'でたらめな名前', taxCode: 'JP-IN-10-S', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
      ] }),
    }), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entry.lines[0]?.accountName).toBe('会議費');
    expect(result.value.entry.lines[1]?.accountName).toBe('現金');
  });

  it('正常: 新科目として提案された id は、その提案の中では使ってよい', () => {
    const result = validateHearingProposal(proposal({
      newAccounts: [{ id: 'expense.cafe', name: 'カフェ代', category: 'expense', aliases: ['喫茶'] }],
      rule: rule({ outcome: { lines: [
        { side: 'debit', accountId: 'expense.cafe', taxCode: 'JP-IN-10-S', amount: 'total' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ] } }),
      entry: entry({ lines: [
        { side: 'debit', accountId: 'expense.cafe', taxCode: 'JP-IN-10-S', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
      ] }),
    }), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newAccounts[0]).toMatchObject({ id: 'expense.cafe', name: 'カフェ代' });
    // 名前はマスタに無いので新科目の名前が写る。
    expect(result.value.entry.lines[0]?.accountName).toBe('カフェ代');
  });
});

describe('validateHearingProposal（異常系）', () => {
  it('異常: マスタにも新科目にも無い科目 id は理由つきで落ちる', () => {
    const result = validateHearingProposal(proposal({
      rule: rule({ outcome: { lines: [
        { side: 'debit', accountId: 'expense.cafe', taxCode: 'JP-IN-10-S', amount: 'total' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ] } }),
    }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('expense.cafe');
    expect(result.issues.join(' ')).toContain('科目マスタにも newAccounts にも無い');
  });

  it('異常: 存在しない税区分コードも落ちる', () => {
    const result = validateHearingProposal(proposal({
      entry: entry({ lines: [
        { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-99-X', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
      ] }),
    }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('JP-IN-99-X');
  });

  it('異常: 貸借が一致しない仕訳は落ちる（帳簿の不変条件）', () => {
    const result = validateHearingProposal(proposal({
      entry: entry({ lines: [
        { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1000 },
      ] }),
    }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/debit total|貸借|1100/u);
  });

  it('異常: ルール条件が facts のパスとして解釈できなければ落ちる', () => {
    const result = validateHearingProposal(proposal({
      rule: rule({ conditions: [{ field: 'めもらんだむ', op: 'contains', value: 'x' }] }),
    }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('facts のパスとして解釈できない');
  });

  it('異常: 演算子や金額指定がドメインの検証に通らなければ落ちる', () => {
    const invalidOp = validateHearingProposal(proposal({ rule: rule({ conditions: [{ field: 'grandTotal', op: 'approximately', value: 1 }] }) }), context);
    expect(invalidOp.ok).toBe(false);
    const invalidAmount = validateHearingProposal(proposal({
      rule: rule({ outcome: { lines: [
        { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 'half' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ] } }),
    }), context);
    expect(invalidAmount.ok).toBe(false);
    if (invalidAmount.ok) return;
    expect(invalidAmount.issues.join(' ')).toContain('ドメインの検証を通らない');
  });

  it('異常: 既にマスタにある id を「新科目」として出したら落ちる（二重登録を防ぐ）', () => {
    const result = validateHearingProposal(proposal({
      newAccounts: [{ id: 'expense.meetings', name: '会議費（重複）', category: 'expense', aliases: [] }],
    }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('既にマスタにある');
  });

  it('異常: 提案そのものがオブジェクトでなければ落ちる', () => {
    expect(validateHearingProposal('だいたいこんな感じです', context).ok).toBe(false);
    expect(validateHearingProposal(null, context).ok).toBe(false);
  });

  it('例外: モデルの出力がどんな形でも投げず、必ず issues で返す（1 件の異常で会話を落とさない）', () => {
    for (const raw of [undefined, null, 42, [], 'テキスト', { rule: null, entry: null }, { rule: {}, entry: { lines: 'たくさん' } }]) {
      expect(() => validateHearingProposal(raw, context), String(raw)).not.toThrow();
      const result = validateHearingProposal(raw, context);
      expect(result.ok, String(raw)).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('異常: 補助軸の値はマスタに無い軸へは足せない', () => {
    const result = validateHearingProposal(proposal({
      newDimensionValues: [{ dimensionId: 'project', id: 'p1', name: '案件A' }],
    }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('project');
  });
});

describe('isWellFormedFactPath / knownChartIds', () => {
  it('正常: facts のキー・配列パス・extra.<key> は正しい形', () => {
    for (const path of ['descriptionNorm', 'grandTotal', 'lines[].description', 'extra.purpose', 'extra.businessRatio']) {
      expect(isWellFormedFactPath(path), path).toBe(true);
    }
  });

  it('異常: facts に無い根・extra 単体・記号入りは正しくない形', () => {
    for (const path of ['memo', 'extra', 'extra..x', 'grand total', '', 'lines[].des cription', 42]) {
      expect(isWellFormedFactPath(path as unknown), String(path)).toBe(false);
    }
  });

  it('境界: knownChartIds はマスタと新規分を合わせる（新規が無ければマスタだけ）', () => {
    const bare = knownChartIds(chart);
    expect(bare.accountNames.get('expense.meetings')).toBe('会議費');
    expect(bare.accountNames.has('expense.cafe')).toBe(false);

    const withNew = knownChartIds(chart, {
      newAccounts: [{ id: 'expense.cafe', name: 'カフェ代', category: 'expense', aliases: [] }],
      newDimensionValues: [{ dimensionId: 'department', id: 'sales', name: '営業部' }],
      newTaxCategories: [{ code: 'JP-IN-5-S', name: '課税仕入 5%', side: 'in', rate: 5 }],
    });
    expect(withNew.accountNames.get('expense.cafe')).toBe('カフェ代');
    expect(withNew.taxCodes.has('JP-IN-5-S')).toBe(true);
    expect(withNew.dimensionValues.get('department')?.has('sales')).toBe(true);
  });

  it('境界: ルール単体・仕訳単体の検証も同じ規則で使える（受け入れ時の再検証）', () => {
    const known = knownChartIds(chart);
    expect(validateProposedRule(rule(), known, scope).ok).toBe(true);
    expect(validateProposedEntry(entry(), known).ok).toBe(true);
    expect(validateProposedEntry({ ...entry(), lines: [] }, known).ok).toBe(false);
  });
});

describe('提案の埋め忘れを帳票の値で補う', () => {
  const defaults = { ruleName: '株式会社サンプル商事 の仕訳', entryDate: '2026-08-31' };

  it('正常: ルール名が空でも帳票由来の既定値で補い、補ったことを警告に残す', () => {
    // 小さいモデルは name を落としがち。そこだけで提案全体を捨てない。
    const result = validateHearingProposal({ rule: rule({ name: '' }), entry: entry(), rationale: '理由' }, { scope, chart, defaults });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rule.name).toBe(defaults.ruleName);
    expect(result.value.warnings.some((warning) => warning.includes('ルール名が提案に無かった'))).toBe(true);
  });

  it('正常: 仕訳日が空でも帳票の取引日で補い、補ったことを警告に残す', () => {
    const result = validateHearingProposal({ rule: rule(), entry: entry({ date: '' }), rationale: '理由' }, { scope, chart, defaults });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entry.date).toBe(defaults.entryDate);
    expect(result.value.warnings.some((warning) => warning.includes('仕訳日が提案に無かった'))).toBe(true);
  });

  it('境界: モデルが値を返していれば既定値で上書きせず、警告も出さない', () => {
    const result = validateHearingProposal({ rule: rule(), entry: entry(), rationale: '理由' }, { scope, chart, defaults });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rule.name).toBe('カフェは会議費');
    expect(result.value.entry.date).toBe('2026-09-10');
    expect(result.value.warnings.some((warning) => warning.includes('補った'))).toBe(false);
  });

  it('異常: 既定値が無ければ従来どおり検証で落とす（黙って空のまま保存しない）', () => {
    const result = validateHearingProposal({ rule: rule({ name: '' }), entry: entry({ date: '' }), rationale: '理由' }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' / ')).toMatch(/name|date/);
  });
});

describe('提案の参照先が壊れている場合（モデルの出力をそのまま保存しない）', () => {
  /** rule だけを差し替えて検証し、issues をまとめて読む。entry は正常なままにする。 */
  function issuesOf(overrides: { rule?: unknown; entry?: unknown }): readonly string[] {
    const result = validateHearingProposal({ rule: overrides.rule ?? rule(), entry: overrides.entry ?? entry(), rationale: '理由' }, context);
    return result.ok ? [] : result.issues;
  }
  function lines(overrides: Record<string, unknown>) {
    return { lines: [
      { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 'total', ...overrides },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ] };
  }

  it('異常: 借方の科目 id が空なら断る', () => {
    expect(issuesOf({ rule: rule({ outcome: lines({ accountId: '  ' }) }) }).join(' / ')).toContain('accountId が空');
  });

  it('異常: 科目マスタにも newAccounts にも無い科目を指したら断る', () => {
    expect(issuesOf({ rule: rule({ outcome: lines({ accountId: 'no.such.account' }) }) }).join(' / ')).toContain('科目マスタにも newAccounts にも無い');
  });

  it('異常: 税区分が空なら断る', () => {
    expect(issuesOf({ rule: rule({ outcome: lines({ taxCode: '' }) }) }).join(' / ')).toContain('taxCode が空');
  });

  it('異常: 税区分マスタに無いコードを指したら断る', () => {
    expect(issuesOf({ rule: rule({ outcome: lines({ taxCode: 'JP-NO-SUCH' }) }) }).join(' / ')).toContain('税区分マスタにも newTaxCategories にも無い');
  });

  it('異常: マスタに無い補助軸を指したら断る', () => {
    expect(issuesOf({ rule: rule({ outcome: lines({ dimensionValues: { no_such_dimension: 'v1' } }) }) }).join(' / ')).toContain('補助軸');
  });

  it('異常: 補助軸はあっても、その値がマスタに無ければ断る', () => {
    // 既定マスタの sub_account は値を持たない（利用者が定義する）ので、どの値を指しても未登録になる。
    expect(issuesOf({ rule: rule({ outcome: lines({ dimensionValues: { sub_account: 'no-such-value' } }) }) }).join(' / ')).toContain('sub_account');
  });

  it('異常: askIf の条件が facts のパスとして解釈できなければ断る', () => {
    const broken = rule({ askIf: [{ conditions: [{ field: 'window.location', op: 'equals', value: 'x' }], questionId: 'q1', prompt: '確認' }] });
    expect(issuesOf({ rule: broken }).join(' / ')).toContain('askIf');
  });

  it('異常: requiredFacts に facts のパスでない文字列があれば断る', () => {
    expect(issuesOf({ rule: rule({ requiredFacts: ['../secrets'] }) }).join(' / ')).toContain('requiredFacts');
  });

  it('異常: 仕訳側の科目が壊れていても同じように断る（ルールだけ見て通さない）', () => {
    const brokenEntry = entry({ lines: [
      { side: 'debit', accountId: 'no.such.account', taxCode: 'JP-IN-10-S', amount: 1100 },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
    ] });
    expect(issuesOf({ entry: brokenEntry }).join(' / ')).toContain('科目マスタにも newAccounts にも無い');
  });

  it('境界: 壊れている箇所が複数あれば、まとめて全部返す（1 つ直して次が出る、を繰り返させない）', () => {
    const issues = issuesOf({ rule: rule({ outcome: lines({ accountId: '', taxCode: '' }) }) });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe('配列に混ざった異物を落とす', () => {
  it('異常: tags と warnings に文字列以外が混ざっていても、文字列だけを残して通す', () => {
    // モデルは配列へ数値や null を混ぜてくる。ここで落とさないと保存時にドメインの検証で弾かれ、
    // 「提案そのものが駄目」と誤って見えてしまう。
    const result = validateHearingProposal({
      rule: rule(),
      entry: entry({ tags: ['カード', 42, null, '月次'] }),
      rationale: '理由',
      warnings: ['税率を確かめること', 7, { note: 'x' }],
    }, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entry.tags).toEqual(['カード', '月次']);
    expect(result.value.warnings).toEqual(['税率を確かめること']);
  });

  it('境界: tags が配列でなければ項目ごと落とす（空配列にもしない）', () => {
    const result = validateHearingProposal({ rule: rule(), entry: entry({ tags: 'カード' }), rationale: '理由' }, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entry.tags).toBeUndefined();
  });
});
