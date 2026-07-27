import { describe, expect, it } from 'vitest';
import { IdleLatch } from './idle-latch';

describe('IdleLatch', () => {
  it('既に暇なら待たずにtrueを返す', async () => {
    await expect(new IdleLatch().settle(true, 10_000)).resolves.toBe(true);
  });

  it('猶予0は「待たない」を意味し、実行中でもfalseを返す', async () => {
    await expect(new IdleLatch().settle(false, 0)).resolves.toBe(false);
  });

  it('猶予内にreleaseされればtrueを返す', async () => {
    const latch = new IdleLatch();
    const settled = latch.settle(false, 5_000);
    latch.release();
    await expect(settled).resolves.toBe(true);
  });

  it('猶予を過ぎてもreleaseされなければfalseを返す', async () => {
    await expect(new IdleLatch().settle(false, 5)).resolves.toBe(false);
  });

  it('待っている全員を1回のreleaseで起こす', async () => {
    const latch = new IdleLatch();
    const waiters = [latch.settle(false, 5_000), latch.settle(false, 5_000)];
    latch.release();
    await expect(Promise.all(waiters)).resolves.toEqual([true, true]);
  });

  it('release後に改めてsettleすると再び待つ（状態を持ち越さない）', async () => {
    const latch = new IdleLatch();
    latch.release();
    await expect(latch.settle(false, 5)).resolves.toBe(false);
  });
});
