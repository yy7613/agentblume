import { describe, expect, it } from 'vitest';
import { caseResultStatusLabel, experimentStatusLabel, gateStatusLabel, scenarioRunStatusLabel } from './status-labels';

// text(english, japanese) の両分岐を素通しで確かめるだけの最小スタブ。
const en = (english: string): string => english;
const ja = (_english: string, japanese: string): string => japanese;

describe('status-labels（検証まわりの状態語を言語に合わせる。値そのものは変えない）', () => {
  it('正常: experimentStatusLabel は全ステータスを日本語に訳す', () => {
    expect(experimentStatusLabel('queued', ja)).toBe('キュー待ち');
    expect(experimentStatusLabel('running', ja)).toBe('実行中');
    expect(experimentStatusLabel('completed', ja)).toBe('完了');
    expect(experimentStatusLabel('failed', ja)).toBe('失敗');
    expect(experimentStatusLabel('cancelled', ja)).toBe('取消済み');
    expect(experimentStatusLabel('interrupted', ja)).toBe('中断');
  });

  it('正常: caseResultStatusLabel は succeeded/failed/cancelled を日本語に訳す', () => {
    expect(caseResultStatusLabel('succeeded', ja)).toBe('成功');
    expect(caseResultStatusLabel('failed', ja)).toBe('失敗');
    expect(caseResultStatusLabel('cancelled', ja)).toBe('取消済み');
  });

  it('正常: scenarioRunStatusLabel は completed/max-turns/error を日本語に訳す', () => {
    expect(scenarioRunStatusLabel('completed', ja)).toBe('完了');
    expect(scenarioRunStatusLabel('max-turns', ja)).toBe('ターン上限');
    expect(scenarioRunStatusLabel('error', ja)).toBe('エラー');
  });

  it('正常: gateStatusLabel はPASS/FAILを合格/不合格に訳す', () => {
    expect(gateStatusLabel('pass', ja)).toBe('合格');
    expect(gateStatusLabel('fail', ja)).toBe('不合格');
  });

  it('境界: 英語表示ではどの関数も値そのもの（大文字PASS/FAILを含む）をそのまま返す', () => {
    expect(experimentStatusLabel('completed', en)).toBe('completed');
    expect(caseResultStatusLabel('succeeded', en)).toBe('succeeded');
    expect(scenarioRunStatusLabel('max-turns', en)).toBe('max-turns');
    expect(gateStatusLabel('pass', en)).toBe('PASS');
    expect(gateStatusLabel('fail', en)).toBe('FAIL');
  });
});
