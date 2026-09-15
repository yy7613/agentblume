import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * 実験的な機能（業務テンプレート: 仕訳・経費精算・入金消込・契約）を画面に出すかどうか。
 *
 * **初期値は非表示**。業務テンプレートは会計・法務の判断に近い結果を出す一方で仕様が固まっていないので、
 * 利用者が設定で自分から有効にしたときだけ入口を見せる。言語設定（`i18n.tsx`）と同じく
 * このブラウザに保存する（サーバーの機能自体は止めない。見せるかどうかの設定）。
 */
const STORAGE_KEY = 'agentcontext.experimentalFeatures';

interface ExperimentalFeaturesValue {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

const ExperimentalFeaturesContext = createContext<ExperimentalFeaturesValue>({ enabled: false, setEnabled: () => {} });

function storedEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'on'; }
  catch { return false; }
}

export function ExperimentalFeaturesProvider({ children, initialEnabled }: { readonly children: ReactNode; readonly initialEnabled?: boolean }) {
  const [enabled, setEnabled] = useState<boolean>(() => initialEnabled ?? storedEnabled());
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* 埋め込みブラウザでは Storage が使えないことがある。 */ } }, [enabled]);
  const value = useMemo<ExperimentalFeaturesValue>(() => ({ enabled, setEnabled }), [enabled]);
  return <ExperimentalFeaturesContext.Provider value={value}>{children}</ExperimentalFeaturesContext.Provider>;
}

export function useExperimentalFeatures(): ExperimentalFeaturesValue { return useContext(ExperimentalFeaturesContext); }
