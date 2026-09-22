/**
 * プロンプトファイルの形式のテスト（v48 実装契約 §6）。
 *
 * 文が 1 節欠けても差し込み名が 1 文字違っても、モデルは**それらしい応答を返してしまう**。
 * だから「通る条件」より**弾く条件と、そのときのメッセージ**を厚く確認する
 * （`config/environment.test.ts` と同じ方針）。
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_SECTION_NAME_PATTERN,
  PROMPT_VARIABLE_PATTERN,
  PROMPT_VERSION_PATTERN,
  PromptRenderError,
  parsePromptFile,
  type PromptTemplate,
} from './prompt-template';

/** 妥当な最小ファイル（節だけ差し替えて使う）。 */
function file(body: string, front = 'id: tool/sample\nversion: sample/v1\ndescription: 見本'): string {
  return `---\n${front}\n---\n\n${body}\n`;
}

/** 読めた前提で template を取り出す（読めなければ problems を見せて落とす）。 */
function parsed(id: string, text: string): PromptTemplate {
  const result = parsePromptFile(id, text);
  if (!result.ok) throw new Error(`読めるはずのファイルが読めなかった:\n  - ${result.problems.join('\n  - ')}`);
  return result.template;
}

/** 読めない前提で problems を取り出す。 */
function problemsOf(id: string, text: string): readonly string[] {
  const result = parsePromptFile(id, text);
  if (result.ok) throw new Error('形式違反のはずのファイルが読めてしまった');
  return result.problems;
}

describe('parsePromptFile', () => {
  it('正常: frontmatter と節を読み、id・version・description・節を返す', () => {
    const template = parsed('tool/calculate-expression', [
      '---',
      'id: tool/calculate-expression',
      'version: calculate-expression/v2',
      'description: 関数電卓ノードの式を提案させる',
      '---',
      '',
      '## system',
      'You write one expression for a calculator node.',
      '',
      '## repair',
      'Your previous expression was rejected.',
      '',
    ].join('\n'));

    expect(template.id).toBe('tool/calculate-expression');
    expect(template.version).toBe('calculate-expression/v2');
    expect(template.description).toBe('関数電卓ノードの式を提案させる');
    expect([...template.sections.keys()]).toEqual(['system', 'repair']);
    expect(template.render('system')).toBe('You write one expression for a calculator node.');
  });

  it('正常: 本文の前後の空行は落とし、途中の空行と `###` は本文として残す', () => {
    const template = parsed('a', file(['## system', '', 'first', '', '### not a section', 'last', '', ''].join('\n'), 'id: a\nversion: a/v1\ndescription: x'));
    expect(template.render('system')).toBe('first\n\n### not a section\nlast');
  });

  it('正常: 差し込みに文字列・数値・配列を埋める（配列は改行で連結）', () => {
    const template = parsed('a', file(['## system', 'limit={{max}}', 'who={{who}}', 'rules:', '{{rules}}'].join('\n'), 'id: a\nversion: a/v1\ndescription: x'));
    expect(template.render('system', { max: 12, who: 'analyst', rules: ['- one', '- two'] })).toBe('limit=12\nwho=analyst\nrules:\n- one\n- two');
  });

  it('境界: 埋めた値の中の `{{…}}` と `$&` は再解釈しない（利用者のデータで指示文を書き換えさせない）', () => {
    const template = parsed('a', file('## system\nq={{question}}', 'id: a\nversion: a/v1\ndescription: x'));
    expect(template.render('system', { question: '{{secret}} $& {{question}}' })).toBe('q={{secret}} $& {{question}}');
  });

  it('境界: 同じ差し込みが複数回出ても全部埋まる／空配列は空文字になる', () => {
    const template = parsed('a', file('## system\n{{x}}-{{x}}\n{{y}}', 'id: a\nversion: a/v1\ndescription: x'));
    expect(template.render('system', { x: 'a', y: [] })).toBe('a-a\n');
  });

  it('境界: CRLF と BOM のファイルも読む（Windows のエディタで保存しただけで落とさない）', () => {
    const template = parsed('a', '﻿---\r\nid: a\r\nversion: a/v1\r\ndescription: x\r\n---\r\n\r\n## system\r\nline one\r\nline two\r\n');
    expect(template.render('system')).toBe('line one\nline two');
  });

  it('境界: 値に `:` を含む description は最初の `:` だけで切る', () => {
    expect(parsed('a', file('## system\nx', 'id: a\nversion: a/v1\ndescription: 誰が: いつ: 何のために')).description).toBe('誰が: いつ: 何のために');
  });

  it('異常: frontmatter が無い／閉じていないファイルは読まない', () => {
    expect(problemsOf('a', '## system\nx')[0]).toContain(`make the first line '---'`);
    expect(problemsOf('a', '---\nid: a\nversion: a/v1\ndescription: x\n\n## system\nx')[0]).toContain('never closed');
  });

  it('異常: frontmatter のキー不足・未知のキー・重複はそれぞれ理由を出す', () => {
    expect(problemsOf('a', '---\nid: a\nversion: a/v1\n---\n## system\nx').join('\n')).toContain('has no description');
    expect(problemsOf('a', '---\nid: a\nversion: a/v1\ndescription: x\nauthor: me\n---\n## system\nx').join('\n')).toContain(`key 'author' is not understood`);
    expect(problemsOf('a', '---\nid: a\nid: a\nversion: a/v1\ndescription: x\n---\n## system\nx').join('\n')).toContain(`key 'id' appears twice`);
    expect(problemsOf('a', '---\nid: a\nversion: a/v1\ndescription: x\njust a line\n---\n## system\nx').join('\n')).toContain('is not written as "key: value"');
  });

  it('異常: id がファイルの相対パスと一致しなければ読まない（複製して直し忘れる事故）', () => {
    const problems = problemsOf('factory/planner', file('## system\nx', 'id: factory/tool-smith\nversion: planner/v1\ndescription: x'));
    expect(problems[0]).toContain(`id 'factory/tool-smith'`);
    expect(problems[0]).toContain(`'factory/planner.md'`);
    expect(problems[0]).toContain(`change the id to 'factory/planner'`);
  });

  it('異常: version が `名前/v番号` でなければ読まない', () => {
    for (const bad of ['1.0.0', 'Sample/v1', 'sample/v', 'sample-v1', 'sample/vX']) {
      expect(PROMPT_VERSION_PATTERN.test(bad)).toBe(false);
      expect(problemsOf('a', file('## system\nx', `id: a\nversion: ${bad}\ndescription: x`))[0]).toContain('does not match');
    }
    expect(parsed('a', file('## system\nx', 'id: a\nversion: sample-2/v10\ndescription: x')).version).toBe('sample-2/v10');
  });

  it('異常: 節が 1 つも無いファイルは読まない（送る文が無い）', () => {
    expect(problemsOf('a', '---\nid: a\nversion: a/v1\ndescription: x\n---\n')[0]).toContain('has no sections');
  });

  it('異常: 節名が規則外・`##` の後に空白が無い見出しは読まない', () => {
    expect(PROMPT_SECTION_NAME_PATTERN.test('system')).toBe(true);
    expect(problemsOf('a', file('## System rules\nx', 'id: a\nversion: a/v1\ndescription: x'))[0]).toContain('does not match');
    expect(problemsOf('a', file('##system\nx', 'id: a\nversion: a/v1\ndescription: x'))[0]).toContain(`space after '##'`);
  });

  it('異常: 同じ名前の節が 2 つあれば読まない（どちらが送られるか決められない）', () => {
    const problems = problemsOf('a', file('## system\nfirst\n\n## system\nsecond', 'id: a\nversion: a/v1\ndescription: x'));
    expect(problems[0]).toContain(`section 'system' is declared twice`);
    expect(problems[0]).toContain('merge');
  });

  it('異常: 空の節は読まない（描画すると黙って空文字が送られる）', () => {
    expect(problemsOf('a', file('## system\n\n## repair\nx', 'id: a\nversion: a/v1\ndescription: x'))[0]).toContain(`section 'system' has no text`);
  });

  it('異常: 差し込み名が規則外・`{{` が閉じていない本文は読まない', () => {
    expect(PROMPT_VARIABLE_PATTERN.test('max-rows')).toBe(false);
    expect(problemsOf('a', file('## system\n{{max-rows}}', 'id: a\nversion: a/v1\ndescription: x'))[0]).toContain(`'{{max-rows}}'`);
    expect(problemsOf('a', file('## system\n{{ name }}', 'id: a\nversion: a/v1\ndescription: x'))[0]).toContain('does not match');
    expect(problemsOf('a', file('## system\nuse {{name', 'id: a\nversion: a/v1\ndescription: x'))[0]).toContain('never closed');
  });

  it('異常: frontmatter と最初の節の間の文は読まない（誰にも届かない）', () => {
    const problems = problemsOf('a', file('前置きの文\nもう1行\n\n## system\nx', 'id: a\nversion: a/v1\ndescription: x'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('where nothing reads it');
  });

  it('異常: 問題は 1 件目で止めず全部並べ、どれも「どう直すか」を含む', () => {
    const problems = problemsOf('a', '---\nversion: BAD\ndescription: x\n---\n## Bad Name\ny\n\n## ok\n{{bad-name}}');
    expect(problems.length).toBeGreaterThanOrEqual(3);
    const fixes = ['add', 'write', 'rename', 'delete', 'remove', 'merge', 'change', 'move', 'split', 'keep', 'close', 'copy', 'create', 'pass', 'put'];
    for (const problem of problems) {
      expect(fixes.some((verb) => problem.includes(verb)), `直し方が無い: ${problem}`).toBe(true);
    }
  });
});

describe('PromptTemplate.render', () => {
  const template = parsed('tool/sample', file('## system\nhello {{who}}', 'id: tool/sample\nversion: sample/v1\ndescription: x'));

  it('例外: 未定義の差し込みは PromptRenderError（id・節・名前を持つ）', () => {
    expect(() => template.render('system')).toThrow(PromptRenderError);
    try {
      template.render('system', { other: 'x' });
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptRenderError);
      const rendered = error as PromptRenderError;
      expect(rendered.promptId).toBe('tool/sample');
      expect(rendered.section).toBe('system');
      expect(rendered.variable).toBe('who');
      expect(rendered.message).toContain('pass who to render()');
    }
  });

  it('例外: 無い節を描画したら PromptRenderError（在る節を案内する）', () => {
    try {
      template.render('repair');
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptRenderError);
      const rendered = error as PromptRenderError;
      expect(rendered.section).toBe('repair');
      expect(rendered.variable).toBeUndefined();
      expect(rendered.message).toContain(`add a '## repair' heading`);
      expect(rendered.message).toContain(`'system'`);
    }
  });
});
