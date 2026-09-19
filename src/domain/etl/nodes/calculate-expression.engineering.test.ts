/**
 * 工学計算の試験 — 実務で書かれる式が、関数一覧の範囲でそのまま書けるか。
 *
 * 文法や関数単体の確認は `calculate-expression.test.ts`、複雑な組み合わせは
 * `calculate-expression.patterns.test.ts` が持つ。ここで見るのは
 * **分野ごとの実際の式が、期待どおりの値を出すか**:
 * 電気（オームの法則・合成抵抗・共振周波数・デシベル）、力学（運動量・自由落下・
 * 斜面・合力）、流体（レイノルズ数・ベルヌーイ）、熱（熱伝導・比熱）、
 * 材料（応力ひずみ・たわみ）、測量（三角測量・方位角）、信号（RMS・SN 比）。
 *
 * 期待値は教科書の既知の値か、独立に手計算できるものだけを使う。
 * 割り切れない値は `toBeCloseTo` で比べる（浮動小数の誤差は避けられない）。
 */
import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseExpression } from './calculate-expression';

/** 式を評価する。cells のキーが knownColumns、値がセル値。読めない式はここで落とす。 */
function value(text: string, cells: Readonly<Record<string, number | null>> = {}): number | null {
  const result = parseExpression(text, Object.keys(cells));
  expect(result.ok ? '' : `${result.message} (${result.position})`).toBe('');
  if (!result.ok) return null;
  return evaluateExpression(result.ast, (name) => cells[name] ?? null);
}

describe('工学計算: 電気', () => {
  it('正常: オームの法則と消費電力', () => {
    // V = I R、P = V I、P = I^2 R の 3 つが一致する。
    expect(value('[I] * [R]', { I: 0.5, R: 220 })).toBe(110);
    expect(value('[V] * [I]', { V: 110, I: 0.5 })).toBe(55);
    expect(value('[I] ^ 2 * [R]', { I: 0.5, R: 220 })).toBe(55);
  });

  it('正常: 並列合成抵抗と分圧', () => {
    // 100Ω と 100Ω の並列は 50Ω。
    expect(value('1 / (1 / [R1] + 1 / [R2])', { R1: 100, R2: 100 })).toBe(50);
    // 3 本並列（10, 20, 30）は 60/11。
    expect(value('1 / (1 / [R1] + 1 / [R2] + 1 / [R3])', { R1: 10, R2: 20, R3: 30 })).toBeCloseTo(60 / 11, 12);
    // 分圧: 12V を 1k と 2k で分けると 8V。
    expect(value('[Vin] * [R2] / ([R1] + [R2])', { Vin: 12, R1: 1000, R2: 2000 })).toBe(8);
  });

  it('正常: LC 共振周波数と RC 時定数', () => {
    // f = 1 / (2 pi sqrt(L C))。L=1mH, C=1uF なら約 5032.9 Hz。
    expect(value('1 / (2 * pi * sqrt([L] * [C]))', { L: 1e-3, C: 1e-6 })).toBeCloseTo(5032.921, 3);
    // 時定数 tau = R C。1k と 10uF で 10ms。
    expect(value('[R] * [C]', { R: 1000, C: 10e-6 })).toBeCloseTo(0.01, 12);
    // 充電カーブ: 1 時定数後は 63.2%。
    expect(value('(1 - exp(-1)) * 100')).toBeCloseTo(63.212, 3);
  });

  it('正常: デシベル（電圧比 20log / 電力比 10log）', () => {
    expect(value('20 * log10([Vout] / [Vin])', { Vout: 10, Vin: 1 })).toBe(20);
    expect(value('10 * log10([Pout] / [Pin])', { Pout: 100, Pin: 1 })).toBe(20);
    // 半分の電力は約 -3dB。
    expect(value('10 * log10(0.5)')).toBeCloseTo(-3.0103, 4);
    // dB から比へ戻す往復。
    expect(value('10 ^ ([dB] / 20)', { dB: 20 })).toBeCloseTo(10, 12);
  });

  it('例外: 開放（抵抗 0 の分母）や無信号（0 の対数）は空になる', () => {
    expect(value('1 / (1 / [R1] + 1 / [R2])', { R1: 0, R2: 100 })).toBeNull();
    expect(value('20 * log10([Vout] / [Vin])', { Vout: 0, Vin: 1 })).toBeNull();
  });
});

describe('工学計算: 力学', () => {
  it('正常: 運動エネルギーと運動量', () => {
    expect(value('0.5 * [m] * [v] ^ 2', { m: 2, v: 3 })).toBe(9);
    expect(value('[m] * [v]', { m: 2, v: 3 })).toBe(6);
  });

  it('正常: 自由落下と斜方投射', () => {
    // 落下距離 h = 1/2 g t^2。g=9.80665、t=2 秒で約 19.61m。
    expect(value('0.5 * [g] * [t] ^ 2', { g: 9.80665, t: 2 })).toBeCloseTo(19.6133, 4);
    // 斜方投射の最大到達距離 R = v^2 sin(2θ) / g。45 度で最大。
    const range = '[v] ^ 2 * sin(2 * rad([deg])) / [g]';
    expect(value(range, { v: 20, deg: 45, g: 9.80665 })).toBeCloseTo(400 / 9.80665, 10);
    // 30 度と 60 度は同じ飛距離になる（sin(60°) = sin(120°)）。
    expect(value(range, { v: 20, deg: 30, g: 9.80665 })).toBeCloseTo(value(range, { v: 20, deg: 60, g: 9.80665 }) as number, 10);
  });

  it('正常: 斜面上の分力と合力', () => {
    // 斜面 30 度、質量 10kg の平行成分 = m g sin30 = 49.03N。
    expect(value('[m] * [g] * sin(rad([deg]))', { m: 10, g: 9.80665, deg: 30 })).toBeCloseTo(49.033, 3);
    // 直交する 2 力の合力（3N と 4N で 5N）と、その向き。
    expect(value('hypot([fx], [fy])', { fx: 3, fy: 4 })).toBe(5);
    expect(value('deg(atan2([fy], [fx]))', { fx: 3, fy: 4 })).toBeCloseTo(53.13, 2);
  });

  it('正常: 単振り子の周期', () => {
    // T = 2 pi sqrt(L / g)。1m で約 2.006 秒。
    expect(value('2 * pi * sqrt([L] / [g])', { L: 1, g: 9.80665 })).toBeCloseTo(2.0064, 4);
  });
});

describe('工学計算: 流体・熱', () => {
  it('正常: レイノルズ数', () => {
    // Re = rho v D / mu。水（998, 1m/s, 0.05m, 0.001）で 49900。
    expect(value('[rho] * [v] * [D] / [mu]', { rho: 998, v: 1, D: 0.05, mu: 0.001 })).toBeCloseTo(49900, 6);
  });

  it('正常: ベルヌーイの動圧と流量', () => {
    expect(value('0.5 * [rho] * [v] ^ 2', { rho: 1.225, v: 30 })).toBeCloseTo(551.25, 6);
    // 円管の流量 Q = v * pi * (D/2)^2。
    expect(value('[v] * pi * ([D] / 2) ^ 2', { v: 2, D: 0.1 })).toBeCloseTo(0.015708, 6);
  });

  it('正常: 熱量と熱伝導', () => {
    // Q = m c ΔT。水 1kg を 20→80℃ で 251.04kJ。
    expect(value('[m] * [c] * ([T2] - [T1])', { m: 1, c: 4184, T1: 20, T2: 80 })).toBe(251040);
    // フーリエの法則 q = k A ΔT / L。
    expect(value('[k] * [A] * ([T2] - [T1]) / [L]', { k: 0.6, A: 2, T1: 20, T2: 30, L: 0.1 })).toBeCloseTo(120, 10);
  });

  it('正常: 摂氏・華氏・絶対温度の変換', () => {
    expect(value('[C] * 9 / 5 + 32', { C: 100 })).toBe(212);
    expect(value('([F] - 32) * 5 / 9', { F: 32 })).toBe(0);
    expect(value('[C] + 273.15', { C: -273.15 })).toBe(0);
    // 往復して元に戻る。
    expect(value('(([C] * 9 / 5 + 32) - 32) * 5 / 9', { C: 37 })).toBeCloseTo(37, 12);
  });
});

describe('工学計算: 材料・構造', () => {
  it('正常: 応力・ひずみ・ヤング率', () => {
    // σ = F / A。1000N を 0.0001m² に掛けると 10MPa。
    expect(value('[F] / [A]', { F: 1000, A: 0.0001 })).toBe(10000000);
    // ε = ΔL / L、E = σ / ε。
    expect(value('[dL] / [L]', { dL: 0.002, L: 2 })).toBe(0.001);
    expect(value('([F] / [A]) / ([dL] / [L])', { F: 1000, A: 0.0001, dL: 0.002, L: 2 })).toBeCloseTo(1e10, 2);
  });

  it('正常: 円形断面の断面二次モーメントと片持ち梁のたわみ', () => {
    // I = pi d^4 / 64。
    expect(value('pi * [d] ^ 4 / 64', { d: 0.02 })).toBeCloseTo(7.854e-9, 12);
    // δ = F L^3 / (3 E I)。
    // 100N / 1m / E=200GPa / I=7.854e-9 で約 21.2mm。
    expect(value('[F] * [L] ^ 3 / (3 * [E] * [I])', { F: 100, L: 1, E: 2e11, I: 7.854e-9 })).toBeCloseTo(0.021221, 6);
  });

  it('境界: 断面積 0 は応力が空になる（部材が無い行を黙って 0 にしない）', () => {
    expect(value('[F] / [A]', { F: 1000, A: 0 })).toBeNull();
  });
});

describe('工学計算: 測量・信号', () => {
  it('正常: 三角測量（正弦定理と余弦定理）', () => {
    // 3-4-5 の直角三角形。余弦定理で斜辺を出すと 5。
    expect(value('sqrt([a] ^ 2 + [b] ^ 2 - 2 * [a] * [b] * cos(rad([C])))', { a: 3, b: 4, C: 90 })).toBeCloseTo(5, 12);
    // 正弦定理: a / sin A = b / sin B。
    expect(value('[b] * sin(rad([A])) / sin(rad([B]))', { b: 10, A: 30, B: 90 })).toBeCloseTo(5, 12);
    // 仰角から高さ（水平距離 100m、仰角 30 度）。
    expect(value('[d] * tan(rad([deg]))', { d: 100, deg: 30 })).toBeCloseTo(57.735, 3);
  });

  it('正常: 方位角と成分分解が往復する', () => {
    // 北を 0 度として、東へ 45 度・距離 100 の成分。
    const east = value('[r] * sin(rad([az]))', { r: 100, az: 45 }) as number;
    const north = value('[r] * cos(rad([az]))', { r: 100, az: 45 }) as number;
    expect(east).toBeCloseTo(70.711, 3);
    expect(north).toBeCloseTo(70.711, 3);
    // 成分から距離と方位へ戻す。
    expect(value('hypot([e], [n])', { e: east, n: north })).toBeCloseTo(100, 10);
    expect(value('deg(atan2([e], [n]))', { e: east, n: north })).toBeCloseTo(45, 10);
  });

  it('正常: 正弦波の実効値と SN 比', () => {
    // 正弦波の RMS = 振幅 / √2。
    expect(value('[amp] / sqrt(2)', { amp: 100 })).toBeCloseTo(70.711, 3);
    // SN 比（dB）。
    expect(value('20 * log10([signal] / [noise])', { signal: 1, noise: 0.001 })).toBeCloseTo(60, 10);
    // 2 乗平均平方根（3 点）。
    expect(value('sqrt(([a] ^ 2 + [b] ^ 2 + [c] ^ 2) / 3)', { a: 3, b: 4, c: 5 })).toBeCloseTo(Math.sqrt(50 / 3), 12);
  });

  it('正常: 対数尺度（pH・マグニチュード・オクターブ）', () => {
    expect(value('-log10([H])', { H: 1e-7 })).toBeCloseTo(7, 12);
    // マグニチュードが 1 上がるとエネルギーは約 31.6 倍。
    expect(value('10 ^ (1.5 * 1)')).toBeCloseTo(31.6228, 4);
    // 周波数比からオクターブ数。
    expect(value('log2([f2] / [f1])', { f1: 440, f2: 880 })).toBe(1);
  });

  it('例外: 対数尺度は 0 以下で空になる（無音・濃度 0 を数として扱わない）', () => {
    expect(value('-log10([H])', { H: 0 })).toBeNull();
    expect(value('20 * log10([signal] / [noise])', { signal: 1, noise: 0 })).toBeNull();
    expect(value('log2([f2] / [f1])', { f1: 440, f2: -880 })).toBeNull();
  });
});

describe('工学計算: 単位と桁の取り違え', () => {
  it('異常: 単位を混ぜた式は読めない（1000mm のような書き方は通さない）', () => {
    // 工学では単位を書きたくなるが、式は無次元の数しか扱わない。黙って数だけ拾うと
    // 「mm のつもりが m で計算されていた」という気づけない誤りになる。
    expect(parseExpression('[L] * 1000mm', ['L']).ok).toBe(false);
    expect(parseExpression('9.8m/s^2', []).ok).toBe(false);
    expect(parseExpression('[V] / 220V', ['V']).ok).toBe(false);
  });

  it('異常: 指数表記の打ち間違いは読めない（10^-3 を 10e-3 と書くなど）', () => {
    // 1e-3 は正しいが、10e-3 は 0.01 であって 10^-3 ではない。数としては読めてしまうので
    // ここで固定するのは「読めない書き方」の側（e の前後に数字が無い形）。
    expect(parseExpression('1e', []).ok).toBe(false);
    expect(parseExpression('1e-', []).ok).toBe(false);
    // 正しい指数表記は通る。
    expect(value('1e-3')).toBe(0.001);
    // 落とし穴: 単独の e は自然対数の底なので、`e-3` は 10^-3 ではなく e から 3 を引いた値になる。
    // 構文として正しいので断れない。指数表記は必ず数字を前に置く必要がある。
    expect(value('e-3')).toBeCloseTo(Math.E - 3, 12);
  });

  it('異常: ギリシャ文字や記号をそのまま書くと読めない', () => {
    // μ（マイクロ）・Ω（オーム）・°（度）を式に書く事故。
    expect(parseExpression('[R] * 1μF', ['R']).ok).toBe(false);
    expect(parseExpression('220Ω', []).ok).toBe(false);
    expect(parseExpression('sin(30°)', []).ok).toBe(false);
    // 度はラジアンへ直して書く。
    expect(value('sin(rad(30))')).toBeCloseTo(0.5, 12);
  });

  it('異常: 度とラジアンの取り違えは読めるが答えが変わる（rad を忘れた式）', () => {
    // 構文としては正しいので解釈器は通す。数値が別物になることをここで示しておく。
    const withoutRad = value('sin(30)') as number;
    const withRad = value('sin(rad(30))') as number;
    expect(withRad).toBeCloseTo(0.5, 12);
    expect(Math.abs(withoutRad - withRad)).toBeGreaterThan(0.4);
  });

  it('異常: 分母をまとめ忘れた式は読めるが別の値になる（括弧の付け忘れ）', () => {
    // 1/(2 pi f C) を 1/2/pi/f/C と書くのは正しいが、1/2*pi*f*C は別物。
    const correct = value('1 / (2 * pi * [f] * [C])', { f: 50, C: 1e-6 }) as number;
    const grouped = value('1 / 2 / pi / [f] / [C]', { f: 50, C: 1e-6 }) as number;
    const wrong = value('1 / 2 * pi * [f] * [C]', { f: 50, C: 1e-6 }) as number;
    expect(grouped).toBeCloseTo(correct, 6);
    expect(wrong).not.toBeCloseTo(correct, 6);
  });
});

describe('工学計算: 桁と精度', () => {
  it('境界: 非常に小さい値・大きい値でも有限なら計算できる', () => {
    // 電子の電荷とアボガドロ数の桁。
    expect(value('[q] * [N]', { q: 1.602176634e-19, N: 6.02214076e23 })).toBeCloseTo(96485.33, 2);
    expect(value('1e-300 * 1e-300')).toBe(0);
  });

  it('例外: 倍精度の範囲を超えると空になる（無限大を数として流さない）', () => {
    expect(value('1e300 * 1e300')).toBeNull();
    expect(value('exp(1000)')).toBeNull();
    expect(value('[big] ^ 2', { big: 1e200 })).toBeNull();
  });

  it('例外: 桁落ちは起こりうるので、比較する式は丸めてから使う', () => {
    // 0.1 + 0.2 は 0.3 にならない。利用者が踏む落とし穴なので明示的に固定する。
    expect(value('0.1 + 0.2')).not.toBe(0.3);
    expect(value('round(0.1 + 0.2, 10)')).toBe(0.3);
  });
});
