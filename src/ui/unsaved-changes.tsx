import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * 「未保存の編集がある」ことを画面（Builder）から App へ伝える仕組み。
 *
 * 画面は同時に1つしかマウントされないが、将来の同時表示にも耐えるよう id 付きの集合で持つ。
 * App はこの集合が空でない間だけ beforeunload を登録し、左ナビのクリックには確認を挟む。
 */

interface UnsavedChangesValue {
  readonly report: (id: string, unsaved: boolean) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesValue>({ report: () => { /* Provider の外では何もしない。 */ } });

export interface UnsavedChangesRegistry {
  readonly unsaved: boolean;
  readonly value: UnsavedChangesValue;
}

/** App 側で使う。未保存の集約と beforeunload の登録／解除を持つ。 */
export function useUnsavedChangesRegistry(): UnsavedChangesRegistry {
  const flags = useRef(new Map<string, boolean>());
  const [unsaved, setUnsaved] = useState(false);
  const report = useCallback((id: string, next: boolean) => {
    if (next) flags.current.set(id, true);
    else flags.current.delete(id);
    setUnsaved(flags.current.size > 0);
  }, []);

  // 未保存の間だけ登録する（常時登録するとブラウザによっては毎回ダイアログが出る）。
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const value = useMemo<UnsavedChangesValue>(() => ({ report }), [report]);
  return { unsaved, value };
}

export function UnsavedChangesProvider({ value, children }: { readonly value: UnsavedChangesValue; readonly children: ReactNode }) {
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

/** 画面側で使う。未保存かどうかを App へ伝え、アンマウント時には必ず取り下げる。 */
export function useReportUnsavedChanges(id: string, unsaved: boolean): void {
  const { report } = useContext(UnsavedChangesContext);
  useEffect(() => { report(id, unsaved); }, [report, id, unsaved]);
  useEffect(() => () => report(id, false), [report, id]);
}
