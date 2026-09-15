import { describe, expect, it } from 'vitest';
import { chunkPolicyDocument, isHeadingLine, splitPolicySections } from './document-sections';
import { HEARING_TOPICS, hearingTopicId, OTHER_HEARING_TOPIC } from './hearing-topics';

const DOCUMENT = [
  '株式会社サンプル商事 旅費・経費規程',
  '第1条 目的',
  'この規程は経費の精算について定める。',
  '第2条 交通費',
  '公共交通機関の運賃は実費とする。',
  '# 付則',
  '1. 本規程は2026年4月1日から施行する。',
].join('\n');

describe('isHeadingLine', () => {
  it.each([['第5条 タクシー', true], ['第十二条', true], ['## 交際費', true], ['1. 総則', true], ['２．宿泊', true], ['【別表】', true], ['本文です。', false], ['', false], [`第1条 ${'長'.repeat(80)}`, false]])('%s → %s', (line, expected) => {
    expect(isHeadingLine(line)).toBe(expected);
  });
});

describe('splitPolicySections', () => {
  it('正常: 見出しで節に分け、最初の見出しより前は見出しの無い節。位置は原文の文字位置', () => {
    const sections = splitPolicySections(DOCUMENT);
    expect(sections.map((section) => section.heading)).toEqual(['', '第1条 目的', '第2条 交通費', '# 付則', '1. 本規程は2026年4月1日から施行する。']);
    expect(DOCUMENT.slice(sections[2]!.start, sections[2]!.end)).toBe('第2条 交通費\n公共交通機関の運賃は実費とする。\n');
    expect(sections[sections.length - 1]!.end).toBe(DOCUMENT.length);
  });

  it('境界: 空白だけの前置きは節にしない。見出しが無ければ全体で 1 節', () => {
    expect(splitPolicySections('\n\n第1条 目的\n本文').map((section) => section.heading)).toEqual(['第1条 目的']);
    expect(splitPolicySections('見出しの無い本文')).toEqual([{ heading: '', start: 0, end: 8 }]);
    expect(splitPolicySections('   ')).toEqual([]);
  });
});

describe('chunkPolicyDocument', () => {
  it('正常: 上限以内なら隣り合う節を 1 塊にまとめ、見出しを重複なく持つ', () => {
    const chunks = chunkPolicyDocument(DOCUMENT);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ start: 0, end: DOCUMENT.length, text: DOCUMENT });
    expect(chunks[0]!.headings).toContain('第2条 交通費');
  });

  it('境界: 上限を超える前で塊を分け、1 節が長ければ字数で割る（見出しは各片に付く）', () => {
    const text = `第1条 A\n${'あ'.repeat(30)}\n第2条 B\n${'い'.repeat(5)}\n`;
    const chunks = chunkPolicyDocument(text, undefined, 20);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.end - chunk.start <= 20)).toBe(true);
    expect(chunks[0]!.headings).toEqual(['第1条 A']);
    expect(chunks[1]!.headings).toEqual(['第1条 A']);
    expect(chunks[chunks.length - 1]!.headings).toContain('第2条 B');
  });
});

describe('hearingTopicId', () => {
  it('正常: カタログの話題はそのまま、それ以外は other', () => {
    expect(hearingTopicId(HEARING_TOPICS[0]!.id)).toBe(HEARING_TOPICS[0]!.id);
    expect(hearingTopicId('transport.taxi.limit')).toBe(OTHER_HEARING_TOPIC);
    expect(hearingTopicId(3)).toBe(OTHER_HEARING_TOPIC);
    expect(new Set(HEARING_TOPICS.map((topic) => topic.id)).size).toBe(HEARING_TOPICS.length);
  });
});
