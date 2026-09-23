// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { I18nProvider } from '../i18n';
import { QualityTab, groupMetricRows, splitMetricName } from './QualityTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };
const stats = (mean: number) => ({ count: 2, mean, median: mean, p50: mean, p95: mean, stddev: 0, min: mean, max: mean, samples: [mean, mean] });
const metric = (name: string, mean: number) => ({ metric: name, preference: 'higher', baseline: stats(mean - 0.1), candidate: stats(mean), delta: 0.1, direction: 'improved' });
const completed = (id: string, version: string) => ({ id, scope, target: { agentId: 'agent', version }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 1, status: 'completed', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 1, total: 1 }, createdAt: 'now' });

function makeClient(metrics: readonly unknown[]): ToolApiClient {
  return {
    listExperiments: vi.fn().mockResolvedValue([completed('candidate', '2.0.0'), completed('baseline', '1.0.0')]),
    listGatePolicies: vi.fn().mockResolvedValue([]),
    listPromotionRequests: vi.fn().mockResolvedValue([]),
    compareExperiments: vi.fn().mockResolvedValue({ baselineExperimentId: 'baseline', candidateExperimentId: 'candidate', baseline: { experimentId: 'baseline', caseCount: 1, metrics: {} }, candidate: { experimentId: 'candidate', caseCount: 1, metrics: {} }, metrics, cases: [] }),
  } as unknown as ToolApiClient;
}

async function compare(client: ToolApiClient): Promise<HTMLTableElement> {
  render(<QualityTab client={client} scope={scope} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Compare' }));
  await waitFor(() => expect(client.compareExperiments).toHaveBeenCalledWith(scope, 'baseline', 'candidate'));
  return (await screen.findAllByRole('table'))[0] as HTMLTableElement;
}

describe('splitMetricName / groupMetricRows（基準別指標の群化）', () => {
  it('`metric:criterion` を親と基準に分け、素の指標は親だけを返す', () => {
    expect(splitMetricName('judge:accuracy')).toEqual({ parent: 'judge', criterion: 'accuracy' });
    expect(splitMetricName('coverage')).toEqual({ parent: 'coverage' });
  });

  it('境界: 先頭や末尾の `:`、空文字は基準として扱わない。2 つ目以降の `:` は基準名に含める', () => {
    expect(splitMetricName(':accuracy')).toEqual({ parent: ':accuracy' });
    expect(splitMetricName('judge:')).toEqual({ parent: 'judge:' });
    expect(splitMetricName('')).toEqual({ parent: '' });
    expect(splitMetricName('judge:a:b')).toEqual({ parent: 'judge', criterion: 'a:b' });
  });

  it('基準行は親の直後に集まり、親の無い基準行は末尾へ、素の指標の順は保つ', () => {
    const rows = [{ metric: 'judge:accuracy' }, { metric: 'coverage' }, { metric: 'orphan:x' }, { metric: 'judge' }, { metric: 'judge:safety' }, { metric: 'latency' }];
    expect(groupMetricRows(rows).map((row) => row.metric)).toEqual(['coverage', 'judge', 'judge:accuracy', 'judge:safety', 'latency', 'orphan:x']);
  });

  it('空の配列は空のまま', () => { expect(groupMetricRows([])).toEqual([]); });
});

describe('QualityTab の比較表', () => {
  it('`judge:accuracy` の行は合成指標 `judge` の下に「judge › accuracy」として字下げされ、素の指標はそのまま', async () => {
    const table = await compare(makeClient([metric('judge:accuracy', 0.9), metric('coverage', 0.8), metric('judge', 0.85)]));
    const rows = within(table).getAllByRole('row').slice(1) as HTMLTableRowElement[];
    expect(rows.map((row) => row.className)).toEqual(['metric-row-composite', 'metric-row-composite', 'metric-row-criterion']);
    expect(rows[0]?.cells[0]?.textContent).toBe('coverage');
    expect(rows[1]?.cells[0]?.textContent).toBe('judge');
    expect(rows[2]?.cells[0]?.textContent).toBe('judge › accuracy');
    expect(rows[2]?.querySelector('.metric-criterion')?.getAttribute('title')).toBe('judge:accuracy');
    expect(rows[2]?.cells[1]?.textContent).toBe('0.800');
  });

  it('ゲート指標の候補（datalist）に比較で見えた指標が基準別も含めて並び、既定の case-success-rate を先頭に置く', async () => {
    await compare(makeClient([metric('judge', 0.85), metric('judge:accuracy', 0.9)]));
    const input = screen.getByRole('combobox', { name: 'Gate metric' }) as HTMLInputElement;
    expect(input.getAttribute('list')).toBe('gate-metric-options');
    const options = Array.from(document.querySelectorAll('#gate-metric-options option')).map((option) => option.getAttribute('value'));
    expect(options).toEqual(['case-success-rate', 'judge', 'judge:accuracy']);
    await userEvent.clear(input); await userEvent.type(input, 'judge:accuracy');
    expect(input.value).toBe('judge:accuracy');
  });

  it('比較前は datalist に既定の指標だけがあり、入力は自由記述で使える', async () => {
    render(<QualityTab client={makeClient([])} scope={scope} />);
    await screen.findByRole('button', { name: 'Compare' });
    expect(Array.from(document.querySelectorAll('#gate-metric-options option')).map((option) => option.getAttribute('value'))).toEqual(['case-success-rate']);
  });

  it('[回帰固定] 比較の取得失敗はアラートで出し、表は描かない（例外）', async () => {
    const client = makeClient([]);
    (client.compareExperiments as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('compare failed'));
    render(<QualityTab client={client} scope={scope} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Compare' }));
    expect((await screen.findByRole('alert')).textContent).toBe('compare failed');
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('正常: 日本語表示ではケースの状態語（succeeded/failed等）が日本語になる', async () => {
    const client = makeClient([]);
    (client.compareExperiments as ReturnType<typeof vi.fn>).mockResolvedValue({
      baselineExperimentId: 'baseline', candidateExperimentId: 'candidate',
      baseline: { experimentId: 'baseline', caseCount: 1, metrics: {} }, candidate: { experimentId: 'candidate', caseCount: 1, metrics: {} },
      metrics: [],
      cases: [{ caseId: 'c1', repetition: 1, baselineStatus: 'succeeded', candidateStatus: 'failed', baselineScore: 0.9, candidateScore: 0.1, delta: -0.8, direction: 'regressed' }],
    });
    render(<I18nProvider initialLanguage="ja"><QualityTab client={client} scope={scope} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: '比較' }));
    const tables = await screen.findAllByRole('table');
    const caseTable = tables[1] as HTMLTableElement;
    expect(caseTable.textContent).toContain('成功');
    expect(caseTable.textContent).toContain('失敗');
    expect(caseTable.textContent).not.toContain('succeeded');
    expect(caseTable.textContent).not.toContain('failed');
  });
});

describe('QualityTab のゲート判定', () => {
  function gateClient(overrides: Record<string, unknown> = {}): ToolApiClient {
    return {
      listExperiments: vi.fn().mockResolvedValue([completed('candidate', '2.0.0'), completed('baseline', '1.0.0')]),
      listGatePolicies: vi.fn().mockResolvedValue([{ internalId: 'release', displayName: 'Release', publishName: 'release', latestVersion: '1.0.0', state: 'draft', ruleCount: 1 }]),
      listPromotionRequests: vi.fn().mockResolvedValue([]),
      getGatePolicy: vi.fn().mockResolvedValue({ metadata: { internalId: 'release', version: '1.0.0' }, reportTtlHours: 24, rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'case-success-rate', operator: 'gte', threshold: 0.8 }] }),
      evaluateGate: vi.fn().mockResolvedValue({ id: 'report', scope, policy: { id: 'release', version: '1.0.0' }, candidateExperimentId: 'candidate', status: 'pass', ruleResults: [{ ruleId: 'threshold', passed: true, message: 'ok' }], createdAt: 'now', expiresAt: 'later' }),
      ...overrides,
    } as unknown as ToolApiClient;
  }

  it('正常: 日本語表示では品質ゲートの合否がPASS/FAILの英語のまま出ず日本語になる（値そのものは変えない）', async () => {
    const client = gateClient();
    render(<I18nProvider initialLanguage="ja"><QualityTab client={client} scope={scope} /></I18nProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'ゲート判定' }));
    expect(await screen.findByText('合格')).toBeTruthy();
    expect(screen.queryByText('PASS')).toBeNull();
  });

  it('境界: 英語表示（既定）では従来どおりPASS/FAILの英大文字表記を保つ', async () => {
    const client = gateClient();
    render(<QualityTab client={client} scope={scope} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate gate' }));
    expect(await screen.findByText('PASS')).toBeTruthy();
  });
});
