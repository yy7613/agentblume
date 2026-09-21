// @vitest-environment jsdom
/**
 * Tool Builder の「テンプレートから作成」の入口（v43 / ADR-0049）。
 *
 * ダイアログの中身は `TemplateDialog.test.tsx` が見る。ここは一覧画面からの導線だけ:
 * 新規作成の隣に入口があること、作成するとキャンバスへ移ってテンプレート名の通知が出ること、
 * 作らずに閉じれば一覧のままであること。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { InstantiatedTemplateDto, ToolTemplateCatalogDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider } from '../navigation';
import { ToolBuilder } from './ToolBuilder';
import { useToolBuilderStore } from './store';

vi.mock('./FlowCanvas', () => ({ FlowCanvas: () => <div aria-label="ETL canvas" /> }));
vi.mock('./NodePalette', () => ({ NodePalette: () => <aside aria-label="Node palette" /> }));

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); useToolBuilderStore.getState().reset(); });

const CATALOG: ToolTemplateCatalogDto = {
  templates: [{
    id: 'period-series', version: '1.0.0',
    title: { ja: '時系列の取り出し', en: 'Time series lookup' },
    summary: { ja: '推移を返す。', en: 'Returns a series.' },
    whenToUse: { ja: ['推移'], en: ['Trend'] },
    tags: [],
    sources: { min: 1, max: 1 },
    slots: [{ name: 'source', kind: 'dataSource', label: { ja: 'データソース', en: 'Data source' }, optional: false }],
  }],
  invalid: [],
};

const INSTANTIATED: InstantiatedTemplateDto = {
  template: { id: 'period-series', version: '1.0.0' },
  graph: {
    nodes: [
      { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-population' } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 10, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [{ from: 'src', to: 'out' }],
  },
  agentTool: { name: 'period-series', description: '推移を返します。' },
  pendingExpressions: [],
};

function client(overrides: Readonly<Record<string, unknown>> = {}): ToolApiClient {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    inferDraft: vi.fn().mockResolvedValue(undefined),
    previewDraft: vi.fn().mockResolvedValue(undefined),
    listToolTemplates: vi.fn().mockResolvedValue(CATALOG),
    listDataSources: vi.fn().mockResolvedValue([
      { id: 'ds-population', tenant: { tenantId: 'local', workspaceId: 'default' }, name: '人口', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 1, createdAt: '', updatedAt: '' },
    ]),
    // 編集画面（NodeInspector）が起動時に叩く 2 本。無いと選択ノードの描画で落ちる。
    listSearchProviders: vi.fn().mockResolvedValue([]),
    analysisAssistantCapability: vi.fn().mockResolvedValue(false),
    toolTemplateSlotCandidates: vi.fn().mockResolvedValue({ templateId: 'period-series', version: '1.0.0', candidates: [] }),
    instantiateToolTemplate: vi.fn().mockResolvedValue(INSTANTIATED),
    ...overrides,
  } as unknown as ToolApiClient;
}

/** ダイアログの名前欄（v45 で必須）。中身の検証は TemplateDialog.test.tsx が見る。 */
function fillNames(displayName = '人口の推移', functionName = 'population_trend'): void {
  fireEvent.change(screen.getByLabelText('Tool name'), { target: { value: displayName } });
  fireEvent.change(screen.getByLabelText('Function name'), { target: { value: functionName } });
}

function renderBuilder(api: ToolApiClient, language: 'en' | 'ja' = 'en') {
  render(<I18nProvider initialLanguage={language}><NavigationProvider navigate={vi.fn()}><ToolBuilder client={api} /></NavigationProvider></I18nProvider>);
}

describe('ToolBuilder: テンプレートから作成の入口', () => {
  it('正常: ツール一覧に入口があり、押すとテンプレート一覧のダイアログが開く', async () => {
    renderBuilder(client());
    await userEvent.click(screen.getByRole('button', { name: 'Create from a template' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Time series lookup')).toBeTruthy();
  });

  it('正常: 日本語では「テンプレートから作成」として出る', async () => {
    renderBuilder(client(), 'ja');
    expect(await screen.findByRole('button', { name: 'テンプレートから作成' })).toBeTruthy();
  });

  it('従来どおり: 作成するとキャンバスへ移り、どのテンプレートから作ったかを通知する（名前は決まっているので残る宿題は所有者）', async () => {
    renderBuilder(client());
    await userEvent.click(screen.getByRole('button', { name: 'Create from a template' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use this template' }));
    await userEvent.selectOptions(screen.getByLabelText('Data source'), 'ds-population');
    fillNames();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByLabelText('ETL canvas')).toBeTruthy());
    const notice = screen.getByRole('status').textContent ?? '';
    expect(notice).toContain('period-series@1.0.0');
    expect(notice).toContain('Set the owner, then save.');
    expect(useToolBuilderStore.getState().nodes.map((node) => node.id)).toEqual(['src', 'out']);
  });

  it('異常: 作らずに閉じれば一覧のまま（キャンバスへは移らない）', async () => {
    renderBuilder(client());
    await userEvent.click(screen.getByRole('button', { name: 'Create from a template' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('ETL canvas')).toBeNull();
    expect(screen.getByRole('button', { name: 'New tool' })).toBeTruthy();
  });

  it('正常: 通知は閉じられる（直しながら作業する邪魔にならない）', async () => {
    renderBuilder(client());
    await userEvent.click(screen.getByRole('button', { name: 'Create from a template' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use this template' }));
    await userEvent.selectOptions(screen.getByLabelText('Data source'), 'ds-population');
    fillNames();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
