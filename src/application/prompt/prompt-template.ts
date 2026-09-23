/**
 * application層: プロンプトファイル 1 件の形式（v48 実装契約 §3・§4 / ADR-0052）。
 *
 * ## なぜこの形にするか
 *
 * モデルへ送る**文**はファイルに置き、**組み立て**（どの節をどの順に使うか・条件での入れ替え・
 * untrusted data の隔離・JSON schema）はコードに残す。だからここにあるのは
 * 「frontmatter と `## 節` を読む」「`{{name}}` を埋める」だけで、条件も繰り返しも持たない。
 * テンプレート言語を入れると、隔離や組み立ての規則までファイル側へ流れて検証できなくなる
 * （ADR-0049 でツールテンプレートに対して下したのと同じ判断）。
 *
 * ## 厳しくする理由
 *
 * 文が 1 節欠けたり差し込み名が 1 文字違ったりしても、モデルは**それらしい応答を返してしまう**。
 * 静かに別の指示で動くより、読み込み時に落として「どのファイルの何が悪く、どう直すか」を出す方が安い。
 * そのため `problems` は必ず「何が悪いか + どう直すか」を 1 文に含める英文にする
 * （ツールテンプレートの `invalid[].problems` と同じ流儀。運用者はこの 2 つを同じ画面で読む）。
 *
 * YAML パーサを使わないのは、frontmatter が 3 キーしかないのに YAML の全機能（別名・複数行・型推論）を
 * 持ち込むと、書ける形が増えるぶんだけ「読めるが意図と違う」が増えるため。
 */
import type { Flavor } from '../../domain/shared/brand';

/** プロンプトファイルの id（ファイルの相対パス・拡張子なし・`/` 区切り）。素の string から代入可能な弱ブランド（ADR-0034）。 */
export type PromptId = Flavor<string, 'PromptId'>;
/** プロンプトの版（`calculate-expression/v2` の形）。素の string から代入可能な弱ブランド（ADR-0034）。 */
export type PromptVersion = Flavor<string, 'PromptVersion'>;

/** 差し込みに渡せる値。配列は改行で連結する（箇条書きをコード側で組み立てるため）。 */
export type PromptVariableValue = string | number | readonly string[];

/** 節 1 つを描画するときの差し込み。 */
export type PromptVariables = Readonly<Record<string, PromptVariableValue>>;

/** `version` の形式（実行記録に残す版の文字列。例 `calculate-expression/v2`）。 */
export const PROMPT_VERSION_PATTERN = /^[a-z0-9-]+\/v[0-9]+$/;
/** 節の名前（`## system` の `system`）。 */
export const PROMPT_SECTION_NAME_PATTERN = /^[a-z][a-z0-9.-]*$/;
/** 差し込みの名前（`{{maxToolCalls}}` の `maxToolCalls`）。 */
export const PROMPT_VARIABLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
/** frontmatter に書ける唯一のキーの並び（この 3 つだけ・すべて必須）。 */
export const PROMPT_FRONTMATTER_KEYS = ['id', 'version', 'description'] as const;

/** 本文から差し込みを拾う（`{{` と `}}` の間に `{`・`}` を含まないものだけを 1 件と見る）。 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * プロンプトの描画に失敗した。
 *
 * **起動時の検査（`PromptCatalogPort.require`）を通っていれば節は必ず在る**ので、ここへ来るのは
 * 呼び出し側のコードの誤り（差し込みの渡し忘れ・節名の打ち間違い）である。握り潰さず落とす。
 */
export class PromptRenderError extends Error {
  /** どのプロンプトか（ファイルの相対パス）。 */
  readonly promptId: PromptId;
  /** どの節か。 */
  readonly section: string;
  /** どの差し込み名か（節そのものが無い場合は `undefined`）。 */
  readonly variable?: string;

  constructor(promptId: PromptId, section: string, message: string, variable?: string) {
    super(message);
    this.name = 'PromptRenderError';
    this.promptId = promptId;
    this.section = section;
    if (variable !== undefined) this.variable = variable;
  }
}

/** 読み込み済みのプロンプト 1 件。 */
export interface PromptTemplate {
  /** ファイルの相対パス（拡張子なし・`/` 区切り）。 */
  readonly id: PromptId;
  /** 実行記録に残す版（`calculate-expression/v2`）。版はファイルが正で、定数は持たない。 */
  readonly version: PromptVersion;
  /**
   * 何のための文かを日本語 1〜2 行で。`{{}}` の一覧はコード側の `PromptSpec` と合わせて読む。
   * （契約 §4 の interface への追加。ファイルが必ず持つ値を読めないと README の案内が嘘になるため。）
   */
  readonly description: string;
  /** 節名 → 本文（前後の空行は落としてある）。宣言順を保つ。 */
  readonly sections: ReadonlyMap<string, string>;
  /** 節を差し込みつきで描画する。無い節・無い名前は `PromptRenderError`。 */
  render(section: string, vars?: PromptVariables): string;
}

/** `parsePromptFile` の結果。読めなかった場合は理由と直し方を**全部**並べる。 */
export type ParsePromptFileResult =
  | { readonly ok: true; readonly template: PromptTemplate }
  | { readonly ok: false; readonly problems: readonly string[] };

/** 差し込みの値を文字列へ。配列は改行で連結する（空配列は空文字＝行が消える）。 */
function formatValue(value: PromptVariableValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return value.join('\n');
}

class FilePromptTemplate implements PromptTemplate {
  constructor(
    readonly id: PromptId,
    readonly version: PromptVersion,
    readonly description: string,
    readonly sections: ReadonlyMap<string, string>,
  ) {}

  render(section: string, vars: PromptVariables = {}): string {
    const body = this.sections.get(section);
    if (body === undefined) {
      const available = [...this.sections.keys()].map((name) => `'${name}'`).join(', ');
      throw new PromptRenderError(
        this.id,
        section,
        `prompt '${this.id}' has no section '${section}'; add a '## ${section}' heading to the file, or render one of its sections (${available})`,
      );
    }
    // 置換に関数を渡すので、**埋めた値の中の `{{…}}` や `$&` は再解釈されない**
    // （利用者のデータが差し込みの形をしていても、指示文を書き換えられない）。
    return body.replace(PLACEHOLDER, (_match, name: string) => {
      const value = vars[name];
      if (value === undefined) {
        throw new PromptRenderError(
          this.id,
          section,
          `section '${section}' of prompt '${this.id}' uses '{{${name}}}' but no value was given for it;`
          + ` pass ${name} to render(), or delete '{{${name}}}' from the file`,
          name,
        );
      }
      return formatValue(value);
    });
  }
}

/** 本文の前後の空行を落とす（節の途中の空行は意味を持つので残す）。 */
function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(start, end);
}

/** 節の本文に書かれた差し込みを検査する（描画時ではなく**読み込み時**に落とす）。 */
function checkPlaceholders(section: string, body: string, problems: string[]): void {
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (PROMPT_VARIABLE_PATTERN.test(name)) continue;
    problems.push(
      `section '${section}' has the placeholder '{{${name}}}', whose name does not match ${PROMPT_VARIABLE_PATTERN.source};`
      + ` rename it to letters and digits starting with a letter (for example '{{maxToolCalls}}')`,
    );
  }
  if (body.replace(PLACEHOLDER, '').includes('{{')) {
    problems.push(
      `section '${section}' has a '{{' that is never closed; write '{{name}}' for a placeholder, or remove the braces`
      + ' (this file format has no other use for double braces)',
    );
  }
}

/**
 * プロンプトファイル 1 件を読む。
 *
 * `id` は**ファイルの置き場所から決まる**（相対パス・拡張子なし・`/` 区切り）ので呼び出し側が渡し、
 * frontmatter の `id` がそれと一致するかをここで見る。2 つを突き合わせるのは、ファイルを複製して
 * 中身の `id` を直し忘れたときに「別名のつもりが元の文を上書きしていた」を防ぐため。
 */
export function parsePromptFile(id: PromptId, text: string): ParsePromptFileResult {
  const problems: string[] = [];
  // BOM と CRLF を落とす。Windows のエディタで保存しただけで形式違反になるのは理不尽なので、
  // ここは寛容にする（読み取れる差異であり、意図の曖昧さを生まない）。
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  if (lines[0]?.trim() !== '---') {
    return {
      ok: false,
      problems: [
        `the file does not start with a frontmatter fence; make the first line '---' and put "id: ${id}",`
        + ' "version: <name>/v<number>" and "description: <日本語で1〜2行>" under it, then close it with another \'---\'',
      ],
    };
  }

  const values = new Map<string, string>();
  let index = 1;
  let closed = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '---') {
      closed = true;
      index += 1;
      break;
    }
    if (line.trim() === '') continue;
    // 節の見出しに行き当たったら、閉じ忘れが確定する。ここで止めないと、以降の本文が全部
    // 「key: value ではない」として報告され、本当の原因（`---` が無い）が埋もれる。
    if (line.startsWith('##') && !line.startsWith('###')) break;
    const separator = line.indexOf(':');
    const key = separator === -1 ? '' : line.slice(0, separator).trim();
    if (key === '') {
      problems.push(
        `frontmatter line ${index + 1} (${JSON.stringify(line)}) is not written as "key: value";`
        + ` write ${PROMPT_FRONTMATTER_KEYS.join(' / ')} one per line, or close the frontmatter with '---' before this line`,
      );
      continue;
    }
    if (!(PROMPT_FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `the frontmatter key '${key}' is not understood; it holds exactly ${PROMPT_FRONTMATTER_KEYS.join(' / ')}`
        + ' — move anything else into a section or delete it',
      );
      continue;
    }
    if (values.has(key)) {
      problems.push(`the frontmatter key '${key}' appears twice; keep the line you mean and delete the other`);
      continue;
    }
    values.set(key, line.slice(separator + 1).trim());
  }

  if (!closed) {
    return {
      ok: false,
      problems: [...problems, `the frontmatter is never closed; add a line holding only '---' after the description, before the first '## ' section`],
    };
  }

  for (const key of PROMPT_FRONTMATTER_KEYS) {
    if ((values.get(key) ?? '') !== '') continue;
    problems.push(
      `the frontmatter has no ${key}; add "${key}: ${key === 'id' ? id : key === 'version' ? '<name>/v<number>' : '<日本語で誰がいつ何のために使う文か>'}" between the '---' lines`,
    );
  }

  const declaredId = values.get('id');
  if (declaredId !== undefined && declaredId !== '' && declaredId !== id) {
    problems.push(
      `the frontmatter says id '${declaredId}' but the file sits at '${id}.md';`
      + ` change the id to '${id}', or move the file to '${declaredId}.md' — the id is the path so that the code can find the file`,
    );
  }

  const version = values.get('version');
  if (version !== undefined && version !== '' && !PROMPT_VERSION_PATTERN.test(version)) {
    problems.push(
      `the version '${version}' does not match ${PROMPT_VERSION_PATTERN.source};`
      + ' write it as "<lowercase-name>/v<number>" (for example "calculate-expression/v2") and raise the number whenever the text changes meaning',
    );
  }

  const sections = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    const content = trimBlankLines(body).join('\n');
    if (content === '') {
      problems.push(`section '${current}' has no text; write the sentences the model receives under '## ${current}', or delete the heading`);
    } else {
      checkPlaceholders(current, content, problems);
      sections.set(current, content);
    }
    body = [];
  };

  const seen = new Set<string>();
  let sawHeading = false;
  let reportedPreamble = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    // `##` で始まり `###` ではない行は**必ず**節の見出し（`###` 以下は本文の一部）。
    if (line.startsWith('##') && !line.startsWith('###')) {
      flush();
      current = undefined;
      sawHeading = true;
      if (!line.startsWith('## ')) {
        problems.push(`the heading ${JSON.stringify(line)} needs a space after '##'; write '## ${line.slice(2).trim()}'`);
        continue;
      }
      const name = line.slice(3).trim();
      if (!PROMPT_SECTION_NAME_PATTERN.test(name)) {
        problems.push(
          `the section name '${name}' does not match ${PROMPT_SECTION_NAME_PATTERN.source};`
          + ` rename it to lowercase letters, digits, '.' and '-' starting with a letter (for example '## repair' or '## rules.join')`,
        );
        continue;
      }
      if (seen.has(name)) {
        problems.push(`the section '${name}' is declared twice; merge the two into one '## ${name}', or give the second one another name`);
        continue;
      }
      seen.add(name);
      current = name;
      continue;
    }
    if (current === undefined) {
      // 見出しが一度でも現れていれば、本文が読まれない原因は見出しの側（名前が規則外・重複）で、
      // それは既に報告済み。ここで重ねて指摘しない。
      if (line.trim() === '' || reportedPreamble || sawHeading) continue;
      // frontmatter と最初の節の間に文を書くと、それは誰にも届かない（描画は節単位）。
      // 1 行目だけ報告する（前置きは何行も続くのが普通で、同じ指摘を並べても読みにくくなるだけ）。
      reportedPreamble = true;
      problems.push(
        `the text ${JSON.stringify(line.trim().slice(0, 40))} sits between the frontmatter and the first '## ' section, where nothing reads it;`
        + ' put it under a section heading, or delete it',
      );
      continue;
    }
    body.push(line);
  }
  flush();

  if (!sawHeading) {
    problems.push(`the file has no sections; add at least one '## <name>' heading followed by the text the model receives`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    template: new FilePromptTemplate(id, values.get('version')!, values.get('description')!, sections),
  };
}
