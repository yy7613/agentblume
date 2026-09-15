import { useCallback, useEffect, useState } from 'react';
import type { ContractApi } from '../api/contract-api';
import type {
  ClauseTopicDto, ConditionOpDto, ContractNatureDto, CriterionCheckDto, OurRoleDto, PaymentMethodDto, PlaybookCriterionDto, PlaybookDto,
  PlaybookSummaryDto, PlaybookTemplateDto, SavePlaybookDto, ValueKindDto,
} from '../api/contract-types';
import { useI18n } from '../i18n';
import { scope } from '../scope';
import {
  CONDITION_OPS, FIELD_PATHS, formatConditionValue, nextCriterionId, opTakesValue, parseConditionValue, playbookToSave,
  previewRecommendedText, roleLabel, textToTiers, tiersToText, unknownPlaceholders, VALUE_KINDS,
} from './contract-model';
import { ApiFailure, Field, LegalNotice } from './contract-shared';

type Tab = 'topics' | 'criteria' | 'legal' | 'stampDuty';
const PAYMENT_METHODS: readonly PaymentMethodDto[] = ['bank_transfer', 'promissory_note', 'electronic_record', 'factoring', 'cash', 'other'];
const NATURES: readonly ContractNatureDto[] = ['ukeoi', 'jun_inin', 'sale', 'nda', 'license', 'basic_transaction', 'other', 'unknown'];

/**
 * 審査基準（プレイブック）の一覧と編集（docs/23 §7.1）。基準・日数・税額表はすべて利用者が編集するデータ。
 * 0 件のときはテンプレートからの作成を案内する（開いただけでデータを作らない）。
 */
export function PlaybookStep({ api, focus, onChanged }: {
  readonly api: ContractApi;
  /** ディープリンク（基準 id / 'legal' / 'stampDuty'）。 */
  readonly focus?: { readonly playbookId?: string; readonly nodeId?: string; readonly seq: number };
  readonly onChanged: () => void;
}) {
  const { text } = useI18n();
  const [summaries, setSummaries] = useState<readonly PlaybookSummaryDto[]>([]);
  const [unsaved, setUnsaved] = useState(false);
  const [templates, setTemplates] = useState<readonly PlaybookTemplateDto[]>([]);
  const [draft, setDraft] = useState<SavePlaybookDto>();
  const [draftUnsaved, setDraftUnsaved] = useState(false);
  const [tab, setTab] = useState<Tab>('topics');
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [list, templateList] = await Promise.all([api.listPlaybooks(scope), api.listTemplates(scope)]);
      setSummaries(list.playbooks); setUnsaved(list.unsaved); setTemplates(templateList); setError(undefined);
    } catch (cause) { setError(cause); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const open = useCallback(async (id: string) => {
    try {
      const result = await api.getPlaybook(scope, id);
      setDraft(playbookToSave(result.playbook, result.unsaved)); setDraftUnsaved(result.unsaved); setSaved(undefined); setError(undefined);
    } catch (cause) { setError(cause); }
  }, [api]);

  useEffect(() => {
    if (focus === undefined) return;
    const id = focus.playbookId ?? summaries.find((entry) => entry.isDefault)?.id ?? summaries[0]?.id;
    if (id !== undefined) void open(id);
    if (focus.nodeId === 'legal' || focus.nodeId === 'stampDuty') setTab(focus.nodeId);
    else if (focus.nodeId !== undefined) setTab('criteria');
  }, [focus, summaries, open]);

  async function fromTemplate(templateId: string): Promise<void> {
    setBusy(true);
    try {
      const playbook = await api.createPlaybookFromTemplate(scope, { templateId, isDefault: summaries.length === 0 || unsaved });
      await reload(); setDraft(playbookToSave(playbook, false)); setDraftUnsaved(false); onChanged();
      setSaved(text('Created from the template. Edit it to fit your company.', 'テンプレートから作成しました。自社に合わせて編集してください。'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  async function save(): Promise<void> {
    if (draft === undefined) return;
    setBusy(true);
    try {
      const playbook: PlaybookDto = await api.savePlaybook(scope, draft);
      setDraft(playbookToSave(playbook, false)); setDraftUnsaved(false); await reload(); onChanged();
      setSaved(text('Saved. Reviews run from now on use these criteria.', '保存しました。以後のレビューはこの基準で判定します。')); setError(undefined);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }

  async function remove(id: string): Promise<void> {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(text('Delete this playbook? Past reviews keep their own copy.', 'この審査基準を削除しますか？ 過去のレビューは判定時の写しを持つので壊れません。'))) return;
    try { await api.deletePlaybook(scope, id); setDraft(undefined); await reload(); onChanged(); } catch (cause) { setError(cause); }
  }

  const update = (patch: Partial<SavePlaybookDto>) => setDraft((current) => current === undefined ? current : { ...current, ...patch });

  return <section className="contract-step contract-playbook" aria-label={text('Playbook', '審査基準')}>
    {error !== undefined && <ApiFailure cause={error} />}
    {saved !== undefined && <p className="contract-saved" role="status">{saved}</p>}
    {unsaved && <div className="empty-state">
      <p>{text('No playbook yet. Create one from a template to start with the common points of an outsourcing contract.', 'まだ審査基準がありません。テンプレートから作ると、業務委託契約の一般的な論点が入った状態で始められます。')}</p>
    </div>}
    <div className="contract-toolbar">
      {templates.map((template) => <button key={template.id} type="button" className="secondary" disabled={busy} title={template.description} onClick={() => void fromTemplate(template.id)}>{text(`Create from template: ${template.name}`, `テンプレートから作る: ${template.name}`)}</button>)}
    </div>
    <p className="contract-hint">{text('A vendor-side template is not bundled: create the client-side one, then flip the criteria (for example require a liability cap).', '受注者側のテンプレートは同梱していません。発注者側から作り、基準を反転してください（例: 損害賠償の上限があることを求める）。')}</p>
    <ul className="contract-list">
      {summaries.map((summary) => <li key={summary.id}>
        <button type="button" className="ghost" onClick={() => void open(summary.id)}>{summary.name}</button>
        {summary.isDefault && <span className="judge-chip">{text('Default', '既定')}</span>}
        {unsaved && <span className="judge-chip">{text('Template (not saved)', 'テンプレート（未保存）')}</span>}
        <small>{text(`${summary.topicCount} clause types · ${summary.criterionCount} criteria`, `条項 ${summary.topicCount} 種・基準 ${summary.criterionCount} 件`)}</small>
        {!unsaved && <button type="button" className="secondary danger" onClick={() => void remove(summary.id)}>{text('Delete', '削除')}</button>}
      </li>)}
    </ul>

    {draft !== undefined && <div className="workspace-card contract-editor">
      <div className="contract-form-row">
        <Field label={text('Name', '名前')}><input value={draft.name} onChange={(event) => update({ name: event.target.value })} /></Field>
        <Field label={text('Our role', '自社の立場')}>
          <select value={draft.ourRole} onChange={(event) => update({ ourRole: event.target.value as OurRoleDto })}>{(['client', 'vendor', 'mutual'] as const).map((role) => <option key={role} value={role}>{roleLabel(role, text)}</option>)}</select>
        </Field>
        <Field label={text('Our company names (one per line)', '自社名の表記ゆれ（1 行に 1 つ）')} hint={text('Matched against the parties in the preamble to decide whether we are party A or B.', '前文の当事者名と照らして、自社が甲か乙かを決めます。')}>
          <textarea rows={2} value={draft.ourCompanyNames.join('\n')} onChange={(event) => update({ ourCompanyNames: event.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== '') })} />
        </Field>
        <label className="contract-check"><input type="checkbox" checked={draft.isDefault} onChange={(event) => update({ isDefault: event.target.checked })} />{text('Default playbook', '既定の審査基準にする')}</label>
      </div>
      <div className="contract-tabs" role="tablist">
        {([['topics', text('Clause types', '条項の種類')], ['criteria', text('Criteria', '基準')], ['legal', text('Legal settings', '法令設定')], ['stampDuty', text('Stamp duty table', '印紙税表')]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'topics' && <TopicsEditor topics={draft.topics} onChange={(topics) => update({ topics })} />}
      {tab === 'criteria' && <CriteriaEditor topics={draft.topics} criteria={draft.criteria} paymentMaxDays={draft.legal.paymentMaxDays} focusId={focus?.nodeId} onChange={(criteria) => update({ criteria })} />}
      {tab === 'legal' && <LegalEditor draft={draft} onChange={(legal) => update({ legal })} />}
      {tab === 'stampDuty' && <StampDutyEditor draft={draft} onChange={(stampDuty) => update({ stampDuty })} />}
      <div className="run-failure-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{draftUnsaved ? text('Save this template as a playbook', 'このテンプレートを審査基準として保存') : text('Save', '保存')}</button>
      </div>
    </div>}
  </section>;
}

function TopicsEditor({ topics, onChange }: { readonly topics: readonly ClauseTopicDto[]; readonly onChange: (topics: readonly ClauseTopicDto[]) => void }) {
  const { text } = useI18n();
  const set = (index: number, patch: Partial<ClauseTopicDto>) => onChange(topics.map((topic, position) => position === index ? { ...topic, ...patch } : topic));
  return <div className="contract-topics">
    {topics.map((topic, index) => <fieldset key={index} className="contract-fieldset">
      <legend>{topic.label || topic.id}</legend>
      <div className="contract-form-row">
        <Field label="id"><input value={topic.id} onChange={(event) => set(index, { id: event.target.value })} /></Field>
        <Field label={text('Label', '表示名')}><input value={topic.label} onChange={(event) => set(index, { label: event.target.value })} /></Field>
        <Field label={text('Value type', '値の型')}><select value={topic.valueKind} onChange={(event) => set(index, { valueKind: event.target.value as ValueKindDto })}>{VALUE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></Field>
        <label className="contract-check"><input type="checkbox" checked={topic.enabled} onChange={(event) => set(index, { enabled: event.target.checked })} />{text('Enabled', '有効')}</label>
      </div>
      <Field label={text('Keywords (comma separated)', 'キーワード（カンマ区切り）')}><input value={topic.keywords.join(', ')} onChange={(event) => set(index, { keywords: event.target.value.split(',').map((word) => word.trim()).filter((word) => word !== '') })} /></Field>
      <Field label={text('Reading guidance for the AI', 'AI への読み取り指示')}><textarea rows={2} value={topic.guidance} onChange={(event) => set(index, { guidance: event.target.value })} /></Field>
      <button type="button" className="secondary danger" onClick={() => onChange(topics.filter((_, position) => position !== index))}>{text('Remove this clause type', 'この種類を削除')}</button>
    </fieldset>)}
    <button type="button" className="secondary" onClick={() => onChange([...topics, { id: `topic_${topics.length + 1}`, label: text('New clause type', '新しい条項'), valueKind: 'text', keywords: [], guidance: '', enabled: true, sortOrder: (topics.length + 1) * 10 }])}>{text('Add a clause type', '条項の種類を追加')}</button>
  </div>;
}

function CriteriaEditor({ topics, criteria, paymentMaxDays, focusId, onChange }: {
  readonly topics: readonly ClauseTopicDto[]; readonly criteria: readonly PlaybookCriterionDto[]; readonly paymentMaxDays: number; readonly focusId?: string;
  readonly onChange: (criteria: readonly PlaybookCriterionDto[]) => void;
}) {
  const { text } = useI18n();
  const set = (index: number, patch: Partial<PlaybookCriterionDto>) => onChange(criteria.map((criterion, position) => position === index ? { ...criterion, ...patch } : criterion));
  const checkFor = (type: CriterionCheckDto['type'], topic: ClauseTopicDto | undefined): CriterionCheckDto => {
    if (type === 'condition') return { type, conditions: [{ field: FIELD_PATHS[topic?.valueKind ?? 'text'][0] ?? 'present', op: 'exists' }] };
    if (type === 'legal') return { type, rule: 'payment-max-days' };
    if (type === 'llm') return { type, question: '', passWhen: 'yes' };
    return { type: 'required' };
  };
  return <div className="contract-criteria">
    {criteria.map((criterion, index) => {
      const topic = topics.find((entry) => entry.id === criterion.topicId);
      const unknown = unknownPlaceholders(criterion.recommendedText ?? '');
      const paths = ['present', ...FIELD_PATHS[topic?.valueKind ?? 'text']];
      return <fieldset key={index} className={`contract-fieldset${focusId === criterion.id ? ' focused' : ''}`} id={`criterion-${criterion.id}`}>
        <legend>{criterion.id}</legend>
        <div className="contract-form-row">
          <Field label={text('Clause type', '対象の条項')}><select value={criterion.topicId} onChange={(event) => set(index, { topicId: event.target.value })}>{topics.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></Field>
          <Field label={text('Check', '検査')}><select value={criterion.check.type} onChange={(event) => set(index, { check: checkFor(event.target.value as CriterionCheckDto['type'], topic) })}>
            <option value="required">{text('required (the clause must exist)', 'required（条項が必要）')}</option>
            <option value="condition">{text('condition (compare values)', 'condition（値を比べる）')}</option>
            <option value="legal">{text('legal (payment period / method)', 'legal（支払期日・支払手段）')}</option>
            <option value="llm">{text('AI yes/no question', 'AI の はい/いいえ 質問')}</option>
          </select></Field>
          <Field label={text('When it fails', '合わないとき')}><select value={criterion.onFail} onChange={(event) => set(index, { onFail: event.target.value as 'negotiate' | 'reject' })}><option value="negotiate">{text('negotiate', '要交渉')}</option><option value="reject">{text('reject', '不可')}</option></select></Field>
          <label className="contract-check"><input type="checkbox" checked={criterion.enabled} onChange={(event) => set(index, { enabled: event.target.checked })} />{text('Enabled', '有効')}</label>
        </div>
        {criterion.check.type === 'condition' && criterion.check.conditions.map((condition, conditionIndex) => {
          const check = criterion.check as Extract<CriterionCheckDto, { type: 'condition' }>;
          const setCondition = (patch: Partial<typeof condition>) => set(index, { check: { type: 'condition', conditions: check.conditions.map((entry, position) => position === conditionIndex ? { ...entry, ...patch } : entry) } });
          return <div key={conditionIndex} className="contract-form-row">
            <Field label={text('Field', '項目')}><select value={condition.field} onChange={(event) => setCondition({ field: event.target.value })}>{paths.map((path) => <option key={path} value={path}>{path}</option>)}</select></Field>
            <Field label={text('Operator', '演算子')}><select value={condition.op} onChange={(event) => { const op = event.target.value as ConditionOpDto; setCondition({ op, value: parseConditionValue(op, formatConditionValue(condition.value)) }); }}>{CONDITION_OPS.map((op) => <option key={op} value={op}>{op}</option>)}</select></Field>
            {opTakesValue(condition.op) && <Field label={text('Value', '値')}><input value={formatConditionValue(condition.value)} onChange={(event) => setCondition({ value: parseConditionValue(condition.op, event.target.value) })} /></Field>}
          </div>;
        })}
        {criterion.check.type === 'legal' && <Field label={text('Rule', '照合')}><select value={criterion.check.rule} onChange={(event) => set(index, { check: { type: 'legal', rule: event.target.value as 'payment-max-days' | 'prohibited-payment-method' } })}><option value="payment-max-days">{text('longest payment period', '支払期日の最長日数')}</option><option value="prohibited-payment-method">{text('prohibited payment method', '禁止された支払手段')}</option></select></Field>}
        {criterion.check.type === 'llm' && <div className="contract-form-row">
          <Field label={text('Question', '質問')}><input value={criterion.check.question} onChange={(event) => set(index, { check: { ...(criterion.check as Extract<CriterionCheckDto, { type: 'llm' }>), question: event.target.value } })} /></Field>
          <Field label={text('Passes when the answer is', '合格とする答え')}><select value={criterion.check.passWhen} onChange={(event) => set(index, { check: { ...(criterion.check as Extract<CriterionCheckDto, { type: 'llm' }>), passWhen: event.target.value as 'yes' | 'no' } })}><option value="yes">yes</option><option value="no">no</option></select></Field>
        </div>}
        <Field label={text('Internal rationale', '社内向けの理由')}><input value={criterion.rationale} onChange={(event) => set(index, { rationale: event.target.value })} /></Field>
        <Field label={text('Suggested wording', '推奨修正文案')} hint={text('Placeholders: {counterparty} {us} {paymentMaxDays} {articleRef}', '置換子: {counterparty} {us} {paymentMaxDays} {articleRef}')}>
          <textarea rows={2} value={criterion.recommendedText ?? ''} onChange={(event) => set(index, event.target.value === '' ? { recommendedText: undefined } : { recommendedText: event.target.value })} />
        </Field>
        {unknown.length > 0 && <p className="field-error" role="alert">{text(`Unknown placeholders: ${unknown.join(', ')}. Use {counterparty}, {us}, {paymentMaxDays} or {articleRef}.`, `未知の置換子があります: ${unknown.join('、')}。{counterparty} {us} {paymentMaxDays} {articleRef} を使ってください。`)}</p>}
        {criterion.recommendedText !== undefined && criterion.recommendedText !== '' && <p className="contract-preview"><small>{text('Preview', 'プレビュー')}:</small> {previewRecommendedText(criterion.recommendedText, { paymentMaxDays })}</p>}
        <button type="button" className="secondary danger" onClick={() => onChange(criteria.filter((_, position) => position !== index))}>{text('Remove this criterion', 'この基準を削除')}</button>
      </fieldset>;
    })}
    <button type="button" className="secondary" disabled={topics.length === 0} onClick={() => { const topicId = topics[0]!.id; onChange([...criteria, { id: nextCriterionId(criteria, topicId), topicId, check: { type: 'required' }, onFail: 'negotiate', rationale: '', enabled: true, sortOrder: (criteria.length + 1) * 10 }]); }}>{text('Add a criterion', '基準を追加')}</button>
  </div>;
}

function LegalEditor({ draft, onChange }: { readonly draft: SavePlaybookDto; readonly onChange: (legal: SavePlaybookDto['legal']) => void }) {
  const { text } = useI18n();
  const legal = draft.legal;
  const number = (key: 'paymentMaxDays' | 'freelancePaymentMaxDays' | 'freelanceRedelegationMaxDays' | 'dueSoonDays', label: string) =>
    <Field label={label}><input type="number" min={0} value={legal[key]} onChange={(event) => onChange({ ...legal, [key]: Number(event.target.value) })} /></Field>;
  return <div className="contract-legal">
    <LegalNotice />
    <p className="contract-hint">{text('These are initial values. Update them when the law changes (check the sources below).', '設定値は初期値です。改正時は下の出典で確かめて更新してください。')}</p>
    <div className="contract-form-row">
      {number('paymentMaxDays', text('Payment period limit (Toriteki Act, days from receipt)', '支払期日の上限（取適法。受領日から起算した日数）'))}
      {number('freelancePaymentMaxDays', text('Payment period limit (Freelance Act)', '支払期日の上限（フリーランス法）'))}
      {number('freelanceRedelegationMaxDays', text('Re-delegation limit (Freelance Act)', '再委託の場合の上限（フリーランス法）'))}
      {number('dueSoonDays', text('Days before a deadline counts as due soon', '期限が近いとする日数'))}
    </div>
    <fieldset className="contract-fieldset"><legend>{text('Prohibited payment methods', '禁止する支払手段')}</legend>
      {PAYMENT_METHODS.map((method) => <label key={method} className="contract-check"><input type="checkbox" checked={legal.prohibitedPaymentMethods.includes(method)} onChange={(event) => onChange({ ...legal, prohibitedPaymentMethods: event.target.checked ? [...legal.prohibitedPaymentMethods, method] : legal.prohibitedPaymentMethods.filter((entry) => entry !== method) })} />{method}</label>)}
    </fieldset>
    <label className="contract-check"><input type="checkbox" checked={legal.allowMonthEndNextMonthEnd} onChange={(event) => onChange({ ...legal, allowMonthEndNextMonthEnd: event.target.checked })} />{text('Treat month-end closing / next month-end payment as within 2 months', '月末締め翌月末払いは「受領後 2 か月以内」として超過にしない')}</label>
    <ul className="contract-sources">{legal.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></li>)}</ul>
  </div>;
}

function StampDutyEditor({ draft, onChange }: { readonly draft: SavePlaybookDto; readonly onChange: (stampDuty: SavePlaybookDto['stampDuty']) => void }) {
  const { text } = useI18n();
  const settings = draft.stampDuty;
  const setType = (index: number, patch: Partial<SavePlaybookDto['stampDuty']['documentTypes'][number]>) => onChange({ ...settings, documentTypes: settings.documentTypes.map((type, position) => position === index ? { ...type, ...patch } : type) });
  return <div className="contract-stamp">
    <p className="contract-hint">{text('This is an initial table. Check the latest tax table of the National Tax Agency and update it when the law changes. Electronic contracts are generally not taxable documents.', '税額表は初期値です。国税庁の最新の税額表で確かめ、改正時はここを更新してください。電子契約は課税文書の作成に当たらないとされます。')}</p>
    <label className="contract-check"><input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />{text('Show stamp duty candidates', '印紙税の候補を出す')}</label>
    {settings.documentTypes.map((type, index) => <fieldset key={index} className="contract-fieldset">
      <legend>{type.name}</legend>
      <div className="contract-form-row">
        <Field label={text('Code', 'コード')}><input value={type.code} onChange={(event) => setType(index, { code: event.target.value })} /></Field>
        <Field label={text('Name', '名前')}><input value={type.name} onChange={(event) => setType(index, { name: event.target.value })} /></Field>
        <Field label={text('Fixed amount (JPY)', '定額（円）')}><input type="number" value={type.fixedAmount ?? ''} onChange={(event) => setType(index, event.target.value === '' ? { fixedAmount: undefined } : { fixedAmount: Number(event.target.value) })} /></Field>
        <Field label={text('No amount stated (JPY)', '金額の記載なし（円）')}><input type="number" value={type.noAmountStated ?? ''} onChange={(event) => setType(index, event.target.value === '' ? { noAmountStated: undefined } : { noAmountStated: Number(event.target.value) })} /></Field>
      </div>
      <fieldset className="contract-fieldset"><legend>{text('Contract natures', '契約の性質')}</legend>
        {NATURES.map((nature) => <label key={nature} className="contract-check"><input type="checkbox" checked={type.natures.includes(nature)} onChange={(event) => setType(index, { natures: event.target.checked ? [...type.natures, nature] : type.natures.filter((entry) => entry !== nature) })} />{nature}</label>)}
      </fieldset>
      <Field label={text('Tiers: "up to,amount" per line ("-" for no upper bound)', '階層: 1 行に「この金額以下,税額」（上限なしは -）')}><textarea rows={4} value={tiersToText(type.tiers)} onChange={(event) => setType(index, event.target.value.trim() === '' ? { tiers: undefined } : { tiers: textToTiers(event.target.value) })} /></Field>
      <Field label={text('Note', '注記')}><input value={type.note} onChange={(event) => setType(index, { note: event.target.value })} /></Field>
      {type.sourceUrl !== '' && <a href={type.sourceUrl} target="_blank" rel="noreferrer">{text('Source', '出典')}</a>}
    </fieldset>)}
  </div>;
}
