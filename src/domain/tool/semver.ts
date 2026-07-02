/**
 * ドメイン: SemVer 値オブジェクト（v2 実装契約 §5）
 *
 * `major.minor.patch` の3要素のみを扱う（プレリリース/ビルドメタは範囲外）。
 * 不正な入力は `ToolValidationError` を投げる。イミュータブル。
 */
import { ToolValidationError } from './errors';

/** 非負整数（0 以上の整数）か判定する。 */
function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** セマンティックバージョン（major.minor.patch）の値オブジェクト。 */
export class SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;

  private constructor(major: number, minor: number, patch: number) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    Object.freeze(this);
  }

  /** 3つの非負整数から生成する。非負整数以外 → ToolValidationError。 */
  static of(major: number, minor: number, patch: number): SemVer {
    for (const [name, value] of [
      ['major', major],
      ['minor', minor],
      ['patch', patch],
    ] as const) {
      if (!isNonNegativeInteger(value)) {
        throw new ToolValidationError(
          `SemVer: ${name} must be a non-negative integer, got ${String(value)}`,
        );
      }
    }
    return new SemVer(major, minor, patch);
  }

  /** "x.y.z" 形式の文字列を解析する。不正 → ToolValidationError。 */
  static parse(text: string): SemVer {
    if (typeof text !== 'string') {
      throw new ToolValidationError(`SemVer: expected string, got ${typeof text}`);
    }
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (match === null) {
      throw new ToolValidationError(`SemVer: invalid version string: "${text}"`);
    }
    // 正規表現で数字のみを保証済み。
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    return SemVer.of(major, minor, patch);
  }

  /** "x.y.z" 形式へ整形する。 */
  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }

  /** major→minor→patch の順に比較する。 */
  compare(other: SemVer): -1 | 0 | 1 {
    if (this.major !== other.major) return this.major < other.major ? -1 : 1;
    if (this.minor !== other.minor) return this.minor < other.minor ? -1 : 1;
    if (this.patch !== other.patch) return this.patch < other.patch ? -1 : 1;
    return 0;
  }

  /** 全要素が等しいか。 */
  equals(other: SemVer): boolean {
    return this.compare(other) === 0;
  }

  /** 指定要素をインクリメントし、下位要素を 0 にリセットした新インスタンスを返す。 */
  bump(part: 'major' | 'minor' | 'patch'): SemVer {
    switch (part) {
      case 'major':
        return SemVer.of(this.major + 1, 0, 0);
      case 'minor':
        return SemVer.of(this.major, this.minor + 1, 0);
      case 'patch':
        return SemVer.of(this.major, this.minor, this.patch + 1);
    }
  }
}
