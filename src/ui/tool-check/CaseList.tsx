import type { ToolCheckCaseDto, ToolCheckRunResultDto, ToolSummaryDto } from '../api/types';
import { useI18n } from '../i18n';
import { statusLabel, type ResultStatus } from './tool-check-model';

/**
 * 保存済みケースの一覧（左列）。各行に 実行 / 開く / 削除 を置き、直近の結果をチップで示す。
 * `results` はこの画面で実行して得た結果（保存済みの lastResult より新しい）を優先して表示するために受け取る。
 */
export function CaseList({ cases, tools, results, selectedId, busyId, disabled, onRun, onOpen, onDelete }: {
  readonly cases: readonly ToolCheckCaseDto[];
  readonly tools: readonly ToolSummaryDto[];
  readonly results: ReadonlyMap<string, ToolCheckRunResultDto>;
  readonly selectedId: string | undefined;
  /** 単体実行中のケースID（そのケースのボタンだけを「実行中…」にする）。 */
  readonly busyId: string | undefined;
  readonly disabled: boolean;
  readonly onRun: (item: ToolCheckCaseDto) => void;
  readonly onOpen: (item: ToolCheckCaseDto) => void;
  readonly onDelete: (item: ToolCheckCaseDto) => void;
}) {
  const { text } = useI18n();
  if (cases.length === 0) {
    return (
      <p className="empty-state">
        {text(
          'No saved cases yet. A case is one set of arguments and expectations for a tool; save one from the editor and re-run it after changing the tool or its data.',
          '保存済みのケースはまだありません。ケースは「ツール1つに対する引数と期待の組」です。右のエディタから保存すると、ツールやデータを変えた後に再実行して退行を見つけられます。',
        )}
      </p>
    );
  }
  return (
    <ul className="validation-list tool-check-cases" aria-label={text('Saved cases', '保存済みケース')}>
      {cases.map((item) => {
        const tool = tools.find((candidate) => candidate.internalId === item.toolId);
        const latest = results.get(item.id);
        const status: ResultStatus | undefined = latest?.status ?? item.lastResult?.status;
        const checkedAt = latest?.checkedAt ?? item.lastResult?.checkedAt;
        const [statusEn, statusJa] = statusLabel(status);
        const version = item.toolVersion ?? text('latest', '最新');
        return (
          <li key={item.id} className={`tool-check-case${selectedId === item.id ? ' selected' : ''}`}>
            <div className="tool-check-case-body">
              <strong className="tool-check-name">{item.name}</strong>
              <span className="tool-check-name tool-check-case-tool"><code>{tool?.publishName ?? item.toolId}</code>@{version}</span>
              <span className={`run-status tool-check-chip ${status ?? 'none'}`}>{text(statusEn, statusJa)}</span>
              {checkedAt !== undefined && <time dateTime={checkedAt}>{checkedAt}</time>}
            </div>
            <div className="tool-check-case-actions">
              <button type="button" className="secondary" disabled={disabled} onClick={() => onRun(item)}>{busyId === item.id ? text('Running…', '実行中…') : text('Run', '実行')}</button>
              <button type="button" className="secondary" disabled={disabled} onClick={() => onOpen(item)}>{text('Open', '開く')}</button>
              <button type="button" className="secondary danger" disabled={disabled} onClick={() => onDelete(item)}>{text('Delete', '削除')}</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
