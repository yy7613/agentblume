import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from './console-logger';

function capture(): { readonly lines: string[]; readonly logger: ConsoleLogger } {
  const lines: string[] = [];
  const sink = (message: string): void => { lines.push(message); };
  return { lines, logger: new ConsoleLogger({ info: sink, warn: sink, error: sink }) };
}

describe('ConsoleLogger', () => {
  it('levelと本文、contextのJSONを1行で出す', () => {
    const { lines, logger } = capture();
    logger.info('retention sweep completed', { deleted: 3 });
    logger.warn('run metric was not recorded', { runId: 'run-1' });
    logger.error('retention sweep failed', { reason: 'db is locked' });
    expect(lines).toEqual([
      'agentblume [info] retention sweep completed {"deleted":3}',
      'agentblume [warn] run metric was not recorded {"runId":"run-1"}',
      'agentblume [error] retention sweep failed {"reason":"db is locked"}',
    ]);
  });

  it('contextが無い・空なら本文だけを出す', () => {
    const { lines, logger } = capture();
    logger.warn('no context');
    logger.warn('empty context', {});
    expect(lines).toEqual(['agentblume [warn] no context', 'agentblume [warn] empty context']);
  });

  it('JSON化できないcontextは落として本文だけ出す（ログのためにthrowしない）', () => {
    const { lines, logger } = capture();
    const circular: Record<string, unknown> = {}; circular['self'] = circular;
    expect(() => { logger.warn('circular', circular); }).not.toThrow();
    expect(lines).toEqual(['agentblume [warn] circular']);
  });

  it('既定の出力先はconsole', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLogger();
    logger.info('a'); logger.warn('b'); logger.error('c');
    expect(info).toHaveBeenCalledWith('agentblume [info] a');
    expect(warn).toHaveBeenCalledWith('agentblume [warn] b');
    expect(error).toHaveBeenCalledWith('agentblume [error] c');
    info.mockRestore(); warn.mockRestore(); error.mockRestore();
  });
});
