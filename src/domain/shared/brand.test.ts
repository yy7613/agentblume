import { describe, expect, it } from 'vitest';
import type { Brand, Flavor } from './brand';

// 型レベルテスト: ブランドプロパティは unique symbol のため実行時表現を持たない。
// 誤代入の拒否は @ts-expect-error(typecheck ゲート)で検証し、値の透過性は expect(実行時)で固定する。
type FlavorA = Flavor<string, 'A'>;
type FlavorB = Flavor<string, 'B'>;
type BrandX = Brand<string, 'X'>;

describe('Flavor', () => {
  it('rejects assignment between different flavors (type-level)', () => {
    const b: FlavorB = 'from-b';
    // @ts-expect-error 異種ブランド間(FlavorB → FlavorA)の代入は拒否される(ID 取り違えの検出)
    const a: FlavorA = b;
    // ブランドはコンパイル後に消えるため、実行時表現は素の string のまま。
    expect(a).toBe('from-b');
  });

  it('accepts a plain string and keeps the value intact', () => {
    const plain = 'plain-value';
    // 弱ブランド: 素の値からの代入は許す(既存コードを変更せず導入できる移行の既定形式)。
    const flavored: FlavorA = plain;
    expect(flavored).toBe(plain);
  });
});

describe('Brand', () => {
  it('rejects assignment from a plain string (type-level)', () => {
    // @ts-expect-error 強ブランドへ素の string は代入できない(スマートコンストラクタ経由のみ)
    const x: BrandX = 'plain-value';
    expect(x).toBe('plain-value');
  });

  it('passes branded/flavored values to a function expecting string', () => {
    const upper = (value: string): string => value.toUpperCase();
    // ブランド付与の `as` はスマートコンストラクタ内部限定の規約だが、テストでは生成の代替として用いる。
    const branded = 'branded' as BrandX;
    const flavored: FlavorA = 'flavored';
    expect(upper(branded)).toBe('BRANDED');
    expect(upper(flavored)).toBe('FLAVORED');
  });
});
