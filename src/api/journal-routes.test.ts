/**
 * /journal ルートのテスト。
 *
 * createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` で検証する。
 * ここで守りたいのは **UI（`src/ui/api/tool-api.ts`）が期待する形**: パス・クエリ名・応答の包み方
 * （`{ chart } / { rules } / { rule } / { documents } / { document } / { entries } / { entry } /
 * { presets } / { content } / { result }`、削除は 204）。包みを変えると画面は静かに undefined を掴む。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { explicitRouteAuthorization } from './authorization';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;

/** 最小の科目マスタ（保存の往復に使う）。 */
function chartBody() {
  return {
    scope: SCOPE,
    accounts: [
      { id: 'expense.supplies', name: '消耗品費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: ['消耗品'], enabled: true, sortOrder: 10 },
      { id: 'asset.cash', name: '現金', category: 'asset', defaultTaxCode: 'JP-NA', aliases: [], enabled: true, sortOrder: 20 },
    ],
    dimensions: [{ id: 'sub_account', name: '補助科目', values: [] }],
    taxCategories: [
      { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true },
      { code: 'JP-NA', name: '対象外', side: 'none', enabled: true },
    ],
  };
}

function ruleBody(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    rule: {
      name: 'テスト消耗品',
      enabled: true,
      mode: 'auto',
      priority: 100,
      scope: {},
      conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'テスト' }],
      outcome: {
        lines: [
          { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' },
          { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
        ],
      },
      askIf: [],
      requiredFacts: [],
      ...overrides,
    },
  };
}

function documentBody(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    kind: 'invoice',
    source: { type: 'structured' },
    facts: { direction: 'out', issuerName: 'テスト商事', transactionDate: '2026-09-10', grandTotal: 1100, description: 'テスト仕入' },
    ...overrides,
  };
}

describe('journal routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    // 以降のテストは科目マスタが保存済みであることを前提にする。
    expect((await server.inject({ method: 'PUT', url: '/journal/chart', payload: chartBody() })).statusCode).toBe(200);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('科目マスタ', () => {
    it('GET /journal/chart は { chart } を返す。未保存のワークスペースは標準セット（保存はしない）', async () => {
      const res = await server.inject({ method: 'GET', url: `/journal/chart?${scopeQuery}` });
      expect(res.statusCode).toBe(200);
      const { chart } = res.json();
      expect(chart.accounts).toHaveLength(2);
      // 保存済みのワークスペースは saved=true（画面はこれを見て件数を出す）。
      expect(chart.saved).toBe(true);
      expect(chart.dimensions[0]).toMatchObject({ id: 'sub_account' });
      expect(typeof chart.updatedAt).toBe('string');

      // 別ワークスペースは保存していないので標準セットが返り、DB には書かれない。
      const fresh = createApp({ profile: 'test' });
      const freshServer = buildServer(fresh, { authentication: new SingleUserAuthentication(SCOPE) });
      try {
        const first = await freshServer.inject({ method: 'GET', url: `/journal/chart?${scopeQuery}` });
        expect(first.json().chart.accounts.length).toBeGreaterThan(50);
        // 標準セットのままは saved=false。件数だけ出して「設定済み」に見せないための旗。
        expect(first.json().chart.saved).toBe(false);
        expect(await fresh.journalChartRepo.get(SCOPE)).toBeNull();
      } finally {
        await freshServer.close();
        fresh.close();
      }
    });

    it('POST /journal/chart/reset は標準セットを保存して { chart } を返す', async () => {
      const res = await server.inject({ method: 'POST', url: '/journal/chart/reset', payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(200);
      expect(res.json().chart.accounts.length).toBeGreaterThan(50);
      expect(await app.journalChartRepo.get(SCOPE)).not.toBeNull();
    });

    it('GET /journal/chart/export は { content }（BOM 付き CSV）、POST /journal/chart/import は { chart }', async () => {
      const exported = await server.inject({ method: 'GET', url: `/journal/chart/export?${scopeQuery}` });
      expect(exported.statusCode).toBe(200);
      const { content } = exported.json();
      expect(content.startsWith('﻿')).toBe(true);
      expect(content).toContain('id,code,name,category,defaultTaxCode,aliases,enabled');
      expect(content).toContain('expense.supplies');

      const imported = await server.inject({
        method: 'POST', url: '/journal/chart/import',
        payload: { scope: SCOPE, content: 'id,code,name,category,defaultTaxCode,aliases,enabled\r\nexpense.misc,,雑費,expense,JP-IN-10-S,その他;諸経費,true\r\n' },
      });
      expect(imported.statusCode).toBe(200);
      const { chart } = imported.json();
      // 勘定科目だけが置き換わり、税区分と補助軸は残る。
      expect(chart.accounts).toEqual([expect.objectContaining({ id: 'expense.misc', name: '雑費', aliases: ['その他', '諸経費'], enabled: true })]);
      expect(chart.taxCategories).toHaveLength(2);
      expect(chart.dimensions).toHaveLength(1);
    });

    it('異常: 未知の category は 400 JOURNAL_DOMAIN（行番号つき）', async () => {
      const res = await server.inject({
        method: 'POST', url: '/journal/chart/import',
        payload: { scope: SCOPE, content: 'id,name,category\r\nx,雑費,nope\r\n' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'JOURNAL_DOMAIN' });
      expect(res.json().error.message).toContain('row 2');
    });
  });

  describe('ルール', () => {
    it('POST /journal/rules は { rule }、GET は { rules }、DELETE は 204', async () => {
      const created = await server.inject({ method: 'POST', url: '/journal/rules', payload: ruleBody() });
      expect(created.statusCode).toBe(200);
      const { rule } = created.json();
      expect(rule).toMatchObject({ name: 'テスト消耗品', mode: 'auto', priority: 100 });
      expect(rule.id).toBeTruthy();
      // 応答に tenant は含めない（スコープは Principal 由来）。
      expect(rule).not.toHaveProperty('tenant');

      const listed = await server.inject({ method: 'GET', url: `/journal/rules?${scopeQuery}` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().rules).toHaveLength(1);

      const deleted = await server.inject({ method: 'DELETE', url: `/journal/rules/${rule.id}?${scopeQuery}` });
      expect(deleted.statusCode).toBe(204);
      expect((await server.inject({ method: 'GET', url: `/journal/rules?${scopeQuery}` })).json().rules).toEqual([]);
    });

    it('異常: 存在しないルールの削除は 404 JOURNAL_RULE_NOT_FOUND', async () => {
      const res = await server.inject({ method: 'DELETE', url: `/journal/rules/missing?${scopeQuery}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('JOURNAL_RULE_NOT_FOUND');
    });

    it('異常: マスタに無い科目を指すルールは 400 JOURNAL_DOMAIN', async () => {
      const res = await server.inject({
        method: 'POST', url: '/journal/rules',
        payload: ruleBody({ outcome: { lines: [
          { side: 'debit', accountId: 'expense.nope', taxCode: 'JP-IN-10-S', amount: 'total' },
          { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
        ] } }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'JOURNAL_DOMAIN' });
      expect(res.json().error.message).toContain('expense.nope');
    });

    it('POST /journal/rules/test は { result } を返し、何も保存しない', async () => {
      const document = (await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() })).json().document;
      const res = await server.inject({
        method: 'POST', url: '/journal/rules/test',
        payload: { ...ruleBody(), documentIds: [document.id, 'missing'] },
      });
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      // 見つからない文書は結果に現れない。
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ documentId: document.id, matched: true });
      expect(result[0].entry.lines).toHaveLength(2);
      expect((await server.inject({ method: 'GET', url: `/journal/rules?${scopeQuery}` })).json().rules).toEqual([]);
    });
  });

  describe('文書', () => {
    it('POST は { document }、GET 一覧は { documents }（要約）、GET 単体は { document }（本体つき）', async () => {
      const created = await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() });
      expect(created.statusCode).toBe(200);
      const { document } = created.json();
      expect(document).toMatchObject({ kind: 'invoice', status: 'extracted' });
      expect(document).not.toHaveProperty('tenant');
      // 保存時に正規化される（摘要の正規化と相手先の切り出し）。
      expect(document.facts.descriptionNorm).toBe('テスト仕入');

      const listed = await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}` });
      expect(listed.statusCode).toBe(200);
      const { documents } = listed.json();
      expect(documents).toHaveLength(1);
      // 一覧は要約（source を持たない）。
      expect(documents[0]).not.toHaveProperty('source');
      expect(documents[0]).toMatchObject({ id: document.id, sourceType: 'structured', transactionDate: '2026-09-10', grandTotal: 1100 });

      const single = await server.inject({ method: 'GET', url: `/journal/documents/${document.id}?${scopeQuery}` });
      expect(single.statusCode).toBe(200);
      expect(single.json().document.source).toEqual({ type: 'structured' });
    });

    it('一覧は status / kind / from / to / limit で絞り込める（UI のフィルタ名と一致）', async () => {
      await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() });
      await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody({ kind: 'receipt', facts: { direction: 'out', transactionDate: '2026-08-01', grandTotal: 500 } }) });

      expect((await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}&kind=receipt` })).json().documents).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}&status=extracted` })).json().documents).toHaveLength(2);
      expect((await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}&from=2026-09-01` })).json().documents).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}&to=2026-08-31` })).json().documents).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}&limit=1` })).json().documents).toHaveLength(1);
    });

    it('PUT はパスの id を対象にし、facts を変えると未判定へ戻る。DELETE は 204', async () => {
      const document = (await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() })).json().document;
      const updated = await server.inject({
        method: 'PUT', url: `/journal/documents/${document.id}`,
        payload: documentBody({ facts: { direction: 'out', issuerName: 'テスト商事', transactionDate: '2026-09-11', grandTotal: 2200, description: 'テスト仕入' } }),
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().document).toMatchObject({ id: document.id, status: 'extracted' });
      expect(updated.json().document.facts.grandTotal).toBe(2200);

      const deleted = await server.inject({ method: 'DELETE', url: `/journal/documents/${document.id}?${scopeQuery}` });
      expect(deleted.statusCode).toBe(204);
      expect((await server.inject({ method: 'GET', url: `/journal/documents/${document.id}?${scopeQuery}` })).statusCode).toBe(404);
    });

    it('異常: 存在しない文書の取得は 404 JOURNAL_DOCUMENT_NOT_FOUND', async () => {
      const res = await server.inject({ method: 'GET', url: `/journal/documents/missing?${scopeQuery}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('JOURNAL_DOCUMENT_NOT_FOUND');
    });
  });

  describe('CSV 取込とプリセット', () => {
    it('GET /journal/csv-presets は { presets }（列名署名つき）', async () => {
      const res = await server.inject({ method: 'GET', url: '/journal/csv-presets' });
      expect(res.statusCode).toBe(200);
      const { presets } = res.json();
      expect(presets.map((preset: { id: string }) => preset.id)).toEqual(expect.arrayContaining(['generic', 'rakuten-bank', 'mufg', 'smbc', 'yucho', 'rakuten-card']));
      expect(presets[0]).toHaveProperty('headerSignature');
    });

    it('POST /journal/documents/import-csv は { result }。読めない行は skippedRows へ積んで残りを保存する', async () => {
      const content = [
        '日付,摘要,出金,入金,残高',
        '2026-09-10,アマゾン ウェブ サービス,1100,,50000',
        'これは合計行です,,,,',
        '2026-09-11,振込 ｶ)ヤマダ,,20000,70000',
        '',
      ].join('\r\n');
      const res = await server.inject({ method: 'POST', url: '/journal/documents/import-csv', payload: { scope: SCOPE, content, accountHint: 'テスト銀行' } });
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.preset).toBe('generic');
      expect(result.imported).toHaveLength(2);
      // 行番号はヘッダ行を 1 とした 1 始まり（表計算ソフトの行番号と一致）。
      expect(result.skippedRows).toEqual([{ row: 3, reason: expect.stringContaining('row 3') }]);
      expect(result.imported[0]).not.toHaveProperty('source');
    });

    it('異常: プリセットが決まらない CSV は 400 JOURNAL_CSV_IMPORT（row 無し）', async () => {
      const res = await server.inject({ method: 'POST', url: '/journal/documents/import-csv', payload: { scope: SCOPE, content: 'foo,bar\r\n1,2\r\n' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'JOURNAL_CSV_IMPORT' });
      expect(res.json().error.row).toBeUndefined();
    });

    it('異常: 引用符が閉じていない CSV は 400 JOURNAL_CSV_IMPORT で row を本文に載せる', async () => {
      const res = await server.inject({ method: 'POST', url: '/journal/documents/import-csv', payload: { scope: SCOPE, content: '日付,摘要,出金,入金,残高\r\n2026-09-10,"閉じていない,1100,,1\r\n' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'JOURNAL_CSV_IMPORT', row: 2 });
    });
  });

  describe('判定と仕訳', () => {
    async function seedDecided() {
      await server.inject({ method: 'POST', url: '/journal/rules', payload: ruleBody() });
      const document = (await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() })).json().document;
      const judged = await server.inject({ method: 'POST', url: '/journal/documents/judge', payload: { scope: SCOPE } });
      return { document, judged };
    }

    it('POST /journal/documents/judge は { result }（judged / decided / undecided / skipped）', async () => {
      const { judged } = await seedDecided();
      expect(judged.statusCode).toBe(200);
      const { result } = judged.json();
      expect(result).toMatchObject({ decided: 1, undecided: 0, skipped: 0 });
      expect(result.judged).toHaveLength(1);
      expect(result.judged[0]).toMatchObject({ status: 'decided' });
      expect(result.judged[0].judgment).toMatchObject({ stage: 'decided' });
      expect(result.judged[0].entryId).toBeTruthy();
    });

    it('ルールが無ければ undecided（no-rule）— エラーにはしない', async () => {
      await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() });
      const res = await server.inject({ method: 'POST', url: '/journal/documents/judge', payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ decided: 0, undecided: 1 });
      expect(res.json().result.judged[0].judgment.reasons).toEqual([{ code: 'no-rule' }]);
    });

    it('見積・納品は判定キューに乗らず skipped', async () => {
      await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody({ kind: 'quotation' }) });
      const res = await server.inject({ method: 'POST', url: '/journal/documents/judge', payload: { scope: SCOPE } });
      expect(res.json().result).toMatchObject({ skipped: 1, decided: 0, undecided: 0 });
      expect(res.json().result.judged[0].judgment).toMatchObject({ stage: 'skipped', reason: 'document-kind' });
    });

    it('GET /journal/entries は { entries }、確定は { entry }、DELETE は 204', async () => {
      await seedDecided();
      const listed = await server.inject({ method: 'GET', url: `/journal/entries?${scopeQuery}` });
      expect(listed.statusCode).toBe(200);
      const { entries } = listed.json();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: 'draft', decidedBy: 'rule' });
      expect(entries[0]).not.toHaveProperty('tenant');
      // 科目名はマスタから写されている。
      expect(entries[0].lines[0]).toMatchObject({ accountId: 'expense.supplies', accountName: '消耗品費' });

      const confirmed = await server.inject({ method: 'POST', url: `/journal/entries/${entries[0].id}/confirm`, payload: { scope: SCOPE } });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().entry.status).toBe('confirmed');

      expect((await server.inject({ method: 'GET', url: `/journal/entries?${scopeQuery}&status=confirmed` })).json().entries).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: `/journal/entries?${scopeQuery}&status=draft` })).json().entries).toEqual([]);

      const deleted = await server.inject({ method: 'DELETE', url: `/journal/entries/${entries[0].id}?${scopeQuery}` });
      expect(deleted.statusCode).toBe(204);
    });

    it('POST /journal/entries は手入力の仕訳を作り、科目名をマスタから写し直す', async () => {
      const res = await server.inject({
        method: 'POST', url: '/journal/entries',
        payload: {
          scope: SCOPE, date: '2026-09-10', description: '手入力', invoiceStatus: 'qualified',
          lines: [
            { side: 'debit', accountId: 'expense.supplies', accountName: 'クライアントが送った嘘の名前', taxCode: 'JP-IN-10-S', amount: 1100 },
            { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const { entry } = res.json();
      expect(entry.decidedBy).toBe('manual');
      expect(entry.lines[0].accountName).toBe('消耗品費');
    });

    it('異常: 貸借が一致しない仕訳は 400 JOURNAL_DOMAIN', async () => {
      const res = await server.inject({
        method: 'POST', url: '/journal/entries',
        payload: {
          scope: SCOPE, date: '2026-09-10', description: 'ずれ', invoiceStatus: 'qualified',
          lines: [
            { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 1100 },
            { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1000 },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('JOURNAL_DOMAIN');
    });

    it('異常: 存在しない仕訳の確定は 404 JOURNAL_ENTRY_NOT_FOUND', async () => {
      const res = await server.inject({ method: 'POST', url: '/journal/entries/missing/confirm', payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('JOURNAL_ENTRY_NOT_FOUND');
    });
  });

  describe('CSV 出力', () => {
    it('GET /journal/export は { result }（format / fileName / content / entryCount）', async () => {
      await server.inject({ method: 'POST', url: '/journal/rules', payload: ruleBody() });
      await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() });
      await server.inject({ method: 'POST', url: '/journal/documents/judge', payload: { scope: SCOPE } });

      const res = await server.inject({ method: 'GET', url: `/journal/export?${scopeQuery}&format=generic` });
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.format).toBe('generic');
      expect(result.fileName).toMatch(/^journal-\d{4}-\d{2}-\d{2}\.csv$/u);
      expect(result.entryCount).toBe(1);
      expect(result.content.startsWith('﻿')).toBe(true);
      expect(result.content).toContain('entry_id,line_no,date');
      expect(result.content).toContain('消耗品費');
      // 既定では状態を動かさない。
      expect((await server.inject({ method: 'GET', url: `/journal/entries?${scopeQuery}&status=draft` })).json().entries).toHaveLength(1);
    });

    it('markExported=true は出力した仕訳を exported にする', async () => {
      await server.inject({ method: 'POST', url: '/journal/rules', payload: ruleBody() });
      await server.inject({ method: 'POST', url: '/journal/documents', payload: documentBody() });
      await server.inject({ method: 'POST', url: '/journal/documents/judge', payload: { scope: SCOPE } });

      const res = await server.inject({ method: 'GET', url: `/journal/export?${scopeQuery}&format=generic&markExported=true` });
      expect(res.statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: `/journal/entries?${scopeQuery}&status=exported` })).json().entries).toHaveLength(1);
    });

    it('異常: generic 以外の形式はまだ無いので 400 JOURNAL_EXPORT', async () => {
      const res = await server.inject({ method: 'GET', url: `/journal/export?${scopeQuery}&format=yayoi` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'JOURNAL_EXPORT' });
      expect(res.json().error.message).toContain('yayoi');
    });
  });

  describe('機能フラグと認可', () => {
    it('GET /runtime/capabilities は journal を含む（test プロファイルはどちらも false）', async () => {
      const res = await server.inject({ method: 'GET', url: '/runtime/capabilities' });
      expect(res.statusCode).toBe(200);
      expect(res.json().journal).toEqual({ extraction: { enabled: false, vision: false }, hearing: { enabled: false } });
    });

    it('フェーズ 2 の抽出・ヒアリングも登録されている（test プロファイルはモデル未設定なので 409 / 検証エラー）', async () => {
      // 404（未登録）ではないことがここでの主眼。抽出はモデル未設定なので 409、
      // ヒアリングは documentId が無いので本文の検証で 400。
      const extract = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, text: 'テスト' } });
      expect(extract.statusCode).toBe(409);
      expect(extract.json().error).toMatchObject({ code: 'JOURNAL_EXTRACTION_UNAVAILABLE' });
      expect((await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE } })).statusCode).toBe(400);
    });

    it('全ルートが認可表に載っている（参照は read、変更は edit）', () => {
      expect(explicitRouteAuthorization('GET', '/journal/chart')).toMatchObject({ action: 'read', kind: 'workspace' });
      expect(explicitRouteAuthorization('PUT', '/journal/chart')).toMatchObject({ action: 'edit', audit: true });
      expect(explicitRouteAuthorization('POST', '/journal/rules')).toMatchObject({ action: 'edit', audit: true });
      expect(explicitRouteAuthorization('DELETE', '/journal/entries/:id')).toMatchObject({ action: 'edit', audit: true });
      expect(explicitRouteAuthorization('GET', '/journal/export')).toMatchObject({ action: 'read', audit: true });
      // フェーズ 2: 抽出はモデルを回すので edit、参照は read、受け入れだけ監査する。
      expect(explicitRouteAuthorization('POST', '/journal/documents/extract')).toMatchObject({ action: 'edit', kind: 'workspace' });
      expect(explicitRouteAuthorization('GET', '/journal/hearings')).toMatchObject({ action: 'read', kind: 'workspace' });
      expect(explicitRouteAuthorization('GET', '/journal/hearings/:id')).toMatchObject({ action: 'read', kind: 'workspace' });
      expect(explicitRouteAuthorization('POST', '/journal/hearings')).toMatchObject({ action: 'edit' });
      expect(explicitRouteAuthorization('POST', '/journal/hearings/:id/answers')).toMatchObject({ action: 'edit' });
      expect(explicitRouteAuthorization('POST', '/journal/hearings/:id/accept')).toMatchObject({ action: 'edit', audit: true });
      expect(explicitRouteAuthorization('POST', '/journal/hearings/:id/cancel')).toMatchObject({ action: 'edit' });
      expect(server.unmappedAuthorizationRoutes.filter((route) => route.includes('/journal'))).toEqual([]);
    });
  });
});