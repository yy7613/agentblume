import { useEffect, useState } from 'react';
import type { ExpenseApi } from '../api/expense-api';
import {
  EXPENSE_REASON_CODES, type ExpenseCapabilitiesDto, type ExpenseCategoryDto, type ExpensePolicyResultDto, type ExpensePreApprovalRuleDto, type ExpenseReasonCodeDto, type SaveExpensePolicyDto,
} from '../api/expense-types';
import type { JournalChartOfAccountsDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';
import { decodeCsvText, triggerDownload } from '../journal/journal-model';
import { useOpenInScreen, type OpenTarget } from '../navigation';
import { scope } from '../scope';
import {
  EXPENSE_PAYMENT_METHODS, EXPENSE_REASON_ADJUSTABLE, EXPENSE_REASON_DEFAULT_SEVERITY, accountKnown, amountFromInput, newCategory, newPreApprovalRule,
  paymentMethodLabel, policyBody, policyIssues, reasonTitle, severityLabel, splitNames, withOptional, withSeverityOverride,
} from './expense-model';
import { messageOf, useExpenseSlotEnvironment, type ExpenseFocusRequest } from './expense-shared';
import { PolicyApprovalRoutes, PolicyHearingPanel, PolicyMoneySettings, PolicyTransportSettings } from './expense-slots';

const ignoreOpen = (_target: OpenTarget): void => undefined;

/** 数値の入力欄。打ちかけの値（「1,」など）を消さないよう、表示用の文字列を自分で持つ。 */
function AmountInput({ value, onChange, label, id }: { readonly value: number | undefined; readonly onChange: (next: number | undefined) => void; readonly label: string; readonly id?: string }) {
  const [raw, setRaw] = useState(value === undefined || Number.isNaN(value) ? '' : String(value));
  useEffect(() => {
    const parsed = amountFromInput(raw);
    const same = parsed === value || (parsed !== undefined && value !== undefined && Number.isNaN(parsed) && Number.isNaN(value));
    if (!same) setRaw(value === undefined || Number.isNaN(value) ? '' : String(value));
    // raw は依存に入れない（打鍵ごとに値へ引き戻さないため）。
  }, [value]);
  return <input {...(id === undefined ? {} : { id })} inputMode="numeric" aria-label={label} value={raw} onChange={(event) => { setRaw(event.target.value); onChange(amountFromInput(event.target.value)); }} />;
}

/**
 * 規程タブ（docs/21 §5, §11）。未保存バナー、費目の表、申請ルール、事前承認条件、理由コードの重さ、仕訳設定、費目 CSV、初期テンプレートに戻す。
 * 規程は常にある（未保存なら初期テンプレート）ので空状態は無い。数値・費目名はすべてデータで、ここに固定値を持たない。
 *
 * 実用化の節（承認経路 A / 交通費 C / カード・仮払 B / 社内規程から案を作る C）はスロットで差し込み、下書きは同じ `draft` を編集する
 * （保存は「規程を保存」の 1 か所。`policyBody` が実用化の節を引き継ぐので、節を持たない保存でも系統の設定は消えない）。
 */
export function PolicyTab({ api, result, chart, chartError, onReloadChart, onPolicyChanged, onReloadPolicy, focus, capabilities, onOpen = ignoreOpen }: {
  readonly api: ExpenseApi;
  readonly result: ExpensePolicyResultDto | undefined;
  readonly chart: JournalChartOfAccountsDto | undefined;
  readonly chartError: string | undefined;
  readonly onReloadChart: () => Promise<void>;
  readonly onPolicyChanged: (next: ExpensePolicyResultDto) => void;
  readonly onReloadPolicy: () => Promise<void>;
  readonly focus: ExpenseFocusRequest | undefined;
  readonly capabilities?: ExpenseCapabilitiesDto | undefined;
  readonly onOpen?: (target: OpenTarget) => void;
}) {
  const { text } = useI18n();
  const openInScreen = useOpenInScreen();
  const slot = useExpenseSlotEnvironment();
  const [draft, setDraft] = useState<SaveExpensePolicyDto>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [exported, setExported] = useState<{ readonly fileName: string; readonly content: string; readonly downloaded: boolean }>();
  const [highlight, setHighlight] = useState<string>();

  useEffect(() => { if (result !== undefined) { setDraft(policyBody(result.policy)); setDirty(false); } }, [result]);

  // 理由カード・ディープリンクから来たら、その区画（費目の行・申請ルール・保存ボタン）へスクロールして印を付ける。
  useEffect(() => {
    if (focus === undefined || draft === undefined) return;
    const elementId = focus.section === 'category' && focus.id !== '' ? `expense-category-${focus.id}`
      : focus.section === 'pre-approval' && focus.id !== '' ? `expense-rule-${focus.id}`
        : `expense-policy-${focus.section}`;
    const element = document.getElementById(elementId) ?? document.getElementById(`expense-policy-${focus.section}`);
    setHighlight(element?.id);
    element?.scrollIntoView?.({ block: 'center' });
    if (element instanceof HTMLButtonElement) element.focus();
    // focus.seq の変化（と規程の読み込み完了）だけで動かす。
  }, [focus?.seq, draft === undefined]);

  if (result === undefined || draft === undefined) return <p className="empty-state" role="status">{text('Loading the policy…', '規程を読み込み中…')}</p>;

  const issues = policyIssues(draft);
  const issueAt = (path: string) => issues.find((issue) => issue.path === path);
  const issueClass = (path: string) => (issueAt(path) === undefined ? '' : 'expense-cell-issue');
  const accounts = chart?.accounts ?? [];
  const enabledAccounts = accounts.filter((account) => account.enabled);
  const update = (next: SaveExpensePolicyDto) => { setDraft(next); setDirty(true); setFeedback(undefined); };
  const updateCategory = (index: number, change: (category: ExpenseCategoryDto) => ExpenseCategoryDto) => update({ ...draft, categories: draft.categories.map((category, at) => (at === index ? change(category) : category)) });
  const updateRule = (index: number, change: (rule: ExpensePreApprovalRuleDto) => ExpensePreApprovalRuleDto) => update({ ...draft, preApprovalRules: draft.preApprovalRules.map((rule, at) => (at === index ? change(rule) : rule)) });
  const rowClass = (id: string) => (highlight === id ? 'expense-focused' : '');

  const save = async () => {
    if (issues.length > 0) return;
    setSaving(true);
    setError(undefined);
    try {
      const policy = await api.savePolicy(scope, draft);
      onPolicyChanged({ policy, saved: true });
      setFeedback(text('Saved. Check the claims again so the new policy applies.', '保存しました。新しい規程で判定するには、申請をもう一度チェックしてください。'));
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.resetPolicy(scope);
      await onReloadPolicy();
      setFeedback(text('The policy was reset to the initial template.', '規程を初期テンプレートに戻しました。'));
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
      setConfirmReset(false);
    }
  };

  const exportCsv = async () => {
    setError(undefined);
    try {
      const file = await api.exportPolicyCsv(scope);
      setExported({ ...file, downloaded: triggerDownload(file.fileName, file.content) });
    } catch (cause: unknown) {
      setError(messageOf(cause));
    }
  };

  const importCsv = async (file: File | undefined) => {
    if (file === undefined) return;
    setError(undefined);
    setSaving(true);
    try {
      const { content } = decodeCsvText(new Uint8Array(await file.arrayBuffer()));
      const policy = await api.importPolicyCsv(scope, content);
      onPolicyChanged({ policy, saved: true });
      setFeedback(text(`Imported the categories from "${file.name}". Claim rules, pre-approval rules, severities, and journal settings were kept.`, `「${file.name}」から費目を取り込みました。申請ルール・事前承認条件・重さ・仕訳設定はそのままです。`));
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const accountCell = (value: string | undefined, onChange: (next: string | undefined) => void, label: string) => {
    const known = accountKnown(value, accounts);
    return <>
      {chart === undefined
        ? <input aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value.trim() === '' ? undefined : event.target.value.trim())} />
        : <select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}>
          <option value="">{text('— no account —', '— 科目なし —')}</option>
          {!known && value !== undefined && <option value={value}>{text(`${value} (not in the chart)`, `${value}（マスタに無い）`)}</option>}
          {enabledAccounts.map((account) => <option key={account.id} value={account.id}>{account.code === undefined || account.code === '' ? account.name : `${account.code} ${account.name}`}</option>)}
        </select>}
      {chart !== undefined && !known && value !== undefined && <span className="expense-not-in-chart">
        {text('Not in the journal chart of accounts', '仕訳の科目マスタに無い')}{' '}
        <button type="button" className="screen-link" onClick={() => openInScreen('Journal', { internalId: value, section: 'account' })}>{text('Open accounts', '科目を開く')}</button>
      </span>}
    </>;
  };

  const adjustableCodes = EXPENSE_REASON_CODES.filter((code) => EXPENSE_REASON_ADJUSTABLE[code].length > 0);
  const sectionProps = { transport: slot.transport, scope: slot.scope, onOpen, draft, saved: result.saved, onChange: update, chart, focus };

  return <div className="expense-policy">
    {(!result.saved || dirty) && <div className="notice-card" role="note">
      <strong>{dirty ? text('You have unsaved changes', '保存していない変更があります') : text('Not saved yet', '未保存')}</strong>
      <p>{!result.saved
        ? text('This is still the initial template. Compare it with your company rules and save it. Until then, every check reports "policy not saved yet".', '初期テンプレートのままです。自社の規程と見比べて保存してください。保存するまで、チェックには「規程が未保存」が出ます。')
        : text('Save to apply the changes to the next check.', '保存すると次のチェックから反映されます。')}</p>
      <div className="run-failure-actions">
        <button id="expense-policy-save" type="button" className={`primary ${rowClass('expense-policy-save')}`} disabled={saving || issues.length > 0} onClick={() => void save()}>{saving ? text('Saving…', '保存中…') : text('Save policy', '規程を保存')}</button>
        {dirty && <button type="button" className="secondary" disabled={saving} onClick={() => { setDraft(policyBody(result.policy)); setDirty(false); }}>{text('Discard changes', '変更を破棄')}</button>}
      </div>
    </div>}
    {result.saved && !dirty && <div className="run-failure-actions"><button id="expense-policy-save" type="button" className="secondary" disabled>{text('Saved', '保存済み')}</button></div>}
    {issues.length > 0 && <div className="notice-card" role="alert">
      <strong>{text('Fix these before saving', '保存する前に直す箇所があります')}</strong>
      <ul>{issues.map((issue) => <li key={`${issue.path}-${issue.message[0]}`}><code>{issue.path}</code>: {text(issue.message[0], issue.message[1])}</li>)}</ul>
    </div>}
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    {error !== undefined && <p className="api-error" role="alert">{error}</p>}

    <PolicyHearingPanel transport={slot.transport} scope={slot.scope} onOpen={onOpen} policy={result.policy} dirty={dirty} capabilities={capabilities ?? slot.capabilities} onPolicySaved={onPolicyChanged} />

    <section id="expense-policy-category" className="workspace-card" aria-labelledby="expense-categories-heading">
      <div className="expense-row-between">
        <h2 id="expense-categories-heading">{text('Categories', '費目')}</h2>
        <div className="expense-actions">
          <button type="button" className="secondary" onClick={() => update({ ...draft, categories: [...draft.categories, newCategory(draft.categories)] })}>{text('Add a category', '費目を追加')}</button>
          <button type="button" className="secondary" onClick={() => void exportCsv()}>{text('Export categories CSV', '費目 CSV を出力')}</button>
          <label className="secondary">{text('Import categories CSV', '費目 CSV を取込')}
            <input type="file" accept=".csv,text/csv" disabled={saving} onChange={(event) => { void importCsv(event.target.files?.[0]); event.target.value = ''; }} />
          </label>
        </div>
      </div>
      <p className="empty-state">{text('Limits are your data; the initial values are only a starting point. Empty limits mean "no limit". Deleting is done by turning "enabled" off.', '上限はワークスペースのデータで、初期値は出発点にすぎません。空欄の上限は「上限なし」です。削除は「有効」を外して行います。')}</p>
      {chartError !== undefined && <div className="notice-card" role="status">
        <p>{text(`Could not load the journal chart of accounts, so accounts are entered as ids: ${chartError}`, `仕訳の科目マスタを読めなかったため、科目は id で入力します: ${chartError}`)}</p>
        <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => void onReloadChart()}>{text('Retry', '再試行')}</button></div>
      </div>}
      {exported !== undefined && !exported.downloaded && <label>{text('The download did not start. Copy the CSV below.', 'ダウンロードを開始できませんでした。下の CSV をコピーしてください。')}
        <textarea className="expense-textarea" readOnly aria-label={text('Categories CSV', '費目 CSV')} value={exported.content} />
      </label>}
      <div className="table-wrap"><table className="expense-policy-table">
        <thead><tr>
          <th>{text('Enabled', '有効')}</th><th>{text('Name / id', '名前 / id')}</th><th>{text('Account', '科目')}</th><th>{text('Tax rate', '税率')}</th>
          <th>{text('Receipt / registration no.', '領収書 / 登録番号')}</th><th>{text('Required', '必須')}</th><th>{text('Limits (yen)', '上限（円）')}</th><th>{text('Aliases', '別名')}</th>
        </tr></thead>
        <tbody>{draft.categories.map((category, index) => {
          const at = `categories.${index}`;
          const name = category.name === '' ? category.id : category.name;
          return <tr key={`${category.id}-${index}`} id={`expense-category-${category.id}`} className={rowClass(`expense-category-${category.id}`)}>
            <td><input type="checkbox" aria-label={text(`${name} enabled`, `${name} を有効にする`)} checked={category.enabled} onChange={(event) => updateCategory(index, (current) => ({ ...current, enabled: event.target.checked }))} /></td>
            <td className={issueClass(`${at}.name`)}>
              <input aria-label={text(`Name of ${category.id}`, `${category.id} の名前`)} value={category.name} onChange={(event) => updateCategory(index, (current) => ({ ...current, name: event.target.value }))} />
              <span className={issueClass(`${at}.id`)}><input aria-label={text(`Id of ${name}`, `${name} の id`)} value={category.id} onChange={(event) => updateCategory(index, (current) => ({ ...current, id: event.target.value }))} /></span>
            </td>
            <td>{accountCell(category.accountId, (next) => updateCategory(index, (current) => withOptional(current, 'accountId', next)), text(`Account of ${name}`, `${name} の科目`))}</td>
            <td><select aria-label={text(`Tax rate of ${name}`, `${name} の税率`)} value={category.defaultTaxRate} onChange={(event) => updateCategory(index, (current) => ({ ...current, defaultTaxRate: Number(event.target.value) as 10 | 8 | 0 }))}>
              <option value={10}>10%</option><option value={8}>8%</option><option value={0}>0%</option>
            </select></td>
            <td>
              <div className="expense-checks">
                <label><input type="checkbox" checked={category.receipt.required} onChange={(event) => updateCategory(index, (current) => ({ ...current, receipt: { ...current.receipt, required: event.target.checked } }))} />{text('Receipt', '領収書')}</label>
                <label><input type="checkbox" checked={category.invoice.required} onChange={(event) => updateCategory(index, (current) => ({ ...current, invoice: { ...current.invoice, required: event.target.checked } }))} />{text('Reg. no.', '登録番号')}</label>
              </div>
              <span className={issueClass(`${at}.receipt.exemptBelow`)}><AmountInput label={text(`Receipt not needed below (yen) for ${name}`, `${name} の領収書不要の金額（未満）`)} value={category.receipt.exemptBelow} onChange={(next) => updateCategory(index, (current) => ({ ...current, receipt: withOptional(current.receipt, 'exemptBelow', next) }))} /></span>
              <span className={issueClass(`${at}.invoice.exemptBelow`)}><AmountInput label={text(`Registration number not needed below (yen) for ${name}`, `${name} の登録番号不要の金額（未満）`)} value={category.invoice.exemptBelow} onChange={(next) => updateCategory(index, (current) => ({ ...current, invoice: withOptional(current.invoice, 'exemptBelow', next) }))} /></span>
            </td>
            <td className={issueClass(`${at}.requires.attendees`)}><div className="expense-checks">
              <label><input type="checkbox" checked={category.requires.purpose} onChange={(event) => updateCategory(index, (current) => ({ ...current, requires: { ...current.requires, purpose: event.target.checked } }))} />{text('Purpose', '目的')}</label>
              <label><input type="checkbox" aria-label={text(`${name} requires attendees`, `${name} は参加人数が必須`)} checked={category.requires.attendees} onChange={(event) => updateCategory(index, (current) => ({ ...current, requires: { ...current.requires, attendees: event.target.checked } }))} />{text('Attendees', '人数')}</label>
              <label><input type="checkbox" checked={category.requires.attendeeDetails} onChange={(event) => updateCategory(index, (current) => ({ ...current, requires: { ...current.requires, attendeeDetails: event.target.checked } }))} />{text('Attendee names', '参加者')}</label>
            </div></td>
            <td>
              <span className={issueClass(`${at}.limits.perItem`)}><AmountInput label={text(`Per-item limit of ${name}`, `${name} の 1 件上限`)} value={category.limits.perItem} onChange={(next) => updateCategory(index, (current) => ({ ...current, limits: withOptional(current.limits, 'perItem', next) }))} /></span>
              <span className={issueClass(`${at}.limits.perClaim`)}><AmountInput label={text(`Per-claim limit of ${name}`, `${name} の 1 申請上限`)} value={category.limits.perClaim} onChange={(next) => updateCategory(index, (current) => ({ ...current, limits: withOptional(current.limits, 'perClaim', next) }))} /></span>
              <span className={issueClass(`${at}.limits.perPerson`)}><AmountInput label={text(`Per-person limit of ${name}`, `${name} の 1 人あたり上限`)} value={category.limits.perPerson} onChange={(next) => updateCategory(index, (current) => ({ ...current, limits: withOptional(current.limits, 'perPerson', next) }))} /></span>
              <select aria-label={text(`Per-person basis of ${name}`, `${name} の 1 人あたりの基準`)} value={category.limits.perPersonBasis} onChange={(event) => updateCategory(index, (current) => ({ ...current, limits: { ...current.limits, perPersonBasis: event.target.value as 'tax-included' | 'tax-excluded' } }))}>
                <option value="tax-included">{text('tax included', '税込')}</option><option value="tax-excluded">{text('tax excluded', '税抜')}</option>
              </select>
              <span className={issueClass(`${at}.limits.perUnit.label`)}><input aria-label={text(`Unit of ${name} (day, night)`, `${name} の単位（日・泊）`)} value={category.limits.perUnit?.label ?? ''} onChange={(event) => updateCategory(index, (current) => ({ ...current, limits: withOptional(current.limits, 'perUnit', event.target.value === '' && current.limits.perUnit?.amount === undefined ? undefined : { label: event.target.value, amount: current.limits.perUnit?.amount ?? Number.NaN }) }))} /></span>
              <span className={issueClass(`${at}.limits.perUnit.amount`)}><AmountInput label={text(`Per-unit limit of ${name}`, `${name} の 1 単位あたり上限`)} value={category.limits.perUnit?.amount} onChange={(next) => updateCategory(index, (current) => ({ ...current, limits: withOptional(current.limits, 'perUnit', next === undefined && (current.limits.perUnit?.label ?? '') === '' ? undefined : { label: current.limits.perUnit?.label ?? '', amount: next ?? Number.NaN }) }))} /></span>
            </td>
            <td><input aria-label={text(`Aliases of ${name} (separate with ;)`, `${name} の別名（; 区切り）`)} value={category.aliases.join('; ')} onChange={(event) => updateCategory(index, (current) => ({ ...current, aliases: splitNames(event.target.value) }))} /></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>

    <section id="expense-policy-rules" className={`workspace-card ${rowClass('expense-policy-rules')}`} aria-labelledby="expense-rules-heading">
      <h2 id="expense-rules-heading">{text('Claim rules', '申請ルール')}</h2>
      <div className="expense-form">
        <label className={issueClass('claimRules.submissionDeadlineDays')}>{text('Submission deadline (days from the transaction date; empty = none)', '提出期限（取引日からの日数。空欄 = 期限なし）')}
          <AmountInput label={text('Submission deadline in days', '提出期限の日数')} value={draft.claimRules.submissionDeadlineDays} onChange={(next) => update({ ...draft, claimRules: withOptional(draft.claimRules, 'submissionDeadlineDays', next) })} />
        </label>
        <fieldset className="expense-wide"><legend>{text('Payment methods that are not reimbursable', '立替精算の対象外にする支払方法')}</legend>
          <div className="expense-checks">{EXPENSE_PAYMENT_METHODS.map((method) => <label key={method}>
            <input type="checkbox" checked={draft.claimRules.nonReimbursablePaymentMethods.includes(method)} onChange={(event) => update({ ...draft, claimRules: { ...draft.claimRules, nonReimbursablePaymentMethods: event.target.checked ? [...draft.claimRules.nonReimbursablePaymentMethods, method] : draft.claimRules.nonReimbursablePaymentMethods.filter((entry) => entry !== method) } })} />
            {paymentMethodLabel(method, text)}
          </label>)}</div>
        </fieldset>
        <label><span><input type="checkbox" checked={draft.claimRules.attendeesIncludeClaimant} onChange={(event) => update({ ...draft, claimRules: { ...draft.claimRules, attendeesIncludeClaimant: event.target.checked } })} /> {text('The entered head count includes the claimant', '入力された参加人数に申請者を含む')}</span></label>
        <label><span><input type="checkbox" checked={draft.claimRules.forbidSelfApproval} onChange={(event) => update({ ...draft, claimRules: { ...draft.claimRules, forbidSelfApproval: event.target.checked } })} /> {text('Forbid approving a claim you imported yourself', '自分で取り込んだ申請の承認を禁止する')}</span></label>
      </div>
      {!draft.claimRules.forbidSelfApproval && <p className="empty-state">{text('If several people use this workspace, turning this on is recommended (the person who enters a claim and the person who approves it should differ). It is off by default so a single local user can still approve.', '複数人で運用するなら、自己承認の禁止を on にすることを推奨します（入力する人と承認する人を分けるため）。1 人で使うと承認できなくなるので、初期値は off です。')}</p>}
    </section>

    <section id="expense-policy-pre-approval" className={`workspace-card ${rowClass('expense-policy-pre-approval')}`} aria-labelledby="expense-pre-approval-heading">
      <div className="expense-row-between">
        <h2 id="expense-pre-approval-heading">{text('Pre-approval rules', '事前承認条件')}</h2>
        <button type="button" className="secondary" onClick={() => update({ ...draft, preApprovalRules: [...draft.preApprovalRules, newPreApprovalRule(draft.preApprovalRules)] })}>{text('Add a rule', '条件を追加')}</button>
      </div>
      <p className="empty-state">{text('Conditions are combined with AND. No categories = all categories.', '条件は AND で組み合わせます。費目を選ばなければ全費目が対象です。')}</p>
      {draft.preApprovalRules.length === 0 ? <p className="empty-state">{text('No pre-approval rules.', '事前承認条件はありません。')}</p>
        : <div className="table-wrap"><table className="expense-policy-table">
          <thead><tr><th>{text('Enabled', '有効')}</th><th>{text('Name', '名前')}</th><th>{text('Categories', '費目')}</th><th>{text('From amount (yen)', '1 件の金額（以上）')}</th><th>{text('From per person (yen)', '1 人あたり（以上）')}</th><th /></tr></thead>
          <tbody>{draft.preApprovalRules.map((rule, index) => <tr key={`${rule.id}-${index}`} id={`expense-rule-${rule.id}`} className={rowClass(`expense-rule-${rule.id}`)}>
            <td><input type="checkbox" aria-label={text(`${rule.name || rule.id} enabled`, `${rule.name || rule.id} を有効にする`)} checked={rule.enabled} onChange={(event) => updateRule(index, (current) => ({ ...current, enabled: event.target.checked }))} /></td>
            <td className={issueClass(`preApprovalRules.${index}.name`)}><input aria-label={text(`Name of rule ${rule.id}`, `条件 ${rule.id} の名前`)} value={rule.name} onChange={(event) => updateRule(index, (current) => ({ ...current, name: event.target.value }))} /></td>
            <td className={issueClass(`preApprovalRules.${index}.categoryIds`)}><div className="expense-checks">{draft.categories.filter((category) => category.enabled || rule.categoryIds.includes(category.id)).map((category) => <label key={category.id}>
              <input type="checkbox" checked={rule.categoryIds.includes(category.id)} onChange={(event) => updateRule(index, (current) => ({ ...current, categoryIds: event.target.checked ? [...current.categoryIds, category.id] : current.categoryIds.filter((id) => id !== category.id) }))} />{category.name || category.id}
            </label>)}</div></td>
            <td className={issueClass(`preApprovalRules.${index}.minAmount`)}><AmountInput label={text(`Minimum amount of rule ${rule.id}`, `条件 ${rule.id} の金額`)} value={rule.minAmount} onChange={(next) => updateRule(index, (current) => withOptional(current, 'minAmount', next))} /></td>
            <td className={issueClass(`preApprovalRules.${index}.minPerPerson`)}><AmountInput label={text(`Minimum per person of rule ${rule.id}`, `条件 ${rule.id} の 1 人あたり金額`)} value={rule.minPerPerson} onChange={(next) => updateRule(index, (current) => withOptional(current, 'minPerPerson', next))} /></td>
            <td><button type="button" className="secondary danger" onClick={() => update({ ...draft, preApprovalRules: draft.preApprovalRules.filter((_, at) => at !== index) })}>{text('Remove', '削除')}</button></td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    {/* 導線 `approval`（承認者が決まらない理由・準備状況のカード）はこの id へスクロールする。 */}
    <div id="expense-policy-approval" className={rowClass('expense-policy-approval')}><PolicyApprovalRoutes {...sectionProps} /></div>

    <section className="workspace-card" aria-labelledby="expense-severity-heading">
      <h2 id="expense-severity-heading">{text('Severity of each reason', '理由ごとの重さ')}</h2>
      <p className="empty-state">{text('Only reasons whose severity can be changed are listed, and only the allowed choices are offered.', '重さを変えられる理由だけを並べ、選べる値だけを出しています。')}</p>
      <div className="table-wrap"><table>
        <thead><tr><th>{text('Reason', '理由')}</th><th>{text('Code', 'コード')}</th><th>{text('Severity', '重さ')}</th></tr></thead>
        <tbody>{adjustableCodes.map((code: ExpenseReasonCodeDto) => {
          const title = reasonTitle(code, text);
          return <tr key={code}>
            <td>{title}</td><td><code>{code}</code></td>
            <td><select aria-label={text(`Severity of ${title}`, `${title} の重さ`)} value={draft.severityOverrides[code] ?? ''} onChange={(event) => update({ ...draft, severityOverrides: withSeverityOverride(draft.severityOverrides, code, event.target.value as '' | 'review' | 'return' | 'off') })}>
              <option value="">{text(`Default (${severityLabel(EXPENSE_REASON_DEFAULT_SEVERITY[code], text)})`, `既定（${severityLabel(EXPENSE_REASON_DEFAULT_SEVERITY[code], text)}）`)}</option>
              {EXPENSE_REASON_ADJUSTABLE[code].map((value) => <option key={value} value={value}>{severityLabel(value, text)}</option>)}
            </select></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>

    <section id="expense-policy-journal" className={`workspace-card ${rowClass('expense-policy-journal')}`} aria-labelledby="expense-journal-heading">
      <h2 id="expense-journal-heading">{text('Journal drafts', '仕訳設定')}</h2>
      <div className="expense-form">
        <label className={issueClass('journal.creditAccountId')}>{text('Credit account', '貸方科目')}
          {accountCell(draft.journal.creditAccountId, (next) => update({ ...draft, journal: { ...draft.journal, creditAccountId: next ?? '' } }), text('Credit account', '貸方科目'))}
        </label>
        <label>{text('Credit tax category', '貸方の税区分')}
          {chart === undefined
            ? <input aria-label={text('Credit tax category', '貸方の税区分')} value={draft.journal.creditTaxCode} onChange={(event) => update({ ...draft, journal: { ...draft.journal, creditTaxCode: event.target.value } })} />
            : <select aria-label={text('Credit tax category', '貸方の税区分')} value={draft.journal.creditTaxCode} onChange={(event) => update({ ...draft, journal: { ...draft.journal, creditTaxCode: event.target.value } })}>
              {!chart.taxCategories.some((tax) => tax.enabled && tax.code === draft.journal.creditTaxCode) && <option value={draft.journal.creditTaxCode}>{text(`${draft.journal.creditTaxCode} (not in the chart)`, `${draft.journal.creditTaxCode}（マスタに無い）`)}</option>}
              {chart.taxCategories.filter((tax) => tax.enabled).map((tax) => <option key={tax.code} value={tax.code}>{tax.name} ({tax.code})</option>)}
            </select>}
        </label>
        <label>{text('Partner on the credit line', '貸方の取引先')}
          <select value={draft.journal.partnerFrom} onChange={(event) => update({ ...draft, journal: { ...draft.journal, partnerFrom: event.target.value as 'claimant' | 'payee' } })}>
            <option value="claimant">{text('Claimant', '申請者')}</option><option value="payee">{text('Payee', '支払先')}</option>
          </select>
        </label>
        <label className={`expense-wide ${issueClass('journal.descriptionTemplate')}`}>{text('Description template ({claimant} {payee} {category} {purpose} {description} {claimId})', '摘要のひな形（{claimant} {payee} {category} {purpose} {description} {claimId}）')}
          <input value={draft.journal.descriptionTemplate} onChange={(event) => update({ ...draft, journal: { ...draft.journal, descriptionTemplate: event.target.value } })} />
        </label>
      </div>
    </section>

    <PolicyTransportSettings {...sectionProps} />
    <PolicyMoneySettings {...sectionProps} />

    <section className="workspace-card" aria-labelledby="expense-reset-heading">
      <h2 id="expense-reset-heading">{text('Initial template', '初期テンプレート')}</h2>
      <p className="empty-state">{text('Replace the whole policy (categories, rules, severities, journal settings) with the initial template.', '規程全体（費目・ルール・重さ・仕訳設定）を初期テンプレートに置き換えます。')}</p>
      <button type="button" className="secondary danger" disabled={saving} onClick={() => setConfirmReset(true)}>{text('Reset to the initial template', '初期テンプレートに戻す')}</button>
    </section>
    <ConfirmDialog open={confirmReset} danger busy={saving}
      title={text('Reset the policy?', '規程を初期テンプレートに戻しますか？')}
      message={text('Your categories, limits, pre-approval rules, severities, and journal settings are replaced by the initial template. Claims checked with the current policy will need to be checked again.', '費目・上限・事前承認条件・重さ・仕訳設定が初期テンプレートに置き換わります。いまの規程でチェックした申請は再チェックが必要になります。')}
      confirmLabel={text('Reset', '戻す')} cancelLabel={text('Cancel', 'キャンセル')}
      onConfirm={() => void reset()} onCancel={() => setConfirmReset(false)} />
  </div>;
}
