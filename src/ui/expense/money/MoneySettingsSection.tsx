import { useEffect, useState } from 'react';
import type { ExpenseAdvancePolicySettingsDto, ExpenseCardPolicySettingsDto } from '../../api/expense-types';
import type { JournalChartOfAccountsDto } from '../../api/types';
import { useI18n } from '../../i18n';
import { FieldError } from '../expense-shared';
import type { ExpensePolicySectionSlotProps } from '../expense-slots';
import './money.css';

/** 規程に `card` が無いときの表示（サーバーの既定値と同じ）。 */
export const DEFAULT_CARD_POLICY: ExpenseCardPolicySettingsDto = {
  acceptCorporatePaymentItems: false, dateToleranceDays: 3, amountToleranceYen: 0, weakMatchMinAmount: 3000,
  creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA',
};

/** 規程に `advance` が無いときの表示（サーバーの既定値と同じ）。 */
export const DEFAULT_ADVANCE_POLICY: ExpenseAdvancePolicySettingsDto = {
  advanceAccountId: 'asset.suspense_paid', paymentAccountId: 'asset.ordinary_deposit', refundAccountId: 'asset.ordinary_deposit',
};

/** 整数の入力欄。範囲外・整数でない間は書き戻さず、欄の下に直し方を出す。`optional` なら空で undefined を返す。 */
function IntegerField({ label, value, min, max, optional = false, onCommit }: {
  readonly label: string;
  readonly value: number | undefined;
  readonly min: number;
  readonly max: number;
  readonly optional?: boolean;
  readonly onCommit: (next: number | undefined) => void;
}) {
  const { text } = useI18n();
  const [raw, setRaw] = useState(value === undefined ? '' : String(value));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setRaw((current) => (current.trim() === '' && value === undefined) || Number(current) === value ? current : value === undefined ? '' : String(value));
  }, [value]);
  const change = (next: string) => {
    setRaw(next);
    if (next.trim() === '' && optional) { setError(undefined); onCommit(undefined); return; }
    const parsed = Number(next);
    if (next.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      setError(text(`Enter a whole number from ${min} to ${max.toLocaleString('en-US')}.`, `${min}〜${max.toLocaleString('en-US')} の整数で入力してください。`));
      return;
    }
    setError(undefined);
    onCommit(parsed);
  };
  return <label>{label}
    <input inputMode="numeric" aria-label={label} value={raw} onChange={(event) => change(event.target.value)} />
    <FieldError message={error} />
  </label>;
}

function AccountField({ label, value, chart, onChange }: {
  readonly label: string;
  readonly value: string;
  readonly chart: JournalChartOfAccountsDto | undefined;
  readonly onChange: (next: string) => void;
}) {
  const { text } = useI18n();
  if (chart === undefined) return <label>{label}<input aria-label={label} value={value} onChange={(event) => onChange(event.target.value.trim())} /></label>;
  const accounts = chart.accounts.filter((account) => account.enabled);
  const known = accounts.some((account) => account.id === value);
  return <label>{label}
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {!known && <option value={value}>{text(`${value} (not in the chart)`, `${value}（マスタに無い）`)}</option>}
      {accounts.map((account) => <option key={account.id} value={account.id}>{account.code === undefined || account.code === '' ? account.name : `${account.code} ${account.name}`}</option>)}
    </select>
    {!known && <small className="expense-not-in-chart">{text('Not in the journal chart of accounts', '仕訳の科目マスタに無い')}</small>}
  </label>;
}

/**
 * 規程タブの「カード・仮払」節（docs/21 §20.10.1）。`draft.card` / `draft.advance` を編集して `onChange` で下書きを差し替える。
 * 保存は規程タブの「規程を保存」でまとめて行う（ここに保存ボタンは置かない）。未設定の節は既定値で表示し、変えたときに書く。
 */
export function MoneySettingsSection({ draft, onChange, chart }: ExpensePolicySectionSlotProps) {
  const { text } = useI18n();
  const card = draft.card ?? DEFAULT_CARD_POLICY;
  const advance = draft.advance ?? DEFAULT_ADVANCE_POLICY;
  const updateCard = (next: ExpenseCardPolicySettingsDto) => onChange({ ...draft, card: next, advance });
  const updateAdvance = (next: ExpenseAdvancePolicySettingsDto) => onChange({ ...draft, card, advance: next });
  const taxes = chart?.taxCategories.filter((tax) => tax.enabled) ?? [];
  const taxKnown = taxes.some((tax) => tax.code === card.creditTaxCode);

  return <section id="expense-policy-money" className="workspace-card" aria-labelledby="expense-money-settings-heading">
    <h2 id="expense-money-settings-heading">{text('Corporate cards and advances', 'カード・仮払')}</h2>
    {(draft.card === undefined || draft.advance === undefined) && <p className="empty-state">{text('Showing the default values. They are written into the policy when you change them.', '既定値を表示しています。変更すると規程に書き込みます。')}</p>}

    <h3>{text('Corporate card matching', '法人カードの照合')}</h3>
    <div className="expense-form">
      <label className="expense-wide">
        <span><input type="checkbox" checked={card.acceptCorporatePaymentItems} onChange={(event) => updateCard({ ...card, acceptCorporatePaymentItems: event.target.checked })} />{' '}
          {text('Include company-paid card items in claims (they are not reimbursed)', '会社払いの明細を申請に含める（立替の支払額には入れない）')}</span>
      </label>
      <IntegerField label={text('Date tolerance (days, 0–10)', '日付の許容日数（0〜10）')} value={card.dateToleranceDays} min={0} max={10} onCommit={(next) => updateCard({ ...card, dateToleranceDays: next ?? 0 })} />
      <IntegerField label={text('Amount tolerance (yen, 0–1,000)', '金額の許容差（円、0〜1,000）')} value={card.amountToleranceYen} min={0} max={1000} onCommit={(next) => updateCard({ ...card, amountToleranceYen: next ?? 0 })} />
      <IntegerField label={text('Minimum amount for a weak match (yen)', '弱い一致の最低金額（円）')} value={card.weakMatchMinAmount} min={1} max={1_000_000} onCommit={(next) => updateCard({ ...card, weakMatchMinAmount: next ?? 1 })} />
      <AccountField label={text('Credit account for company-paid items', '会社払いの貸方科目')} value={card.creditAccountId} chart={chart} onChange={(next) => updateCard({ ...card, creditAccountId: next })} />
      {chart === undefined
        ? <label>{text('Tax category for company-paid items', '会社払いの貸方の税区分')}<input aria-label={text('Tax category for company-paid items', '会社払いの貸方の税区分')} value={card.creditTaxCode} onChange={(event) => updateCard({ ...card, creditTaxCode: event.target.value.trim() })} /></label>
        : <label>{text('Tax category for company-paid items', '会社払いの貸方の税区分')}
          <select aria-label={text('Tax category for company-paid items', '会社払いの貸方の税区分')} value={card.creditTaxCode} onChange={(event) => updateCard({ ...card, creditTaxCode: event.target.value })}>
            {!taxKnown && <option value={card.creditTaxCode}>{text(`${card.creditTaxCode} (not in the chart)`, `${card.creditTaxCode}（マスタに無い）`)}</option>}
            {taxes.map((tax) => <option key={tax.code} value={tax.code}>{tax.name} ({tax.code})</option>)}
          </select>
        </label>}
    </div>

    <h3>{text('Advances', '仮払')}</h3>
    <div className="expense-form">
      <AccountField label={text('Advance account', '仮払金の科目')} value={advance.advanceAccountId} chart={chart} onChange={(next) => updateAdvance({ ...advance, advanceAccountId: next })} />
      <AccountField label={text('Payment account', '支払の科目')} value={advance.paymentAccountId} chart={chart} onChange={(next) => updateAdvance({ ...advance, paymentAccountId: next })} />
      <AccountField label={text('Refund account', '返金の科目')} value={advance.refundAccountId} chart={chart} onChange={(next) => updateAdvance({ ...advance, refundAccountId: next })} />
      <IntegerField label={text('Settle within (days after payment, optional)', '精算の目安日数（支払から。任意）')} value={advance.settleWithinDays} min={1} max={365} optional
        onCommit={(next) => {
          const { settleWithinDays: _omit, ...rest } = advance;
          updateAdvance(next === undefined ? rest : { ...rest, settleWithinDays: next });
        }} />
    </div>
  </section>;
}
