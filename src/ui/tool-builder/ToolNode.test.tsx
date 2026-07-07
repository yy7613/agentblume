// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { constantSizeHandleStyle, HANDLE_SCREEN_SIZE } from './ToolNode';

describe('constantSizeHandleStyle', () => {
  it('どのズーム倍率でも画面上の直径が一定(px)になるflow座標系サイズを返す', () => {
    for (const zoom of [0.5, 1, 1.5, 2]) {
      const style = constantSizeHandleStyle(zoom);
      // viewportは scale(zoom) で描画するので、flowサイズ × zoom が画面px。これが一定なら見た目一定。
      expect(Number(style.width) * zoom).toBeCloseTo(HANDLE_SCREEN_SIZE);
      expect(Number(style.height) * zoom).toBeCloseTo(HANDLE_SCREEN_SIZE);
      expect(Number(style.borderWidth) * zoom).toBeCloseTo(1);
    }
  });

  it('min-width/min-heightもサイズへ揃え、既定5px下限で高ズーム時に潰れないようにする', () => {
    const style = constantSizeHandleStyle(4); // 14/4 = 3.5px < 既定min 5px
    expect(style.minWidth).toBe(style.width);
    expect(style.minHeight).toBe(style.height);
    expect(Number(style.minWidth)).toBeCloseTo(HANDLE_SCREEN_SIZE / 4);
  });

  it('extraのstyle（2入力ノードのtop位置など）をマージする', () => {
    const style = constantSizeHandleStyle(1, { top: '35%' });
    expect(style.top).toBe('35%');
    expect(Number(style.width)).toBeCloseTo(HANDLE_SCREEN_SIZE);
  });

  it('ズーム0や負値でも1として扱い、0除算(Infinity)を避ける', () => {
    const style = constantSizeHandleStyle(0);
    expect(Number(style.width)).toBeCloseTo(HANDLE_SCREEN_SIZE);
    expect(Number.isFinite(Number(style.width))).toBe(true);
  });
});
