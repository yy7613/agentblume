import { useState } from 'react';
import type { SchemaDto, ToolCheckCellOpDto } from '../api/types';
import { useI18n } from '../i18n';
import { CELL_OPS, EMPTY_CELL, ROW_COUNT_OPS, cellOpLabel, type CellDraft, type CellMode, type ExpectationDraft, type OutcomeChoice, type RowCountOp } from './tool-check-model';

/**
 * 期待の編集欄。すべて任意で、空欄の項目は送らない（buildExpectations が畳む）。
 * 列名は出力スキーマが分かるときだけ選択式にし、分からなければ自由入力にする。
 */
export function ExpectationEditor({ draft, outputSchema, disabled, onChange }: {
  readonly draft: ExpectationDraft;
  readonly outputSchema: SchemaDto | undefined;
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

      <div className="tool-check-expect-row">
        <label htmlFor="tool-check-max-duration">{text('Max duration (ms)', '所要時間上限 (ms)')}</label>
        <input id="tool-check-max-duration" type="number" min={0} step={1} value={draft.maxDurationMs} disabled={disabled} onChange={(event) => onChange({ ...draft, maxDurationMs: event.target.value })} />
      </div>
    </section>
  );
}
