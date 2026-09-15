/**
 * 経費精算「入力と規程」の組み立てと、合成根ごと一本通す E2E（docs/21 §20.15 の composition 行のうち系統 C の分）。
 *
 * 1. 組み立て: モデルの配線（test プロファイルは使えない側）、機能フラグ。
 * 2. 交通費: サンプルの運賃マスタ CSV を取り込み → 通勤定期のある従業員の申請に区間つきの明細 → チェックの理由が期待値と一致。
 * 3. 規程のヒアリング: 台本のモデルでサンプルの規程文から案 → 差分 → 根拠のある変更を選んで保存。
 * 4. 追加読取: 骨格の読取（`detail: true`）に系統 C の読取が続き、印が付く。サンプルの読取の見本も同じ純関数で固定する。
 * 5. ツール: `expense_fares` を紐づけたエージェントが運賃マスタを読む（通勤定期は出ない）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { fixtureOrganization } from '../adapters/storage/expense-v9.fixtures';
import type { ModelCompletion, ModelProviderPort } from '../application/model/model-provider';
import { BUILTIN_SCOPE, seedBuiltinTools } from '../builtin-tools';
import { EXPENSE_FARES_TOOL_ID } from '../builtin-tools/expense-input';
import type { ExpenseDetailRead } from '../domain/expense/detail-read';
import { createExpenseEmployee } from '../domain/expense/employee';
import { mergeExpenseDetail, type DetailMergeDraft } from '../domain/expense/input/detail-merge';
import { allReasons } from '../domain/expense/judgment';
import { INPUT_REASON_CODES } from '../domain/expense/reason-codes';
import type { ReceiptFacts } from '../domain/expense/receipt-facts';
import { SemVer } from '../domain/tool/semver';
import type { BusinessCompositionContext } from './business';
import { expenseModelBinding } from './expense-input';
import { createApp, type App } from './root';

const SAMPLES = join(process.cwd(), 'samples', 'expense');
const sample = (name: string): string => readFileSync(join(SAMPLES, name), 'utf8');
const scope = BUILTIN_SCOPE;
const by = 'keiri@example.com';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

const stop = (content: string): ModelCompletion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
const INPUT_CODES: ReadonlySet<string> = new Set(INPUT_REASON_CODES);

function localApp(): { readonly app: App; readonly model: ScriptedModelProvider } {
  const model = new ScriptedModelProvider();
  // 読取とヒアリングは「main モデルの設定の有無」を見る。台本模型を使う E2E では設定済みとして扱う。
  vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
  return { app: createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 保存先ログは出さない */ } }), model };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('expenseModelBinding', () => {
  const provider: ModelProviderPort = { capabilities: () => ['chat'], complete: async () => stop('') };
  const context = (overrides: Partial<BusinessCompositionContext>): Pick<BusinessCompositionContext, 'profile' | 'modelProvider' | 'mainModelConfigured' | 'mainModelCapabilities'> & Partial<BusinessCompositionContext> => ({
    profile: 'local', modelProvider: provider, mainModelConfigured: async () => true, mainModelCapabilities: async () => ['structured-output', 'vision'], ...overrides,
  });

  it('正常: local で main モデルが設定済みなら使える。能力は保存済みの設定から読み、モデル名は指紋から写す', async () => {
    const binding = expenseModelBinding({ context: context({ resolveModelSnapshot: async () => ({ provider: 'lm-studio', model: 'gemma-3-12b', modelConfigHash: 'h' }) }) as BusinessCompositionContext });
    expect(await binding.enabled()).toBe(true);
    expect(await binding.capabilities?.()).toEqual(['structured-output', 'vision']);
    expect(await binding.snapshot?.()).toEqual({ provider: 'lm-studio', model: 'gemma-3-12b' });
  });

  it('境界: test プロファイル・未設定は使えない。指紋を解決できない配線ではモデル名を持たない', async () => {
    expect(await expenseModelBinding({ context: context({ profile: 'test' }) as BusinessCompositionContext }).enabled()).toBe(false);
    const unconfigured = expenseModelBinding({ context: context({ mainModelConfigured: async () => false }) as BusinessCompositionContext });
    expect(await unconfigured.enabled()).toBe(false);
    expect(unconfigured.snapshot).toBeUndefined();
  });

  it('正常: test プロファイルの App では追加読取もヒアリングも使えない側に倒れる', async () => {
    const app = createApp({ profile: 'test' });
    try {
      expect(await app.expensePolicyHearings.available()).toBe(false);
      expect(await app.expenseCapabilities.execute()).toMatchObject({ detailExtraction: { enabled: false }, policyHearing: { enabled: false } });
    } finally { app.close(); }
  });
});

interface TransportSample {
  readonly period: { readonly from: string; readonly to: string };
  readonly stationAliases: readonly { readonly name: string; readonly aliases: readonly string[] }[];
  readonly employee: { readonly id: string; readonly name: string; readonly commuterPasses: readonly { readonly id: string; readonly stations: readonly string[]; readonly validFrom?: string; readonly validTo?: string }[] };
  readonly items: readonly { readonly label: string; readonly facts: ReceiptFacts; readonly codes: readonly string[] }[];
}

describe('交通費の一本通し（E2E。モデルなし）', () => {
  it('正常: 運賃マスタ CSV の取込 → 通勤定期のある申請者の交通費 → チェックの理由が input-expected-transport-checks.json と一致する', async () => {
    const expected = JSON.parse(sample('input-expected-transport-checks.json')) as TransportSample;
    const app = createApp({ profile: 'test' });
    try {
      await app.resetExpensePolicy.execute(scope);
      const at = new Date().toISOString();
      await app.expenseEmployeeRepo.save(createExpenseEmployee({ tenant: scope, id: expected.employee.id, name: expected.employee.name, commuterPasses: expected.employee.commuterPasses, history: [{ type: 'created', by, at }], createdAt: at, updatedAt: at }));

      const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: expected.employee.name, employeeId: expected.employee.id }, period: expected.period, by });
      for (const item of expected.items) {
        await app.saveExpenseItem.execute({ scope, claimId: claim.id, by, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] }, categoryId: 'transport.public', facts: item.facts });
      }

      // 運賃マスタも定期も無い構成（定期を持たない申請者）は MVP と同じで、区間が無くても理由を出さない。
      const plain = await app.createExpenseClaim.execute({ scope, claimant: { name: '手入力' }, period: expected.period, by });
      await app.saveExpenseItem.execute({ scope, claimId: plain.id, by, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] }, categoryId: 'transport.public', facts: { transactionDate: '2026-09-20', payeeName: '都営バス', amount: 210, purpose: '研修会場へ' } });
      await app.checkExpenseClaims.execute({ scope, claimIds: [plain.id], by });
      // 他系統（人と承認など）の理由は系統ごとの設定で出るので、ここでは系統 C のコードだけを見る。
      expect(allReasons((await app.getExpenseClaim.execute(scope, plain.id)).judgment!).filter((reason) => INPUT_CODES.has(reason.code))).toEqual([]);

      const table = await app.expenseImportFaresCsv.execute({ scope, content: sample('fares.csv') });
      await app.expenseSaveFares.execute({ scope, routes: table.routes, stationAliases: expected.stationAliases });
      expect((await app.expenseGetFares.execute(scope)).table.routes).toHaveLength(6);

      await app.checkExpenseClaims.execute({ scope, claimIds: [claim.id], by });
      const checked = await app.getExpenseClaim.execute(scope, claim.id);
      const outcomes = checked.items.map((item) => (checked.judgment!.items.find((entry) => entry.itemId === item.id)?.reasons ?? []).map((reason) => reason.code).filter((code) => INPUT_CODES.has(code)));
      expect(outcomes).toEqual(expected.items.map((item) => item.codes));
      const partial = checked.judgment!.items[1]!.reasons.find((reason) => reason.code === 'commuter-pass-partial-overlap')!;
      expect(partial.params).toMatchObject({ overlapFrom: '中野', overlapTo: '新宿', restRoute: '新宿 > 渋谷', suggestedAmount: 160, employeeId: expected.employee.id });
    } finally { app.close(); }
  });
});

describe('規程のヒアリングの一本通し（E2E。台本のモデル）', () => {
  it('正常: サンプルの規程文 → 案と根拠 → 差分 → 根拠のある変更を選んで保存。特定の従業員を承認者にする案は落とす', async () => {
    const { app, model } = localApp();
    try {
      await app.expenseSettingsRepo.save(scope, 'organization', fixtureOrganization());
      expect(await app.expenseCapabilities.execute()).toMatchObject({ detailExtraction: { enabled: true }, policyHearing: { enabled: true } });
      model.enqueue(stop(sample('policy-hearing-scripted-proposal.json')));

      const hearing = await app.expensePolicyHearings.start({ scope, mode: 'document', documentText: sample('policy-hearing-document-sample.md'), fileName: 'policy-hearing-document-sample.md' });
      expect(hearing.status).toBe('proposed');
      expect(hearing.proposal?.dropped.map((entry) => entry.path)).toEqual(['approval.routes.director-approval']);
      expect(hearing.proposal?.warnings).toEqual([]);

      const diff = await app.expensePolicyHearings.diff(scope, hearing.id);
      expect(diff.changes.map((change) => [change.id, change.rationale?.quoteFound])).toEqual([
        // 費目は規程の並び（初期テンプレートはタクシーが交際費より前）。
        ['category:transport.taxi:limits.perItem', true],
        ['category:meal.entertainment:limits.perPerson', true],
        ['claim-rule:submissionDeadlineDays', true],
        ['approval-route:manager-then-accounting', true],
      ]);

      const chosen = diff.changes.filter((change) => change.rationale?.quoteFound === true && change.section !== 'approval-route').map((change) => change.id);
      const { policy } = await app.expensePolicyHearings.accept({ scope, id: hearing.id, changeIds: chosen, basePolicyUpdatedAt: diff.basePolicyUpdatedAt });
      expect(policy.categories.find((category) => category.id === 'meal.entertainment')?.limits.perPerson).toBe(8000);
      expect(policy.categories.find((category) => category.id === 'transport.taxi')?.limits.perItem).toBe(5000);
      expect(policy.claimRules.submissionDeadlineDays).toBe(60);
      expect(policy.approval.routes).toEqual([]);
      expect((await app.getExpensePolicy.execute(scope))).toEqual({ policy, saved: true });
      expect((await app.expensePolicyHearings.get(scope, hearing.id)).status).toBe('accepted');
    } finally { app.close(); }
  });
});

describe('追加読取の一本通し（E2E。台本のモデル）', () => {
  it('正常: 骨格の読取の detail: true で仕訳の読取の後に追加読取が続き、読取の印と記録が下書きに付く（保存しない）', async () => {
    const { app, model } = localApp();
    try {
      const journalFacts = {
        direction: 'out', issuerName: 'サンプル交通', recipientName: null, registrationNumber: null, issueDate: '2026-09-10', transactionDate: '2026-09-10', dueDate: null,
        grandTotal: 3200, totalsByRate: null, lines: null, paymentMethod: 'cash', description: 'タクシー代', extra: null,
      };
      const detail: ExpenseDetailRead = {
        registrationNumberText: 'T123456789012', payeeNameText: 'サンプル交通', transactionDateText: null, issueDateText: '2026/09/10',
        attendees: { countText: null, names: [] }, purposeClues: ['終電後の帰社'], route: { from: null, to: null, via: [], fareType: null }, notes: [],
      };
      model.enqueue(stop(JSON.stringify({ kind: 'receipt', facts: journalFacts, fieldEvidence: null, warnings: null })), stop(JSON.stringify(detail)));
      const result = await app.extractExpenseReceipt.execute({ scope, images: [PNG], fileName: 'taxi.png', detail: true });
      expect(result.drafts[0]?.extraction).toMatchObject({ flags: ['registration-number-rejected', 'transaction-date-substituted'], rejectedRegistrationNumber: 'T123456789012', detail: { promptVersion: 'expense-detail/v1' } });
      expect(result.warnings.some((warning) => warning.includes('数字 12 桁'))).toBe(true);
      expect(await app.listExpenseClaims.execute(scope)).toEqual([]);
    } finally { app.close(); }
  });

  it('正常: サンプルの読取の見本（input-detail-read-cases.json）が期待する印・事実・食い違いになる', () => {
    const cases = (JSON.parse(sample('input-detail-read-cases.json')) as { readonly cases: readonly { readonly name: string; readonly routeWanted: boolean; readonly draft: DetailMergeDraft; readonly read: ExpenseDetailRead; readonly expected: { readonly flags: readonly string[]; readonly disagreements: readonly unknown[]; readonly facts?: Partial<ReceiptFacts>; readonly rejectedRegistrationNumber?: string } }[] }).cases;
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const entry of cases) {
      const merged = mergeExpenseDetail(entry.draft, entry.read, { routeWanted: entry.routeWanted });
      expect(merged.flags, entry.name).toEqual(entry.expected.flags);
      expect(merged.disagreements, entry.name).toEqual(entry.expected.disagreements);
      if (entry.expected.facts !== undefined) expect(merged.facts, entry.name).toMatchObject(entry.expected.facts);
      expect(merged.rejectedRegistrationNumber, entry.name).toBe(entry.expected.rejectedRegistrationNumber);
    }
  });
});

describe('expense_fares ツールの一本通し（E2E）', () => {
  it('正常: シードしたツールを紐づけたエージェントが、from で絞った運賃マスタの行を読む（通勤定期は出ない）', async () => {
    const { app, model } = localApp();
    try {
      await seedBuiltinTools(app);
      await app.expenseImportFaresCsv.execute({ scope, content: sample('fares.csv') });
      await app.saveAgent.execute({
        scope, internalId: 'fare-assistant', workingName: 'fare-assistant-draft', displayName: '運賃アシスタント', publishName: 'fare_assistant', owner: 'owner', kind: 'normal',
        systemPrompt: '運賃マスタをツールで調べて答えてください。', tools: [{ internalId: EXPENSE_FARES_TOOL_ID, version: SemVer.parse('1.0.0') }],
      });
      model.enqueue({ message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'expense_fares', arguments: { from: '中野' } }] }, finishReason: 'tool_calls' }, stop('中野からの経路は 3 件です。'));
      const run = await app.runAgentPreview.executeSaved({ scope, agentId: 'fare-assistant', message: '中野からの運賃は？', mode: 'preview' });
      const trace = run.trace as readonly { readonly kind: string; readonly name?: string; readonly outputPreview?: unknown }[];
      const event = trace.find((entry) => entry.kind === 'tool-result' && entry.name === 'expense_fares');
      const rows = (event?.outputPreview ?? []) as readonly Record<string, unknown>[];
      expect(rows.map((row) => row['route_id'])).toEqual(['fare-nakano-shinjuku', 'fare-nakano-kasumigaseki', 'fare-nakano-kasumigaseki-ticket']);
      expect(rows[0]).toMatchObject({ stations: '中野 > 新宿', from: '中野', to: '新宿', fare_type: 'ic', fare: 170, bidirectional: true, saved: true });
      expect(JSON.stringify(rows)).not.toContain('pass');
    } finally { app.close(); }
  });
});
