import { useEffect, useState } from 'react';

/**
 * busy中（実行待ち）の経過秒数を1秒毎に返す共有hook。
 * Chat/Inspectorの「実行中… N秒」表示で共有する（UXレビュー: 三点ドットのみでは経過が分からない対策）。
 * busyがfalseに戻ると0にリセットする。
 */
export function useElapsedSeconds(busy: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!busy) { setElapsedSeconds(0); return; }
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  return elapsedSeconds;
}
