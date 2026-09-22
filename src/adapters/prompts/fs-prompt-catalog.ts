/**
 * adapters層: プロンプトをファイルから読むカタログ（v48 実装契約 §4 / ADR-0052）。
 *
 * 設計の要点（ツールテンプレートの `FsToolTemplateCatalog` と**同じ流儀**にしてある。
 * 運用者が学ぶことを増やさないため: 同じ環境変数の書き方・後勝ち・再起動不要）:
 *
 * - **起動時に全件読む**。`get` は同期で、そのとき候補ファイルの更新時刻とサイズだけ見て、
 *   変わっていれば読み直す（文を直したらサーバーを再起動せずに次の実行から効く）。
 * - **実行中の再読込で壊れたファイルは、直前の良い版を使い続けて警告を残す**。文を編集している
 *   最中に保存された半端なファイルで、動いているサーバーの指示が消えるのは割に合わない。
 *   一方 **起動時**に壊れていれば `require` が止める（黙って別の指示で動かさない）。
 * - **同じ id は後勝ち・ファイル単位**。運用者の置き場所（環境変数）が同梱の文を上書きできる。
 *   上書きが節を欠いていれば起動時に止める（同梱へ部分的に混ぜ戻したりはしない — どの文が
 *   送られているか追えなくなる）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NOOP_LOGGER, type LoggerPort } from '../../application/operations/logger';
import { MissingPromptsError, PromptNotFoundError, type PromptCatalogPort, type PromptSpec } from '../../application/prompt/prompt-catalog-port';
import { parsePromptFile, type PromptTemplate } from '../../application/prompt/prompt-template';
// 環境変数の分け方はツールテンプレートと**同じ規則**でなければならない（運用者から見て同じ書式の
// 設定が 2 つあり、片方だけ `C:\` を割ってしまう、という事態を避ける）。adapters 間の import は
// dependency-cruiser で禁じられていないので、規則を複製せずこの純関数を共有する。
import { splitTemplateDirectories } from '../templates/fs-tool-template-catalog';

/** リポジトリ同梱のプロンプトの置き場所（作業ディレクトリからの相対）。 */
export const DEFAULT_PROMPT_DIRECTORY = 'prompts';

/** 追加の置き場所を指定する環境変数（`;` / `:` 区切り・後勝ち）。 */
export const PROMPT_DIRECTORY_ENV = 'AGENTCONTEXT_PROMPTS_DIR';

/** 1 ファイルの上限（これを超える file は読まない）。 */
export const MAX_PROMPT_BYTES = 256 * 1024;

/** 読む file 数の上限（置き場所を間違えて数千件を読み始めないための安全弁）。 */
export const MAX_PROMPT_FILES = 500;

/** 読まない file（説明・書き方の見本・下書き）。 */
export function isPromptFileName(name: string): boolean {
  if (name.startsWith('_')) return false;
  if (name.toLowerCase() === 'readme.md') return false;
  return name.toLowerCase().endsWith('.md');
}

/** 置き場所からの相対パスを id へ（`factory\planner.md` → `factory/planner`）。 */
export function promptIdFromRelativePath(relative: string): string {
  return relative.replace(/\\/g, '/').replace(/\.md$/i, '');
}

/** id を、ある置き場所の下のファイルパスへ（`get` のたびに候補を組み立てるために使う）。 */
function promptPath(directory: string, id: string): string {
  return `${join(directory, ...id.split('/'))}.md`;
}

export interface FsPromptCatalogOptions {
  /** 置き場所（省略すると `<cwd>/prompts` + 環境変数）。テストは一時ディレクトリを渡す。 */
  readonly directories?: readonly string[];
  /** 環境変数の入れ物（既定 `process.env`）。テストが差し替えられるようにする。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 作業ディレクトリ（既定 `process.cwd()`）。 */
  readonly cwd?: string;
  readonly logger?: LoggerPort;
}

/** 読み込めなかったファイル 1 件（`ToolTemplateCatalog.invalid` と同じ形）。 */
export interface InvalidPromptFile {
  /** ファイルの置き場所（人がそれを開けるだけの情報＝絶対パス）。 */
  readonly file: string;
  /** そのファイルが定義しているはずの id。 */
  readonly id: string;
  /** 問題ごとに「何が悪いか」と「どう直すか」を 1 文で書いたもの。 */
  readonly problems: readonly string[];
}

/** 1 つの置き場所にある 1 ファイルの状態。 */
interface PromptFileState {
  readonly path: string;
  /** 更新時刻とサイズ。これが同じなら読み直さない。 */
  readonly fingerprint: string;
  /** 読めた版。壊れた再読込のあとは**直前の良い版**が入っている。 */
  readonly template?: PromptTemplate;
  /** 今のファイルの中身の問題（読めていれば空）。 */
  readonly problems: readonly string[];
}

export class FsPromptCatalog implements PromptCatalogPort {
  private readonly directories: readonly string[];
  private readonly logger: LoggerPort;
  /** 絶対パス → 状態。存在しないファイルは持たない（消されたら delete する）。 */
  private readonly files = new Map<string, PromptFileState>();
  /** 起動時の走査で見つかった id（どの置き場所にあったかは問わない）。 */
  private readonly discovered = new Set<string>();

  constructor(options: FsPromptCatalogOptions = {}) {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    this.directories = options.directories ?? [
      join(cwd, DEFAULT_PROMPT_DIRECTORY),
      ...splitTemplateDirectories(env[PROMPT_DIRECTORY_ENV] ?? ''),
    ];
    this.logger = options.logger ?? NOOP_LOGGER;
    this.loadAll();
  }

  get(id: string): PromptTemplate {
    const state = this.resolve(id);
    if (state === undefined) {
      throw new PromptNotFoundError(
        id,
        `prompt '${id}' is not defined anywhere; create ${promptPath(this.directories[0] ?? DEFAULT_PROMPT_DIRECTORY, id)}`
        + ` (looked in ${this.directories.join(', ')})`,
      );
    }
    if (state.template === undefined) {
      throw new PromptNotFoundError(id, `prompt '${id}' cannot be read from ${state.path}:\n  - ${state.problems.join('\n  - ')}`, state.problems);
    }
    return state.template;
  }

  require(specs: readonly PromptSpec[]): void {
    const problems: string[] = [];
    for (const spec of specs) {
      const state = this.resolve(spec.id);
      if (state === undefined) {
        problems.push(
          `prompt '${spec.id}' is required by the code but no file defines it;`
          + ` create ${promptPath(this.directories[0] ?? DEFAULT_PROMPT_DIRECTORY, spec.id)} with the sections ${spec.sections.map((name) => `'## ${name}'`).join(', ')}`
          + ` (looked in ${this.directories.join(', ')})`,
        );
        continue;
      }
      if (state.template === undefined) {
        for (const problem of state.problems) problems.push(`${state.path}: ${problem}`);
        continue;
      }
      for (const section of spec.sections) {
        if (state.template.sections.has(section)) continue;
        const bundled = this.otherFileWithSection(spec.id, section, state.path);
        problems.push(bundled === undefined
          ? `${state.path}: prompt '${spec.id}' has no section '## ${section}', which the code renders;`
            + ` add that heading with the text for it (the file has ${[...state.template.sections.keys()].map((name) => `'${name}'`).join(', ')})`
          : `${state.path}: this override of prompt '${spec.id}' has no section '## ${section}', but ${bundled} does;`
            + ` copy that section into the override, or delete the override so the bundled file is used again`);
      }
    }
    if (problems.length > 0) throw new MissingPromptsError(problems);
  }

  /** 起動時の走査で見つかった id（昇順）。同梱ファイルの検査テストが使う。 */
  ids(): readonly string[] {
    return [...this.discovered].sort();
  }

  /** 読めなかったファイル（理由と直し方つき）。同梱ファイルの検査テストが使う。 */
  invalid(): readonly InvalidPromptFile[] {
    const entries: InvalidPromptFile[] = [];
    for (const id of this.ids()) {
      for (const directory of this.directories) {
        const state = this.files.get(promptPath(directory, id));
        if (state === undefined || state.problems.length === 0) continue;
        entries.push({ file: state.path, id, problems: state.problems });
      }
    }
    return entries;
  }

  /** 全置き場所を走査して読む（コンストラクタから 1 回）。 */
  private loadAll(): void {
    let budget = MAX_PROMPT_FILES;
    const invalid: InvalidPromptFile[] = [];
    for (const directory of this.directories) {
      for (const relative of listPromptFiles(directory)) {
        if (budget <= 0) {
          this.logger.warn('too many prompt files, the rest were not read', { limit: MAX_PROMPT_FILES, directory, file: relative });
          break;
        }
        budget -= 1;
        const id = promptIdFromRelativePath(relative);
        this.discovered.add(id);
        const state = this.read(promptPath(directory, id), id);
        this.files.set(state.path, state);
        if (state.problems.length > 0) invalid.push({ file: state.path, id, problems: state.problems });
      }
    }
    if (invalid.length > 0) {
      // 起動を止めるのは `require`（コードが要求する id だけ）。ここは「置いたのに効いていない」
      // ファイルを運用者が見つけられるように痕跡を残すだけ。
      this.logger.warn('prompt files could not be read', { count: invalid.length, files: invalid.map((entry) => entry.file) });
    }
  }

  /**
   * id に対する今の勝者を返す（無ければ `undefined`）。
   *
   * 置き場所の並び順に候補パスを `stat` し、**最後に存在したもの**が勝つ。候補を毎回組み立てるので、
   * 起動後に上書きファイルを足しても消しても次の `get` から効く（`stat` は置き場所の数だけ＝通常 1〜2 回）。
   */
  private resolve(id: string): PromptFileState | undefined {
    let winner: PromptFileState | undefined;
    for (const directory of this.directories) {
      const path = promptPath(directory, id);
      const previous = this.files.get(path);
      let info;
      try {
        info = statSync(path);
      } catch {
        if (previous !== undefined) this.files.delete(path);
        continue;
      }
      if (!info.isFile()) continue;
      const fingerprint = `${info.mtimeMs}|${info.size}`;
      if (previous?.fingerprint === fingerprint) {
        winner = previous;
        continue;
      }
      let next = this.read(path, id);
      if (next.template === undefined && previous?.template !== undefined) {
        // 編集の途中で保存された半端なファイル。動いているサーバーの指示を消さず、警告だけ残す。
        this.logger.warn('a prompt file changed but cannot be read, so the previous version stays in use', {
          id,
          file: path,
          problems: next.problems,
        });
        next = { path, fingerprint, template: previous.template, problems: next.problems };
      }
      this.files.set(path, next);
      winner = next;
    }
    return winner;
  }

  /** ファイル 1 件を読んで解析する（読めない理由も「直し方」つきで持ち帰る）。 */
  private read(path: string, id: string): PromptFileState {
    let fingerprint = 'unreadable';
    try {
      const info = statSync(path);
      fingerprint = `${info.mtimeMs}|${info.size}`;
      if (info.size > MAX_PROMPT_BYTES) {
        return {
          path,
          fingerprint,
          problems: [`the file is ${info.size} bytes, more than the ${MAX_PROMPT_BYTES} byte limit; split it into one prompt per file, or remove what the model does not need`],
        };
      }
    } catch (error) {
      return { path, fingerprint, problems: [`the file cannot be inspected (${describe(error)}); check that it exists and that this process may read it`] };
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      return { path, fingerprint, problems: [`the file cannot be read (${describe(error)}); check that it exists and that this process may read it`] };
    }
    const parsed = parsePromptFile(id, text);
    return parsed.ok ? { path, fingerprint, template: parsed.template, problems: [] } : { path, fingerprint, problems: parsed.problems };
  }

  /** 勝者より前の置き場所で、その節を持っているファイル（上書きで節が欠けたときの案内に使う）。 */
  private otherFileWithSection(id: string, section: string, winnerPath: string): string | undefined {
    for (const directory of this.directories) {
      const path = promptPath(directory, id);
      if (path === winnerPath) continue;
      if (this.files.get(path)?.template?.sections.has(section) === true) return path;
    }
    return undefined;
  }
}

/** 例外を 1 行の理由へ（`logger.describeError` と同じ用途だが、ここでは文脈を短く保つ）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 置き場所の下の `*.md` を再帰的に並べる（置き場所からの相対パス・`/` 区切り・昇順）。
 *
 * 読めない置き場所は「空」として扱う（環境変数に書いた場所がまだ無いのはエラーではない）。
 * `_` と `.` で始まるディレクトリは辿らない（下書き置き場と `.git` を読み始めない）。
 */
function listPromptFiles(directory: string, prefix = ''): readonly string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      files.push(...listPromptFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.isFile() || !isPromptFileName(entry.name)) continue;
    files.push(`${prefix}${entry.name}`);
  }
  return files;
}
