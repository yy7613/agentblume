import { useState } from 'react';
import type { SchemaDto, ToolCheckCellOpDto } from '../api/types';
import { useI18n } from '../i18n';
import {
  CELL_OPS, EMPTY_CELL, EMPTY_JUDGMENT, EMPTY_ROW, EMPTY_ROW_CELL, MAX_JUDGMENT_EXPECTATIONS, MAX_ROW_CELLS, MAX_ROW_EXPECTATIONS, ROW_COUNT_OPS, cellOpLabel,
  type AiJudgeNodeInfo, type CellDraft, type CellMode, type ExpectationDraft, type JudgmentExpectationDraft, type OutcomeChoice, type RowCellDraft, type RowCountOp, type RowExpectationDraft,
} from './tool-check-model';

/** 選択肢に添える質問文の抜粋（長い質問で select が横に伸びないように切る）。 */
function questionExcerpt(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 40)}…`;
}

/**
 * 期待の編集欄。すべて任意で、空欄の項目は送らない（buildExpectations が畳む）。
 * 列名は出力スキーマが分かるときだけ選択式にし、分からなければ自由入力にする。
 *
 * 「行の期待」は終端出力の 1 行を特定して見る（残ったか・消えたか・その行の値）。
 * 「AI判定の期待」はツールに AI判定ノードがあるときだけ出し、ノードの**入力行**の判定を見る
 * （keep / exclude で行が出力から消えていても「この行は no と判定された」を確かめられる）。
 */
export function ExpectationEditor({ draft, outputSchema, judgeNodes = [], disabled, onChange }: {
  readonly draft: ExpectationDraft;
  readonly outputSchema: SchemaDto | undefined;
  /** ツールのグラフにある AI判定ノード。空なら「AI判定の期待」の節を出さない。 */
  readonly judgeNodes?: readonly AiJudgeNodeInfo[];
  readonly disabled: boolean;
  readonly onChange: (next: ExpectationDraft) => void;
}) {
  const { text } = useI18n();
  const [columnInput, setColumnInput] = useState('');
  const knownColumns = outputSchema?.columns.map((column) => column.name) ?? [];
  const opLabel = (op: RowCountOp): string => (op === 'eq' ? '==' : op === 'gte' ? '>=' : '<=');

  const addColumn = () => {
    const name = columnInput.trim();
    if (name === '') return;
    if (!draft.columns.includes(name)) onChange({ ...draft, columns: [...draft.columns, name] });
    setColumnInput('');
  };
  const updateCell = (index: number, patch: Partial<CellDraft>) => {
    onChange({ ...draft, cells: draft.cells.map((cell, at) => (at === index ? { ...cell, ...patch } : cell)) });
  };
  const updateRow = (index: number, patch: Partial<RowExpectationDraft>) => {
    onChange({ ...draft, rows: draft.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)) });
  };
  const updateRowCell = (rowIndex: number, cellIndex: number, patch: Partial<RowCellDraft>) => {
    const row = draft.rows[rowIndex];
    if (row === undefined) return;
    updateRow(rowIndex, { cells: row.cells.map((cell, at) => (at === cellIndex ? { ...cell, ...patch } : cell)) });
  };
  const updateJudgment = (index: number, patch: Partial<JudgmentExpectationDraft>) => {
    onChange({ ...draft, judgments: draft.judgments.map((judgment, at) => (at === index ? { ...judgment, ...patch } : judgment)) });
  };
  /** 判定値のチェックを入れ替える。並びは選んだ順ではなくノードの選択肢の順に揃える（読み順を安定させる）。 */
  const toggleVerdict = (index: number, options: readonly string[], value: string, checked: boolean) => {
    const judgment = draft.judgments[index];
    if (judgment === undefined) return;
    const next = checked ? [...judgment.verdicts, value] : judgment.verdicts.filter((existing) => existing !== value);
    const ordered = [...options.filter((option) => next.includes(option)), ...next.filter((existing) => !options.includes(existing))];
    updateJudgment(index, { verdicts: ordered });
  };
  const nodeOf = (nodeId: string): AiJudgeNodeInfo | undefined => judgeNodes.find((node) => node.nodeId === nodeId);

  return (
    <section className="tool-check-section" aria-labelledby="tool-check-expectations-heading">
      <h2 id="tool-check-expectations-heading">{text('Expectations', '期待')}</h2>
      <p className="tool-check-hint">{text('All optional. Leave a field empty to skip that check.', 'すべて任意です。空欄の項目は確認しません。')}</p>

      <div className="tool-check-expect-row">
        <label htmlFor="tool-check-outcome">{text('Outcome', '実行の結末')}</label>
        <select id="tool-check-outcome" value={draft.outcome} disabled={disabled} onChange={(event) => onChange({ ...draft, outcome: event.target.value as OutcomeChoice })}>
          <option value="">{text('Not specified', '指定なし')}</option>
          <option value="success">{text('Must succeed', '成功すること')}</option>
          <option value="error">{text('Must fail (abnormal case)', '失敗すること（異常系）')}</option>
        </select>
        {draft.outcome === 'error' && <span className="tool-check-hint tool-check-outcome-hint">{text('Passes when the run errors (bad arguments, node error). Other expectations are not evaluated.', '実行が失敗（引数不正・ノードエラー）したら合格です。他の期待は評価しません。')}</span>}
      </div>

      <div className="tool-check-expect-row">
        <label htmlFor="tool-check-rowcount-op">{text('Row count', '行数')}</label>
        <select id="tool-check-rowcount-op" value={draft.rowCountOp} disabled={disabled} onChange={(event) => onChange({ ...draft, rowCountOp: event.target.value as RowCountOp })}>
          {ROW_COUNT_OPS.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
        </select>
        <input id="tool-check-rowcount-value" aria-label={text('Expected row count', '期待する行数')} type="number" min={0} step={1} value={draft.rowCountValue} disabled={disabled} onChange={(event) => onChange({ ...draft, rowCountValue: event.target.value })} />
      </div>

      <div className="tool-check-expect-row">
        <label htmlFor="tool-check-column-input">{text('Columns that must exist', '存在すべき列')}</label>
        {knownColumns.length > 0
          ? <select id="tool-check-column-input" value={columnInput} disabled={disabled} onChange={(event) => setColumnInput(event.target.value)}>
            <option value="">{text('Select a column…', '列を選ぶ…')}</option>
            {knownColumns.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          : <input id="tool-check-column-input" type="text" value={columnInput} disabled={disabled} placeholder={text('column name', '列名')} onChange={(event) => setColumnInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addColumn(); } }} />}
        <button type="button" className="secondary" disabled={disabled || columnInput.trim() === ''} onClick={addColumn}>{text('Add column', '列を追加')}</button>
      </div>
      {draft.columns.length > 0 && (
        <ul className="tool-check-chips" aria-label={text('Expected columns', '期待する列')}>
          {draft.columns.map((name) => (
            <li key={name} className="version-chip">
              {name}
              <button type="button" className="tool-check-chip-remove" aria-label={text(`Remove column ${name}`, `列 ${name} を外す`)} disabled={disabled} onClick={() => onChange({ ...draft, columns: draft.columns.filter((existing) => existing !== name) })}>×</button>
            </li>
          ))}
        </ul>
      )}

      <div className="tool-check-cells">
        <div className="tool-check-cells-head">
          <span>{text('Cell conditions', 'セル条件')}</span>
          <button type="button" className="secondary" disabled={disabled} onClick={() => onChange({ ...draft, cells: [...draft.cells, EMPTY_CELL] })}>{text('Add condition', '条件を追加')}</button>
        </div>
        {draft.cells.map((cell, index) => (
          <div key={index} className="tool-check-cell-row">
            {knownColumns.length > 0
              ? <select aria-label={text(`Condition ${index + 1} column`, `条件 ${index + 1} の列`)} value={cell.column} disabled={disabled} onChange={(event) => updateCell(index, { column: event.target.value })}>
                <option value="">{text('column…', '列…')}</option>
                {knownColumns.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              : <input aria-label={text(`Condition ${index + 1} column`, `条件 ${index + 1} の列`)} type="text" value={cell.column} disabled={disabled} placeholder={text('column', '列名')} onChange={(event) => updateCell(index, { column: event.target.value })} />}
            <select aria-label={text(`Condition ${index + 1} operator`, `条件 ${index + 1} の演算子`)} value={cell.op} disabled={disabled} onChange={(event) => updateCell(index, { op: event.target.value as ToolCheckCellOpDto })}>
              {CELL_OPS.map((op) => <option key={op} value={op}>{cellOpLabel(op)}</option>)}
            </select>
            <input aria-label={text(`Condition ${index + 1} value`, `条件 ${index + 1} の値`)} type="text" value={cell.value} disabled={disabled} placeholder={text('value', '値')} onChange={(event) => updateCell(index, { value: event.target.value })} />
            <select aria-label={text(`Condition ${index + 1} mode`, `条件 ${index + 1} の適用範囲`)} value={cell.mode} disabled={disabled} onChange={(event) => updateCell(index, { mode: event.target.value as CellMode })}>
              <option value="any">{text('some row', 'いずれかの行')}</option>
              <option value="all">{text('every row', 'すべての行')}</option>
            </select>
            <button type="button" className="secondary danger" aria-label={text(`Remove condition ${index + 1}`, `条件 ${index + 1} を削除`)} disabled={disabled} onClick={() => onChange({ ...draft, cells: draft.cells.filter((_, at) => at !== index) })}>×</button>
          </div>
        ))}
      </div>

      <div className="tool-check-cells tool-check-rows">
        <div className="tool-check-cells-head">
          <span>{text('Row expectations', '行の期待')}</span>
          <button type="button" className="secondary" disabled={disabled || draft.rows.length >= MAX_ROW_EXPECTATIONS} onClick={() => onChange({ ...draft, rows: [...draft.rows, EMPTY_ROW] })}>{text('Add row expectation', '行の期待を追加')}</button>
        </div>
        <p className="tool-check-hint">{text('Find one row by "column == value" (the first match) and check that it is there, that it is gone, or what its cells hold.', '「列 == 値」で行を1つ特定し（最初に一致した行）、その行が残るか・消えるか・値がどうかを確かめます。')}</p>
        {draft.rows.map((row, index) => (
          <div key={index} className="tool-check-row-expect">
            <div className="tool-check-cell-row">
              {knownColumns.length > 0
                ? <select aria-label={text(`Row ${index + 1} locator column`, `行の期待 ${index + 1} の列`)} value={row.column} disabled={disabled} onChange={(event) => updateRow(index, { column: event.target.value })}>
                  <option value="">{text('column…', '列…')}</option>
                  {knownColumns.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                : <input aria-label={text(`Row ${index + 1} locator column`, `行の期待 ${index + 1} の列`)} type="text" value={row.column} disabled={disabled} placeholder={text('column', '列名')} onChange={(event) => updateRow(index, { column: event.target.value })} />}
              <span className="tool-check-op">==</span>
              <input aria-label={text(`Row ${index + 1} locator value`, `行の期待 ${index + 1} の値`)} type="text" value={row.value} disabled={disabled} placeholder={text('value', '値')} onChange={(event) => updateRow(index, { value: event.target.value })} />
              <select aria-label={text(`Row ${index + 1} presence`, `行の期待 ${index + 1} の有無`)} value={row.present ? 'present' : 'absent'} disabled={disabled} onChange={(event) => updateRow(index, { present: event.target.value === 'present' })}>
                <option value="present">{text('is present', '存在する')}</option>
                <option value="absent">{text('is absent', '存在しない')}</option>
              </select>
              <button type="button" className="secondary danger" aria-label={text(`Remove row expectation ${index + 1}`, `行の期待 ${index + 1} を削除`)} disabled={disabled} onClick={() => onChange({ ...draft, rows: draft.rows.filter((_, at) => at !== index) })}>×</button>
            </div>
            {row.present && (
              <div className="tool-check-row-cells">
                {row.cells.map((cell, cellIndex) => (
                  <div key={cellIndex} className="tool-check-cell-row">
                    {knownColumns.length > 0
                      ? <select aria-label={text(`Row ${index + 1} condition ${cellIndex + 1} column`, `行の期待 ${index + 1} の条件 ${cellIndex + 1} の列`)} value={cell.column} disabled={disabled} onChange={(event) => updateRowCell(index, cellIndex, { column: event.target.value })}>
                        <option value="">{text('column…', '列…')}</option>
                        {knownColumns.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                      : <input aria-label={text(`Row ${index + 1} condition ${cellIndex + 1} column`, `行の期待 ${index + 1} の条件 ${cellIndex + 1} の列`)} type="text" value={cell.column} disabled={disabled} placeholder={text('column', '列名')} onChange={(event) => updateRowCell(index, cellIndex, { column: event.target.value })} />}
                    <select aria-label={text(`Row ${index + 1} condition ${cellIndex + 1} operator`, `行の期待 ${index + 1} の条件 ${cellIndex + 1} の演算子`)} value={cell.op} disabled={disabled} onChange={(event) => updateRowCell(index, cellIndex, { op: event.target.value as ToolCheckCellOpDto })}>
                      {CELL_OPS.map((op) => <option key={op} value={op}>{cellOpLabel(op)}</option>)}
                    </select>
                    <input aria-label={text(`Row ${index + 1} condition ${cellIndex + 1} value`, `行の期待 ${index + 1} の条件 ${cellIndex + 1} の値`)} type="text" value={cell.value} disabled={disabled} placeholder={text('value', '値')} onChange={(event) => updateRowCell(index, cellIndex, { value: event.target.value })} />
                    <button type="button" className="secondary danger" aria-label={text(`Remove row ${index + 1} condition ${cellIndex + 1}`, `行の期待 ${index + 1} の条件 ${cellIndex + 1} を削除`)} disabled={disabled} onClick={() => updateRow(index, { cells: row.cells.filter((_, at) => at !== cellIndex) })}>×</button>
                  </div>
                ))}
                <button type="button" className="secondary" disabled={disabled || row.cells.length >= MAX_ROW_CELLS} onClick={() => updateRow(index, { cells: [...row.cells, EMPTY_ROW_CELL] })}>{text(`Add condition to row ${index + 1}`, `行の期待 ${index + 1} に条件を追加`)}</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {judgeNodes.length > 0 && (
        <div className="tool-check-cells tool-check-judgments">
          <div className="tool-check-cells-head">
            <span>{text('AI judgment expectations', 'AI判定の期待')}</span>
            <button type="button" className="secondary" disabled={disabled || draft.judgments.length >= MAX_JUDGMENT_EXPECTATIONS} onClick={() => onChange({ ...draft, judgments: [...draft.judgments, { ...EMPTY_JUDGMENT, nodeId: judgeNodes[0]?.nodeId ?? '' }] })}>{text('Add judgment expectation', 'AI判定の期待を追加')}</button>
          </div>
          <p className="tool-check-hint">
            {text(
              'Checks what the AI judgment node decided for one of its input rows, even when that row is filtered out afterwards. AI verdicts vary between runs, so tick every verdict you would accept.',
              'AI判定ノードが「入力の1行」をどう判定したかを見ます（判定で除かれて出力から消えた行でも確かめられます）。AIの判定は実行ごとに揺れるので、許容できる判定値をすべて選んでください。',
            )}
          </p>
          {draft.judgments.map((judgment, index) => {
            const node = nodeOf(judgment.nodeId);
            const options = node?.verdicts ?? [];
            const nodeColumns = node?.columns ?? [];
            return (
              <div key={index} className="tool-check-judgment-expect">
                <div className="tool-check-cell-row">
                  <select aria-label={text(`Judgment ${index + 1} node`, `AI判定の期待 ${index + 1} のノード`)} value={judgment.nodeId} disabled={disabled} onChange={(event) => updateJudgment(index, { nodeId: event.target.value, verdicts: [] })}>
                    <option value="">{text('node…', 'ノード…')}</option>
                    {judgeNodes.map((item) => <option key={item.nodeId} value={item.nodeId}>{item.question.trim() === '' ? item.nodeId : `${item.nodeId} — ${questionExcerpt(item.question)}`}</option>)}
                  </select>
                  {nodeColumns.length > 0
                    ? <select aria-label={text(`Judgment ${index + 1} locator column`, `AI判定の期待 ${index + 1} の列`)} value={judgment.column} disabled={disabled} onChange={(event) => updateJudgment(index, { column: event.target.value })}>
                      <option value="">{text('column…', '列…')}</option>
                      {nodeColumns.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                    : <input aria-label={text(`Judgment ${index + 1} locator column`, `AI判定の期待 ${index + 1} の列`)} type="text" value={judgment.column} disabled={disabled} placeholder={text('column', '列名')} onChange={(event) => updateJudgment(index, { column: event.target.value })} />}
                  <span className="tool-check-op">==</span>
                  <input aria-label={text(`Judgment ${index + 1} locator value`, `AI判定の期待 ${index + 1} の値`)} type="text" value={judgment.value} disabled={disabled} placeholder={text('value', '値')} onChange={(event) => updateJudgment(index, { value: event.target.value })} />
                  <button type="button" className="secondary danger" aria-label={text(`Remove judgment expectation ${index + 1}`, `AI判定の期待 ${index + 1} を削除`)} disabled={disabled} onClick={() => onChange({ ...draft, judgments: draft.judgments.filter((_, at) => at !== index) })}>×</button>
                </div>
                <fieldset className="tool-check-verdicts">
                  <legend>{text(`Accepted verdicts for judgment ${index + 1}`, `AI判定の期待 ${index + 1} の判定値（いずれか1つに一致すれば合格）`)}</legend>
                  {options.length === 0
                    ? <span className="tool-check-hint">{text('Pick a node first.', '先にノードを選んでください。')}</span>
                    : options.map((value) => (
                      <label key={value} className="tool-check-verdict">
                        <input type="checkbox" aria-label={text(`Judgment ${index + 1} verdict ${value}`, `AI判定の期待 ${index + 1} の判定値 ${value}`)} checked={judgment.verdicts.includes(value)} disabled={disabled} onChange={(event) => toggleVerdict(index, options, value, event.target.checked)} />
                        {value}
                      </label>
                    ))}
                </fieldset>
                <div className="tool-check-cell-row">
                  <input aria-label={text(`Judgment ${index + 1} reason contains`, `AI判定の期待 ${index + 1} の理由に含まれる文字列`)} type="text" value={judgment.reasonContains} disabled={disabled} placeholder={text('reason contains… (optional)', '理由に含まれる文字列（任意）')} onChange={(event) => updateJudgment(index, { reasonContains: event.target.value })} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="tool-check-expect-row">
        <label htmlFor="tool-check-max-duration">{text('Max duration (ms)', '所要時間上限 (ms)')}</label>
        <input id="tool-check-max-duration" type="number" min={0} step={1} value={draft.maxDurationMs} disabled={disabled} onChange={(event) => onChange({ ...draft, maxDurationMs: event.target.value })} />
      </div>
    </section>
  );
}
