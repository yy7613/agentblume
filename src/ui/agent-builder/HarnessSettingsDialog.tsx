import { useState } from 'react';
import type { AgentRuntimeHarnessDto } from '../api/types';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { useI18n } from '../i18n';

/**
 * Agent単位のランタイムハーネス設定。undefined は「未設定（サーバー既定の従来動作）」を意味する。
 *
 * **表示名は「実行オプション / Runtime options」**にしている。UIには別概念の「ハーネス」
 * （複数Agentのオーケストレーション＝ナビ表示は「マルチエージェント」）があり、同じ言葉が
 * 2つの意味で並ぶと利用者が取り違えるため。型名・内部id・保存フィールド名は Harness のまま。
 */
export type AgentHarnessValue = AgentRuntimeHarnessDto;

/** 未設定のAgentへダイアログを開いたときの初期値（バックエンドの既定値と一致させる）。 */
export const DEFAULT_HARNESS: AgentHarnessValue = {
  fileMemory: false,
  todoProvider: false,
  compaction: false,
  webSearch: false,
  toolApproval: false,
  functionInvocation: true,
};

/** ボタンのバッジに出す「有効な機能数」。functionInvocationは既定trueなので単純にtrueの数を数える。 */
export function countEnabledHarness(harness: AgentHarnessValue): number {
  return Object.values(harness).filter((enabled) => enabled).length;
}

type HarnessKey = keyof AgentHarnessValue;

export function HarnessSettingsDialog({ initial, onCancel, onClear, onApply }: {
  readonly initial: AgentHarnessValue;
  readonly onCancel: () => void;
  readonly onClear: () => void;
  readonly onApply: (harness: AgentHarnessValue) => void;
}) {
  // ダイアログ内だけで編集し、Applyで初めて親へ反映する（Cancelで破棄）。
  const [draft, setDraft] = useState<AgentHarnessValue>(initial);
  const dialogRef = useModalBehavior<HTMLElement>({ onClose: onCancel });
  const { text } = useI18n();
  const toggle = (key: HarnessKey) => setDraft((current) => ({ ...current, [key]: !current[key] }));
  // aria-labelは英語固定（テスト安定化）。表示ラベル・説明だけを日英で切り替える。
  const rows: readonly { readonly key: HarnessKey; readonly ariaLabel: string; readonly label: string; readonly description: string }[] = [
    { key: 'fileMemory', ariaLabel: 'File memory', label: text('File memory', 'ファイルメモリ'), description: text('persistent notes across sessions (memory_* tools)', 'セッションをまたいで残るメモ（memory_*ツール、Wiki保存）') },
    { key: 'todoProvider', ariaLabel: 'Todo provider', label: text('Todo provider', 'TODOリスト'), description: text('multi-step plan tracking (todos_add / todos_complete)', '複数ステップ計画の管理（todos_add / todos_complete）') },
    { key: 'compaction', ariaLabel: 'Compaction', label: text('Compaction', 'コンパクション'), description: text('auto-compress context in long tool loops', '長いツールループの文脈を自動圧縮') },
    { key: 'webSearch', ariaLabel: 'Web search', label: text('Web search', 'Web検索'), description: text('inject the web_search tool (requires a search provider)', 'web_searchツールを注入（検索プロバイダ設定が必要）') },
    { key: 'toolApproval', ariaLabel: 'Tool approval', label: text('Tool approval', 'ツール承認'), description: text('pause before write tools and ask for approval', '書き込み系ツールの実行前に承認を要求') },
    { key: 'functionInvocation', ariaLabel: 'Function invocation', label: text('Function invocation', 'ツール自動実行'), description: text('automatic tool-calling loop (off = single reply, no tools)', 'ツール呼び出しの自動ループ（オフで1回応答のみ）') },
  ];
  return <div className="node-config-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section ref={dialogRef} tabIndex={-1} className="node-config-dialog harness-settings-dialog" role="dialog" aria-modal="true" aria-label={text('Runtime options', '実行オプション')}>
      <header>
        <div><span className="eyebrow">{text('Agent runtime', 'エージェント実行')}</span><h2>{text('Runtime options', '実行オプション')}</h2></div>
        <button type="button" className="ghost" aria-label={text('Close runtime options', '実行オプションを閉じる')} onClick={onCancel}>×</button>
      </header>
      <div className="node-config-dialog-body harness-toggle-list">
        <p className="harness-hint">{text('These runtime features are opt-in per Agent (they are unrelated to the Multi-Agent screen). Leaving them unset keeps the previous behaviour.', 'これらの実行時機能はAgent単位のopt-inです（マルチエージェント画面とは別物です）。未設定のままなら従来どおりの動作になります。')}</p>
        {rows.map((row) => <label className="harness-toggle" key={row.key}>
          <input type="checkbox" aria-label={row.ariaLabel} checked={draft[row.key]} onChange={() => toggle(row.key)} />
          <span><strong>{row.label}</strong><small>{row.description}</small></span>
        </label>)}
      </div>
      <footer>
        <button type="button" className="secondary harness-clear" onClick={onClear}>{text('Clear', '未設定に戻す')}</button>
        <button type="button" className="secondary" onClick={onCancel}>{text('Cancel', 'キャンセル')}</button>
        <button type="button" className="primary" onClick={() => onApply(draft)}>{text('Apply', '適用')}</button>
      </footer>
    </section>
  </div>;
}
