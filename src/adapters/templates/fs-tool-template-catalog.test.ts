import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import {
  FsToolTemplateCatalog,
  MAX_TOOL_TEMPLATE_BYTES,
  MAX_TOOL_TEMPLATE_FILES,
  isTemplateFileName,
  splitTemplateDirectories,
} from './fs-tool-template-catalog';

const registry = createDefaultRegistry();
const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-templates-'));
  created.push(directory);
  return directory;
}

/** 妥当な最小テンプレート（id と件数だけを差し替えて使う）。 */
function templateJson(id: string, limit = 10): string {
  return JSON.stringify({
    formatVersion: 1,
    id,
    version: '1.0.0',
    title: { ja: id, en: id },
    summary: { ja: `${id} の要約`, en: `summary of ${id}` },
    whenToUse: { ja: ['いつ使うか'], en: ['when to use'] },
    tags: [],
    sources: { min: 1, max: 1 },
    slots: [
      { name: 'source', kind: 'dataSource', label: { ja: 'ソース', en: 'Source' } },
      { name: 'rows', kind: 'number', min: 1, max: 100, integer: true, default: limit, label: { ja: '件数', en: 'Rows' } },
    ],
    arguments: [],
    nodes: [
      { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
      { id: 'limit', type: 'limit', config: { count: { $slot: 'rows' } } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: { $slot: 'rows' }, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [{ from: 'src', to: 'limit' }, { from: 'limit', to: 'out' }],
    description: { ja: '先頭 {{rows}} 件。', en: 'First {{rows}} rows.' },
  });
}

describe('splitTemplateDirectories', () => {
  it('正常: `;` と `:` のどちらでも区切る', () => {
    expect(splitTemplateDirectories('/a/b:/c/d;/e/f')).toEqual(['/a/b', '/c/d', '/e/f']);
  });

  it('境界: Windows のドライブ接頭辞（`C:\\`）の `:` では切らない', () => {
    expect(splitTemplateDirectories('C:\\tmp\\one;D:/tmp/two')).toEqual(['C:\\tmp\\one', 'D:/tmp/two']);
    expect(splitTemplateDirectories('C:\\a;C:\\b:C:\\c')).toEqual(['C:\\a', 'C:\\b', 'C:\\c']);
  });

  it('境界: 空文字・空白だけの要素は落とす', () => {
    expect(splitTemplateDirectories('  ;; /a ; ')).toEqual(['/a']);
    expect(splitTemplateDirectories('')).toEqual([]);
  });
});

describe('isTemplateFileName', () => {
  it('正常/異常: schema・README・`_` 始まり・`.json` 以外は読まない', () => {
    expect(isTemplateFileName('period-series.json')).toBe(true);
    expect(isTemplateFileName('tool-template.schema.json')).toBe(false);
    expect(isTemplateFileName('README.md')).toBe(false);
    expect(isTemplateFileName('_draft-x.json')).toBe(false);
    expect(isTemplateFileName('notes.txt')).toBe(false);
  });
});

describe('FsToolTemplateCatalog', () => {
  it('正常: ディレクトリの `*.json` を読み、無視すべき file は読まない', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'a.json'), templateJson('alpha'), 'utf8');
    await writeFile(join(directory, '_draft.json'), '{ broken', 'utf8');
    await writeFile(join(directory, 'tool-template.schema.json'), '{}', 'utf8');
    await writeFile(join(directory, 'README.md'), '# readme', 'utf8');
    await writeFile(join(directory, 'notes.txt'), 'x', 'utf8');

    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates.map((template) => template.id)).toEqual(['alpha']);
    expect(catalog.invalid).toEqual([]);
  });

  it('正常: 置き場所が複数あるとき、同じ id は後から読んだ方が勝つ', async () => {
    const standard = await temporaryDirectory();
    const custom = await temporaryDirectory();
    await writeFile(join(standard, 'a.json'), templateJson('alpha', 10), 'utf8');
    await writeFile(join(custom, 'a.json'), templateJson('alpha', 99), 'utf8');

    const catalog = await new FsToolTemplateCatalog({ directories: [standard, custom], registry }).list();
    expect(catalog.templates).toHaveLength(1);
    const slot = catalog.templates[0]?.slots.find((candidate) => candidate.name === 'rows');
    expect(slot?.kind === 'number' ? slot.default : undefined).toBe(99);
  });

  it('異常: 壊れた JSON は読み飛ばし、file 名と直し方つきの理由を返す', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'ok.json'), templateJson('alpha'), 'utf8');
    await writeFile(join(directory, 'broken.json'), '{ "formatVersion": 1,, }', 'utf8');

    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates.map((template) => template.id)).toEqual(['alpha']);
    expect(catalog.invalid).toHaveLength(1);
    expect(catalog.invalid[0]?.file).toBe('broken.json');
    expect(catalog.invalid[0]?.problems.join('')).toContain('not valid JSON');
  });

  it('異常: 形式が違うテンプレートは id つきで invalid に入り、他のテンプレートを巻き込まない', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'ok.json'), templateJson('alpha'), 'utf8');
    await writeFile(join(directory, 'bad.json'), JSON.parse(templateJson('beta')) && templateJson('beta').replace('"sources":{"min":1,"max":1}', '"sources":{"min":1,"max":3}'), 'utf8');

    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates.map((template) => template.id)).toEqual(['alpha']);
    expect(catalog.invalid[0]).toMatchObject({ file: 'bad.json', id: 'beta' });
  });

  it('異常: 登録されていないノード種別は invalid に入り、使える種別を挙げる', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'x.json'), templateJson('gamma').replace('"type":"limit"', '"type":"teleport"'), 'utf8');

    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates).toEqual([]);
    expect(catalog.invalid[0]?.problems.join('')).toContain("type 'teleport'");
  });

  it('境界: 256KB を超える file は読まずに、上限と直し方を返す', async () => {
    const directory = await temporaryDirectory();
    const padded = JSON.parse(templateJson('huge')) as Record<string, unknown>;
    padded['notes'] = 'あ'.repeat(MAX_TOOL_TEMPLATE_BYTES);
    await writeFile(join(directory, 'huge.json'), JSON.stringify(padded), 'utf8');

    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates).toEqual([]);
    expect(catalog.invalid[0]?.problems.join('')).toContain(`${MAX_TOOL_TEMPLATE_BYTES} byte limit`);
  });

  it('境界: file 数の上限を超えた分は読まず、どこから外すかを言う', async () => {
    const directory = await temporaryDirectory();
    await Promise.all(Array.from({ length: MAX_TOOL_TEMPLATE_FILES + 2 }, (_unused, index) =>
      writeFile(join(directory, `t${String(index).padStart(4, '0')}.json`), templateJson(`t-${index}`), 'utf8')));

    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates).toHaveLength(MAX_TOOL_TEMPLATE_FILES);
    expect(catalog.invalid).toHaveLength(2);
    expect(catalog.invalid[0]?.problems.join('')).toContain(`more than ${MAX_TOOL_TEMPLATE_FILES} template files`);
  });

  it('正常: 2 回目は更新時刻が同じならキャッシュを返す（同一参照）', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'a.json'), templateJson('alpha'), 'utf8');
    const catalog = new FsToolTemplateCatalog({ directories: [directory], registry });
    const first = await catalog.list();
    expect(await catalog.list()).toBe(first);
  });

  it('正常: file を書き換えたら（更新時刻が変われば）再起動せずに反映される', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.json');
    await writeFile(path, templateJson('alpha', 10), 'utf8');
    const catalog = new FsToolTemplateCatalog({ directories: [directory], registry });
    await catalog.list();

    await writeFile(path, templateJson('alpha', 42), 'utf8');
    const future = new Date(Date.now() + 5_000);
    await utimes(path, future, future);

    const slot = (await catalog.list()).templates[0]?.slots.find((candidate) => candidate.name === 'rows');
    expect(slot?.kind === 'number' ? slot.default : undefined).toBe(42);
  });

  it('正常: file を足したら次の list で増える', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'a.json'), templateJson('alpha'), 'utf8');
    const catalog = new FsToolTemplateCatalog({ directories: [directory], registry });
    expect((await catalog.list()).templates).toHaveLength(1);

    await writeFile(join(directory, 'b.json'), templateJson('beta'), 'utf8');
    expect((await catalog.list()).templates.map((template) => template.id)).toEqual(['alpha', 'beta']);
  });

  it('例外: ディレクトリが無くても throw せず、空のカタログを返す', async () => {
    const directory = await temporaryDirectory();
    const missing = join(directory, 'does-not-exist');
    const catalog = await new FsToolTemplateCatalog({ directories: [missing], registry }).list();
    expect(catalog).toEqual({ templates: [], invalid: [] });
  });

  it('例外: ディレクトリの中の子ディレクトリは読まない（file だけを読む）', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'nested.json'));
    await writeFile(join(directory, 'a.json'), templateJson('alpha'), 'utf8');
    const catalog = await new FsToolTemplateCatalog({ directories: [directory], registry }).list();
    expect(catalog.templates.map((template) => template.id)).toEqual(['alpha']);
    expect(catalog.invalid).toEqual([]);
  });

  it('正常: 既定の置き場所は作業ディレクトリ配下 + 環境変数（同梱の標準テンプレートが読める）', async () => {
    const extra = await temporaryDirectory();
    await writeFile(join(extra, 'x.json'), templateJson('extra-one'), 'utf8');
    const catalog = await new FsToolTemplateCatalog({
      registry,
      cwd: process.cwd(),
      env: { AGENTCONTEXT_TOOL_TEMPLATES_DIR: extra },
    }).list();
    expect(catalog.templates.map((template) => template.id)).toContain('period-series');
    expect(catalog.templates.map((template) => template.id)).toContain('extra-one');
    expect(catalog.invalid).toEqual([]);
  });
});
