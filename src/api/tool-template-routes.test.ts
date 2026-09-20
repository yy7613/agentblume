/**
 * ツールテンプレートの HTTP routes（v43 §5）。
 *
 * 一覧は同梱の本物のテンプレート（`templates/tools/*.json`）を読む配線をそのまま通す。
 * 候補・実体化は登録済みのファイルデータソースに対して、実エンジンで実体化・検査まで走らせる。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { authenticated, type AuthenticationPort } from '../application/security/authentication';
import type { App } from '../composition/root';
import { createApp } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { explicitRouteAuthorization } from './authorization';
import { buildServer } from './server';

/** 既定の認証（single-user）が解決するスコープ。データソースはこのスコープに登録する。 */
const scope = { tenantId: 'local', workspaceId: 'default' };

const REGION_CSV = [
  '時点,地域コード,地域,人口,注記',
  '2023年,01000,北海道,5200,',
  '2023年,13000,東京都,14000,',
  '2022年,01000,北海道,5250,',
  '2022年,13000,東京都,13900,',
  '2023年5月,13000,東京都,13950,速報',
].join('\n');

const WORKERS_CSV = [
  '時点,地域コード,地域,就業者数,注記',
  '2023年,01000,北海道,2500,',
  '2023年,13000,東京都,7000,',
  '2022年,01000,北海道,2480,',
  '2022年,13000,東京都,6950,',
].join('\n');

const SERIES_VALUES = { source: 'ds-population', periodColumn: '時点', valueColumns: ['人口'], categoryColumn: '地域', defaultGranularity: 'year', limit: 12 };

describe('tool template routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app);
    for (const [id, name, csv] of [['ds-population', '人口', REGION_CSV], ['ds-workers', '就業者数', WORKERS_CSV]] as const) {
      await app.dataSourceRepo.save(
        { id, tenant: scope, name, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: csv.length, createdAt: '', updatedAt: '' },
        csv,
      );
    }
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('GET /tool-templates', () => {
    it('正常: 同梱テンプレートをスロット宣言つきで返し、読めなかったファイルの一覧も一緒に返す', async () => {
      const response = await server.inject({ method: 'GET', url: `/tool-templates?tenantId=${scope.tenantId}&workspaceId=${scope.workspaceId}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.invalid).toEqual([]);
      const series = body.templates.find((template: { id: string }) => template.id === 'period-series');
      expect(series).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), sources: { min: 1, max: 1 } });
      expect(series.title.ja).toBe('時系列の取り出し');
      expect(series.slots.find((slot: { name: string }) => slot.name === 'valueColumns')).toMatchObject({ kind: 'column', role: 'value', multiple: { min: 1, max: 5 } });
      // ノード・エッジは人が選ぶ材料ではないので載せない。
      expect(series).not.toHaveProperty('nodes');
    });
  });

  describe('POST /tool-templates/:id/slot-candidates', () => {
    it('正常: スロットごとの候補を、型・実在値の例・粒度つきで返す', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/period-series/slot-candidates',
        payload: { scope, dataSourceIds: ['ds-population'] },
      });
      expect(response.statusCode).toBe(200);
      const { candidates } = response.json();
      const at = (slot: string) => candidates.find((candidate: { slot: string }) => candidate.slot === slot);
      expect(at('source').options).toEqual([{ value: 'ds-population', name: '人口' }]);
      expect(at('valueColumns').options).toEqual([{ value: '人口', type: 'number' }]);
      expect(at('categoryColumn').options.find((option: { value: string }) => option.value === '地域').examples).toEqual(['北海道', '東京都']);
      expect(at('periodColumn').options[0].granularities).toEqual({ year: 4, month: 1 });
      expect(at('limit')).toEqual({ slot: 'limit', kind: 'number', range: { min: 1, max: 100 } });
    });

    it('正常: 部分的なスロット値を渡すと、それに依存する候補が絞られる', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/ratio-of-two-sources/slot-candidates',
        payload: { scope, dataSourceIds: ['ds-population', 'ds-workers'], values: { numeratorSource: 'ds-workers', denominatorSource: 'ds-population' } },
      });
      expect(response.statusCode).toBe(200);
      const { candidates } = response.json();
      const numerator = candidates.find((candidate: { slot: string }) => candidate.slot === 'numerator');
      expect(numerator.options).toEqual([{ value: '就業者数', type: 'number' }]);
      const joinKeys = candidates.find((candidate: { slot: string }) => candidate.slot === 'joinKeys');
      expect(joinKeys.options.map((option: { value: string }) => option.value)).toEqual(expect.arrayContaining(['時点', '地域コード', '地域']));
      expect(joinKeys.options[0].overlap).toBeGreaterThan(0);
    });

    it('異常: 知らないテンプレート id は 404（使える id を本文に挙げる）', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/no-such-template/slot-candidates',
        payload: { scope, dataSourceIds: ['ds-population'] },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('TOOL_TEMPLATE_NOT_FOUND');
      expect(response.json().error.message).toContain('period-series');
    });

    it('異常: データソースの数がテンプレートの読む数と違えば 422（いくつ選べばよいかを言う）', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/period-series/slot-candidates',
        payload: { scope, dataSourceIds: ['ds-population', 'ds-workers'] },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatchObject({ code: 'TOOL_TEMPLATE', message: expect.stringContaining('exactly 1 data source') });
    });

    it('異常: 本文の形が違えば 400（どの項目が悪いかを言う）', async () => {
      const response = await server.inject({ method: 'POST', url: '/tool-templates/period-series/slot-candidates', payload: { scope } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
      expect(response.json().error.message).toContain('dataSourceIds');
    });
  });

  describe('POST /tool-templates/:id/instantiate', () => {
    it('正常: グラフ・引数スキーマ・Agent Tool 契約を返し、Tool は保存しない', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/period-series/instantiate',
        payload: { scope, dataSourceIds: ['ds-population'], values: SERIES_VALUES, language: 'ja' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.template).toEqual({ id: 'period-series', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
      expect(body.graph.nodes.map((node: { type: string }) => node.type)).toContain('parse-period');
      expect(body.inputSchema.columns.map((column: { name: string }) => column.name)).toEqual(['granularity', 'period_from', 'period_to', 'categories']);
      expect(body.agentTool).toMatchObject({ name: 'period-series', description: expect.stringContaining('人口') });
      expect(body.pendingExpressions).toEqual([]);
      await expect(app.repo.listVersions(scope, 'period-series')).resolves.toEqual([]);
    });

    it('正常: 式を AI に書かせるテンプレートは pendingExpressions つきで返る（式は空のまま）', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/custom-computation/instantiate',
        payload: {
          scope, dataSourceIds: ['ds-population'], language: 'ja',
          values: { source: 'ds-population', periodColumn: '時点', valueColumns: ['人口'], outputColumn: '千人', computationIntent: '人口を千で割る', defaultGranularity: 'year', limit: 12 },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().pendingExpressions).toEqual([{ nodeId: 'calc', intent: '人口を千で割る' }]);
    });

    it('異常: スロット違反は 422 で、どの欄を直せばよいかを slots に載せる', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/period-series/instantiate',
        payload: { scope, dataSourceIds: ['ds-population'], values: { ...SERIES_VALUES, valueColumns: ['世帯数'] }, language: 'ja' },
      });
      expect(response.statusCode).toBe(422);
      const { error } = response.json();
      expect(error.code).toBe('TOOL_TEMPLATE_SLOTS');
      expect(error.slots).toEqual([{ slot: 'valueColumns', message: expect.stringContaining('世帯数') }]);
      expect(error.slots[0].message).toContain('choose one of');
    });

    it('異常: 知らないテンプレート id は 404', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/nope/instantiate',
        payload: { scope, dataSourceIds: ['ds-population'], values: {}, language: 'ja' },
      });
      // status だけでは「ルートが無い」と区別が付かないので、写像した code まで見る。
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('TOOL_TEMPLATE_NOT_FOUND');
    });

    it('境界: ソース数が足りなければ 422（2 つ要るテンプレートに 1 つ）', async () => {
      const response = await server.inject({
        method: 'POST', url: '/tool-templates/ratio-of-two-sources/instantiate',
        payload: { scope, dataSourceIds: ['ds-population'], values: {}, language: 'ja' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.message).toContain('exactly 2 data source');
    });
  });

  describe('認可', () => {
    it('従来どおり: 一覧と候補は tool の read、実体化は tool の execute を要求する', () => {
      expect(explicitRouteAuthorization('GET', '/tool-templates')).toMatchObject({ action: 'read', kind: 'tool' });
      expect(explicitRouteAuthorization('POST', '/tool-templates/:id/slot-candidates')).toMatchObject({ action: 'read', kind: 'tool' });
      expect(explicitRouteAuthorization('POST', '/tool-templates/:id/instantiate')).toMatchObject({ action: 'execute', kind: 'tool' });
    });

    it('例外: viewer は一覧を読めるが、実体化（execute）は 403', async () => {
      await server.close();
      const authentication: AuthenticationPort = {
        mode: 'token', required: true,
        authenticate: async () => authenticated({ subject: 'viewer', tenantId: scope.tenantId, workspaceId: scope.workspaceId, roles: ['viewer' as AuthorizationRole] }),
      };
      server = buildServer(app, { authentication, authorization: new RoleMatrixAuthorization() });
      const listed = await server.inject({ method: 'GET', url: `/tool-templates?tenantId=${scope.tenantId}&workspaceId=${scope.workspaceId}` });
      expect(listed.statusCode).toBe(200);
      const denied = await server.inject({
        method: 'POST', url: '/tool-templates/period-series/instantiate',
        payload: { scope, dataSourceIds: ['ds-population'], values: SERIES_VALUES, language: 'ja' },
      });
      expect(denied.statusCode).toBe(403);
    });
  });
});
