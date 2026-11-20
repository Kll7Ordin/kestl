import type { MortgageConfig, MortgageLedgerEntry, MortgageRateChange } from '../db';

type Freq = MortgageConfig['paymentFrequency'];

export function periodsPerYear(freq: Freq): number {
  return freq === 'monthly' ? 12 : freq === 'biweekly' ? 26 : 24;
}

/** Canadian convention: semi-annual compounding converted to the payment period. */
export function periodRate(annualRate: number, freq: Freq): number {
  return Math.pow(1 + annualRate / 2, 2 / periodsPerYear(freq)) - 1;
}

/** Payment that pays `balance` off in `periods` at per-period rate `r`. */
export function annuityPayment(balance: number, r: number, periods: number): number {
  if (periods <= 0) return balance;
  if (r === 0) return balance / periods;
  return (balance * r) / (1 - Math.pow(1 + r, -periods));
}

/** Number of periods `payment` takes to pay off `balance` at rate `r`; null if it never does. */
export function periodsToPayoff(balance: number, r: number, payment: number): number | null {
  if (balance <= 0) return 0;
  if (r === 0) return balance / payment;
  const x = 1 - (balance * r) / payment;
  if (x <= 0) return null;
  return -Math.log(x) / Math.log(1 + r);
}

/** Annual rate in effect on `date`. Falls back to the config's current rate when there is no history. */
export function rateAt(cfg: Pick<MortgageConfig, 'annualRate' | 'rateHistory'>, date: string): number {
  const hist = cfg.rateHistory;
  if (!hist || hist.length === 0) return cfg.annualRate;
  const sorted = [...hist].sort((a, b) => a.date.localeCompare(b.date));
  let rate = sorted[0].rate;
  for (const h of sorted) {
    if (h.date <= date) rate = h.rate;
    else break;
  }
  return rate;
}

/** Record that `rate` applies from `date`, seeding history with the previous rate if it was empty. */
export function withRateChange(cfg: MortgageConfig, date: string, rate: number, firstLedgerDate: string): MortgageRateChange[] {
  const hist: MortgageRateChange[] = cfg.rateHistory?.length
    ? cfg.rateHistory.filter((h) => h.date !== date)
    : [{ date: firstLedgerDate < date ? firstLedgerDate : date, rate: cfg.annualRate }];
  hist.push({ date, rate });
  return hist.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Recompute every entry's interest/principal split and balance using the rate in effect on its date.
 * Balances before the first anchor (opening balance / reset) are reconstructed backwards from it;
 * after it they run forward, re-anchoring at each balance reset.
 */
export function recalcLedger(entries: MortgageLedgerEntry[], cfg: MortgageConfig): MortgageLedgerEntry[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const isAnchor = (e: MortgageLedgerEntry) => e.type === 'opening_balance' || e.type === 'balance_reset';
  const anchorIdx = sorted.findIndex(isAnchor);
  if (anchorIdx < 0) return sorted;
  const r = (e: MortgageLedgerEntry) => periodRate(rateAt(cfg, e.date), cfg.paymentFrequency);

  const apply = (e: MortgageLedgerEntry, bal: number): MortgageLedgerEntry => {
    if (e.type === 'payment') {
      const interest = Math.max(0, bal * r(e));
      const principal = Math.max(0, Math.min(e.amount - interest, bal));
      return { ...e, balance: Math.max(0, bal - principal), interestPortion: interest, principalPortion: principal };
    }
    return { ...e, balance: Math.max(0, bal - e.amount), principalPortion: e.amount };
  };

  // Backwards from the anchor: balance_before = (balance_after + amount) / (1 + r) for payments.
  let startBal = sorted[anchorIdx].balance;
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const e = sorted[i];
    if (e.type === 'prepayment') startBal += e.amount;
    else if (e.type === 'payment') startBal = (startBal + e.amount) / (1 + r(e));
  }

  const out: MortgageLedgerEntry[] = [];
  let bal = startBal;
  for (const e of sorted) {
    if (isAnchor(e)) { bal = e.balance; out.push(e); continue; }
    const next = apply(e, bal);
    bal = next.balance;
    out.push(next);
  }
  return out;
}

export interface PaymentChange {
  key: string;
  date: string;
  oldAmount: number;
  newAmount: number;
  oldRate: number;
  /** Rate that keeps the remaining amortization unchanged at the new payment; null if it can't be solved. */
  impliedRate: number | null;
}

export const paymentChangeKey = (e: Pick<MortgageLedgerEntry, 'date' | 'amount'>) => `${e.date}:${e.amount.toFixed(2)}`;

/**
 * Solve for the annual rate at which `newPayment` keeps the same payoff horizon that `oldPayment`
 * had at `oldRate` on `balance`. Lenders recalculate variable-rate payments this way.
 */
export function impliedRate(balance: number, oldRate: number, oldPayment: number, newPayment: number, freq: Freq): number | null {
  const n = periodsToPayoff(balance, periodRate(oldRate, freq), oldPayment);
  if (n == null || n <= 0) return null;
  let lo = 0;
  let hi = 0.5;
  if (annuityPayment(balance, periodRate(hi, freq), n) < newPayment) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (annuityPayment(balance, periodRate(mid, freq), n) < newPayment) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * First regular payment whose amount differs from the previous regular one by more than 1%
 * and hasn't been resolved yet. `ledger` should be the output of recalcLedger so balances are right.
 */
export function findPaymentChange(ledger: MortgageLedgerEntry[], cfg: MortgageConfig): PaymentChange | null {
  const resolved = new Set(cfg.resolvedPaymentChanges ?? []);
  const ignored = new Set(cfg.ignoredPayments ?? []);
  let ref: MortgageLedgerEntry | null = null;
  let balBefore = 0;
  let bal = 0;
  for (const e of [...ledger].sort((a, b) => a.date.localeCompare(b.date))) {
    balBefore = bal;
    bal = e.balance;
    if (e.type !== 'payment') continue;
    const key = paymentChangeKey(e);
    if (ignored.has(key)) continue;
    if (ref && Math.abs(e.amount - ref.amount) / ref.amount > 0.01 && !resolved.has(key)) {
      const oldRate = rateAt(cfg, ref.date);
      return {
        key,
        date: e.date,
        oldAmount: ref.amount,
        newAmount: e.amount,
        oldRate,
        impliedRate: impliedRate(balBefore, oldRate, ref.amount, e.amount, cfg.paymentFrequency),
      };
    }
    ref = e;
  }
  return null;
}
