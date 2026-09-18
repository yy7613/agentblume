import { localizeRunTraceError, localizeToolCheckAssertion } from '../api/error-messages';
import type { JsonCell, ToolCheckRunResultDto } from '../api/types';
import { RunFailureNotice } from '../components/RunFailureNotice';
import { useI18n } from '../i18n';
import { assertionCounts, assertionKindLabel, isExpectedFailure, statusLabel } from './tool-check-model';

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
function displayCell(value: JsonCell): string {
  return value === null ? 'null' : String(value);
}

/**
 * 1回の検証結果。並びは **合否 → （エラーなら）次の一手と直す場所 → 期待の表 → 出力の表 → ノード別行数**。
 * status = error のときは RunFailureNotice に委ねて、Chat / Tool Builder と同じ「次の一手 → 原因 → 失敗箇所 →
 * 直す場所へのボタン」で描く（fixTargetsForFailure がツール・ノード・区画を決める）。
 * `argumentFields` は TOOL_ARGUMENTS でサーバーが名指しした引数欄。引数フォームへ戻るボタンを出す。
 *
 * 期待が「失敗すること」（outcome = error）で実際に失敗したときは status = passed のまま error が入る。
 * その失敗は期待どおりなので、直すボタンや引数の強調は出さず、失敗の内容だけを情報として見せる。
 */
export function ResultPanel({ result, argumentFields, onFocusArgument }: {
  readonly result: ToolCheckRunResultDto;
  readonly argumentFields: readonly string[];
  readonly onFocusArgument: (name: string) => void;
}) {
  const { text, language } = useI18n();
  const counts = assertionCounts(result);
  const expectedFailure = isExpectedFailure(result);
  const [statusEn, statusJa] = statusLabel(result.status);
  const shown = result.output.rows.length;
  const truncated = result.rowCount > shown;
  const rowSummary = truncated
    ? text(`Showing ${formatCount(shown)} of ${formatCount(result.rowCount)} rows.`, `全 ${formatCount(result.rowCount)} 行のうち ${formatCount(shown)} 行を表示`)
    : text(`${formatCount(result.rowCount)} row${result.rowCount === 1 ? '' : 's'}`, `${formatCount(result.rowCount)} 行`);

  return (
    <section className="tool-check-section tool-check-result" aria-labelledby="tool-check-result-heading">
      <h2 id="tool-check-result-heading">{text('Result', '結果')}</h2>
      <div className={`tool-check-banner ${result.status}`} role="status">
        <strong>{text(statusEn, statusJa)}</strong>
        <span>
          {text(`${counts.passed} passed / ${counts.failed} failed`, `合格 ${counts.passed} / 不合格 ${counts.failed}`)}
          {' · '}{formatCount(result.durationMs)} ms
          {' · '}<code>{result.tool.publishName}</code> v{result.tool.version}
        </span>
      </div>

      {result.error !== undefined && expectedFailure && (
        <div className="tool-check-expected-failure" role="note">
          <p><strong>{text('The run failed as expected.', '期待どおり実行が失敗しました。')}</strong> {text('Nothing to fix; the details are shown for reference.', '直すものはありません。参考として失敗の内容を示します。')}</p>
          <p>{localizeRunTraceError(result.error, language)}</p>
          <p><small><code>{result.error.code}</code>{result.error.nodeId === undefined ? '' : <> · {text('node', 'ノード')} <code>{result.error.nodeId}</code></>} · {result.error.message}</small></p>
        </div>
      )}

      {result.error !== undefined && !expectedFailure && (
        <div className="tool-check-error">
          {argumentFields.length > 0 && (
            <div className="tool-check-argument-hint" role="alert">
              <p><strong>{text(`Fix the argument ${argumentFields.map((name) => `"${name}"`).join(', ')} and run again.`, `引数 ${argumentFields.map((name) => `「${name}」`).join('、')} を直して再実行してください。`)}</strong></p>
              <p>{text('If the value the agent would pass is right, the tool definition needs the change instead.', 'エージェントが渡す値が正しいなら、直すのはツール側の引数定義です。')}</p>
              <div className="run-failure-actions">
                {argumentFields.map((name) => <button key={name} type="button" className="secondary" onClick={() => onFocusArgument(name)}>{text(`Go to argument "${name}"`, `引数「${name}」の欄へ`)}</button>)}
              </div>
            </div>
          )}
          <RunFailureNotice
            code={result.error.code}
            message={localizeRunTraceError(result.error, language)}
            serverMessage={result.error.message}
            tool={{ internalId: result.tool.internalId, version: result.tool.version, publishName: result.tool.publishName }}
            {...(result.error.nodeId === undefined ? {} : { nodeId: result.error.nodeId })}
          />
        </div>
      )}

      {result.assertions.length > 0 && (
        <div className="table-wrap tool-check-assertions">
          <table>
            <caption>{text('Expectations', '期待')}</caption>
            <thead><tr><th>{text('Check', '項目')}</th><th>{text('Expected', '期待')}</th><th>{text('Actual', '実測')}</th><th>{text('Result', '結果')}</th></tr></thead>
            <tbody>
              {result.assertions.map((assertion, index) => {
                const [kindEn, kindJa] = assertionKindLabel(assertion.kind);
                return (
                  <tr key={index} className={assertion.passed ? 'passed' : 'failed'}>
                    <td>{text(kindEn, kindJa)}</td>
                    <td>{localizeToolCheckAssertion(assertion.expected, language)}</td>
                    <td>{localizeToolCheckAssertion(assertion.actual, language, 'actual')}</td>
                    <td><span className={`tool-check-mark ${assertion.passed ? 'passed' : 'failed'}`} aria-label={assertion.passed ? text('passed', '合格') : text('failed', '不合格')}>{assertion.passed ? '✓' : '✕'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>{text('Output', '出力')}</h3>
      {result.output.schema.columns.length > 0 && (
        <div className="schema-strip">{result.output.schema.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.type}{column.nullable ? ' · nullable' : ''}</span></div>)}</div>
      )}
      {shown === 0
        ? <p className="empty-state">{text(result.rowCount === 0 ? 'The tool returned 0 rows.' : 'No rows to show.', result.rowCount === 0 ? '出力は 0 行でした' : '表示できる行がありません')}</p>
        : <div className="table-wrap">
          <table>
            <thead><tr>{result.output.schema.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead>
            <tbody>{result.output.rows.map((row, index) => <tr key={index}>{result.output.schema.columns.map((column) => <td key={column.name}>{displayCell(row[column.name] ?? null)}</td>)}</tr>)}</tbody>
          </table>
          <small className="row-count">{rowSummary}</small>
        </div>}

      {(result.judgments ?? []).length > 0 && (
        <div className="tool-check-judgment-tables">
          <h3>{text('AI judgments', 'AI判定')}</h3>
          <p className="tool-check-hint">{text('What the AI judgment node decided for each of its input rows. Rows removed by keep / exclude are still listed here.', 'AI判定ノードが入力の各行をどう判定したかです。keep / exclude で出力から消えた行もここには残ります。')}</p>
          {result.judgedBy !== undefined && <p className="tool-check-meta"><small>{text('Judged by', '判定したモデル')} <code>{result.judgedBy}</code></small></p>}
          {(result.judgments ?? []).map((judgment) => {
            const shownRows = judgment.table.rows.length;
            return (
              <div key={judgment.nodeId} className="table-wrap tool-check-judgment-table">
                <table>
                  <caption>{text('Node', 'ノード')} <code>{judgment.nodeId}</code></caption>
                  <thead><tr>{judgment.table.schema.columns.map((column) => <th key={column.name} className={column.name === judgment.verdictColumn || column.name === judgment.reasonColumn ? 'tool-check-judgment-column' : undefined}>{column.name}</th>)}</tr></thead>
                  <tbody>
                    {judgment.table.rows.map((row, index) => (
                      <tr key={index}>
                        {judgment.table.schema.columns.map((column) => (
                          <td key={column.name} className={column.name === judgment.verdictColumn || column.name === judgment.reasonColumn ? 'tool-check-judgment-column' : undefined}>{displayCell(row[column.name] ?? null)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <small className="row-count">
                  {judgment.rowCount > shownRows
                    ? text(`Showing ${formatCount(shownRows)} of ${formatCount(judgment.rowCount)} judged rows.`, `判定した全 ${formatCount(judgment.rowCount)} 行のうち ${formatCount(shownRows)} 行を表示`)
                    : text(`${formatCount(judgment.rowCount)} judged row${judgment.rowCount === 1 ? '' : 's'}`, `判定した行 ${formatCount(judgment.rowCount)} 行`)}
                </small>
              </div>
            );
          })}
        </div>
      )}

      {result.nodes.length > 0 && (
        <p className="tool-check-nodes">
          {text('Rows per node:', 'ノード別の行数:')}{' '}
          {result.nodes.map((node) => <span key={node.nodeId} className="version-chip"><code>{node.nodeId}</code> {formatCount(node.rowCount)}</span>)}
        </p>
      )}
      <p className="tool-check-meta"><small>{text('Checked at', '実行日時')} {result.checkedAt}</small></p>
    </section>
  );
}
