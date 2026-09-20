/**
 * adapters層: ツールテンプレートをファイルから読むカタログ（v43 実装契約 §1）。
 *
 * 設計の要点:
 * - **決して throw しない**。置き場所が無ければ空のカタログ（機能が無効なだけで、エラーではない）。
 *   読めない / 壊れている file は `invalid[]` に理由と直し方を添えて並べる。1 つの file の誤りが
 *   他のテンプレートを道連れにしない。
 * - 読み込みは**要求時**。ファイルの更新時刻とサイズでキャッシュするので、file を足したり直したり
 *   したら再起動せずに反映される（テンプレートは外部ファイルである、という契約の肝）。
 * - 同じ `id` は**後勝ち**: 利用者の置き場所（環境変数）が同梱の標準テンプレートを上書きできる。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NOOP_LOGGER, type LoggerPort } from '../../application/operations/logger';
import { checkTemplateAgainstRegistry } from '../../application/tool-template/check-template';
import type { InvalidToolTemplate, ToolTemplateCatalog, ToolTemplateCatalogPort } from '../../application/tool-template/catalog-port';
import type { NodeRegistry } from '../../domain/etl/registry';
import { parseToolTemplate, type ToolTemplate } from '../../domain/tool-template/template';

/** リポジトリ同梱の標準テンプレートの置き場所（作業ディレクトリからの相対）。 */
export const DEFAULT_TOOL_TEMPLATE_DIRECTORY = 'templates/tools';

/** 追加の置き場所を指定する環境変数。 */
export const TOOL_TEMPLATE_DIRECTORY_ENV = 'AGENTCONTEXT_TOOL_TEMPLATES_DIR';

/** 1 ファイルの上限（これを超える file は読まずに `invalid` へ）。 */
export const MAX_TOOL_TEMPLATE_BYTES = 256 * 1024;

/** 読む file 数の上限（置き場所を間違えて数千件を読み始めないための安全弁）。 */
export const MAX_TOOL_TEMPLATE_FILES = 200;

/** 読まない file（形式の正本・説明・下書き）。 */
const IGNORED_FILES: readonly string[] = ['tool-template.schema.json', 'README.md'];

/**
 * 環境変数の値を置き場所の並びへ分ける。
 *
 * `;` は常に区切り。`:` も区切りだが、**Windows のドライブ接頭辞**（`C:\` / `C:/`）の `:` は
 * 区切りにしない — そうしないと Windows では絶対パスが 2 つに割れる。
 */
export function splitTemplateDirectories(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    if (character === ':') {
      const next = value[index + 1];
      const isDrivePrefix = current.length === 1 && /[A-Za-z]/.test(current) && (next === '\\' || next === '/');
      if (!isDrivePrefix) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 読む対象の file 名か（schema・README・`_` 始まり・`.json` 以外を外す）。 */
export function isTemplateFileName(name: string): boolean {
  if (IGNORED_FILES.includes(name)) return false;
  if (name.startsWith('_')) return false;
  return name.toLowerCase().endsWith('.json');
}

export interface FsToolTemplateCatalogOptions {
  /** 置き場所（省略すると `<cwd>/templates/tools` + 環境変数）。テストは一時ディレクトリを渡す。 */
  readonly directories?: readonly string[];
  /** ノード種別の検査に使う registry。 */
  readonly registry: NodeRegistry;
  readonly logger?: LoggerPort;
  /** 環境変数の入れ物（既定 `process.env`）。テストが差し替えられるようにする。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 作業ディレクトリ（既定 `process.cwd()`）。 */
  readonly cwd?: string;
}

/** キャッシュの照合に使う、置き場所の中身の指紋（名前 + 更新時刻 + サイズ）。 */
interface DirectoryFingerprint {
  readonly signature: string;
  readonly files: readonly { readonly directory: string; readonly name: string; readonly size: number }[];
}

export class FsToolTemplateCatalog implements ToolTemplateCatalogPort {
  private readonly directories: readonly string[];
  private readonly registry: NodeRegistry;
  private readonly logger: LoggerPort;
  private cached?: { readonly signature: string; readonly catalog: ToolTemplateCatalog };

  constructor(options: FsToolTemplateCatalogOptions) {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    this.directories = options.directories ?? [
      join(cwd, ...DEFAULT_TOOL_TEMPLATE_DIRECTORY.split('/')),
      ...splitTemplateDirectories(env[TOOL_TEMPLATE_DIRECTORY_ENV] ?? ''),
    ];
    this.registry = options.registry;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async list(): Promise<ToolTemplateCatalog> {
    const fingerprint = await this.fingerprint();
    if (this.cached?.signature === fingerprint.signature) return this.cached.catalog;
    const catalog = await this.read(fingerprint);
    this.cached = { signature: fingerprint.signature, catalog };
    return catalog;
  }

  /** 置き場所の中身を走査して指紋を作る（読めない置き場所は「空」として扱う）。 */
  private async fingerprint(): Promise<DirectoryFingerprint> {
    const files: { directory: string; name: string; size: number }[] = [];
    const parts: string[] = [];
    for (const directory of this.directories) {
      let names: string[];
      try {
        names = (await readdir(directory)).filter(isTemplateFileName).sort();
      } catch {
        // 置き場所が無い / 読めないのはエラーにしない（機能が無効なだけ）。
        parts.push(`${directory}|absent`);
        continue;
      }
      for (const name of names) {
        try {
          const info = await stat(join(directory, name));
          if (!info.isFile()) continue;
          files.push({ directory, name, size: info.size });
          parts.push(`${directory}|${name}|${info.mtimeMs}|${info.size}`);
        } catch {
          parts.push(`${directory}|${name}|unreadable`);
        }
      }
    }
    return { signature: parts.join('\n'), files };
  }

  private async read(fingerprint: DirectoryFingerprint): Promise<ToolTemplateCatalog> {
    // 同じ id は後勝ち（置き場所の並び順が優先順位）。Map の挿入順で並びは決定的。
    const templates = new Map<string, ToolTemplate>();
    const invalid: InvalidToolTemplate[] = [];
    const capped = fingerprint.files.slice(0, MAX_TOOL_TEMPLATE_FILES);
    for (const skipped of fingerprint.files.slice(MAX_TOOL_TEMPLATE_FILES)) {
      invalid.push({
        file: skipped.name,
        problems: [`this directory holds more than ${MAX_TOOL_TEMPLATE_FILES} template files, so '${skipped.name}' was not read; move the templates you do not need out of ${skipped.directory}`],
      });
    }

    for (const file of capped) {
      const path = join(file.directory, file.name);
      if (file.size > MAX_TOOL_TEMPLATE_BYTES) {
        invalid.push({
          file: file.name,
          problems: [`the file is ${file.size} bytes, more than the ${MAX_TOOL_TEMPLATE_BYTES} byte limit; split it into one template per file or remove what the template does not need`],
        });
        continue;
      }
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        invalid.push({ file: file.name, problems: [`the file cannot be read (${error instanceof Error ? error.message : String(error)}); check that it exists and that this process may read it`] });
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        invalid.push({ file: file.name, problems: [`the file is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix the syntax — a trailing comma or a missing quote is the usual cause`] });
        continue;
      }
      const parsed = parseToolTemplate(json);
      if (!parsed.ok) {
        const id = (json as { id?: unknown } | null)?.id;
        invalid.push({ file: file.name, ...(typeof id === 'string' ? { id } : {}), problems: parsed.problems });
        continue;
      }
      const registryProblems = checkTemplateAgainstRegistry(parsed.template, this.registry);
      if (registryProblems.length > 0) {
        invalid.push({ file: file.name, id: parsed.template.id, problems: registryProblems });
        continue;
      }
      templates.delete(parsed.template.id);
      templates.set(parsed.template.id, parsed.template);
    }

    if (invalid.length > 0) {
      this.logger.warn('tool templates could not be loaded', { count: invalid.length, files: invalid.map((entry) => entry.file) });
    }
    return { templates: [...templates.values()], invalid };
  }
}
