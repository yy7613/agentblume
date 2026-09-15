import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { receivablesApi } from '../api/receivables-api';
import type { BankTransactionDto, CustomerDto, InvoiceDto, InvoiceSummaryDto, ReceivablesSettingsDto } from '../api/receivables-types';
import type { BusinessPageProps } from '../business/types';
import { BusinessStepper, type BusinessStep } from '../components/BusinessStepper';
import { useI18n } from '../i18n';
import { ScreenLink, usePendingOpen } from '../navigation';
import { scope } from '../scope';
import { BankImportStep } from './BankImportStep';
import { CustomersStep } from './CustomersStep';
import { InvoiceEditorStep, type InvoiceEditing } from './InvoiceEditorStep';
import { IssueStep } from './IssueStep';
import { JournalLinkStep } from './JournalLinkStep';
import { MatchingStep } from './MatchingStep';
import { initialStep, openReceivablesTarget, type MatchAction, type ReceivablesStep } from './receivables-model';
import { messageOf } from './receivables-shared';
import { SettingsDialog, type SettingsSection } from './SettingsDialog';
import './receivables.css';

interface Focus { readonly id: string; readonly section: string; readonly seq: number }

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 請求書発行と入金消込の画面（docs/22 §8）。手順: 取引先 → 請求書作成 → 発行 → 明細取込 → 消込 → 仕訳連携。右上に「設定」。
 *
 * 設定・取引先・請求書・入金明細はここで読み、各ステップへ配る（ステップのバッジと、消込の文言の取引先名・請求番号が同じ一覧を見るため）。
 * 最初に開くステップは状態で決める（設定未保存 → 取引先、未消込の入金がある → 消込、それ以外 → 請求書作成）。
 * 他画面からのディープリンクは `usePendingOpen('Receivables', …)`（section: customer / customer-aliases / invoice / transaction / matching / settings）。
 */
export function ReceivablesPage({ client }: BusinessPageProps) {
  const { text } = useI18n();
  const api = useMemo(() => receivablesApi(client), [client]);
  const [step, setStep] = useState<ReceivablesStep>();
  const [settings, setSettings] = useState<{ readonly settings: ReceivablesSettingsDto; readonly saved: boolean }>();
  const [customers, setCustomers] = useState<readonly CustomerDto[]>([]);
  const [invoices, setInvoices] = useState<readonly InvoiceSummaryDto[]>([]);
  const [transactions, setTransactions] = useState<readonly BankTransactionDto[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState<{ readonly section?: SettingsSection }>();
  const [focus, setFocus] = useState<Focus>();
  const [editing, setEditing] = useState<InvoiceEditing>();
  const seq = useRef(0);
  const next = () => { seq.current += 1; return seq.current; };

  const reloadCustomers = useCallback(async () => { setCustomers(await api.listCustomers(scope)); }, [api]);
  const reloadInvoices = useCallback(async () => { setInvoices(await api.listInvoices(scope)); }, [api]);
  const reloadTransactions = useCallback(async () => { setTransactions(await api.listTransactions(scope)); }, [api]);
  const reloadAll = useCallback(async () => {
    try {
      const [loadedSettings, loadedTransactions] = await Promise.all([api.getSettings(scope), api.listTransactions(scope), reloadCustomers(), reloadInvoices()]);
      setSettings(loadedSettings);
      setTransactions(loadedTransactions);
      setLoadError(undefined);
      setStep((current) => current ?? initialStep({ settingsSaved: loadedSettings.saved, unmatchedCount: loadedTransactions.filter((transaction) => transaction.status === 'unmatched').length }));
    } catch (cause: unknown) {
      setLoadError(messageOf(cause));
      setStep((current) => current ?? 'customers');
    }
  }, [api, reloadCustomers, reloadInvoices]);

  useEffect(() => { void reloadAll(); }, [reloadAll]);

  usePendingOpen('Receivables', (target) => {
    const resolved = openReceivablesTarget(target);
    if (resolved === undefined) return;
    if (resolved.section === 'settings') { setSettingsOpen({}); return; }
    setStep(resolved.step);
    setFocus({ id: resolved.id, section: resolved.section, seq: next() });
  });

  const openInvoiceEditor = (invoice?: InvoiceDto) => { setEditing({ ...(invoice === undefined ? {} : { id: invoice.id, invoice }), seq: next() }); setStep('invoice'); };
  const handleMatchAction = (action: MatchAction) => {
    switch (action.kind) {
      case 'new-invoice': openInvoiceEditor(); return;
      case 'open-invoice': setFocus({ id: action.invoiceId, section: 'invoice', seq: next() }); setStep('issue'); return;
      case 'open-customer': setFocus({ id: action.customerId, section: action.section, seq: next() }); setStep('customers'); return;
      case 'open-settings': setSettingsOpen({ section: action.section }); return;
      default: return;
    }
  };

  const drafts = invoices.filter((invoice) => invoice.status === 'draft').length;
  const unpaid = invoices.filter((invoice) => invoice.status === 'issued' || invoice.status === 'partially_paid').length;
  const unmatched = transactions.filter((transaction) => transaction.status === 'unmatched').length;
  const steps: readonly BusinessStep<ReceivablesStep>[] = [
    { id: 'customers', label: text('Customers', '取引先'), caption: text('Register recipients and payer names', '宛名と振込名義を登録する'), badge: text(`${customers.length}`, `${customers.length} 社`) },
    { id: 'invoice', label: text('Invoice', '請求書作成'), caption: text('Create a draft and check it', '下書きを作って検査する'), badge: text(`${drafts} drafts`, `下書き ${drafts}`) },
    { id: 'issue', label: text('Issue', '発行'), caption: text('Issue, print, void', '発行・印刷・取消'), badge: text(`${unpaid} unpaid`, `未入金 ${unpaid}`) },
    { id: 'import', label: text('Bank import', '明細取込'), caption: text('Import the bank CSV', '銀行明細 CSV を取り込む') },
    { id: 'matching', label: text('Matching', '消込'), caption: text('Match deposits to invoices', '入金を請求に消し込む'), badge: text(`${unmatched} pending`, `未消込 ${unmatched}`) },
    { id: 'journal', label: text('Journal link', '仕訳連携'), caption: text('Check the draft entries', '仕訳の下書きを確かめる') },
  ];

  return <main className="workspace-page receivables-page">
    <ScreenLink to="Templates" className="template-back">{text('← Business templates', '← 業務テンプレート')}</ScreenLink>
    <header className="workspace-header receivables-header"><div>
      <span className="eyebrow">{text('Business templates', '業務テンプレート')}</span>
      <h1>{text('Invoicing and receivables', '請求書発行と入金消込')}</h1>
      <p>{text('Issue qualified invoices, import bank statements, and match deposits to invoices. Confirmed matchings become draft journal entries.', '適格請求書を発行し、銀行明細を取り込んで入金を請求に消し込みます。確定した消込は仕訳の下書きになります。')}</p>
    </div>
      <button type="button" className="secondary" disabled={settings === undefined} onClick={() => setSettingsOpen({})}>{text('Settings', '設定')}</button>
    </header>
    {loadError !== undefined && <div className="notice-card" role="status">
      <strong>{text('Could not load part of this screen', 'この画面のデータを一部読み込めませんでした')}</strong>
      <p>{loadError}</p>
      <p>{text('Check that the API server is running (restart it if it was started before this feature), then retry.', 'API サーバーが動いているか確かめてください（この機能より前に起動したサーバーなら再起動が要ります）。そのうえで再試行してください。')}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => { void reloadAll(); }}>{text('Retry', '再試行')}</button></div>
    </div>}
    {step !== undefined && <BusinessStepper steps={steps} active={step} onSelect={setStep} label={text('Invoicing steps', '請求・入金消込の手順')} />}
    {step === 'customers' && <CustomersStep api={api} customers={customers} focus={focus?.section.startsWith('customer') === true ? focus : undefined} settingsSaved={settings?.saved} onChanged={reloadCustomers} onOpenSettings={() => setSettingsOpen({ section: 'issuer' })} />}
    {step === 'invoice' && <InvoiceEditorStep api={api} customers={customers} settings={settings?.settings} editing={editing} today={localToday()}
      onSaved={() => { void reloadInvoices(); }} onOpenSettings={(section) => setSettingsOpen({ section })} onOpenCustomers={() => setStep('customers')} />}
    {step === 'issue' && <IssueStep api={api} invoices={invoices} focus={focus?.section === 'invoice' ? focus : undefined} onChanged={async () => { await reloadInvoices(); await reloadCustomers(); }}
      onEdit={(invoice) => openInvoiceEditor(invoice)} onOpenSettings={(section) => setSettingsOpen({ section })} onGoToEditor={() => setStep('invoice')} />}
    {step === 'import' && <BankImportStep api={api} onImported={reloadTransactions} />}
    {step === 'matching' && <MatchingStep api={api} transactions={transactions} invoices={invoices} customers={customers}
      focus={focus?.section === 'transaction' || focus?.section === 'matching' ? focus : undefined}
      onChanged={async () => { await Promise.all([reloadTransactions(), reloadInvoices(), reloadCustomers()]); }} onAction={handleMatchAction} />}
    {step === 'journal' && <JournalLinkStep api={api} client={client} invoices={invoices} settings={settings?.settings} onOpenSettings={() => setSettingsOpen({ section: 'journal' })} />}
    {settingsOpen !== undefined && settings !== undefined && <SettingsDialog api={api} client={client} initial={settings.settings} invoices={invoices}
      {...(settingsOpen.section === undefined ? {} : { section: settingsOpen.section })}
      onClose={() => setSettingsOpen(undefined)} onSaved={(saved) => { setSettings({ settings: saved, saved: true }); setSettingsOpen(undefined); }} />}
  </main>;
}
