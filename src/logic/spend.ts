import type { AppData, Transaction, TransactionSplit } from '../db';
import { isCredit } from './txnKind';

export interface MonthAgg {
  /** Non-credit amounts per category (signed; refunds are negative). */
  debitByCat: Map<number, number>;
  /** Credit amounts per category as positive numbers (Math.abs). */
  creditByCat: Map<number, number>;
  /** Non-credit, non-split, uncategorized debit total. */
  uncategorizedDebit: number;
}

const splitsIndexCache = new WeakMap<TransactionSplit[], Map<number, TransactionSplit[]>>();
const aggCache = new WeakMap<Transaction[], { splits: TransactionSplit[]; value: Map<string, MonthAgg> }>();

/** transactionId → splits. Cached per `transactionSplits` array (db.ts gives a new array on every change). */
export function getSplitsIndex(d: Pick<AppData, 'transactionSplits'>): Map<number, TransactionSplit[]> {
  const key = d.transactionSplits;
  let idx = splitsIndexCache.get(key);
  if (!idx) {
    idx = new Map();
    for (const s of key) {
      const arr = idx.get(s.transactionId);
      if (arr) arr.push(s); else idx.set(s.transactionId, [s]);
    }
    splitsIndexCache.set(key, idx);
  }
  return idx;
}

/** A transaction is categorized if it has a category OR any splits (splits win over the parent category). */
export function isCategorized(t: Transaction, splits: Map<number, TransactionSplit[]>): boolean {
  return t.categoryId != null || (splits.get(t.id)?.length ?? 0) > 0;
}

function aggFor(map: Map<string, MonthAgg>, month: string): MonthAgg {
  let a = map.get(month);
  if (!a) {
    a = { debitByCat: new Map(), creditByCat: new Map(), uncategorizedDebit: 0 };
    map.set(month, a);
  }
  return a;
}

function bump(m: Map<number, number>, k: number, v: number) {
  m.set(k, (m.get(k) ?? 0) + v);
}

/**
 * One pass over all transactions → per-month, per-category totals.
 * A split portion counts in month `(s.txnDate ?? t.txnDate)`; a non-split categorized transaction in `t.txnDate`.
 * Credits (`ignoreInBudget`) add `Math.abs(amount)` to creditByCat; debits add the signed amount to debitByCat.
 * Transfers are excluded entirely.
 */
export function getMonthAggregates(d: Pick<AppData, 'transactions' | 'transactionSplits'>): Map<string, MonthAgg> {
  const cached = aggCache.get(d.transactions);
  if (cached && cached.splits === d.transactionSplits) return cached.value;

  const splits = getSplitsIndex(d);
  const out = new Map<string, MonthAgg>();
  for (const t of d.transactions) {
    if (t.isTransfer) continue;
    const ts = splits.get(t.id);
    if (ts && ts.length > 0) {
      for (const s of ts) {
        const a = aggFor(out, (s.txnDate ?? t.txnDate).slice(0, 7));
        if (isCredit(t)) bump(a.creditByCat, s.categoryId, Math.abs(s.amount));
        else bump(a.debitByCat, s.categoryId, s.amount);
      }
    } else if (t.categoryId) {
      const a = aggFor(out, t.txnDate.slice(0, 7));
      if (isCredit(t)) bump(a.creditByCat, t.categoryId, Math.abs(t.amount));
      else bump(a.debitByCat, t.categoryId, t.amount);
    } else if (!isCredit(t)) {
      aggFor(out, t.txnDate.slice(0, 7)).uncategorizedDebit += t.amount;
    }
  }
  aggCache.set(d.transactions, { splits: d.transactionSplits, value: out });
  return out;
}

const EMPTY: MonthAgg = { debitByCat: new Map(), creditByCat: new Map(), uncategorizedDebit: 0 };
export function monthAgg(d: Pick<AppData, 'transactions' | 'transactionSplits'>, month: string): MonthAgg {
  return getMonthAggregates(d).get(month) ?? EMPTY;
}

/** Net spend for an expense category in a month (debits minus credits), as the budget row shows it. */
export function netSpent(d: Pick<AppData, 'transactions' | 'transactionSplits'>, catId: number, month: string): number {
  const a = monthAgg(d, month);
  return (a.debitByCat.get(catId) ?? 0) - (a.creditByCat.get(catId) ?? 0);
}

/**
 * Rollover carry into `month` for a category: Σ over months m with rolloverStartMonth ≤ m < month
 * of (target_m − net_spent_m). Expense categories only; 0 when rollover is off.
 */
export function getRolloverCarry(d: AppData, catId: number, month: string): number {
  const cat = d.categories.find((c) => c.id === catId);
  if (!cat || !cat.rollover || cat.isIncome || !cat.rolloverStartMonth) return 0;
  if (cat.rolloverStartMonth >= month) return 0;
  const targets = new Map<string, number>();
  for (const b of d.budgets) if (b.categoryId === catId) targets.set(b.month, b.targetAmount);
  let carry = 0;
  let [y, m] = cat.rolloverStartMonth.split('-').map(Number);
  const [ey, em] = month.split('-').map(Number);
  while (y < ey || (y === ey && m < em)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    carry += (targets.get(key) ?? 0) - netSpent(d, catId, key);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return Math.round(carry * 100) / 100;
}
