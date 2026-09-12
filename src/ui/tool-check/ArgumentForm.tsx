import type { ColumnDto, SchemaDto } from '../api/types';
import { useI18n } from '../i18n';
import { EMPTY_DRAFT, inputKindFor, type ArgumentDrafts } from './tool-check-model';

/**
 * ツールの入力スキーマ（agent-input の列）から生成する引数フォーム。
 * 列の型ごとに入力欄を変え、nullable な列だけ「未指定(null)」トグルを出す。
 * `highlighted` はサーバーが TOOL_ARGUMENTS で名指しした欄、`issues` は送信前に分かった不備（数値でない）。
 */
export function ArgumentForm({ schema, description, drafts, highlighted, issues, disabled, onChange }: {
  readonly schema: SchemaDto | undefined;
  readonly description?: string;
  readonly drafts: ArgumentDrafts;
  readonly highlighted: readonly string[];
  readonly issues: Readonly<Record<string, 'not-a-number'>>;
  readonly disabled: boolean;
  readonly onChange: (name: string, draft: { readonly raw: string; readonly isNull: boolean }) => void;
}) {
  const { text } = useI18n();
  const columns = schema?.columns ?? [];
  return (
    <section className="tool-check-section" aria-labelledby="tool-check-arguments-heading">
      <h2 id="tool-check-arguments-heading">{text('Arguments', '引数')}</h2>
      {description !== undefined && description !== '' && <p className="tool-check-hint">{text('Description shown to the agent:', 'エージェントに見せている説明:')} {description}</p>}
      {columns.length === 0
        ? <p className="empty-state">{text('This tool takes no arguments.', '引数なし（このツールは引数を受け取りません）')}</p>
        : <div className="tool-check-args">{columns.map((column) => (
          <ArgumentField
            key={column.name}
            column={column}
            draft={drafts[column.name] ?? EMPTY_DRAFT}
            highlighted={highlighted.includes(column.name)}
            issue={issues[column.name]}
            disabled={disabled}
            onChange={(draft) => onChange(column.name, draft)}
          />
        ))}</div>}
    </section>
  );
}

function ArgumentField({ column, draft, highlighted, issue, disabled, onChange }: {
  readonly column: ColumnDto;
  readonly draft: { readonly raw: string; readonly isNull: boolean };
  readonly highlighted: boolean;
  readonly issue: 'not-a-number' | undefined;
  readonly disabled: boolean;
  readonly onChange: (draft: { readonly raw: string; readonly isNull: boolean }) => void;
}) {
  const { text } = useI18n();
  const kind = inputKindFor(column);
  const inputId = `tool-check-arg-${column.name}`;
  const nullId = `tool-check-null-${column.name}`;
  const valueDisabled = disabled || draft.isNull;
  const placeholder = column.type === 'date' ? text('ISO date, e.g. 2026-01-31', 'ISO形式の日付（例: 2026-01-31）') : undefined;
  return (
    <div className={`tool-check-arg${highlighted ? ' highlighted' : ''}`} data-argument={column.name}>
      <label htmlFor={inputId}>
        <span className="tool-check-arg-name">{column.name}</span>
        <span className="tool-check-arg-type">{column.type}{column.nullable ? ` · ${text('nullable', 'null可')}` : ''}</span>
      </label>
      {kind === 'boolean'
        ? <select id={inputId} value={draft.raw === 'true' ? 'true' : 'false'} disabled={valueDisabled} onChange={(event) => onChange({ raw: event.target.value, isNull: false })}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        : <input
          id={inputId}
          type={kind === 'number' ? 'number' : 'text'}
          inputMode={kind === 'number' ? 'decimal' : undefined}
          step={kind === 'number' ? 'any' : undefined}
          value={draft.raw}
          placeholder={placeholder}
          disabled={valueDisabled}
          aria-invalid={highlighted || issue !== undefined ? true : undefined}
          onChange={(event) => onChange({ raw: event.target.value, isNull: false })}
        />}
      {column.nullable && (
        <label className="checkbox-label" htmlFor={nullId}>
          <input id={nullId} type="checkbox" checked={draft.isNull} disabled={disabled} onChange={(event) => onChange({ raw: draft.raw, isNull: event.target.checked })} />
          {text('Unspecified (null)', '未指定(null)')}
        </label>
      )}
      {issue === 'not-a-number' && <p className="field-error" role="alert">{text('Enter a number.', '数値を入力してください')}</p>}
      {highlighted && issue === undefined && <p className="field-error" role="alert">{text('The server rejected this argument. Check the value and run again.', 'この引数がサーバーで拒否されました。値を確認して再実行してください')}</p>}
    </div>
  );
}
