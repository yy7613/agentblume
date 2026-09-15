import type { InvoiceDto } from '../api/receivables-types';
import { useI18n } from '../i18n';
import { formatYen, REDUCED_RATE_MARK } from './receivables-model';

/**
 * 印刷用レイアウト（docs/22 §8 / ADR-0041 決定 7）。A4 を想定し、`@media print` とブラウザの「PDF に保存」で出力する。
 * 適格請求書の記載事項を必ず載せる: 発行者名と登録番号・取引年月日・取引内容（8% の明細に ※ と注記）・
 * 税率ごとの対価の合計と税率・税率ごとの消費税額・宛名。発行時に凍結した写し（snapshot）から描く。
 */
export function InvoicePrintView({ invoice, onClose }: { readonly invoice: InvoiceDto; readonly onClose: () => void }) {
  const { text } = useI18n();
  const snapshot = invoice.snapshot;
  const transactionDate = invoice.transactionPeriod === undefined ? invoice.transactionDate : `${invoice.transactionPeriod.from} 〜 ${invoice.transactionPeriod.to}`;
  const hasReduced = invoice.lines.some((line) => line.taxRate === 8);
  return <div className="receivables-print" role="dialog" aria-label={text('Print preview', '印刷プレビュー')}>
    <div className="receivables-toolbar receivables-no-print">
      <button type="button" className="primary" onClick={() => window.print()}>{text('Print / Save as PDF', '印刷 / PDF に保存')}</button>
      <button type="button" className="secondary" onClick={onClose}>{text('Close', '閉じる')}</button>
    </div>
    <article className="receivables-print-sheet">
      <h1>請求書</h1>
      <div className="receivables-print-head">
        <div>
          <p className="receivables-print-recipient">{snapshot?.customer.name} {snapshot?.customer.honorific}</p>
          {snapshot?.customer.address !== undefined && <p>{snapshot.customer.address}</p>}
          <p>請求書番号: {invoice.number}</p>
          <p>発行日: {invoice.issueDate}</p>
          <p>取引年月日: {transactionDate}</p>
          {invoice.dueDate !== undefined && <p>お支払期限: {invoice.dueDate}</p>}
        </div>
        <div className="receivables-print-issuer">
          <p><strong>{snapshot?.issuer.name}</strong></p>
          {snapshot?.issuer.registered === true && snapshot.issuer.registrationNumber !== undefined && <p>登録番号: {snapshot.issuer.registrationNumber}</p>}
          {snapshot?.issuer.address !== undefined && <p>{snapshot.issuer.address}</p>}
          {snapshot?.issuer.tel !== undefined && <p>TEL: {snapshot.issuer.tel}</p>}
        </div>
      </div>
      <p className="receivables-print-total">ご請求金額 {formatYen(invoice.totals.grandTotal)}（税込）</p>
      <table className="receivables-table">
        <thead><tr><th>品名</th><th>数量</th><th>単価</th><th>金額</th><th>税率</th></tr></thead>
        <tbody>{invoice.lines.map((line, index) => <tr key={index}>
          <td>{line.description}{line.taxRate === 8 ? ` ${REDUCED_RATE_MARK}` : ''}</td>
          <td>{line.quantity === undefined ? '' : `${line.quantity}${line.unit ?? ''}`}</td>
          <td>{line.unitPrice === undefined ? '' : formatYen(line.unitPrice)}</td>
          <td>{formatYen(line.amount)}</td>
          <td>{line.taxRate === undefined ? '' : `${line.taxRate}%`}</td>
        </tr>)}</tbody>
      </table>
      {hasReduced && <p className="receivables-print-note">{REDUCED_RATE_MARK} は軽減税率（8%）対象</p>}
      <table className="receivables-table receivables-print-rates" aria-label="税率別内訳">
        <thead><tr><th>税率</th><th>{invoice.pricing === 'exclusive' ? '対象額（税抜）' : '対象額（税込）'}</th><th>消費税額</th></tr></thead>
        <tbody>{invoice.totals.byRate.map((entry) => <tr key={entry.rate}>
          <td>{entry.rate}%{entry.rate === 8 ? REDUCED_RATE_MARK : ''}</td>
          <td>{formatYen(invoice.pricing === 'exclusive' ? entry.taxable : entry.inclusive)}</td>
          <td>{formatYen(entry.tax)}</td>
        </tr>)}</tbody>
      </table>
      {(snapshot?.issuer.transferAccounts ?? []).length > 0 && <div className="receivables-print-bank">
        <p>お振込先</p>
        {snapshot!.issuer.transferAccounts.map((account, index) => <p key={index}>{account.bankName} {account.branchName} {account.accountType} {account.accountNumber} {account.holderKana}</p>)}
      </div>}
      {invoice.note !== undefined && <p>{invoice.note}</p>}
    </article>
  </div>;
}
