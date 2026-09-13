import { useEffect, useMemo, useState } from 'react';
import { localizeJournalReason } from '../api/error-messages';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto, JournalConditionDto, JournalConditionOpDto, JournalDocumentKindDto, JournalDocumentSummaryDto, JournalOutcomeLineDto, JournalRuleDto, JournalRuleTestResultDto, SaveJournalRuleDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import type { TabFocus } from './JournalPage';
import {
  AMOUNT_SPEC_CHOICES, CONDITION_OPS, DOCUMENT_KINDS, FACT_FIELDS, amountSpecChoice, amountSpecFromChoice, amountSpecLabel, conditionValueFromInput, conditionValueToInput, editableRule,
  emptyRule, formatYen, kindLabel, opLabel, ruleSpecificity, ruleValidation, sortRules, splitList, summarizeConditions, summarizeScope, type AmountSpecChoice,
} from './journal-model';
import { AccountSelect, FieldError, TaxSelect, messageOf } from './journal-shared';

/**
 * ルールタブ。左が一覧（priority → 特異度 → 作成順）、右が編集フォーム。
 * `draft` は判定タブの「ルールを作る」（文書から事前入力）、`focus` は「ルールを開く」。
 * 「文書でテスト」は保存せずに `testJournalRule` で文書群へ照合し、一致 / 仕訳 / 理由を文書ごとに出す。
 */
export function RulesTab({ client, chart, rules, reloadRules, focus, draft }: {
  readonly client: ToolApiClient; readonly chart: JournalChartOfAccountsDto | undefined; readonly rules: readonly JournalRuleDto[]; readonly reloadRules: () => Promise<void>;
  readonly focus: TabFocus | undefined; readonly draft: { readonly rule: SaveJournalRuleDto; readonly seq: number } | undefined;
}) {
  const { text } = useI18n();
  const [editor, setEditor] = useState<SaveJournalRuleDto>(() => draft?.rule ?? emptyRule());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: 'success' | 'error'; readonly text: string }>();
  const [pendingDelete, setPendingDelete] = useState<JournalRuleDto>();
  const [deleting, setDeleting] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [documents, setDocuments] = useState<readonly JournalDocumentSummaryDto[]>();
  const [documentsError, setDocumentsError] = useState<string>();
  const [testIds, setTestIds] = useState<readonly string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<readonly JournalRuleTestResultDto[]>();
  const [testError, setTestError] = useState<string>();

  useEffect(() => { if (draft !== undefined) { setEditor(draft.rule); setSubmitted(false); setFeedback(undefined); setTestResults(undefined); } }, [draft]);
  useEffect(() => {
    if (focus === undefined) return;
    const rule = rules.find((item) => item.id === focus.id);
    if (rule !== undefined) { setEditor(editableRule(rule)); setSubmitted(false); setFeedback(undefined); setTestResults(undefined); }
  }, [focus, rules]);
  useEffect(() => {
    if (!testOpen || documents !== undefined) return;
    let active = true;
    void client.listJournalDocuments(scope, {}).then((all) => { if (active) { setDocuments(all); setDocumentsError(undefined); } }).catch((cause: unknown) => { if (active) { setDocuments([]); setDocumentsError(messageOf(cause)); } });
    return () => { active = false; };
  }, [client, testOpen, documents]);

  const emptyChart: Pick<JournalChartOfAccountsDto, 'accounts' | 'taxCategories' | 'dimensions'> = { accounts: [], taxCategories: [], dimensions: [] };
  const chartOrEmpty = chart ?? emptyChart;
  const issues = useMemo(() => ruleValidation(editor, chartOrEmpty), [editor, chartOrEmpty]);
  const issueOf = (path: string): string | undefined => {
    if (!submitted) return undefined;
    const issue = issues.find((item) => item.path === path);
    return issue === undefined ? undefined : text(issue.message[0], issue.message[1]);
  };
  const sorted = useMemo(() => sortRules(rules), [rules]);
  const update = (patch: Partial<SaveJournalRuleDto>) => setEditor((current) => ({ ...current, ...patch }));
  const updateLine = (index: number, patch: Partial<JournalOutcomeLineDto>) => update({ outcome: { ...editor.outcome, lines: editor.outcome.lines.map((line, position) => (position === index ? { ...line, ...patch } : line)) } });
  const updateCondition = (index: number, patch: Partial<JournalConditionDto>) => update({ conditions: editor.conditions.map((condition, position) => (position === index ? { ...condition, ...patch } : condition)) });

  const save = async () => {
    setSubmitted(true);
    setFeedback(undefined);
    if (issues.length > 0) { setFeedback({ kind: 'error', text: text('Fix the highlighted fields before saving.', '赤く示した欄を直してから保存してください') }); return; }
    setSaving(true);
    try {
      const saved = await client.saveJournalRule(scope, editor);
      setEditor(editableRule(saved));
      setFeedback({ kind: 'success', text: text(`Saved rule "${saved.name}". Judge the pending documents again from the Judge tab.`, `ルール「${saved.name}」を保存しました。「判定」タブで未判定の帳票をもう一度判定してください。`) });
      await reloadRules();
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (pendingDelete === undefined) return;
    setDeleting(true);
    try {
      await client.deleteJournalRule(pendingDelete.id, scope);
      if (editor.id === pendingDelete.id) setEditor(emptyRule());
      setPendingDelete(undefined);
      await reloadRules();
    } catch (cause: unknown) { setFeedback({ kind: 'error', text: messageOf(cause) }); }
    finally { setDeleting(false); }
  };

  const runTest = async () => {
    if (testIds.length === 0) { setTestError(text('Pick at least one document.', '文書を 1 つ以上選んでください')); return; }
    setTesting(true);
    setTestError(undefined);
    try { setTestResults(await client.testJournalRule(scope, { rule: editor, documentIds: testIds })); }
    catch (cause: unknown) { setTestError(messageOf(cause)); }
    finally { setTesting(false); }
  };

  const toggleKind = (kind: JournalDocumentKindDto) => {
    const current = editor.scope.documentKinds ?? [];
    const next = current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind];
    update({ scope: { ...editor.scope, ...(next.length === 0 ? { documentKinds: undefined } : { documentKinds: next }) } });
  };
  const documentLabel = (document: JournalDocumentSummaryDto) => `${document.transactionDate ?? '—'} ${document.issuerName ?? document.description ?? document.id} ${formatYen(document.grandTotal)}`;

  return <div className="journal-rules two-column-workspace">
    <section className="workspace-card" aria-labelledby="journal-rules-heading">
      <div className="journal-toolbar">
        <h2 id="journal-rules-heading">{text('Rules', 'ルール')} <small className="empty-state">({rules.length})</small></h2>
        <button type="button" className="secondary" onClick={() => { setEditor(emptyRule()); setSubmitted(false); setFeedback(undefined); setTestResults(undefined); }}>{text('New rule', '新規')}</button>
      </div>
      {sorted.length === 0 ? <p className="empty-state">{text('No rules yet. Judge a document and press "Create a rule", or start from "New rule".', 'ルールがまだありません。帳票を判定して「ルールを作る」を押すか、「新規」から作ってください。')}</p>
        : <div className="table-wrap"><table className="journal-table" aria-label={text('Rule list', 'ルール一覧')}>
          <thead><tr><th>{text('Name', '名前')}</th><th>{text('Mode', 'モード')}</th><th>{text('Priority', '優先度')}</th><th>{text('Specificity', '特異度')}</th><th>{text('Scope', '範囲')}</th><th>{text('Conditions', '条件')}</th><th /></tr></thead>
          <tbody>{sorted.map((rule) => <tr key={rule.id} className={rule.id === editor.id ? 'selected' : ''}>
            <td><button type="button" className="screen-link" onClick={() => { setEditor(editableRule(rule)); setSubmitted(false); setFeedback(undefined); setTestResults(undefined); }}>{rule.name}</button>{rule.enabled ? '' : <small className="empty-state"> ({text('disabled', '無効')})</small>}</td>
            <td>{rule.mode === 'auto' ? text('auto', '自動') : text('suggest', '推測')}</td>
            <td>{rule.priority}</td>
            <td>{ruleSpecificity(rule)}</td>
            <td>{summarizeScope(rule.scope, text)}</td>
            <td><small>{summarizeConditions(rule.conditions, text)}</small></td>
            <td><button type="button" className="secondary danger" onClick={() => setPendingDelete(rule)}>{text('Delete', '削除')}</button></td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section className="workspace-card journal-rule-editor" aria-labelledby="journal-rule-editor-heading">
      <h2 id="journal-rule-editor-heading">{editor.id === undefined ? text('New rule', '新しいルール') : text(`Edit rule "${editor.name}"`, `ルール「${editor.name}」を編集`)}</h2>
      {chart === undefined && <p className="notice-card">{text('The chart of accounts is not loaded, so accounts cannot be chosen yet.', '科目マスタが読み込まれていないため、科目をまだ選べません。')}</p>}
      <div className="journal-form-grid">
        <label>{text('Name', '名前')}<input aria-label={text('Rule name', 'ルール名')} value={editor.name} onChange={(event) => update({ name: event.target.value })} /><FieldError message={issueOf('name')} /></label>
        <label>{text('Mode', 'モード')}<select aria-label={text('Rule mode', 'モード')} value={editor.mode} onChange={(event) => update({ mode: event.target.value as 'auto' | 'suggest' })}><option value="auto">{text('auto (decide in stage 1)', '自動（Stage 1 で確定）')}</option><option value="suggest">{text('suggest (always go to stage 2)', '推測（常に Stage 2 へ）')}</option></select></label>
        <label>{text('Priority (higher wins)', '優先度（大きいほど優先）')}<input aria-label={text('Priority', '優先度')} type="number" value={editor.priority} onChange={(event) => update({ priority: Number(event.target.value) })} /><FieldError message={issueOf('priority')} /></label>
        <label className="journal-checkbox"><input type="checkbox" checked={editor.enabled} onChange={(event) => update({ enabled: event.target.checked })} />{text('Enabled', '有効')}</label>
        <label>{text('Direction', '方向')}<select aria-label={text('Scope direction', '範囲: 方向')} value={editor.scope.direction ?? ''} onChange={(event) => update({ scope: { ...editor.scope, ...(event.target.value === '' ? { direction: undefined } : { direction: event.target.value as 'in' | 'out' }) } })}><option value="">{text('Any', '指定なし')}</option><option value="out">{text('Expense', '支出')}</option><option value="in">{text('Income', '収入')}</option></select></label>
        <label>{text('Account hints (comma separated)', '口座名（カンマ区切り）')}<input aria-label={text('Scope account hints', '範囲: 口座名')} value={(editor.scope.accountHints ?? []).join(', ')} onChange={(event) => { const list = splitList(event.target.value); update({ scope: { ...editor.scope, ...(list.length === 0 ? { accountHints: undefined } : { accountHints: list }) } }); }} /></label>
      </div>
      <fieldset className="journal-kinds"><legend>{text('Document kinds (none = any)', '帳票種別（未選択 = すべて）')}</legend>
        {DOCUMENT_KINDS.map((kind) => <label key={kind} className="journal-checkbox"><input type="checkbox" checked={(editor.scope.documentKinds ?? []).includes(kind)} onChange={() => toggleKind(kind)} />{kindLabel(kind, text)}</label>)}
      </fieldset>

      <h3>{text('Conditions (all must match)', '条件（すべて満たす）')}</h3>
      {editor.conditions.map((condition, index) => <div key={index} className="journal-condition-row">
        <input list="journal-fact-fields" aria-label={text(`Condition ${index + 1} field`, `条件 ${index + 1} 項目`)} value={condition.field} placeholder="descriptionNorm" onChange={(event) => updateCondition(index, { field: event.target.value })} />
        <select aria-label={text(`Condition ${index + 1} operator`, `条件 ${index + 1} 演算`)} value={condition.op} onChange={(event) => { const op = event.target.value as JournalConditionOpDto; updateCondition(index, { op, value: conditionValueFromInput(op, conditionValueToInput(condition.op, condition.value)) }); }}>{CONDITION_OPS.map((op) => <option key={op} value={op}>{opLabel(op, text)}</option>)}</select>
        {!['exists', 'notExists', 'isTrue', 'isFalse'].includes(condition.op) && <input aria-label={text(`Condition ${index + 1} value`, `条件 ${index + 1} 値`)} value={conditionValueToInput(condition.op, condition.value)} placeholder={condition.op === 'between' ? text('min, max', '下限, 上限') : condition.op === 'in' ? text('a, b, c', 'a, b, c') : ''} onChange={(event) => updateCondition(index, { value: conditionValueFromInput(condition.op, event.target.value) })} />}
        <button type="button" className="secondary danger" onClick={() => update({ conditions: editor.conditions.filter((_item, position) => position !== index) })}>{text('Remove', '削除')}</button>
        <FieldError message={issueOf(`conditions.${index}.field`) ?? issueOf(`conditions.${index}.value`)} />
      </div>)}
      <datalist id="journal-fact-fields">{FACT_FIELDS.map((field) => <option key={field} value={field} />)}</datalist>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => update({ conditions: [...editor.conditions, { field: 'descriptionNorm', op: 'contains', value: '' }] })}>{text('Add condition', '条件を追加')}</button></div>

      <h3>{text('Outcome lines', '仕訳行')}</h3>
      <FieldError message={issueOf('outcome.lines')} />
      {editor.outcome.lines.map((line, index) => {
        const spec = amountSpecChoice(line.amount);
        return <div key={index} className="journal-line-row">
          <select aria-label={text(`Line ${index + 1} side`, `行 ${index + 1} 貸借`)} value={line.side} onChange={(event) => updateLine(index, { side: event.target.value as 'debit' | 'credit' })}><option value="debit">{text('Debit', '借方')}</option><option value="credit">{text('Credit', '貸方')}</option></select>
          <div><AccountSelect chart={chartOrEmpty} value={line.accountId} label={text(`Line ${index + 1} account`, `行 ${index + 1} 科目`)} onChange={(accountId) => { const account = chartOrEmpty.accounts.find((item) => item.id === accountId); updateLine(index, { accountId, ...(line.taxCode === '' && account?.defaultTaxCode !== undefined ? { taxCode: account.defaultTaxCode } : {}) }); }} /><FieldError message={issueOf(`outcome.lines.${index}.accountId`)} /></div>
          <div><TaxSelect chart={chartOrEmpty} value={line.taxCode} label={text(`Line ${index + 1} tax`, `行 ${index + 1} 税区分`)} onChange={(taxCode) => updateLine(index, { taxCode })} /><FieldError message={issueOf(`outcome.lines.${index}.taxCode`)} /></div>
          <div>
            <select aria-label={text(`Line ${index + 1} amount`, `行 ${index + 1} 金額`)} value={spec.choice} onChange={(event) => updateLine(index, { amount: amountSpecFromChoice(event.target.value as AmountSpecChoice, spec.value) })}>{AMOUNT_SPEC_CHOICES.map((choice) => <option key={choice} value={choice}>{choice === 'fixed' ? text('Fixed amount', '固定額') : choice === 'ratio' ? text('Ratio', '按分率') : amountSpecLabel(choice, text)}</option>)}</select>
            {(spec.choice === 'fixed' || spec.choice === 'ratio') && <input aria-label={text(`Line ${index + 1} amount value`, `行 ${index + 1} 金額の値`)} value={spec.value} onChange={(event) => updateLine(index, { amount: amountSpecFromChoice(spec.choice, event.target.value) })} />}
            <FieldError message={issueOf(`outcome.lines.${index}.amount`)} />
          </div>
          {chartOrEmpty.dimensions.map((dimension) => <select key={dimension.id} aria-label={text(`Line ${index + 1} ${dimension.name}`, `行 ${index + 1} ${dimension.name}`)} value={line.dimensionValues?.[dimension.id] ?? ''} onChange={(event) => { const next = { ...line.dimensionValues }; if (event.target.value === '') delete next[dimension.id]; else next[dimension.id] = event.target.value; updateLine(index, { dimensionValues: Object.keys(next).length === 0 ? undefined : next }); }}>
            <option value="">{dimension.name}: —</option>
            {dimension.values.filter((value) => value.enabled).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
          </select>)}
          <select aria-label={text(`Line ${index + 1} partner`, `行 ${index + 1} 取引先`)} value={line.partnerFrom === undefined ? '' : typeof line.partnerFrom === 'string' ? line.partnerFrom : 'fixed'} onChange={(event) => updateLine(index, { partnerFrom: event.target.value === '' ? undefined : event.target.value === 'fixed' ? { fixed: '' } : event.target.value as 'issuerName' | 'counterpartyHint' })}>
            <option value="">{text('Partner: none', '取引先: なし')}</option><option value="issuerName">{text('Partner: issuer', '取引先: 発行者')}</option><option value="counterpartyHint">{text('Partner: counterparty hint', '取引先: 相手先')}</option><option value="fixed">{text('Partner: fixed', '取引先: 固定')}</option>
          </select>
          {typeof line.partnerFrom === 'object' && <input aria-label={text(`Line ${index + 1} fixed partner`, `行 ${index + 1} 固定取引先`)} value={line.partnerFrom.fixed} onChange={(event) => updateLine(index, { partnerFrom: { fixed: event.target.value } })} />}
          <button type="button" className="secondary danger" onClick={() => update({ outcome: { ...editor.outcome, lines: editor.outcome.lines.filter((_item, position) => position !== index) } })}>{text('Remove', '削除')}</button>
        </div>;
      })}
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => update({ outcome: { ...editor.outcome, lines: [...editor.outcome.lines, { side: editor.outcome.lines.some((line) => line.side === 'debit') ? 'credit' : 'debit', accountId: '', taxCode: '', amount: 'total' }] } })}>{text('Add line', '行を追加')}</button></div>

      <div className="journal-form-grid">
        <label>{text('Description template', '摘要テンプレート')}<input aria-label={text('Description template', '摘要テンプレート')} value={editor.outcome.descriptionTemplate ?? ''} placeholder="{issuerName} {description}" onChange={(event) => update({ outcome: { ...editor.outcome, ...(event.target.value === '' ? { descriptionTemplate: undefined } : { descriptionTemplate: event.target.value }) } })} /></label>
        <label>{text('Invoice status', 'インボイス区分')}<select aria-label={text('Invoice status', 'インボイス区分')} value={editor.outcome.invoiceStatus ?? 'auto'} onChange={(event) => update({ outcome: { ...editor.outcome, invoiceStatus: event.target.value as NonNullable<SaveJournalRuleDto['outcome']['invoiceStatus']> } })}>
          <option value="auto">{text('auto (from registration number and date)', '自動（登録番号と取引日から）')}</option><option value="qualified">{text('qualified', '適格')}</option><option value="transitional">{text('transitional', '経過措置')}</option><option value="none">{text('none', '控除なし')}</option><option value="not_required">{text('not required', '不要')}</option>
        </select></label>
        <label className="journal-span">{text('Required facts (comma separated fact paths)', '必要項目（facts のパス、カンマ区切り）')}<input aria-label={text('Required facts', '必要項目')} value={editor.requiredFacts.join(', ')} onChange={(event) => update({ requiredFacts: splitList(event.target.value) })} />
          {editor.requiredFacts.length > 0 && <span className="judge-chips">{editor.requiredFacts.map((fact) => <span key={fact} className="judge-chip">{fact}</span>)}</span>}</label>
      </div>

      <h3>{text('Ask if (extra question before deciding)', '確認質問（該当時は確定させず質問する）')}</h3>
      {editor.askIf.map((ask, index) => <div key={index} className="journal-askif-row">
        <input aria-label={text(`Question ${index + 1} id`, `質問 ${index + 1} ID`)} value={ask.questionId} placeholder="fixed_asset_check" onChange={(event) => update({ askIf: editor.askIf.map((item, position) => (position === index ? { ...item, questionId: event.target.value } : item)) })} />
        <input aria-label={text(`Question ${index + 1} prompt`, `質問 ${index + 1} 質問文`)} value={ask.prompt} placeholder={text('Is this a fixed asset?', '固定資産ですか？')} onChange={(event) => update({ askIf: editor.askIf.map((item, position) => (position === index ? { ...item, prompt: event.target.value } : item)) })} />
        <input aria-label={text(`Question ${index + 1} trigger`, `質問 ${index + 1} 条件`)} value={ask.conditions[0] === undefined ? '' : `${ask.conditions[0].field} ${ask.conditions[0].op} ${conditionValueToInput(ask.conditions[0].op, ask.conditions[0].value)}`} placeholder="grandTotal gte 100000" onChange={(event) => { const [field = '', op = 'gte', ...rest] = event.target.value.trim().split(/\s+/); const known = CONDITION_OPS.includes(op as JournalConditionOpDto) ? op as JournalConditionOpDto : 'gte'; update({ askIf: editor.askIf.map((item, position) => (position === index ? { ...item, conditions: field === '' ? [] : [{ field, op: known, value: conditionValueFromInput(known, rest.join(' ')) }] } : item)) }); }} />
        <button type="button" className="secondary danger" onClick={() => update({ askIf: editor.askIf.filter((_item, position) => position !== index) })}>{text('Remove', '削除')}</button>
        <FieldError message={issueOf(`askIf.${index}.questionId`) ?? issueOf(`askIf.${index}.prompt`)} />
      </div>)}
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => update({ askIf: [...editor.askIf, { conditions: [], questionId: '', prompt: '' }] })}>{text('Add question', '質問を追加')}</button></div>

      <div className="run-failure-actions journal-editor-actions">
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save rule', 'ルールを保存')}</button>
        <button type="button" className="secondary" aria-expanded={testOpen} onClick={() => setTestOpen((open) => !open)}>{text('Test against documents', '文書でテスト')}</button>
      </div>
      {feedback !== undefined && <InlineFeedback kind={feedback.kind}>{feedback.text}</InlineFeedback>}

      {testOpen && <div className="journal-test" role="region" aria-label={text('Rule test', 'ルールのテスト')}>
        {documentsError !== undefined && <p className="api-error" role="alert">{documentsError}</p>}
        {documents !== undefined && documents.length === 0 && <p className="empty-state">{text('No documents to test against.', 'テストに使える文書がありません。')}</p>}
        {documents !== undefined && documents.length > 0 && <div className="journal-test-pick">
          {documents.map((document) => <label key={document.id} className="journal-checkbox"><input type="checkbox" checked={testIds.includes(document.id)} onChange={(event) => setTestIds(event.target.checked ? [...testIds, document.id] : testIds.filter((id) => id !== document.id))} />{documentLabel(document)}</label>)}
        </div>}
        <div className="run-failure-actions"><button type="button" className="secondary" disabled={testing} onClick={() => void runTest()}>{testing ? text('Testing…', 'テスト中…') : text('Run test', 'テストを実行')}</button></div>
        {testError !== undefined && <p className="api-error" role="alert">{testError}</p>}
        {testResults !== undefined && <div className="table-wrap"><table className="journal-table" aria-label={text('Test results', 'テスト結果')}>
          <thead><tr><th>{text('Document', '文書')}</th><th>{text('Matched', '一致')}</th><th>{text('Entry / reasons', '仕訳 / 理由')}</th></tr></thead>
          <tbody>{testResults.map((result) => {
            const document = documents?.find((item) => item.id === result.documentId);
            return <tr key={result.documentId}>
              <td>{document === undefined ? result.documentId : documentLabel(document)}</td>
              <td>{result.matched ? text('Yes', '一致') : text('No', '不一致')}{result.specificity === undefined ? '' : ` (${result.specificity})`}</td>
              <td>{result.entry !== undefined && <ul className="journal-entry-lines">{result.entry.lines.map((line, index) => <li key={index}>{line.side === 'debit' ? text('Dr', '借') : text('Cr', '貸')} {line.accountName} {line.taxCode} {formatYen(line.amount)}</li>)}</ul>}
                {result.reasons !== undefined && result.reasons.length > 0 && <span className="judge-chips">{result.reasons.map((reason, index) => <span key={index} className="judge-chip uncertain">{localizeJournalReason(reason, text)}</span>)}</span>}</td>
            </tr>;
          })}</tbody>
        </table></div>}
      </div>}
    </section>
    <ConfirmDialog open={pendingDelete !== undefined} danger busy={deleting} title={text('Delete this rule?', 'このルールを削除しますか？')}
      message={pendingDelete === undefined ? '' : text(`Rule "${pendingDelete.name}" will be removed. Entries it already decided stay.`, `ルール「${pendingDelete.name}」を削除します。既に確定した仕訳は残ります。`)}
      confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} onConfirm={() => void remove()} onCancel={() => setPendingDelete(undefined)} />
  </div>;
}
