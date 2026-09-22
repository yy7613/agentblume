/**
 * ファイルから読むプロンプトカタログのテスト（v48 実装契約 §6）。
 *
 * 見たいのは「読めること」より**運用の事故**である: 節を欠いた上書きで起動が止まるか、
 * 編集の途中で保存された半端なファイルで動いているサーバーの指示が消えないか、
 * 止まるときに「どのファイルの何が無く、どう直すか」が出るか。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogContext, LoggerPort } from '../../application/operations/logger';
import { MissingPromptsError, PromptNotFoundError } from '../../application/prompt/prompt-catalog-port';
import {
  FsPromptCatalog,
  MAX_PROMPT_BYTES,
  isPromptFileName,
  promptIdFromRelativePath,
} from './fs-prompt-catalog';

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'prompts-'));
  created.push(directory);
  return directory;
}

/** 妥当な最小ファイルを書く（`id` はパスから決まるので引数で渡す）。 */
function writePrompt(directory: string, id: string, body: string, front?: string): string {
  const path = `${join(directory, ...id.split('/'))}.md`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${front ?? `id: ${id}\nversion: ${id.split('/').pop()}/v1\ndescription: 見本`}\n---\n\n${body}\n`, 'utf8');
  return path;
}

/** ファイルの更新時刻を確実に進める（同じミリ秒に 2 回書いても指紋が変わるように）。 */
function touch(path: string, secondsAhead: number): void {
  const when = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, when, when);
}

/** 警告を溜めるロガー。 */
function recordingLogger(): LoggerPort & { readonly warnings: { message: string; context?: LogContext }[] } {
  const warnings: { message: string; context?: LogContext }[] = [];
  return {
    warnings,
    info: () => {},
    error: () => {},
    warn: (message, context) => { warnings.push(context === undefined ? { message } : { message, context }); },
  };
}

describe('isPromptFileName / promptIdFromRelativePath', () => {
  it('正常/異常: README・`_` 始まり・`.md` 以外は読まない', () => {
    expect(isPromptFileName('planner.md')).toBe(true);
    expect(isPromptFileName('README.md')).toBe(false);
    expect(isPromptFileName('_example.md')).toBe(false);
    expect(isPromptFileName('notes.txt')).toBe(false);
  });

  it('正常: 相対パスから id を作る（拡張子を落とし `/` 区切りにする）', () => {
    expect(promptIdFromRelativePath('factory/planner.md')).toBe('factory/planner');
    expect(promptIdFromRelativePath('factory\\tasks\\decide-join.md')).toBe('factory/tasks/decide-join');
  });
});

describe('FsPromptCatalog の読み込み', () => {
  it('正常: サブディレクトリを含めて読み、id は相対パスになる', () => {
    const directory = temporaryDirectory();
    writePrompt(directory, 'tool/calculate-expression', '## system\nwrite one expression');
    writePrompt(directory, 'factory/tasks/decide-join', '## system\ndecide the join');

    const catalog = new FsPromptCatalog({ directories: [directory] });
    expect(catalog.ids()).toEqual(['factory/tasks/decide-join', 'tool/calculate-expression']);
    expect(catalog.get('tool/calculate-expression').render('system')).toBe('write one expression');
    expect(catalog.invalid()).toEqual([]);
  });

  it('正常: README・`_` 始まりのファイルとフォルダ・`.md` 以外は読まない', () => {
    const directory = temporaryDirectory();
    writePrompt(directory, 'planner', '## system\nplan');
    writeFileSync(join(directory, 'README.md'), '# 説明', 'utf8');
    writeFileSync(join(directory, '_example.md'), 'これは形式違反だが読まれない', 'utf8');
    writeFileSync(join(directory, 'notes.txt'), 'x', 'utf8');
    mkdirSync(join(directory, '_drafts'));
    writeFileSync(join(directory, '_drafts', 'later.md'), '壊れている', 'utf8');

    const catalog = new FsPromptCatalog({ directories: [directory] });
    expect(catalog.ids()).toEqual(['planner']);
    expect(catalog.invalid()).toEqual([]);
  });

  it('正常: 既定の置き場所は `<cwd>/prompts` と環境変数（`;` 区切り・後勝ち）', () => {
    const home = temporaryDirectory();
    const extra = temporaryDirectory();
    mkdirSync(join(home, 'prompts'));
    writePrompt(join(home, 'prompts'), 'planner', '## system\nbundled');
    writePrompt(extra, 'planner', '## system\noperator');

    const catalog = new FsPromptCatalog({ cwd: home, env: { AGENTCONTEXT_PROMPTS_DIR: `${extra};` } });
    expect(catalog.get('planner').render('system')).toBe('operator');
  });

  it('境界: 置き場所が 1 つも無くても構築でき、空のカタログになる', () => {
    const catalog = new FsPromptCatalog({ directories: [join(temporaryDirectory(), 'missing')] });
    expect(catalog.ids()).toEqual([]);
    expect(() => catalog.get('planner')).toThrow(PromptNotFoundError);
  });

  it('境界: 上限を超える大きさのファイルは読まず、理由と直し方を残す', () => {
    const directory = temporaryDirectory();
    writePrompt(directory, 'huge', `## system\n${'x'.repeat(MAX_PROMPT_BYTES)}`);
    const catalog = new FsPromptCatalog({ directories: [directory] });
    expect(catalog.invalid()[0]?.problems[0]).toContain(`more than the ${MAX_PROMPT_BYTES} byte limit`);
    expect(catalog.invalid()[0]?.problems[0]).toContain('split it into one prompt per file');
  });

  it('異常: 形式違反のファイルは警告を残し、get はその理由を投げる', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, 'broken.md'), '## system\nno frontmatter', 'utf8');
    const logger = recordingLogger();

    const catalog = new FsPromptCatalog({ directories: [directory], logger });
    expect(logger.warnings[0]?.message).toContain('could not be read');
    expect(catalog.invalid()).toHaveLength(1);
    try {
      catalog.get('broken');
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptNotFoundError);
      expect((error as PromptNotFoundError).problems[0]).toContain(`make the first line '---'`);
      expect((error as PromptNotFoundError).message).toContain(join(directory, 'broken.md'));
    }
  });

  it('例外: 定義されていない id の get は置き場所と作るべきファイルを案内する', () => {
    const directory = temporaryDirectory();
    try {
      new FsPromptCatalog({ directories: [directory] }).get('tool/design-chat');
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptNotFoundError);
      expect((error as PromptNotFoundError).promptId).toBe('tool/design-chat');
      expect((error as PromptNotFoundError).message).toContain(join(directory, 'tool', 'design-chat.md'));
      expect((error as PromptNotFoundError).message).toContain('looked in');
    }
  });
});

describe('FsPromptCatalog の上書き', () => {
  it('正常: 同じ id は後の置き場所が勝ち、置き換えはファイル単位（節は混ざらない）', () => {
    const bundled = temporaryDirectory();
    const override = temporaryDirectory();
    writePrompt(bundled, 'planner', '## system\nbundled system\n\n## repair\nbundled repair');
    writePrompt(override, 'planner', '## system\noperator system');

    const template = new FsPromptCatalog({ directories: [bundled, override] }).get('planner');
    expect(template.render('system')).toBe('operator system');
    expect([...template.sections.keys()]).toEqual(['system']);
  });

  it('正常: 上書きファイルを消すと、次の get から同梱の文へ戻る', () => {
    const bundled = temporaryDirectory();
    const override = temporaryDirectory();
    writePrompt(bundled, 'planner', '## system\nbundled');
    const path = writePrompt(override, 'planner', '## system\noperator');

    const catalog = new FsPromptCatalog({ directories: [bundled, override] });
    expect(catalog.get('planner').render('system')).toBe('operator');
    rmSync(path);
    expect(catalog.get('planner').render('system')).toBe('bundled');
  });
});

describe('FsPromptCatalog の再読込', () => {
  it('正常: 更新時刻が変われば読み直す（文を直してもサーバーの再起動は要らない）', () => {
    const directory = temporaryDirectory();
    const path = writePrompt(directory, 'planner', '## system\nfirst');
    const catalog = new FsPromptCatalog({ directories: [directory] });
    expect(catalog.get('planner').render('system')).toBe('first');

    writePrompt(directory, 'planner', '## system\nsecond');
    touch(path, 5);
    expect(catalog.get('planner').render('system')).toBe('second');
  });

  it('境界: 更新時刻もサイズも変わらなければ読み直さない（同じ実体を返す）', () => {
    const directory = temporaryDirectory();
    const path = writePrompt(directory, 'planner', '## system\nfirst');
    touch(path, -5);
    const catalog = new FsPromptCatalog({ directories: [directory] });
    expect(catalog.get('planner')).toBe(catalog.get('planner'));
  });

  it('異常: 実行中の再読込で壊れたファイルは、直前の良い版を使い続けて警告を残す', () => {
    const directory = temporaryDirectory();
    const path = writePrompt(directory, 'planner', '## system\ngood');
    const logger = recordingLogger();
    const catalog = new FsPromptCatalog({ directories: [directory], logger });
    expect(catalog.get('planner').render('system')).toBe('good');

    // 編集の途中で保存された半端なファイル（frontmatter を書き換えている最中など）。
    writeFileSync(path, '## system\nhalf written', 'utf8');
    touch(path, 5);

    expect(catalog.get('planner').render('system')).toBe('good');
    const warning = logger.warnings.at(-1);
    expect(warning?.message).toContain('previous version stays in use');
    expect(warning?.context?.['file']).toBe(path);
    expect(String(warning?.context?.['problems'])).toContain(`make the first line '---'`);
    // 直したら次の get で反映される（壊れたまま固まらない）。
    writePrompt(directory, 'planner', '## system\nfixed');
    touch(path, 10);
    expect(catalog.get('planner').render('system')).toBe('fixed');
  });

  it('正常: 起動後に置いた上書きファイルも次の get から効く', () => {
    const bundled = temporaryDirectory();
    const override = temporaryDirectory();
    writePrompt(bundled, 'planner', '## system\nbundled');
    const catalog = new FsPromptCatalog({ directories: [bundled, override] });
    expect(catalog.get('planner').render('system')).toBe('bundled');

    writePrompt(override, 'planner', '## system\noperator');
    expect(catalog.get('planner').render('system')).toBe('operator');
  });
});

describe('FsPromptCatalog.require', () => {
  it('正常: 宣言した id と節が揃っていれば何も起きない', () => {
    const directory = temporaryDirectory();
    writePrompt(directory, 'tool/design-chat', '## system\nsystem text\n\n## repair\nrepair text');
    const catalog = new FsPromptCatalog({ directories: [directory] });
    expect(() => catalog.require([{ id: 'tool/design-chat', sections: ['system', 'repair'] }])).not.toThrow();
    expect(() => catalog.require([])).not.toThrow();
  });

  it('例外: 無い id・無い節・読めないファイルを 1 つの例外にまとめ、置き場所と直し方を出す', () => {
    const directory = temporaryDirectory();
    writePrompt(directory, 'tool/design-chat', '## system\nsystem text');
    writeFileSync(join(directory, 'broken.md'), 'no frontmatter', 'utf8');
    const catalog = new FsPromptCatalog({ directories: [directory] });

    try {
      catalog.require([
        { id: 'tool/design-chat', sections: ['system', 'repair'] },
        { id: 'factory/planner', sections: ['system'] },
        { id: 'broken', sections: ['system'] },
      ]);
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingPromptsError);
      const problems = (error as MissingPromptsError).problems;
      expect(problems).toHaveLength(3);
      // どこに何が無いか（ファイルの置き場所）と、どう直すか。
      expect(problems[0]).toContain(join(directory, 'tool', 'design-chat.md'));
      expect(problems[0]).toContain(`has no section '## repair'`);
      expect(problems[0]).toContain('add that heading');
      expect(problems[1]).toContain(`prompt 'factory/planner' is required by the code but no file defines it`);
      expect(problems[1]).toContain(join(directory, 'factory', 'planner.md'));
      expect(problems[2]).toContain(join(directory, 'broken.md'));
      expect((error as MissingPromptsError).message).toContain('3件');
    }
  });

  it('例外: 上書き側で節が欠けているときは、同梱のどのファイルが持っているかを言う', () => {
    const bundled = temporaryDirectory();
    const override = temporaryDirectory();
    writePrompt(bundled, 'planner', '## system\nbundled system\n\n## repair\nbundled repair');
    writePrompt(override, 'planner', '## system\noperator system');
    const catalog = new FsPromptCatalog({ directories: [bundled, override] });

    try {
      catalog.require([{ id: 'planner', sections: ['system', 'repair'] }]);
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      const problem = (error as MissingPromptsError).problems[0] ?? '';
      expect(problem).toContain(join(override, 'planner.md'));
      expect(problem).toContain(`this override of prompt 'planner' has no section '## repair'`);
      expect(problem).toContain(join(bundled, 'planner.md'));
      expect(problem).toContain('copy that section into the override');
    }
  });
});
