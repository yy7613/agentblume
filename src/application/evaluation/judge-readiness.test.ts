import { describe, expect, it } from 'vitest';
import { judgeReadinessFromSnapshot } from './judge-readiness';

describe('judgeReadinessFromSnapshot', () => {
  it('正常: provider と model が入った指紋は configured=true で provider / model を返す', () => {
    expect(judgeReadinessFromSnapshot({ provider: 'openai-compatible', model: 'qwen-judge', modelConfigHash: 'h' })).toEqual({ configured: true, provider: 'openai-compatible', model: 'qwen-judge' });
  });

  it('異常: 指紋が無い（undefined）なら configured=false で provider / model は載せない', () => {
    expect(judgeReadinessFromSnapshot(undefined)).toEqual({ configured: false });
  });

  it('異常: 実機で観測された未設定の指紋（lm-studio-judge / model 空文字）は configured=false', () => {
    expect(judgeReadinessFromSnapshot({ provider: 'lm-studio-judge', model: '', modelConfigHash: 'h' })).toEqual({ configured: false });
  });

  it('境界: 空白だけの model / provider は未設定として扱う', () => {
    expect(judgeReadinessFromSnapshot({ provider: 'lm-studio-judge', model: '   ', modelConfigHash: 'h' }).configured).toBe(false);
    expect(judgeReadinessFromSnapshot({ provider: ' \t', model: 'judge', modelConfigHash: 'h' }).configured).toBe(false);
  });

  it('境界: 未配線・未解決の印（unconfigured-judge / unresolved）は実モデル名ではないので configured=false', () => {
    expect(judgeReadinessFromSnapshot({ provider: 'unconfigured-judge', model: 'unconfigured-judge', modelConfigHash: 'unconfigured-judge' }).configured).toBe(false);
    expect(judgeReadinessFromSnapshot({ provider: 'unresolved', model: 'unresolved', modelConfigHash: 'unresolved' }).configured).toBe(false);
    // 片方だけが印でも設定済みとは言えない。
    expect(judgeReadinessFromSnapshot({ provider: 'openai-compatible', model: 'unresolved', modelConfigHash: 'h' }).configured).toBe(false);
  });

  it('境界: modelConfigHash が空でも provider / model が揃っていれば設定済み（指紋のハッシュは設定状態の判定に使わない）', () => {
    expect(judgeReadinessFromSnapshot({ provider: 'scripted-judge', model: 'scripted-judge', modelConfigHash: '' })).toEqual({ configured: true, provider: 'scripted-judge', model: 'scripted-judge' });
  });

  it('例外: 壊れた指紋（provider / model が文字列でない）でも例外を投げず未設定として扱う', () => {
    // 外部設定の読込結果が型どおりでない事故（JSON の欠損など）でも、起票ガードや capabilities が落ちてはいけない。
    const broken = { provider: undefined, model: null, modelConfigHash: 'h' } as unknown as Parameters<typeof judgeReadinessFromSnapshot>[0];
    expect(() => judgeReadinessFromSnapshot(broken)).not.toThrow();
    expect(judgeReadinessFromSnapshot(broken)).toEqual({ configured: false });
  });
});
