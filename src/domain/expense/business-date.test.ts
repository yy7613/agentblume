import { describe, expect, it, vi } from 'vitest';
import { businessDateOf, daysBetween, DEFAULT_BUSINESS_TIME_ZONE } from './business-date';

describe('businessDateOf', () => {
  it('正常: 既定は Asia/Tokyo', () => {
    expect(DEFAULT_BUSINESS_TIME_ZONE).toBe('Asia/Tokyo');
  });

  it('境界: UTC 2026-09-30T15:30Z は日本時間では翌日 2026-10-01', () => {
    // UTC の日付を使うと日本時間 0〜9 時に当日のレシートが「未来日」になるため、業務タイムゾーンで暦日を取る
    expect(businessDateOf(new Date('2026-09-30T15:30:00Z'))).toBe('2026-10-01');
  });

  it('境界: UTC 2026-09-30T14:59Z は日本時間でもまだ 2026-09-30', () => {
    expect(businessDateOf(new Date('2026-09-30T14:59:59Z'))).toBe('2026-09-30');
  });

  it('正常: タイムゾーンを指定するとそのタイムゾーンの暦日になる', () => {
    expect(businessDateOf(new Date('2026-09-30T15:30:00Z'), 'UTC')).toBe('2026-09-30');
  });

  it('例外: 暦の部品を返さない実装でも例外にせず、空の部品で組み立てる', () => {
    // Intl の実装差（部品の欠落）で判定全体を落とさないための防御を確かめる
    // new で呼ばれるのでアロー関数ではなく function で差し替える
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function fakeFormat() { return { formatToParts: () => [] }; } as never);
    try {
      expect(businessDateOf(new Date('2026-09-30T00:00:00Z'))).toBe('--');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('daysBetween', () => {
  it('正常: 同じ日は 0', () => {
    expect(daysBetween('2026-09-30', '2026-09-30')).toBe(0);
  });

  it('正常: 月をまたぐ日数を数える', () => {
    expect(daysBetween('2026-09-30', '2026-10-31')).toBe(31);
  });

  it('境界: to が前なら負', () => {
    expect(daysBetween('2026-10-01', '2026-09-30')).toBe(-1);
  });

  it('境界: うるう年の 2 月をまたぐ', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});
