/**
 * 同梱の `prompts/` 全体の検査（v48 実装契約 §6）。
 *
 * 個々の use case のテストと違い、ここは**フォルダそのもの**を見る。
 * 形式違反のファイルが混ざったまま気づかれない、id とパスがずれる、誰も送らない死んだ文が残る——
 * どれも「壊れているのに動いているように見える」種類の事故なので、1 か所でまとめて落とす。
 *
 * ## なぜ `root.ts` を **読んで** 突き合わせるのか（import しないのか）
 *
 * 「生きている文の一覧」は `composition/root.ts` の `REQUIRED_PROMPTS` ただ 1 つで、文をファイルへ
 * 移した use case はそこへ自分の `PromptSpec` を足す。ところが application 層から composition を
 * import することは依存規則（`only-root-imports-composition`）が禁じている。そこでこのテストは
 * root.ts を**テキストとして読み**、`REQUIRED_PROMPTS` に並んだ識別子とその import 元を取り出して、
 * その module だけを動的に読み込む。こうすると
 *
 * - 依存の向き（application → composition）は生まれない、
 * - 新しい spec を root.ts へ足すだけで、このテストが自動的にそれを見る（このファイルは触らなくてよい）、
 *
 * の両方が同時に成り立つ。配列の書き方を変えた（識別子以外を並べた）ときは、黙って見逃さずに落とす。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED_PROMPTS_DIRECTORY, bundledPrompts } from '../../test-support/prompts';
import type { PromptSpec } from './prompt-catalog-port';
import { parsePromptFile } from './prompt-template';

const ROOT_FILE = join(BUNDLED_PROMPTS_DIRECTORY, '..', 'src', 'composition', 'root.ts');

/** `import { A, B } from './x';` を「識別子 → 相対指定子」へ。 */
function importedFrom(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim() ?? '';
      if (name !== '') map.set(name, match[2] ?? '');
    }
  }
  return map;
}

/** `root.ts` の `REQUIRED_PROMPTS` に並んだ spec を、その定義 module から集める。 */
async function requiredPrompts(): Promise<readonly PromptSpec[]> {
  const source = readFileSync(ROOT_FILE, 'utf8');
  const array = /const REQUIRED_PROMPTS: readonly PromptSpec\[\] = \[([\s\S]*?)\];/.exec(source);
  expect(array, `${ROOT_FILE} に 'const REQUIRED_PROMPTS: readonly PromptSpec[] = [...]' が見つからない`).not.toBeNull();
  const entries = (array?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
    .filter((line) => line !== '');
  const imports = importedFrom(source);
  const specs: PromptSpec[] = [];
  for (const entry of entries) {
    expect(/^[A-Za-z_$][\w$]*$/.test(entry), `REQUIRED_PROMPTS の要素 ${JSON.stringify(entry)} は import した PromptSpec の識別子でなければならない`).toBe(true);
    const specifier = imports.get(entry);
    expect(specifier, `REQUIRED_PROMPTS の ${entry} の import 元が root.ts に見つからない`).toBeDefined();
    // 指定子はフォルダ（バレル）を指すこともあるので、`x.ts` → `x/index.ts` の順で解決する。
    const candidates = [`${specifier ?? ''}.ts`, `${specifier ?? ''}/index.ts`]
      .map((relative) => new URL(relative, pathToFileURL(ROOT_FILE)).href);
    const module = await candidates.reduce<Promise<Record<string, PromptSpec | undefined>>>(
      async (previous, href) => previous.catch(async () => (await import(href)) as Record<string, PromptSpec | undefined>),
      Promise.reject(new Error(`cannot resolve ${specifier ?? ''}`)),
    );
    const spec = module[entry];
    expect(spec, `${specifier} は ${entry} を export していない`).toBeDefined();
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

describe('同梱の prompts/', () => {
  it('正常: 全ファイルが読め、id がファイルの相対パスと一致する', () => {
    const catalog = bundledPrompts();
    expect(catalog.invalid()).toEqual([]);
    for (const id of catalog.ids()) {
      const template = catalog.get(id);
      expect(template.id).toBe(id);
      expect(template.sections.size).toBeGreaterThan(0);
      expect(template.description).not.toBe('');
    }
  });

  it('境界: 読み込み対象のファイルは、`REQUIRED_PROMPTS` が宣言した id のぶんだけ', async () => {
    // 宣言されていないファイルは誰も送らない死んだ文。宣言されているのにファイルが無ければ起動が止まる。
    const specs = await requiredPrompts();
    expect(specs.length).toBeGreaterThan(0);
    expect(bundledPrompts().ids()).toEqual([...new Set(specs.map((spec) => spec.id))].sort());
  });

  it('境界: 各ファイルの節は、その spec が描画する節とちょうど同じ', async () => {
    const catalog = bundledPrompts();
    for (const spec of await requiredPrompts()) {
      const sections = [...catalog.get(spec.id).sections.keys()].sort();
      // 足りなければ起動時に落ちる。余っていれば、コードが一度も render しない死んだ文が残っている。
      expect(sections, `${spec.id} の節`).toEqual([...spec.sections].sort());
    }
  });

  it('正常: 書き方の見本（`_example.md`）はその形式を満たしている', () => {
    // 見本が形式違反だと、それを真似た人が同じ違反を書く。読み込み対象から外れている（`_` 始まり）ぶん、
    // 誰も検査しないので、ここで明示的に読む。
    const result = parsePromptFile('_example', readFileSync(join(BUNDLED_PROMPTS_DIRECTORY, '_example.md'), 'utf8'));
    expect(result.ok ? [] : result.problems).toEqual([]);
    if (!result.ok) return;
    expect([...result.template.sections.keys()]).toEqual(['system', 'repair']);
    expect(result.template.render('repair', { reason: 'unknown column' })).toContain('unknown column');
  });

  it('正常: 読み込み対象から外れるのは `_` 始まりのファイルと README だけ', () => {
    // 置いたのに読まれていないファイルを、フォルダの一覧から見つけられるようにする。
    const top = readdirSync(BUNDLED_PROMPTS_DIRECTORY, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    expect(top).toEqual(['README.md', '_example.md']);
  });
});
