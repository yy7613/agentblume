import { useCallback, useEffect, useState } from 'react';
import type { ExpenseSummaryBasisDto, ExpenseSummaryGroupKeyDto, ExpenseSummaryQueryDto, ExpenseSummaryResultDto, ExpenseSummaryRowDto } from '../../api/expense-money-types';
import { EXPENSE_CLAIM_STATUSES, type ExpenseClaimStatusDto } from '../../api/expense-types';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { formatYen, triggerDownload } from '../../journal/journal-model';
import { claimStatusLabel, type Translate } from '../expense-model';
import { FieldError } from '../expense-shared';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import { MoneyErrorNotice, readMoneyError, useMoneyApi, type MoneyErrorInfo } from './money-shared';

export const SUMMARY_GROUP_KEYS: readonly ExpenseSummaryGroupKeyDto[] = ['month', 'department', 'category', 'claimant', 'status'];
export const SUMMARY_STATUSES: readonly ExpenseClaimStatusDto[] = EXPENSE_CLAIM_STATUSES;
const DEFAULT_STATUSES: readonly ExpenseClaimStatusDto[] = ['approved', 'settled'];
const SUMMARY_MAX_MONTHS = 36;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** YYYY-MM から n か月前（負なら後）。 */
export function shiftMonth(month: string, back: number): string {
  const [year = 0, mon = 1] = month.split('-').map(Number);
  const total = year * 12 + (mon - 1) - back;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** 両端を含む月数。 */
export function monthSpan(from: string, to: string): number {
  const [fy = 0, fm = 1] = from.split('-').map(Number);
  const [ty = 0, tm = 1] = to.split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm) + 1;
}

function groupLabel(key: ExpenseSummaryGroupKeyDto, text: Translate): string {
  switch (key) {
    case 'month': return text('Month', '月');
    case 'department': return text('Department', '部門');
    case 'category': return text('Category', '費目');
    case 'claimant': return text('Claimant', '申請者');
    case 'status': return text('Status', '状態');
  }
}

function groupValue(row: ExpenseSummaryRowDto, key: ExpenseSummaryGroupKeyDto, text: Translate): string {
  switch (key) {
    case 'month': return row.month ?? '—';
    case 'department': return row.department ?? row.departmentId ?? text('(no department)', '（部門なし）');
    case 'category': return row.category ?? row.categoryId ?? text('(no category)', '（費目なし）');
    case 'claimant': return row.claimant ?? row.employeeId ?? '—';
    case 'status': return row.status === null ? '—' : claimStatusLabel(row.status, text);
  }
}

function sameStatuses(left: readonly ExpenseClaimStatusDto[], right: readonly ExpenseClaimStatusDto[]): boolean {
  return left.length === right.length && left.every((status) => right.includes(status));
}

/**
 * 台帳「レポート」（docs/21 §20.10.1）。期間（月）・グループ・基準日・状態で集計した表と合計、CSV 出力。
 * 既定は今日を含む直近 12 か月・月 × 費目・承認済みと精算済み。0 件は失敗ではないので赤くせず、状態の選択を広げる導線を出す。
 */
export function ReportsLedger({ transport, scope, onOpen }: ExpenseLedgerSlotProps) {
  const { text } = useI18n();
  const api = useMoneyApi(transport);
  const thisMonth = monthOf(new Date());
  const [from, setFrom] = useState(shiftMonth(thisMonth, 11));
  const [to, setTo] = useState(thisMonth);
  const [groupBy, setGroupBy] = useState<readonly ExpenseSummaryGroupKeyDto[]>(['month', 'category']);
  const [basis, setBasis] = useState<ExpenseSummaryBasisDto>('transaction');
  const [statuses, setStatuses] = useState<readonly ExpenseClaimStatusDto[]>(DEFAULT_STATUSES);
  const [result, setResult] = useState<ExpenseSummaryResultDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoneyErrorInfo>();
  const [periodError, setPeriodError] = useState<string>();
  const [exported, setExported] = useState<{ readonly fileName: string; readonly content: string; readonly downloaded: boolean }>();

  const validPeriod = (query: Pick<ExpenseSummaryQueryDto, 'from' | 'to'>): boolean => {
    if (!/^\d{4}-\d{2}$/u.test(query.from) || !/^\d{4}-\d{2}$/u.test(query.to)) {
      setPeriodError(text('Choose both the start and end months.', '開始月と終了月を選んでください。'));
      return false;
    }
    if (query.from > query.to) {
      setPeriodError(text('The start month must not be after the end month.', '開始月は終了月より後にできません。'));
      return false;
    }
    if (monthSpan(query.from, query.to) > SUMMARY_MAX_MONTHS) {
      setPeriodError(text(`The period can be at most ${SUMMARY_MAX_MONTHS} months. Narrow it down.`, `期間は最長 ${SUMMARY_MAX_MONTHS} か月です。狭めてください。`));
      return false;
    }
    setPeriodError(undefined);
    return true;
  };

  const queryOf = (overrides: Partial<ExpenseSummaryQueryDto> = {}): ExpenseSummaryQueryDto => ({
    from, to, basis,
    groupBy: SUMMARY_GROUP_KEYS.filter((key) => groupBy.includes(key)),
    statuses: SUMMARY_STATUSES.filter((status) => statuses.includes(status)),
    ...overrides,
  });

  const summarize = useCallback(async (query: ExpenseSummaryQueryDto) => {
    if (!validPeriod(query)) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.getSummary(scope, query));
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
    // validPeriod は text にだけ依存する。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope]);

  // 開いたら既定の条件で一度集計する（読むだけ）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void summarize(queryOf()); }, [summarize]);

  const exportCsv = async () => {
    const query = queryOf();
    if (!validPeriod(query)) return;
    setBusy(true);
    setError(undefined);
    try {
      const file = await api.exportSummary(scope, query);
      setExported({ ...file, downloaded: triggerDownload(file.fileName, file.content) });
    } catch (cause: unknown) {
      setError(readMoneyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const widenStatuses = () => {
    setStatuses(SUMMARY_STATUSES);
    void summarize(queryOf({ statuses: SUMMARY_STATUSES }));
  };

  const toggle = <T,>(list: readonly T[], value: T, on: boolean): readonly T[] => (on ? [...list.filter((entry) => entry !== value), value] : list.filter((entry) => entry !== value));
  const shownKeys = result === undefined ? [] : SUMMARY_GROUP_KEYS.filter((key) => result.groupBy.includes(key));
  const resultDefault = result === undefined || result.statuses.length === 0 || sameStatuses(result.statuses, DEFAULT_STATUSES);
  const allStatuses = result !== undefined && sameStatuses(result.statuses, SUMMARY_STATUSES);

  return <div className="expense-money">
    <section className="workspace-card" aria-labelledby="expense-money-reports-heading">
      <h2 id="expense-money-reports-heading">{text('Reports', 'レポート')}</h2>
      <form className="expense-money-toolbar" onSubmit={(event) => { event.preventDefault(); void summarize(queryOf()); }}>
        <label>{text('From (month)', '開始月')}<input type="month" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>{text('To (month)', '終了月')}<input type="month" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>{text('Date basis', '基準日')}
          <select value={basis} onChange={(event) => setBasis(event.target.value as ExpenseSummaryBasisDto)}>
            <option value="transaction">{text('Transaction date', '取引日')}</option>
            <option value="approved">{text('Approval date', '承認日')}</option>
            <option value="settled">{text('Settlement date', '精算日')}</option>
          </select>
        </label>
        <fieldset className="expense-checks">
          <legend>{text('Group by', 'グループ')}</legend>
          {SUMMARY_GROUP_KEYS.map((key) => <label key={key}><input type="checkbox" checked={groupBy.includes(key)} onChange={(event) => setGroupBy(toggle(groupBy, key, event.target.checked))} />{groupLabel(key, text)}</label>)}
        </fieldset>
        <fieldset className="expense-checks">
          <legend>{text('Claim status', '申請の状態')}</legend>
          {SUMMARY_STATUSES.map((status) => <label key={status}><input type="checkbox" checked={statuses.includes(status)} onChange={(event) => setStatuses(toggle(statuses, status, event.target.checked))} />{claimStatusLabel(status, text)}</label>)}
        </fieldset>
        <div className="expense-actions">
          <button type="submit" className="primary" disabled={busy}>{text('Summarize', '集計')}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void exportCsv()}>{text('Download CSV', 'CSV を出力')}</button>
        </div>
      </form>
      <FieldError message={periodError} />
      {statuses.length === 0 && <p className="empty-state">{text('No status is selected, so approved and settled claims are counted.', '状態を選んでいないので、承認済みと精算済みを数えます。')}</p>}
      <MoneyErrorNotice error={error} onOpen={onOpen}>
        {error?.status === 400 && <p>{error.field === 'groupBy'
          ? text('Check the grouping choices, then summarize again.', 'グループの選択を確かめてから、もう一度集計してください。')
          : text('Check the period (months, start before end, at most 36 months) and the statuses, then summarize again.', '期間（月・開始が終了より前・最長 36 か月）と状態を確かめてから、もう一度集計してください。')}</p>}
      </MoneyErrorNotice>

      {result === undefined && error === undefined && busy && <p className="empty-state" role="status">{text('Summarizing…', '集計中…')}</p>}
      {result !== undefined && result.warnings.length > 0 && <div className="notice-card" role="note">
        <strong>{text('Warnings', '警告')}</strong>
        <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      </div>}
      {result !== undefined && result.rows.length === 0 && <div className="expense-empty">
        <p className="empty-state">{resultDefault
          ? text('There are no approved or settled claims in this period.', 'この期間の承認済み・精算済みの申請はありません')
          : text('There are no claims matching these conditions in this period.', 'この期間に条件に合う申請はありません')}</p>
        {!allStatuses && <button type="button" className="secondary" disabled={busy} onClick={widenStatuses}>{text('Include claims in every status', 'すべての状態の申請を含める')}</button>}
      </div>}
      {result !== undefined && result.rows.length > 0 && <div className="table-wrap"><table aria-label={text('Expense summary', '経費の集計')}>
        <thead><tr>
          {shownKeys.map((key) => <th key={key}>{groupLabel(key, text)}</th>)}
          <th>{text('Claims', '申請')}</th><th>{text('Items', '明細')}</th><th>{text('Amount', '金額')}</th><th>{text('Reimbursed', '立替の支払額')}</th><th>{text('Company-paid', '会社払い')}</th>
        </tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>
          {shownKeys.map((key) => <td key={key}>{groupValue(row, key, text)}</td>)}
          <td className="expense-money-amount">{row.claimCount}</td><td className="expense-money-amount">{row.itemCount}</td>
          <td className="expense-money-amount">{formatYen(row.amount)}</td><td className="expense-money-amount">{formatYen(row.reimbursableAmount)}</td><td className="expense-money-amount">{formatYen(row.corporateAmount)}</td>
        </tr>)}</tbody>
        <tfoot><tr className="expense-total">
          {shownKeys.length > 0 && <td colSpan={shownKeys.length}>{text('Total', '合計')}</td>}
          <td className="expense-money-amount">{result.totals.claimCount}</td><td className="expense-money-amount">{result.totals.itemCount}</td>
          <td className="expense-money-amount">{formatYen(result.totals.amount)}</td><td className="expense-money-amount">{formatYen(result.totals.reimbursableAmount)}</td><td className="expense-money-amount">{formatYen(result.totals.corporateAmount)}</td>
        </tr></tfoot>
      </table></div>}

      {exported !== undefined && <>
        <InlineFeedback kind="info">{text(`Created ${exported.fileName}.`, `${exported.fileName} を作成しました。`)}</InlineFeedback>
        {!exported.downloaded && <label>{text('The download did not start. Copy the CSV below.', 'ダウンロードを開始できませんでした。下の CSV をコピーしてください。')}
          <textarea className="expense-textarea" readOnly aria-label={text('Summary CSV content', '集計 CSV の内容')} value={exported.content} />
        </label>}
      </>}
    </section>
  </div>;
}
