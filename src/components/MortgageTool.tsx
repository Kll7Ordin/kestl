import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import {
  getMortgageConfig,
  setMortgageConfig,
  getMortgageLedger,
  addMortgageLedgerEntry,
  deleteMortgageLedgerEntry,
  getData,
  subscribe,
  type MortgageConfig,
  type MortgageLedgerEntry,
  type PrepayFrequency,
} from '../db';
import { SearchableSelect } from './SearchableSelect';
import { DateInput } from './DateInput';
import { formatAmount } from '../utils/format';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const MORTGAGE_TAB_KEY = 'budget-app-show-mortgage-tab';

// ── Currency input — shows comma-formatted value when blurred ─────────────────

function CurrencyInput({ value, onChange, placeholder, style, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const displayValue = focused ? value : (value && !isNaN(Number(value)) ? Number(value).toLocaleString('en-US') : value);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={displayValue}
      placeholder={placeholder}
      autoFocus={autoFocus}
      style={style}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value.replace(/,/g, ''))}
    />
  );
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function periodRate(annualRate: number, freq: MortgageConfig['paymentFrequency']): number {
  const periods = freq === 'monthly' ? 12 : freq === 'biweekly' ? 26 : 24;
  return Math.pow(1 + annualRate / 2, 2 / periods) - 1;
}

function addPaymentPeriods(date: Date, freq: MortgageConfig['paymentFrequency'], n: number): Date {
  const d = new Date(date);
  if (freq === 'monthly') {
    d.setMonth(d.getMonth() + n);
  } else if (freq === 'biweekly') {
    d.setDate(d.getDate() + n * 14);
  } else {
    for (let i = 0; i < n; i++) {
      if (d.getDate() < 15) d.setDate(15);
      else { d.setMonth(d.getMonth() + 1); d.setDate(1); }
    }
  }
  return d;
}

// Convert prepay amount to equivalent per-payment-period amount
function prepayPerPeriod(
  prepayAmount: number,
  prepayFreq: PrepayFrequency,
  payFreq: MortgageConfig['paymentFrequency'],
): number {
  const payPeriods = payFreq === 'monthly' ? 12 : payFreq === 'biweekly' ? 26 : 24;
  const prepayPerYear =
    prepayFreq === 'monthly' ? 12
    : prepayFreq === 'biweekly' ? 26
    : prepayFreq === 'semi-monthly' ? 24
    : prepayFreq === 'annually' ? 1
    : 2; // semi-annually
  return (prepayAmount * prepayPerYear) / payPeriods;
}

// Calculate payment for a given balance, rate, freq, and remaining periods
function calcPayment(balance: number, annualRate: number, freq: MortgageConfig['paymentFrequency'], periods: number): number {
  const r = periodRate(annualRate, freq);
  if (r === 0 || periods <= 0) return balance / Math.max(periods, 1);
  return balance * r / (1 - Math.pow(1 + r, -periods));
}

interface ProjectionPoint {
  date: Date;
  balance: number;
  interest: number;
  principal: number;
}

function projectMortgage(
  balance: number,
  annualRate: number,
  freq: MortgageConfig['paymentFrequency'],
  payment: number,
  extraPerPeriod: number,
  startDate: Date,
  maxYears = 40,
): ProjectionPoint[] {
  const r = periodRate(annualRate, freq);
  const points: ProjectionPoint[] = [{ date: new Date(startDate), balance, interest: 0, principal: 0 }];
  let bal = balance;
  let date = new Date(startDate);
  const maxPeriods = maxYears * (freq === 'monthly' ? 12 : freq === 'biweekly' ? 26 : 24);

  for (let i = 0; i < maxPeriods && bal > 0.01; i++) {
    const interest = bal * r;
    const principalFromPayment = Math.min(payment - interest, bal);
    if (principalFromPayment <= 0) break;
    const totalPrincipal = Math.min(principalFromPayment + extraPerPeriod, bal);
    bal = Math.max(0, bal - totalPrincipal);
    date = addPaymentPeriods(date, freq, 1);
    points.push({ date: new Date(date), balance: bal, interest, principal: totalPrincipal });
  }
  return points;
}

function freqLabel(f: MortgageConfig['paymentFrequency'] | PrepayFrequency): string {
  switch (f) {
    case 'monthly': return 'Monthly';
    case 'biweekly': return 'Bi-weekly';
    case 'semi-monthly': return 'Semi-monthly';
    case 'annually': return 'Annually';
    case 'semi-annually': return 'Semi-annually';
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  onShowMortgageTabChange?: (show: boolean) => void;
}

type InternalTab = 'overview' | 'simulate' | 'ledger' | 'setup';

export function MortgageTool({ onShowMortgageTabChange }: Props) {
  const [config, setConfigState] = useState<MortgageConfig | null>(() => getMortgageConfig());
  const [ledger, setLedger] = useState<MortgageLedgerEntry[]>(() => getMortgageLedger());
  const [internalTab, setInternalTab] = useState<InternalTab>(
    getMortgageConfig() ? 'overview' : 'setup',
  );
  const [showMortgageTab, setShowMortgageTab] = useState(
    () => localStorage.getItem(MORTGAGE_TAB_KEY) === 'true',
  );

  // ── Setup form ──────────────────────────────────────────────────────────────
  const [setupBalance, setSetupBalance] = useState(() => String(getMortgageConfig()?.outstandingBalance ?? ''));
  const [setupBalanceDate, setSetupBalanceDate] = useState(() => getMortgageConfig()?.lastBalanceDate ?? new Date().toISOString().split('T')[0]);
  const [setupOriginal, setSetupOriginal] = useState(() => String(getMortgageConfig()?.originalAmount ?? ''));
  const [setupStartDate, setSetupStartDate] = useState(() => getMortgageConfig()?.startDate ?? '');
  const [setupRate, setSetupRate] = useState(() =>
    getMortgageConfig() ? String((getMortgageConfig()!.annualRate * 100).toFixed(3)) : '',
  );
  const [setupFreq, setSetupFreq] = useState<MortgageConfig['paymentFrequency']>(
    () => getMortgageConfig()?.paymentFrequency ?? 'monthly',
  );
  const [setupPayment, setSetupPayment] = useState(() => String(getMortgageConfig()?.regularPayment ?? ''));
  const [setupType, setSetupType] = useState<'variable' | 'fixed'>(
    () => getMortgageConfig()?.mortgageType ?? 'variable',
  );
  const [setupMaturityDate, setSetupMaturityDate] = useState(() => getMortgageConfig()?.maturityDate ?? '');
  const [setupRateChangeBehavior, setSetupRateChangeBehavior] = useState<MortgageConfig['rateChangeBehavior']>(
    () => getMortgageConfig()?.rateChangeBehavior ?? 'change_payment',
  );
  const [setupPaymentCatId, setSetupPaymentCatId] = useState<number | null>(
    () => getMortgageConfig()?.paymentCategoryId ?? null,
  );
  const [setupPrepaymentCatId, setSetupPrepaymentCatId] = useState<number | null>(
    () => getMortgageConfig()?.prepaymentCategoryId ?? null,
  );
  const [setupPrepayAmount, setSetupPrepayAmount] = useState(() =>
    getMortgageConfig()?.prepayAmount != null ? String(getMortgageConfig()!.prepayAmount) : '',
  );
  const [setupPrepayFreq, setSetupPrepayFreq] = useState<PrepayFrequency>(
    () => getMortgageConfig()?.prepayFrequency ?? 'monthly',
  );
  const [setupAttempted, setSetupAttempted] = useState(false);
  const [paymentAutoFilledFrom, setPaymentAutoFilledFrom] = useState<number | null>(
    () => getMortgageConfig()?.paymentCategoryId ?? null,
  );

  // ── Simulation ──────────────────────────────────────────────────────────────
  const [simPaymentFreq, setSimPaymentFreq] = useState<MortgageConfig['paymentFrequency']>(
    () => getMortgageConfig()?.paymentFrequency ?? 'monthly',
  );
  const [simPrepayment, setSimPrepayment] = useState('');
  const [simRate, setSimRate] = useState('');
  const [simRateChangeBehavior, setSimRateChangeBehavior] = useState<MortgageConfig['rateChangeBehavior']>(
    () => getMortgageConfig()?.rateChangeBehavior ?? 'change_payment',
  );
  const [simRegularPrepay, setSimRegularPrepay] = useState('');
  const [simRegularPrepayFreq, setSimRegularPrepayFreq] = useState<PrepayFrequency>('monthly');
  const simRegularPrepayInitialized = useRef(false);

  // ── Balance update ──────────────────────────────────────────────────────────
  const [newBalance, setNewBalance] = useState('');
  const [newBalanceDate, setNewBalanceDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [updatingBalance, setUpdatingBalance] = useState(false);

  // ── Ledger ──────────────────────────────────────────────────────────────────
  const [addingEntry, setAddingEntry] = useState<'payment' | 'prepayment' | null>(null);
  const [newEntryDate, setNewEntryDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [newEntryAmount, setNewEntryAmount] = useState('');
  const [newEntryNotes, setNewEntryNotes] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [importStatus, setImportStatus] = useState<{ imported: number } | null>(null);

  // ── Data loading ─────────────────────────────────────────────────────────
  const refreshLedger = useCallback(() => {
    setLedger(getMortgageLedger());
  }, []);
  useEffect(() => subscribe(refreshLedger), [refreshLedger]);

  // ── Category options ─────────────────────────────────────────────────────
  const categoryOptions = useMemo(() => {
    const { categories } = getData();
    return categories.map((c) => ({ value: String(c.id), label: c.name }));
  }, []);

  // Auto-guess mortgage payment category
  const guessedCategoryId = useMemo(() => {
    if (setupPaymentCatId) return setupPaymentCatId;
    const { categories } = getData();
    const match = categories.find((c) =>
      /mortgage|home loan|housing/i.test(c.name),
    );
    return match?.id ?? null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!config && guessedCategoryId && !setupPaymentCatId) {
      setSetupPaymentCatId(guessedCategoryId);
    }
  }, [config, guessedCategoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Infer payment details from category transactions ─────────────────────
  const inferredPayment = useMemo(() => {
    if (!setupPaymentCatId) return null;
    const { transactions } = getData();
    const catTxns = transactions
      .filter((t) => t.categoryId === setupPaymentCatId && t.amount > 0)
      .sort((a, b) => b.txnDate.localeCompare(a.txnDate))
      .slice(0, 12);
    if (catTxns.length === 0) return null;
    const amounts = catTxns.map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
    const medianAmount = amounts[Math.floor(amounts.length / 2)];
    let freq: MortgageConfig['paymentFrequency'] = 'monthly';
    if (catTxns.length >= 2) {
      const dates = [...catTxns].map((t) => new Date(t.txnDate)).sort((a, b) => a.getTime() - b.getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / 86400000);
      const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const maxGap = Math.max(...gaps);
      // Biweekly = consistent 14-day intervals (max gap stays ≤ 15).
      // Semi-monthly (e.g. 1st & 15th) alternates ~14 and ~17 day gaps, so max > 15.
      if (meanGap < 16 && maxGap <= 15) freq = 'biweekly';
      else if (meanGap < 20) freq = 'semi-monthly';
    }
    return { amount: medianAmount, freq };
  }, [setupPaymentCatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Infer prepayment from category transactions
  const inferredPrepay = useMemo(() => {
    if (!setupPrepaymentCatId) return null;
    const { transactions } = getData();
    const catTxns = transactions
      .filter((t) => t.categoryId === setupPrepaymentCatId && t.amount > 0)
      .sort((a, b) => b.txnDate.localeCompare(a.txnDate))
      .slice(0, 24);
    if (catTxns.length === 0) return null;
    const amounts = catTxns.map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
    const medianAmount = amounts[Math.floor(amounts.length / 2)];
    let freq: PrepayFrequency = 'monthly';
    if (catTxns.length >= 2) {
      const dates = [...catTxns].map((t) => new Date(t.txnDate + 'T00:00:00')).sort((a, b) => a.getTime() - b.getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / 86400000);
      const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const maxGap = Math.max(...gaps);
      if (meanGap < 16 && maxGap <= 15) freq = 'biweekly';
      else if (meanGap < 20) freq = 'semi-monthly';
      else if (meanGap < 50) freq = 'monthly';
      else if (meanGap < 250) freq = 'semi-annually';
      else freq = 'annually';
    }
    return { amount: medianAmount, freq };
  }, [setupPrepaymentCatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [prepayAutoFilledFrom, setPrepayAutoFilledFrom] = useState<number | null>(
    () => getMortgageConfig()?.prepaymentCategoryId ?? null,
  );

  // Auto-fill prepay on category change
  useEffect(() => {
    if (!inferredPrepay || !setupPrepaymentCatId || prepayAutoFilledFrom === setupPrepaymentCatId) return;
    setSetupPrepayAmount(String(Math.round(inferredPrepay.amount)));
    setSetupPrepayFreq(inferredPrepay.freq);
    setPrepayAutoFilledFrom(setupPrepaymentCatId);
  }, [setupPrepaymentCatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fill payment on category change
  useEffect(() => {
    if (!inferredPayment || !setupPaymentCatId || paymentAutoFilledFrom === setupPaymentCatId) return;
    setSetupPayment(String(Math.round(inferredPayment.amount)));
    setSetupFreq(inferredPayment.freq);
    setPaymentAutoFilledFrom(setupPaymentCatId);
  }, [setupPaymentCatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-import transactions when ledger tab is opened
  useEffect(() => {
    if (internalTab === 'ledger' && config) {
      setImportStatus(null);
      const currentLedger = getMortgageLedger();
      autoImportFromTransactions(config, currentLedger);
    }
  }, [internalTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const paymentMismatch = useMemo(() => {
    if (!inferredPayment) return false;
    const current = parseFloat(setupPayment);
    if (isNaN(current) || current <= 0) return false;
    return Math.abs(current - inferredPayment.amount) / inferredPayment.amount > 0.1;
  }, [inferredPayment, setupPayment]);

  // ── Setup validation ──────────────────────────────────────────────────────
  const missingRequired: string[] = [];
  if (!parseFloat(setupBalance)) missingRequired.push('Outstanding balance');
  if (!setupBalanceDate) missingRequired.push('Balance as-of date');
  if (!parseFloat(setupOriginal)) missingRequired.push('Original mortgage amount');
  if (!parseFloat(setupRate)) missingRequired.push('Annual interest rate');
  if (!parseFloat(setupPayment)) missingRequired.push('Regular payment amount');
  const setupValid = missingRequired.length === 0;

  function isReqMissing(field: string) {
    return setupAttempted && missingRequired.includes(field);
  }
  const reqStyle = (field: string): React.CSSProperties =>
    isReqMissing(field) ? { borderLeft: '3px solid var(--red)', paddingLeft: '0.4rem' } : {};

  async function handleSaveSetup() {
    setSetupAttempted(true);
    if (!setupValid) return;
    const cfg: MortgageConfig = {
      outstandingBalance: parseFloat(setupBalance),
      originalAmount: parseFloat(setupOriginal),
      annualRate: parseFloat(setupRate) / 100,
      paymentFrequency: setupFreq,
      regularPayment: parseFloat(setupPayment),
      startDate: setupStartDate || undefined,
      lastBalanceDate: setupBalanceDate,
      mortgageType: setupType,
      maturityDate: setupType === 'fixed' && setupMaturityDate ? setupMaturityDate : undefined,
      rateChangeBehavior: setupRateChangeBehavior,
      paymentCategoryId: setupPaymentCatId ?? undefined,
      prepaymentCategoryId: setupPrepaymentCatId ?? undefined,
      prepayAmount: parseFloat(setupPrepayAmount) > 0 ? parseFloat(setupPrepayAmount) : undefined,
      prepayFrequency: parseFloat(setupPrepayAmount) > 0 ? setupPrepayFreq : undefined,
    };
    await setMortgageConfig(cfg);
    setConfigState(cfg);
    setSimRateChangeBehavior(cfg.rateChangeBehavior);

    // Create opening balance ledger entry if none exist
    const existing = getMortgageLedger();
    if (existing.length === 0) {
      await addMortgageLedgerEntry({
        date: cfg.lastBalanceDate ?? new Date().toISOString().split('T')[0],
        type: 'opening_balance',
        amount: 0,
        balance: cfg.outstandingBalance,
        notes: 'Opening balance',
      });
      refreshLedger();
    }
    setInternalTab('overview');
    setSetupAttempted(false);
  }

  async function handleUpdateBalance() {
    if (!config || !newBalance || !newBalanceDate) return;
    const bal = parseFloat(newBalance);
    await addMortgageLedgerEntry({
      date: newBalanceDate,
      type: 'balance_reset',
      amount: 0,
      balance: bal,
      notes: `Balance manually reset to $${formatAmount(bal)}`,
    });
    const updated: MortgageConfig = {
      ...config,
      outstandingBalance: bal,
      lastBalanceDate: newBalanceDate,
    };
    await setMortgageConfig(updated);
    setConfigState(updated);
    refreshLedger();
    setNewBalance('');
    setUpdatingBalance(false);
  }

  function handleToggleMortgageTab(show: boolean) {
    setShowMortgageTab(show);
    localStorage.setItem(MORTGAGE_TAB_KEY, String(show));
    onShowMortgageTabChange?.(show);
  }

  // ── Ledger helpers ───────────────────────────────────────────────────────
  const ledgerBalance = useMemo(() => {
    if (ledger.length === 0) return config?.outstandingBalance ?? 0;
    return ledger[ledger.length - 1].balance;
  }, [ledger, config]);

  async function handleAddLedgerEntry(type: 'payment' | 'prepayment') {
    if (!config || !newEntryAmount || !newEntryDate) return;
    const amount = parseFloat(newEntryAmount);
    if (isNaN(amount) || amount <= 0) return;

    const prevBalance = ledgerBalance;
    let entry: Omit<MortgageLedgerEntry, 'id'>;

    if (type === 'payment') {
      const r = periodRate(config.annualRate, config.paymentFrequency);
      const interest = prevBalance * r;
      const principal = Math.min(amount - interest, prevBalance);
      entry = {
        date: newEntryDate,
        type: 'payment',
        amount,
        balance: Math.max(0, prevBalance - principal),
        interestPortion: Math.max(0, interest),
        principalPortion: Math.max(0, principal),
        notes: newEntryNotes || undefined,
      };
    } else {
      entry = {
        date: newEntryDate,
        type: 'prepayment',
        amount,
        balance: Math.max(0, prevBalance - amount),
        principalPortion: amount,
        notes: newEntryNotes || undefined,
      };
    }

    await addMortgageLedgerEntry(entry);
    // Update config balance to match latest ledger entry
    const newBal = entry.balance;
    const updated = { ...config, outstandingBalance: newBal, lastBalanceDate: newEntryDate };
    await setMortgageConfig(updated);
    setConfigState(updated);
    refreshLedger();
    setAddingEntry(null);
    setNewEntryAmount('');
    setNewEntryNotes('');
  }

  async function handleDeleteLedgerEntry(id: number) {
    await deleteMortgageLedgerEntry(id);
    refreshLedger();
    setDeleteConfirmId(null);
  }

  async function autoImportFromTransactions(cfg: MortgageConfig, currentLedger: MortgageLedgerEntry[]) {
    if (!cfg.paymentCategoryId && !cfg.prepaymentCategoryId) return;
    const { transactions } = getData();
    const paymentCatId = cfg.paymentCategoryId;
    const prepayCatId = cfg.prepaymentCategoryId;
    const linkedTxnIds = new Set(currentLedger.map((e) => e.linkedTransactionId).filter(Boolean) as number[]);

    // Import ALL unlinked matching transactions — pre-anchor entries will have their
    // balances reconstructed correctly by displayLedger via backwards calculation.
    const candidates = transactions
      .filter((t) => {
        const catId = t.categoryId ?? -1;
        return (catId === paymentCatId || catId === prepayCatId) && !linkedTxnIds.has(t.id);
      })
      .sort((a, b) => a.txnDate.localeCompare(b.txnDate));
    if (candidates.length === 0) {
      setImportStatus({ imported: 0 });
      return;
    }
    // Use anchor balance as starting point for forward calculation (stored values);
    // displayLedger will recalculate pre-anchor balances correctly.
    const anchorEntry = [...currentLedger].sort((a, b) => a.date.localeCompare(b.date))
      .find((e) => e.type === 'opening_balance' || e.type === 'balance_reset');
    let prevBal = anchorEntry?.balance ?? cfg.outstandingBalance;
    for (const txn of candidates) {
      const isPayment = txn.categoryId === paymentCatId;
      const amount = Math.abs(txn.amount);
      let entry: Omit<MortgageLedgerEntry, 'id'>;
      if (isPayment) {
        const r = periodRate(cfg.annualRate, cfg.paymentFrequency);
        const interest = prevBal * r;
        const principal = Math.min(amount - interest, prevBal);
        entry = {
          date: txn.txnDate,
          type: 'payment',
          amount,
          balance: Math.max(0, prevBal - Math.max(0, principal)),
          interestPortion: Math.max(0, interest),
          principalPortion: Math.max(0, principal),
          linkedTransactionId: txn.id,
        };
      } else {
        entry = {
          date: txn.txnDate,
          type: 'prepayment',
          amount,
          balance: Math.max(0, prevBal - amount),
          principalPortion: amount,
          linkedTransactionId: txn.id,
        };
      }
      await addMortgageLedgerEntry(entry);
      prevBal = entry.balance;
    }
    // Use the most recent ledger entry (by date) as the current balance,
    // not prevBal — because historical (pre-anchor) entries don't represent the current balance.
    const allLedger = getMortgageLedger();
    const sortedLedger = [...allLedger].sort((a, b) => a.date.localeCompare(b.date));
    const lastEntry = sortedLedger[sortedLedger.length - 1];
    const currentBal = lastEntry?.balance ?? prevBal;
    const currentDate = lastEntry?.date ?? candidates[candidates.length - 1].txnDate;
    const updated = { ...cfg, outstandingBalance: currentBal, lastBalanceDate: currentDate };
    await setMortgageConfig(updated);
    setConfigState(updated);
    refreshLedger();
    setImportStatus({ imported: candidates.length });
  }

  // ── Projections ───────────────────────────────────────────────────────────
  const baseExtraPerPeriod = useMemo(() => {
    if (!config?.prepayAmount || !config?.prepayFrequency) return 0;
    return prepayPerPeriod(config.prepayAmount, config.prepayFrequency, config.paymentFrequency);
  }, [config]);

  // Average regular prepayments from actual transactions over the last year
  const regularPrepaymentsFromTxns = useMemo(() => {
    if (!config?.prepaymentCategoryId) return null;
    const { transactions } = getData();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearAgoStr = oneYearAgo.toISOString().split('T')[0];
    const catTxns = transactions
      .filter((t) => t.categoryId === config.prepaymentCategoryId && t.txnDate >= oneYearAgoStr && t.amount > 0)
      .sort((a, b) => a.txnDate.localeCompare(b.txnDate));
    if (catTxns.length === 0) return null;
    const avgAmount = catTxns.reduce((s, t) => s + Math.abs(t.amount), 0) / catTxns.length;
    let freq: PrepayFrequency = 'monthly';
    if (catTxns.length >= 2) {
      const dates = catTxns.map((t) => new Date(t.txnDate + 'T00:00:00'));
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / 86400000);
      const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const maxGap = Math.max(...gaps);
      if (meanGap < 16 && maxGap <= 15) freq = 'biweekly';
      else if (meanGap < 20) freq = 'semi-monthly';
      else if (meanGap < 50) freq = 'monthly';
      else if (meanGap < 250) freq = 'semi-annually';
      else freq = 'annually';
    }
    return { amount: avgAmount, freq };
  }, [config?.prepaymentCategoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  const projection = useMemo(() => {
    if (!config) return null;
    const start = config.lastBalanceDate ? new Date(config.lastBalanceDate) : new Date();
    return projectMortgage(
      config.outstandingBalance,
      config.annualRate,
      config.paymentFrequency,
      config.regularPayment,
      baseExtraPerPeriod,
      start,
    );
  }, [config, baseExtraPerPeriod]);

  const simBaseExtraPerPeriod = useMemo(() => {
    const amt = parseFloat(simRegularPrepay) || 0;
    if (!amt) return 0;
    return prepayPerPeriod(amt, simRegularPrepayFreq, simPaymentFreq);
  }, [simRegularPrepay, simRegularPrepayFreq, simPaymentFreq]);

  // Payment is fully computed — never editable. Recalculates when rate changes (change_payment mode)
  // or when payment frequency changes, to maintain the same payoff date. Otherwise returns
  // config.regularPayment. Clearing the rate field correctly reverts to config.regularPayment.
  // Compute the regular payment for the simulation. Target: same payoff date as `projection`
  // (which includes config's regular prepayments). By subtracting config's prepayments from the
  // total-needed payment, we ensure: (a) payment = config.regularPayment when rate is unchanged,
  // (b) payment is independent of the sim's prepayment slider, and (c) the payoff date stays the
  // same when only the rate changes (with change_payment mode).
  const simEffectivePayment = useMemo(() => {
    if (!config || !projection) return config?.regularPayment ?? 0;
    const rateChanged = simRate !== '' && simRateChangeBehavior === 'change_payment';
    const freqChanged = simPaymentFreq !== config.paymentFrequency;
    if (!rateChanged && !freqChanged) return config.regularPayment;
    const newRate = simRate !== '' ? parseFloat(simRate) / 100 : config.annualRate;
    if (isNaN(newRate) || newRate < 0) return config.regularPayment;
    const prepay = parseFloat(simPrepayment) || 0;
    const startBalance = Math.max(0, config.outstandingBalance - prepay);
    const configPeriodsPerYear = config.paymentFrequency === 'monthly' ? 12 : config.paymentFrequency === 'biweekly' ? 26 : 24;
    const simPeriodsPerYear = simPaymentFreq === 'monthly' ? 12 : simPaymentFreq === 'biweekly' ? 26 : 24;
    // projection.length - 1 is the payoff horizon *with* config's prepayments baked in
    const remainingPeriods = Math.round((projection.length - 1) * simPeriodsPerYear / configPeriodsPerYear);
    if (remainingPeriods <= 0) return config.regularPayment;
    const totalNeeded = calcPayment(startBalance, newRate, simPaymentFreq, remainingPeriods);
    // Subtract config's prepayments (converted to sim frequency) — not sim's, so the payment
    // display doesn't shift when the user adjusts the sim prepayment slider.
    const configPrepayPerSimPeriod = baseExtraPerPeriod * configPeriodsPerYear / simPeriodsPerYear;
    return Math.max(0, totalNeeded - configPrepayPerSimPeriod);
  }, [config, simRate, simRateChangeBehavior, projection, simPrepayment, simPaymentFreq, baseExtraPerPeriod]);

  const simProjection = useMemo(() => {
    const freqChanged = config ? simPaymentFreq !== config.paymentFrequency : false;
    const prepayChanged = Math.round(simBaseExtraPerPeriod * 100) !== Math.round(baseExtraPerPeriod * 100);
    if (!config || (!freqChanged && !simPrepayment && !simRate && !prepayChanged)) return null;
    const start = config.lastBalanceDate ? new Date(config.lastBalanceDate) : new Date();
    const prepay = parseFloat(simPrepayment) || 0;
    const newRate = simRate ? parseFloat(simRate) / 100 : config.annualRate;
    const startBalance = Math.max(0, config.outstandingBalance - prepay);
    return projectMortgage(startBalance, newRate, simPaymentFreq, simEffectivePayment, simBaseExtraPerPeriod, start);
  }, [config, simPrepayment, simRate, simBaseExtraPerPeriod, baseExtraPerPeriod, simEffectivePayment, simPaymentFreq]);

  const payoffDate = projection ? projection[projection.length - 1]?.date : null;
  const simPayoffDate = simProjection ? simProjection[simProjection.length - 1]?.date : null;

  // Pre-populate prepayment fields when config first loads
  useEffect(() => {
    if (config && !simRegularPrepayInitialized.current) {
      simRegularPrepayInitialized.current = true;
      if (config.prepayAmount) setSimRegularPrepay(String(Math.round(config.prepayAmount)));
      if (config.prepayFrequency) setSimRegularPrepayFreq(config.prepayFrequency);
    }
  }, [config]);

  // ── Display ledger — recalculates pre-anchor entry balances via exact backwards math ─
  const displayLedger = useMemo(() => {
    if (ledger.length === 0) return ledger;
    const sorted = [...ledger].sort((a, b) => a.date.localeCompare(b.date));
    const anchorIdx = sorted.findIndex((e) => e.type === 'opening_balance' || e.type === 'balance_reset');
    if (anchorIdx <= 0) return sorted;
    const anchor = sorted[anchorIdx];
    const preAnchor = sorted.slice(0, anchorIdx);
    if (preAnchor.length === 0) return sorted;

    const r = config ? periodRate(config.annualRate, config.paymentFrequency) : 0;

    // Exact backwards calculation: work from anchor balance back through each entry
    // to find the true starting balance before the first pre-anchor entry.
    let startBal = anchor.balance;
    for (let i = preAnchor.length - 1; i >= 0; i--) {
      const e = preAnchor[i];
      if (e.type === 'prepayment') {
        startBal = startBal + e.amount;
      } else if (e.type === 'payment') {
        // balance_after = balance_before*(1+r) - amount  =>  balance_before = (balance_after + amount)/(1+r)
        startBal = (startBal + e.amount) / (1 + r);
      }
    }

    // Forward pass with correct interest/principal splits
    let runningBal = startBal;
    const recalcPre = preAnchor.map((e) => {
      let interest = 0;
      let principal = e.amount;
      if (e.type === 'payment' && r > 0) {
        interest = Math.max(0, runningBal * r);
        principal = Math.max(0, Math.min(e.amount - interest, runningBal));
      }
      runningBal = Math.max(0, runningBal - principal);
      return { ...e, balance: runningBal, interestPortion: interest, principalPortion: principal };
    });

    return [...recalcPre, ...sorted.slice(anchorIdx)];
  }, [ledger, config]);

  const projectedRemainingInterest = useMemo(() => {
    if (!projection) return 0;
    return projection.reduce((s, p) => s + p.interest, 0);
  }, [projection]);

  // ── Chart ────────────────────────────────────────────────────────────────
  const payoffLabelPlugin = useMemo(() => ({
    id: 'payoffLabel',
    afterDatasetsDraw(chart: any) {
      if (!payoffDate) return;
      const { ctx, chartArea } = chart;
      const ds = chart.getDatasetMeta(0);
      if (!ds?.data?.length) return;
      const last = ds.data[ds.data.length - 1];
      if (!last) return;
      const x = last.x;
      ctx.save();
      ctx.strokeStyle = 'rgba(128,128,128,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = payoffDate.toLocaleDateString('en-CA', { year: 'numeric', month: 'short' });
      ctx.fillStyle = 'rgba(200,200,200,0.9)';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(label, x - 4, chartArea.top + 14);
      ctx.restore();
    },
  }), [payoffDate]);

  const baseChartData = useMemo(() => {
    if (!projection) return null;
    const step = Math.max(1, Math.floor(projection.length / 60));
    const base = projection.filter((_, i) => i % step === 0 || i === projection.length - 1);
    const labels = base.map((p) =>
      p.date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short' }),
    );
    return {
      labels,
      datasets: [
        {
          label: 'Projected balance',
          data: base.map((p) => p.balance),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.10)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    };
  }, [projection]);

  const chartData = useMemo(() => {
    if (!projection) return null;
    const step = Math.max(1, Math.floor(projection.length / 60));
    const base = projection.filter((_, i) => i % step === 0 || i === projection.length - 1);
    const simBase = simProjection
      ? simProjection.filter((_, i) => i % step === 0 || i === simProjection.length - 1)
      : null;
    const labels = base.map((p) =>
      p.date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short' }),
    );
    return {
      labels,
      datasets: [
        {
          label: 'Projected balance',
          data: base.map((p) => p.balance),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.10)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
        ...(simBase ? [{
          label: 'Simulation',
          data: simBase.map((p) => p.balance),
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [6, 3],
        }] : []),
      ],
    };
  }, [projection, simProjection]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: !!simProjection, labels: { font: { size: 14 } } },
      tooltip: {
        callbacks: { label: (ctx: any) => ` $${formatAmount(ctx.parsed.y)}` },
      },
    },
    scales: {
      y: {
        ticks: { callback: (v: any) => `$${formatAmount(v)}`, font: { size: 14 } },
        grid: { color: 'rgba(128,128,128,0.15)' },
      },
      x: {
        ticks: { font: { size: 14 }, maxTicksLimit: 10 },
        grid: { color: 'rgba(128,128,128,0.1)' },
      },
    },
  }), [simProjection]);

  // ── Helpers ──────────────────────────────────────────────────────────────
  function monthsDiff(a: Date, b: Date): number {
    return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
  }
  function yearsFromNow(d: Date): number {
    return Math.round((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365));
  }

  const requiredLabel = (text: string) => (
    <span>{text} <span style={{ color: 'var(--red)', fontWeight: 700 }}>*</span></span>
  );

  // ── JSX ──────────────────────────────────────────────────────────────────
  return (
    <div className="view-root">
      <div style={{ marginBottom: '1rem' }}>
        <div className="section-title" style={{ margin: 0 }}>Mortgage Tool</div>
      </div>

      {config && (
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {(['overview', 'simulate', 'ledger', 'setup'] as InternalTab[]).map((t) => (
            <button
              key={t}
              className={`tab-btn ${internalTab === t ? 'active' : ''}`}
              onClick={() => setInternalTab(t)}
              style={{ fontSize: '0.85rem', padding: '0.3rem 0.7rem' }}
            >
              {t === 'overview' ? 'Overview' : t === 'simulate' ? 'Simulate' : t === 'ledger' ? 'Ledger' : 'Settings'}
            </button>
          ))}
        </div>
      )}

      {/* ── Setup / Settings ───────────────────────────────────────────────── */}
      {internalTab === 'setup' && (
        <div>
          <div className="card" style={{ marginBottom: '0.75rem' }}>
            <div className="section-title" style={{ marginBottom: '0.75rem' }}>
              {config ? 'Mortgage Settings' : 'Set Up Your Mortgage'}
            </div>
            <p style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '0.75rem' }}>
              Uses Canadian mortgage math (semi-annual compounding). Fields marked <span style={{ color: 'var(--red)', fontWeight: 700 }}>*</span> are required.
            </p>

            {/* Mortgage type + rate change behavior (variable only) inline */}
            <div className="field" style={{ marginBottom: '0.5rem' }}>
              <label>{requiredLabel('Mortgage type')}</label>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  {(['variable', 'fixed'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`btn ${setupType === t ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setSetupType(t)}
                      style={{ minWidth: 90 }}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
                {setupType === 'variable' && (
                  <div className="field" style={{ margin: 0, flex: 1, minWidth: 260 }}>
                    <label style={{ fontSize: '0.8rem' }}>When rate changes</label>
                    <select value={setupRateChangeBehavior} onChange={(e) => setSetupRateChangeBehavior(e.target.value as MortgageConfig['rateChangeBehavior'])}>
                      <option value="change_payment">Adjust payment amount (keep payoff date) — Usual</option>
                      <option value="change_payoff">Keep payment amount (adjust payoff date) — Less common</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Balance */}
            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div className="field" style={reqStyle('Outstanding balance')}>
                <label>{requiredLabel('Outstanding balance ($)')}</label>
                <CurrencyInput value={setupBalance} onChange={setSetupBalance} placeholder="e.g. 350,000" />
              </div>
              <div className="field" style={reqStyle('Balance as-of date')}>
                <label>{requiredLabel('Balance as of')}</label>
                <DateInput value={setupBalanceDate} onChange={setSetupBalanceDate} />
              </div>
            </div>

            {/* Original + start date */}
            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div className="field" style={reqStyle('Original mortgage amount')}>
                <label>{requiredLabel('Original mortgage amount ($)')}</label>
                <CurrencyInput value={setupOriginal} onChange={setSetupOriginal} placeholder="e.g. 500,000" />
              </div>
              <div className="field">
                <label>Mortgage start date <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
                {setupStartDate ? (
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <DateInput value={setupStartDate} onChange={setSetupStartDate} style={{ flex: 1 }} />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSetupStartDate('')} title="Clear">✕</button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSetupStartDate(new Date().toISOString().split('T')[0])}>
                    + Set date
                  </button>
                )}
              </div>
            </div>

            {/* Maturity date (fixed only) */}
            {setupType === 'fixed' && (
              <div className="field" style={{ marginBottom: '0.5rem' }}>
                <label>Term maturity date <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
                <DateInput value={setupMaturityDate} onChange={setSetupMaturityDate} />
              </div>
            )}

            {/* Annual rate */}
            <div className="field" style={{ marginBottom: '0.5rem', ...reqStyle('Annual interest rate') }}>
              <label>{requiredLabel('Annual interest rate (%)')}</label>
              <input type="number" min="0" max="30" step="0.001" value={setupRate} onChange={(e) => setSetupRate(e.target.value)} placeholder="e.g. 5.540" style={{ maxWidth: 200 }} />
            </div>

            {/* ── Category linking — before payment amount so app can infer from transactions ── */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
              <div className="field" style={{ marginBottom: '0.5rem' }}>
                <label>Mortgage payment category <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-2)', marginBottom: '0.35rem' }}>
                  Select the category used for regular mortgage payments to enable automatic tracking of your current balance.
                </div>
                <SearchableSelect
                  options={categoryOptions}
                  value={setupPaymentCatId != null ? String(setupPaymentCatId) : ''}
                  onChange={(v) => setSetupPaymentCatId(v === '' ? null : Number(v))}
                  placeholder="Select category…"
                />
                {guessedCategoryId && guessedCategoryId === setupPaymentCatId && (
                  <div style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.25rem' }}>Auto-detected from category name</div>
                )}
              </div>

              {/* Payment amount + frequency — inferred from category transactions */}
              {paymentMismatch && inferredPayment && (
                <div style={{ fontSize: '0.8rem', color: '#f59e0b', marginBottom: '0.5rem', padding: '0.4rem 0.6rem', background: 'rgba(245,158,11,0.08)', borderRadius: 4, borderLeft: '3px solid #f59e0b' }}>
                  Are you sure? This doesn't seem to match recent spending in that category (typically ${Math.round(inferredPayment.amount)}).
                </div>
              )}
              <div className="row" style={{ gap: '0.75rem', marginBottom: '0' }}>
                <div className="field" style={reqStyle('Regular payment amount')}>
                  <label>
                    {requiredLabel('Regular payment amount ($)')}
                    {inferredPayment && parseFloat(setupPayment) > 0 && !paymentMismatch && (
                      <span style={{ fontSize: '0.72rem', opacity: 0.6, fontWeight: 400, marginLeft: '0.4rem' }}>· auto-detected</span>
                    )}
                  </label>
                  <input
                    type="number" min="0"
                    value={setupPayment}
                    onChange={(e) => setSetupPayment(e.target.value)}
                    placeholder={inferredPayment ? String(Math.round(inferredPayment.amount)) : 'e.g. 2400'}
                  />
                </div>
                <div className="field">
                  <label>{requiredLabel('Payment frequency')}</label>
                  <select value={setupFreq} onChange={(e) => setSetupFreq(e.target.value as MortgageConfig['paymentFrequency'])}>
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Bi-weekly</option>
                    <option value="semi-monthly">Semi-monthly</option>
                  </select>
                </div>
              </div>
            </div>

            {/* ── Prepayment category + regular prepayment schedule (inline) ── */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
              <div className="field" style={{ marginBottom: '0.5rem' }}>
                <label>Prepayment category <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
                <div style={{ fontSize: '0.78rem', opacity: 0.65, marginBottom: '0.35rem', lineHeight: 1.5 }}>
                  If you have a separate category for lump-sum prepayments, link it here. This will allow the app to automatically pick up any pre-payments you make without having to add them manually. If not — don't worry and just leave it blank.
                </div>
                <SearchableSelect
                  options={[{ value: '', label: 'None' }, ...categoryOptions]}
                  value={setupPrepaymentCatId != null ? String(setupPrepaymentCatId) : ''}
                  onChange={(v) => setSetupPrepaymentCatId(v === '' ? null : Number(v))}
                  placeholder="None"
                />
              </div>

              {/* Regular prepayment amount + frequency */}
              <div className="field" style={{ marginBottom: '0.25rem' }}>
                <label>Regular prepayment <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
                <div style={{ fontSize: '0.78rem', opacity: 0.65, marginBottom: '0.35rem', lineHeight: 1.5 }}>
                  Your typical recurring prepayment amount. Used in overview projections and as the default in simulations.
                  {inferredPrepay && <span style={{ opacity: 0.8 }}> Auto-detected from transactions.</span>}
                </div>
                <div className="row" style={{ gap: '0.75rem', marginBottom: 0 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.78rem' }}>Amount ($)</label>
                    <CurrencyInput
                      value={setupPrepayAmount}
                      onChange={setSetupPrepayAmount}
                      placeholder={inferredPrepay ? String(Math.round(inferredPrepay.amount)) : 'e.g. 500'}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.78rem' }}>Frequency</label>
                    <select value={setupPrepayFreq} onChange={(e) => setSetupPrepayFreq(e.target.value as PrepayFrequency)}>
                      <option value="monthly">Monthly</option>
                      <option value="biweekly">Bi-weekly</option>
                      <option value="semi-monthly">Semi-monthly</option>
                      <option value="semi-annually">Semi-annually</option>
                      <option value="annually">Annually</option>
                    </select>
                  </div>
                </div>
              </div>

            </div>

            {/* Show as mortgage tab toggle */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showMortgageTab}
                  onChange={(e) => handleToggleMortgageTab(e.target.checked)}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Show Mortgage as app tab</div>
                  <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 2 }}>Adds a Mortgage tab to the top navigation bar</div>
                </div>
              </label>
            </div>
          </div>

          {setupAttempted && !setupValid && (
            <div style={{ color: 'var(--red)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              Missing required fields: {missingRequired.join(', ')}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-primary" onClick={handleSaveSetup}>Save</button>
            {config && (
              <button className="btn btn-ghost" onClick={() => { setInternalTab('overview'); setSetupAttempted(false); }}>Cancel</button>
            )}
          </div>
        </div>
      )}

      {/* ── Overview ───────────────────────────────────────────────────────── */}
      {internalTab === 'overview' && config && projection && (
        <>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
            <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Outstanding balance</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--teal)' }}>${formatAmount(config.outstandingBalance)}</div>
              {config.lastBalanceDate && <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>as of {config.lastBalanceDate}</div>}
              {!updatingBalance ? (
                <div
                  style={{ fontSize: '0.72rem', opacity: 0.45, marginTop: '0.35rem', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                  onClick={() => setUpdatingBalance(true)}
                >
                  Update balance
                </div>
              ) : (
                <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <input type="number" min="0" value={newBalance} onChange={(e) => setNewBalance(e.target.value)} placeholder="New balance" autoFocus style={{ fontSize: '0.78rem', padding: '2px 6px', width: '100%' }} />
                  <DateInput value={newBalanceDate} onChange={setNewBalanceDate} />
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    <button className="btn btn-primary btn-sm" onClick={handleUpdateBalance} disabled={!newBalance || parseFloat(newBalance) < 0}>Save</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setUpdatingBalance(false)}>×</button>
                  </div>
                </div>
              )}
            </div>
            <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Payment</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>${formatAmount(config.regularPayment)}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>{freqLabel(config.paymentFrequency)}</div>
            </div>
            {config.prepayAmount && config.prepayFrequency ? (
              <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
                <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Regular prepayment</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>${formatAmount(config.prepayAmount)}</div>
                <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>{freqLabel(config.prepayFrequency)}</div>
              </div>
            ) : regularPrepaymentsFromTxns ? (
              <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
                <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Regular prepayment</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>${formatAmount(regularPrepaymentsFromTxns.amount)}</div>
                <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>{freqLabel(regularPrepaymentsFromTxns.freq)} · est.</div>
              </div>
            ) : null}
            <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Rate</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{(config.annualRate * 100).toFixed(3)}%</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>{config.mortgageType === 'variable' ? 'Variable' : 'Fixed'}{config.maturityDate ? ` · matures ${config.maturityDate}` : ''}</div>
            </div>
          </div>

          {/* Second row: remaining interest + projected payoff */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Remaining interest projected</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>${formatAmount(projectedRemainingInterest)}</div>
            </div>
            <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Projected payoff</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>
                {payoffDate ? payoffDate.toLocaleDateString('en-CA', { year: 'numeric', month: 'long' }) : '—'}
              </div>
              {payoffDate && <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>{yearsFromNow(payoffDate)} yrs from now</div>}
            </div>
            {config.originalAmount > 0 && (
              <div className="card" style={{ flex: '1 1 140px', minWidth: 130 }}>
                <div style={{ fontSize: '0.72rem', opacity: 0.6, marginBottom: '0.2rem' }}>Principal paid</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--green)' }}>${formatAmount(Math.max(0, config.originalAmount - config.outstandingBalance))}</div>
              </div>
            )}
          </div>

          {baseChartData && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div style={{ height: 280 }}>
                <Line data={baseChartData} options={chartOptions as any} plugins={[payoffLabelPlugin]} />
              </div>
            </div>
          )}

        </>
      )}

      {/* ── Simulate ───────────────────────────────────────────────────────── */}
      {internalTab === 'simulate' && config && projection && (
        <>
          {/* Current baked-in amounts */}
          <div className="card" style={{ marginBottom: '0.75rem', background: 'var(--input-bg)', fontSize: '0.85rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.35rem', fontSize: '0.8rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Currently baked in</div>
            <div>Regular payment: <strong>${formatAmount(config.regularPayment)}</strong> {freqLabel(config.paymentFrequency)}</div>
            {baseExtraPerPeriod > 0 && config.prepayAmount && config.prepayFrequency && (
              <div>Regular prepayment: <strong>${formatAmount(config.prepayAmount)}</strong> {freqLabel(config.prepayFrequency)}</div>
            )}
            <div>Rate: <strong>{(config.annualRate * 100).toFixed(3)}%</strong></div>
          </div>

          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <div className="section-title" style={{ margin: 0 }}>Simulation inputs</div>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                setSimRate('');
                setSimPrepayment('');
                setSimPaymentFreq(config.paymentFrequency);
                setSimRegularPrepay(config.prepayAmount ? String(Math.round(config.prepayAmount)) : '');
                setSimRegularPrepayFreq(config.prepayFrequency ?? 'monthly');
                setSimRateChangeBehavior(config.rateChangeBehavior);
              }}>Reset</button>
            </div>

            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div className="field">
                <label>Regular payment ($) <span style={{ opacity: 0.4, fontWeight: 400, fontSize: '0.75rem' }}>— auto-calculated</span></label>
                <div style={{ padding: '0.4rem 0.6rem', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: '0.9rem', color: Math.round(simEffectivePayment) !== Math.round(config.regularPayment) ? '#f59e0b' : 'inherit' }}>
                  ${formatAmount(simEffectivePayment)}
                </div>
              </div>
              <div className="field">
                <label>Frequency</label>
                <select value={simPaymentFreq} onChange={(e) => setSimPaymentFreq(e.target.value as MortgageConfig['paymentFrequency'])}>
                  <option value="monthly">Monthly</option>
                  <option value="biweekly">Bi-weekly</option>
                  <option value="semi-monthly">Semi-monthly</option>
                </select>
              </div>
            </div>

            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div className="field">
                <label>Regular prepayment ($) <span style={{ opacity: 0.5, fontWeight: 400 }}>— per period</span></label>
                <input type="number" min="0" value={simRegularPrepay} onChange={(e) => setSimRegularPrepay(e.target.value)} placeholder="0" />
              </div>
              <div className="field">
                <label>Frequency</label>
                <select value={simRegularPrepayFreq} onChange={(e) => setSimRegularPrepayFreq(e.target.value as PrepayFrequency)}>
                  <option value="monthly">Monthly</option>
                  <option value="biweekly">Bi-weekly</option>
                  <option value="semi-monthly">Semi-monthly</option>
                  <option value="semi-annually">Semi-annually</option>
                  <option value="annually">Annually</option>
                </select>
              </div>
            </div>

            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div className="field">
                <label>New interest rate (%) <span style={{ opacity: 0.5, fontWeight: 400 }}>— leave blank to keep current</span></label>
                <input type="number" min="0" max="30" step="0.001" value={simRate} onChange={(e) => setSimRate(e.target.value)} placeholder={`${(config.annualRate * 100).toFixed(3)} (current)`} />
              </div>
              <div className="field">
                <label>One-off prepayment today ($)</label>
                <input type="number" min="0" value={simPrepayment} onChange={(e) => setSimPrepayment(e.target.value)} placeholder="0" />
              </div>
            </div>

            <div className="field">
              <label>Rate change effect</label>
              <select value={simRateChangeBehavior} onChange={(e) => setSimRateChangeBehavior(e.target.value as MortgageConfig['rateChangeBehavior'])}>
                <option value="change_payment">Adjust payment (keep payoff date)</option>
                <option value="change_payoff">Keep payment (adjust payoff date)</option>
              </select>
            </div>
          </div>

          {(() => {
            const diff = payoffDate && simPayoffDate ? monthsDiff(simPayoffDate, payoffDate) : null;
            const sooner = diff != null && diff > 0;
            const later = diff != null && diff < 0;
            const actualInterest = projectedRemainingInterest;
            const simInterest = simProjection ? simProjection.reduce((s, p) => s + p.interest, 0) : null;
            const interestDelta = simInterest != null ? actualInterest - simInterest : null;
            return (
              <div className="card" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  {/* Actual column */}
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' }}>Actual</div>
                    <div style={{ marginBottom: '0.5rem' }}>
                      <div style={{ fontSize: '0.68rem', opacity: 0.6 }}>Payoff</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#3b82f6' }}>
                        {payoffDate ? `${payoffDate.toLocaleDateString('en-CA', { year: 'numeric', month: 'short' })} · ${yearsFromNow(payoffDate)} yrs` : '—'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.68rem', opacity: 0.6 }}>Remaining interest</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#3b82f6' }}>${formatAmount(actualInterest)}</div>
                    </div>
                  </div>
                  {/* Simulated column */}
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' }}>Simulated</div>
                    <div style={{ marginBottom: '0.5rem' }}>
                      <div style={{ fontSize: '0.68rem', opacity: 0.6 }}>Payoff</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f59e0b' }}>
                        {simPayoffDate ? simPayoffDate.toLocaleDateString('en-CA', { year: 'numeric', month: 'short' }) : '—'}
                      </div>
                      {diff != null && diff !== 0 && (
                        <div style={{ fontSize: '0.72rem', color: sooner ? 'var(--green)' : later ? 'var(--red)' : 'inherit' }}>
                          {Math.abs(diff)} mo {sooner ? 'sooner' : 'later'}
                        </div>
                      )}
                      {diff === 0 && simPayoffDate && <div style={{ fontSize: '0.68rem', opacity: 0.5 }}>no change</div>}
                    </div>
                    <div>
                      <div style={{ fontSize: '0.68rem', opacity: 0.6 }}>Remaining interest</div>
                      {simInterest != null ? (
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f59e0b' }}>
                          ${formatAmount(simInterest)}
                          {interestDelta !== 0 && interestDelta != null && (
                            <span style={{ fontSize: '0.72rem', color: interestDelta > 0 ? 'var(--green)' : 'var(--red)', marginLeft: 5 }}>
                              ({interestDelta > 0 ? '-' : '+'}${formatAmount(Math.abs(interestDelta))} {interestDelta > 0 ? 'saved' : 'added'})
                            </span>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f59e0b', opacity: 0.35 }}>—</div>
                      )}
                    </div>
                    {simProjection && Math.round(simEffectivePayment) !== Math.round(config.regularPayment) && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.68rem', opacity: 0.6 }}>New payment</div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f59e0b' }}>
                          ${formatAmount(simEffectivePayment)} <span style={{ fontSize: '0.72rem', opacity: 0.6 }}>{freqLabel(simPaymentFreq)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {chartData && (
            <div className="card">
              <div style={{ height: 280 }}>
                <Line data={chartData} options={chartOptions as any} plugins={[payoffLabelPlugin]} />
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Ledger ─────────────────────────────────────────────────────────── */}
      {internalTab === 'ledger' && config && (
        <>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ fontWeight: 600 }}>Mortgage Ledger</div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => { setAddingEntry('prepayment'); setNewEntryAmount(''); setNewEntryNotes(''); setNewEntryDate(new Date().toISOString().split('T')[0]); }}>
                  + Prepayment
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setAddingEntry('payment'); setNewEntryAmount(''); setNewEntryNotes(''); setNewEntryDate(new Date().toISOString().split('T')[0]); }}>
                  + Payment
                </button>
              </div>
            </div>

            <p style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: importStatus ? '0.35rem' : '0.75rem' }}>
              This ledger is completely separate from the main transaction ledger. Deleting an entry here does not affect your main transactions.
            </p>

            {/* Import status */}
            {importStatus !== null && importStatus.imported > 0 && (
              <div style={{ fontSize: '0.78rem', marginBottom: '0.65rem', padding: '0.4rem 0.6rem', borderRadius: 5, background: 'rgba(52,211,153,0.08)', borderLeft: '3px solid var(--green)' }}>
                Auto-imported {importStatus.imported} transaction{importStatus.imported !== 1 ? 's' : ''}.
              </div>
            )}

            {(() => {
              if (!config?.paymentCategoryId) return null;
              const allLedger = getMortgageLedger();
              const lastPayment = [...allLedger]
                .filter((e) => e.type === 'payment')
                .sort((a, b) => b.date.localeCompare(a.date))[0];
              if (!lastPayment) return null;
              const lastDate = new Date(lastPayment.date + 'T00:00:00');
              const now = new Date();
              const monthsAgo = (now.getFullYear() - lastDate.getFullYear()) * 12 + (now.getMonth() - lastDate.getMonth());
              if (monthsAgo <= 1) return null;
              const catName = categoryOptions.find((c) => c.value === String(config.paymentCategoryId))?.label ?? `Category #${config.paymentCategoryId}`;
              return (
                <>
                  <div style={{ fontSize: '0.78rem', marginBottom: '0.65rem', padding: '0.4rem 0.6rem', borderRadius: 5, background: 'rgba(245,158,11,0.08)', borderLeft: '3px solid #f59e0b' }}>
                    No new transactions found in "{catName}". Make sure your transactions are imported and categorized correctly.
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: '0.78rem', marginBottom: '0.75rem' }}
                    onClick={() => {
                      setImportStatus(null);
                      autoImportFromTransactions(config, getMortgageLedger());
                    }}
                  >
                    Re-import from transactions
                  </button>
                </>
              );
            })()}

            {/* Add entry form */}
            {addingEntry && (
              <div style={{ background: 'var(--input-bg)', borderRadius: 6, padding: '0.75rem', marginBottom: '0.75rem' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                  Add {addingEntry === 'payment' ? 'Payment' : 'Prepayment'}
                  {addingEntry === 'prepayment' && !config.prepaymentCategoryId && (
                    <span style={{ fontSize: '0.75rem', color: '#f59e0b', marginLeft: '0.5rem', fontWeight: 400 }}>
                      Tip: link a prepayment category in Settings to avoid logging these manually.
                    </span>
                  )}
                </div>
                <div className="row" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Date</label>
                    <DateInput value={newEntryDate} onChange={setNewEntryDate} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Amount ($)</label>
                    <input type="number" min="0" value={newEntryAmount} onChange={(e) => setNewEntryAmount(e.target.value)} placeholder={String(config.regularPayment)} autoFocus />
                  </div>
                </div>
                {addingEntry === 'payment' && newEntryAmount && (() => {
                  const r = periodRate(config.annualRate, config.paymentFrequency);
                  const interest = ledgerBalance * r;
                  const principal = Math.max(0, parseFloat(newEntryAmount) - interest);
                  return (
                    <div style={{ fontSize: '0.78rem', opacity: 0.6, marginBottom: '0.5rem' }}>
                      Interest: ${formatAmount(interest)} · Principal: ${formatAmount(principal)} · New balance: ${formatAmount(Math.max(0, ledgerBalance - principal))}
                    </div>
                  );
                })()}
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: 2, marginBottom: 0 }}>
                    <label>Notes (optional)</label>
                    <input value={newEntryNotes} onChange={(e) => setNewEntryNotes(e.target.value)} placeholder="Optional notes" />
                  </div>
                  <button className="btn btn-primary btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={() => handleAddLedgerEntry(addingEntry)} disabled={!newEntryAmount || !newEntryDate}>
                    Add
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAddingEntry(null)}>Cancel</button>
                </div>
              </div>
            )}


            {/* Ledger table */}
            {ledger.length === 0 ? (
              <p style={{ fontSize: '0.85rem', opacity: 0.6 }}>No entries yet. Add your first payment or import from transactions.</p>
            ) : (
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                <table className="data-table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th className="num">Amount</th>
                      <th className="num">Interest</th>
                      <th className="num">Principal</th>
                      <th className="num">Balance</th>
                      <th>Notes</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayLedger.map((e) => (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{e.date}</td>
                        <td style={{ fontSize: '0.82rem', opacity: 0.8 }}>
                          {e.type === 'opening_balance' ? 'Opening' : e.type === 'balance_reset' ? 'Balance reset' : e.type === 'payment' ? 'Payment' : 'Prepayment'}
                        </td>
                        <td className="num" style={{ fontSize: '0.82rem' }}>{(e.type === 'opening_balance' || e.type === 'balance_reset') ? '—' : `$${formatAmount(e.amount)}`}</td>
                        <td className="num" style={{ fontSize: '0.82rem', opacity: 0.7 }}>{e.interestPortion != null ? `$${formatAmount(e.interestPortion)}` : '—'}</td>
                        <td className="num" style={{ fontSize: '0.82rem', opacity: 0.7 }}>{e.principalPortion != null ? `$${formatAmount(e.principalPortion)}` : '—'}</td>
                        <td className="num" style={{ fontSize: '0.82rem', fontWeight: 600 }}>${formatAmount(e.balance)}</td>
                        <td style={{ fontSize: '0.78rem', opacity: 0.6 }}>{e.notes ?? ''}</td>
                        <td>
                          {e.type !== 'opening_balance' && e.type !== 'balance_reset' && (
                            deleteConfirmId === e.id ? (
                              <div style={{ display: 'flex', gap: '0.3rem' }}>
                                <button className="btn btn-danger btn-sm" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => handleDeleteLedgerEntry(e.id)}>Delete</button>
                                <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => setDeleteConfirmId(null)}>Cancel</button>
                              </div>
                            ) : (
                              <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', opacity: 0.5 }} onClick={() => setDeleteConfirmId(e.id)}>✕</button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
