/**
 * 組込みツール `contract_review_draft` の行（ContractReviewDraftRowsProvider）のテスト。
 *
 * 抽出・LLM 基準・文字起こしは本物のユースケースに缶詰モデルを刺して通す（行の中身が本物の判定から来ることを確かめる）。
 * 何も保存しないこと・テキスト添付を優先すること・行の列が固定スキーマと一致することを見る。
 */
import { describe, expect, it } from 'vitest';
import { COUNTERPARTY, inMemoryContractRepositories, OUR_COMPANY, playbookFixture, QUOTES, SAMPLE_CONTRACT_BODY, scope } from '../../adapters/storage/contract-repository.fixtures';
import { ContractPlaybookNotFoundError } from '../../domain/contract/errors';
import { enabledTopics, type Playbook } from '../../domain/contract/playbook';
import type { Reason } from '../../domain/contract/reasons';
import { segmentArticles, singlePage } from '../../domain/contract/segmentation';
import { CONTRACT_REVIEW_DRAFT_SCHEMA } from '../../domain/etl/nodes/contract-review-draft';
import type { ModelCompletionRequest } from '../model/model-provider';
import { bundledPrompts } from '../../test-support/prompts';
import { clockAt, criteriaContext, extraction, extractionContext, FakeModel, finding, gateFor, PNG, userText } from './contract.fixtures';
import { ContractExtractionSchemaError } from './errors';
import { ContractClauseExtractor, planChunks } from './extract-clauses';
import { ContractCriteriaAnswerer } from './llm-criteria';
import { ContractPlaybookResolver } from './manage-playbooks';
import { CONTRACT_REVIEW_DRAFT_ROW_SCHEMA, ContractReviewDraftRowsProvider, findingText, LEGAL_DISCLAIMER_JA } from './review-draft-rows';
import { TranscribeContractPagesUseCase } from './transcribe-pages';

const COLUMNS = CONTRACT_REVIEW_DRAFT_SCHEMA.columns.map((column) => column.name).sort();

type Kind = 'extract' | 'criteria' | 'transcribe';
const kindOf = (request: ModelCompletionRequest): Kind => request.responseFormat?.name === 'contract_clause_extraction' ? 'extract' : request.responseFormat?.name === 'contract_criteria_answers' ? 'criteria' : 'transcribe';

/** 抽出には本文の引用で、LLM 基準には「はい」で、文字起こしには渡したページで答えるモデル。 */
function contractModel(options: { readonly pages?: readonly string[]; readonly parties?: Record<string, unknown> | null; readonly failWhen?: (topicIds: readonly string[]) => boolean } = {}): FakeModel {
  let page = 0;
  return new FakeModel().respond((request) => {
    const kind = kindOf(request);
    if (kind === 'transcribe') return options.pages?.[page++] ?? '';
    if (kind === 'criteria') return { answers: criteriaContext(request).criteria.map((entry) => ({ criterionId: entry.criterionId, answer: 'yes', evidenceQuote: '委託料の総額を上限として賠償する', reasoning: '委託料が上限になっている' })) };
    const ids = extractionContext(request).topics.map((entry) => entry.id);
    if (options.failWhen?.(ids) === true) return '{broken';
    return extraction([
      ...(ids.includes('term') ? [finding({ topicId: 'term', articleRef: '第2条', quote: QUOTES.term, value: { term_start: '2026-04-01', term_end: '2027-03-31', term_months: 12 } })] : []),
      ...(ids.includes('payment') ? [finding({ topicId: 'payment', articleRef: '第4条', quote: QUOTES.payment, value: { pay_basis: 'delivery', pay_closing_day: 'month_end', pay_month_offset: 1, pay_day: 'month_end', pay_method: 'bank_transfer' } })] : []),
      ...(ids.includes('liability_cap') ? [finding({ topicId: 'liability_cap', articleRef: '第5条', quote: QUOTES.liability, value: { cap_kind: 'fees_paid' } })] : []),
      ...(ids.includes('jurisdiction') ? [finding({ topicId: 'jurisdiction', articleRef: '第6条', quote: QUOTES.jurisdiction, value: { court: '東京地方裁判所', court_exclusive: true } })] : []),
    ], { parties: options.parties ?? null, contractNature: { value: 'jun_inin', quote: null } });
  });
}

async function provider(model: FakeModel, playbook: Playbook = playbookFixture('pb-1', { isDefault: true })) {
  const repos = inMemoryContractRepositories();
  await repos.playbooks.save(playbook);
  const clock = clockAt('2026-09-15');
  const gate = gateFor(model);
  const catalog = bundledPrompts();
  return {
    ...repos,
    rows: new ContractReviewDraftRowsProvider(new ContractPlaybookResolver(repos.playbooks, clock), new ContractClauseExtractor(gate, catalog), new ContractCriteriaAnswerer(gate, catalog), new TranscribeContractPagesUseCase(gate, catalog), clock),
  };
}

const textDocument = (name = 'contract.pdf', text = SAMPLE_CONTRACT_BODY) => ({ name, text, pageCount: 3 });

describe('ContractReviewDraftRowsProvider', () => {
  it('正常: トピックごとの行 + 文書全体の行 1 行を、固定スキーマの列で返す（何も保存しない）', async () => {
    const model = contractModel();
    const { rows: rowsProvider, documents, reviews, signed } = await provider(model);
    const rows = await rowsProvider.rows(scope, { documents: [textDocument()], images: [] });
    const topics = enabledTopics(playbookFixture('pb-1'));
    expect(rows).toHaveLength(topics.length + 1);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(COLUMNS);
      expect(row).toMatchObject({ file_name: 'contract.pdf', playbook_name: '業務委託（発注者側）' });
      expect(row['overall']).toBe(rows[0]!['overall']);
    }
    expect(rows.slice(0, -1).map((row) => row['topic_id'])).toEqual(topics.map((topic) => topic.id));
    expect(await documents.list(scope)).toEqual([]);
    expect(await reviews.listByDocument(scope, 'attachment')).toEqual([]);
    expect(await signed.list(scope)).toEqual([]);

    const term = rows.find((row) => row['topic_id'] === 'term')!;
    expect(term).toMatchObject({
      row_type: 'topic', topic_label: '契約期間', verdict: 'accept', present: true, article_ref: '第2条', quote: QUOTES.term, quote_verified: true,
      value_summary: '2026-04-01〜2027-03-31（12か月）', reasons: '', recommended_text: null,
    });
    expect(JSON.parse(String(term['value_json']))).toEqual({ kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false });
    expect(JSON.parse(String(term['criteria_json']))).toEqual([{ criterionId: 'term-required', outcome: 'pass' }]);

    // LLM 基準（passWhen: no）に「はい」→ 交渉。推奨文案の置換子は自社側（甲）から見た相手方で埋まる。
    const liability = rows.find((row) => row['topic_id'] === 'liability_cap')!;
    expect(liability).toMatchObject({ verdict: 'negotiate', reasons: 'llm-criterion-failed', recommended_text: expect.stringContaining(`${COUNTERPARTY}の故意又は重大な過失`) });
    expect(JSON.parse(String(liability['criteria_json']))[0]).toMatchObject({ outcome: 'fail', llm: { answer: 'yes' } });

    // 見つからなかったトピックは根拠の列が null、警告は findings に出す。
    const subcontracting = rows.find((row) => row['topic_id'] === 'subcontracting')!;
    expect(subcontracting).toMatchObject({ present: false, article_ref: null, quote: null, quote_verified: null, value_summary: null, value_json: 'null', findings: expect.stringContaining('キーワードに当たる条文がありませんでした') });

    const document = rows.at(-1)!;
    expect(document).toMatchObject({ row_type: 'document', topic_id: null, topic_label: null, verdict: null, present: null, article_ref: null, quote: null, quote_verified: null, value_summary: null, recommended_text: null, criteria_json: '[]' });
    expect(JSON.parse(String(document['value_json']))).toEqual({ counterparty: COUNTERPARTY, ourParty: 'A', contractNature: 'jun_inin' });
    const lines = String(document['findings']).split('\n');
    // 法的判断ではない旨の固定文言は必ず最後の行。
    expect(lines.at(-1)).toBe(LEGAL_DISCLAIMER_JA);
    expect(lines.some((line) => line.startsWith('印紙税: 第7号文書'))).toBe(true);
    // 相手方の区分が未入力なので支払期日は判定できないが、最長ケースは決定的に計算して見せる。
    expect(lines).toContain('支払期日の最長ケース: 2026-07-01 受領 → 2026-08-31 支払（62 日目）');
    expect(rows.find((row) => row['topic_id'] === 'payment')).toMatchObject({ verdict: 'unresolved', reasons: 'counterparty-profile-missing' });
    expect(String(document['reasons']).split(',')).toContain('stamp-duty-candidate');
    expect(String(document['findings'])).not.toContain('自社が甲・乙のどちらか決められませんでした');
  });

  it('正常: テキスト添付があれば画像は読まない（文字起こしを呼ばない）。limit で添付の件数を絞る', async () => {
    const model = contractModel();
    const { rows: rowsProvider } = await provider(model);
    const rows = await rowsProvider.rows(scope, { documents: [textDocument('a.pdf'), textDocument('b.txt')], images: [{ name: 'p1.png', dataUrl: PNG }] }, { limit: 1 });
    expect([...new Set(rows.map((row) => row['file_name']))]).toEqual(['a.pdf']);
    expect(model.requests.map(kindOf)).not.toContain('transcribe');
    const both = await rowsProvider.rows(scope, { documents: [textDocument('a.pdf'), textDocument('b.txt')], images: [] });
    expect([...new Set(both.map((row) => row['file_name']))]).toEqual(['a.pdf', 'b.txt']);
    expect(both.filter((row) => row['row_type'] === 'document')).toHaveLength(2);
  });

  it('正常: テキスト添付が無ければ画像を 1 通の契約書のページとして文字起こししてから読む', async () => {
    const half = SAMPLE_CONTRACT_BODY.indexOf('第4条');
    const model = contractModel({ pages: [SAMPLE_CONTRACT_BODY.slice(0, half), SAMPLE_CONTRACT_BODY.slice(half)] });
    const { rows: rowsProvider } = await provider(model);
    const rows = await rowsProvider.rows(scope, { documents: [], images: [{ name: 'page1.png', dataUrl: PNG }, { name: 'page2.png', dataUrl: 'data:image/jpeg;base64,/9j/' }] });
    expect(model.requests.slice(0, 2).map(kindOf)).toEqual(['transcribe', 'transcribe']);
    expect(userText(model.requests[0]!)).toContain('"fileName":"page1.png"');
    expect(userText(model.requests[1]!)).toContain('[image:data:image/jpeg;base64,/9j/]');
    expect(new Set(rows.map((row) => row['file_name']))).toEqual(new Set(['page1.png']));
    // ページをつないだ本文でも引用は照合できる。
    expect(rows.find((row) => row['topic_id'] === 'jurisdiction')).toMatchObject({ present: true, quote_verified: true });
  });

  it('境界: 文字起こしで何も読めなければ、読めなかった旨の本文で判定を続ける（条項はすべて見つからない）', async () => {
    const model = contractModel({ pages: ['', '   '] });
    const { rows: rowsProvider } = await provider(model);
    const rows = await rowsProvider.rows(scope, { documents: [], images: [{ name: 'blank.png', dataUrl: PNG }, { name: 'blank2.png', dataUrl: PNG }] });
    expect(model.requests.map(kindOf)).toEqual(['transcribe', 'transcribe']);
    expect(rows.slice(0, -1).every((row) => row['present'] === false)).toBe(true);
    expect(String(rows.at(-1)!['findings'])).toContain('自社が甲・乙のどちらか決められませんでした');
  });

  it('境界: 添付が 0 件なら行も 0 件（落とすのは行ソースの責務）で、モデルを呼ばない', async () => {
    const model = contractModel();
    const { rows: rowsProvider } = await provider(model);
    expect(await rowsProvider.rows(scope, { documents: [], images: [] })).toEqual([]);
    expect(model.requests).toEqual([]);
  });

  it('正常: llmCriteria: false は LLM 基準を問わず llm-unavailable のまま判定する', async () => {
    const model = contractModel();
    const { rows: rowsProvider } = await provider(model);
    const rows = await rowsProvider.rows(scope, { documents: [textDocument()], images: [] }, { llmCriteria: false });
    expect(model.requests.map(kindOf)).toEqual(['extract']);
    expect(rows.find((row) => row['topic_id'] === 'liability_cap')).toMatchObject({ verdict: 'unresolved', reasons: 'llm-unavailable' });
  });

  it('正常: 甲乙は本文の検出を優先し、足りない側を抽出の当事者名で補う。自社名が無ければ自社側を決めない', async () => {
    // 乙の「以下」が無い本文: 甲は本文から検出し、乙は抽出の当事者名で補う。抽出の甲の名前は検出に負ける
    // （抽出の「別の甲」が勝つと自社名に当たらず、自社側が決まらない）。
    const body = SAMPLE_CONTRACT_BODY.replace('（以下「乙」という。）', '');
    const model = contractModel({ parties: { A: { label: '甲', name: '別の甲' }, B: { label: '乙', name: '抽出が読んだ乙' } } });
    const { rows: rowsProvider } = await provider(model);
    const rows = await rowsProvider.rows(scope, { documents: [textDocument('c.txt', body)], images: [] });
    expect(JSON.parse(String(rows.at(-1)!['value_json']))).toMatchObject({ counterparty: '抽出が読んだ乙', ourParty: 'A' });
    expect(OUR_COMPANY).not.toBe('別の甲');

    const anonymous = await provider(contractModel(), playbookFixture('pb-anon', { isDefault: true, ourCompanyNames: [] }));
    const anonymousRows = await anonymous.rows.rows(scope, { documents: [textDocument()], images: [] });
    expect(JSON.parse(String(anonymousRows.at(-1)!['value_json']))).toEqual({ counterparty: null, ourParty: null, contractNature: 'jun_inin' });
    expect(String(anonymousRows.at(-1)!['findings'])).toContain('審査基準の自社名を登録すると決まります');
  });

  it('異常: 一部の束が読めなければ文書の行にその条文を並べ、該当トピックは extraction-failed', async () => {
    const body = SAMPLE_CONTRACT_BODY.replace(QUOTES.liability, `${QUOTES.liability}\n2 ${'乙の責任は本条の定めによる。'.repeat(50)}`);
    const playbook = playbookFixture('pb-1', { isDefault: true, extraction: { scanAllArticles: false, chunkMaxChars: 1000 } });
    const plan = planChunks(body, segmentArticles(body, singlePage(body), 1000), enabledTopics(playbook), { chunkMaxChars: 1000, scanAllArticles: false });
    const failing = plan.chunks.find((chunk) => chunk.topicIds.includes('liability_cap'))!;
    expect(plan.chunks.length).toBeGreaterThan(1);
    const { rows: rowsProvider } = await provider(contractModel({ failWhen: (ids) => ids.includes('liability_cap') }), playbook);
    const rows = await rowsProvider.rows(scope, { documents: [textDocument('long.txt', body)], images: [] });
    expect(String(rows.at(-1)!['findings'])).toContain(`読み取りに失敗した条文: ${failing.articleRefs.join('、')}`);
    expect(rows.find((row) => row['topic_id'] === 'liability_cap')).toMatchObject({ verdict: 'unresolved', reasons: 'extraction-failed' });
    expect(rows.find((row) => row['topic_id'] === 'term')).toMatchObject({ present: true });
  });

  it('例外: 抽出が全部失敗・審査基準が無いときは投げる（読めた分だけ返さない）', async () => {
    const { rows: rowsProvider } = await provider(contractModel({ failWhen: () => true }));
    await expect(rowsProvider.rows(scope, { documents: [textDocument()], images: [] })).rejects.toThrow(ContractExtractionSchemaError);
    const { rows: other } = await provider(contractModel());
    await expect(other.rows(scope, { documents: [textDocument()], images: [] }, { playbookId: 'missing' })).rejects.toThrow(ContractPlaybookNotFoundError);
  });

  it('スキーマ: 公開している行スキーマはノードの固定スキーマそのもの', () => {
    expect(CONTRACT_REVIEW_DRAFT_ROW_SCHEMA).toBe(CONTRACT_REVIEW_DRAFT_SCHEMA);
  });
});

describe('findingText', () => {
  const reason = (code: Reason['code'], detail?: Reason['detail']): Reason => ({ code, ...(detail === undefined ? {} : { detail }) });

  it('文書全体の所見の理由コードを 1 行の説明にする', () => {
    expect(findingText(reason('stamp-duty-candidate', { name: '第2号文書', amount: 2000, electronic: false }))).toBe('印紙税: 第2号文書 に当たる可能性があります（税額 2000 円。紙で締結するなら要否と金額を確かめてください）');
    expect(findingText(reason('stamp-duty-candidate', { name: '第2号文書', amount: null, electronic: false }))).toContain('税額 不明');
    expect(findingText(reason('stamp-duty-candidate', { name: '第7号文書', amount: 0, electronic: true }))).toBe('印紙税: 第7号文書 の候補ですが、電子契約は課税文書の作成に当たらないとされます（社内の判断に従ってください）');
    expect(findingText(reason('stamp-duty-amount-unknown', { name: '第2号文書' }))).toBe('印紙税: 第2号文書 の候補ですが、契約金額が分からず税額を決められません');
    expect(findingText(reason('deadline-mismatch', { message: '満了日が一致しません' }))).toBe('期限の突き合わせ: 満了日が一致しません');
    expect(findingText(reason('payment-basis-acceptance'))).toBe('支払期日が検収日基準で、受領日からの日数が決まりません');
    // 説明を持たないコードはコードのまま（黙って消さない）。
    expect(findingText(reason('review-stale'))).toBe('review-stale');
  });
});
