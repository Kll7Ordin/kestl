import { getData, addCategoryRule, persistData, setSplitsBulk, withUndo, type Transaction, type CategoryRule, type SplitRuleItem } from '../db';

export interface RunRuleOptions {
  ruleId: number;
  startDate?: string; // ISO date or undefined for all time
  endDate?: string;
  includeAlreadyCategorized: boolean;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Category suggestions (history-based guesses) live in suggest.ts.

export interface SplitAction {
  txnIndex: number;
  splits: Array<{ categoryId: number; amount: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Turn rule split items into concrete amounts. Each amount is rounded to cents, and any
 * remainder (stray cents from percentages, or fixed-dollar splits applied to a transaction of a
 * different amount) goes to the LAST split so the parts always sum to the transaction.
 */
export function resolveSplits(items: SplitRuleItem[], txnAmount: number): Array<{ categoryId: number; amount: number }> {
  const out = items.map((s) => ({
    categoryId: s.categoryId,
    amount: round2(s.percent != null ? txnAmount * s.percent / 100 : (s.amount ?? 0)),
  }));
  if (out.length === 0) return out;
  const diff = round2(txnAmount - out.reduce((sum, x) => sum + x.amount, 0));
  if (Math.abs(diff) >= 0.005) out[out.length - 1].amount = round2(out[out.length - 1].amount + diff);
  return out;
}

function splitTxnIds(): Set<number> {
  return new Set(getData().transactionSplits.map((s) => s.transactionId));
}

export function categorizeTransactionsInPlace(txns: Omit<Transaction, 'id'>[]): SplitAction[] {
  const { categoryRules } = getData();
  const splitActions: SplitAction[] = [];

  for (let i = 0; i < txns.length; i++) {
    const txn = txns[i];
    if (txn.categoryId || txn.isTransfer) continue;
    const norm = normalize(txn.descriptor);
    const amountMatch = (r: CategoryRule) =>
      r.amountMatch == null || Math.abs((r.amountMatch ?? 0) - txn.amount) < 0.01;

    // Apply rules in order — last match wins
    let lastMatch: CategoryRule | undefined;
    for (const r of categoryRules) {
      const descMatch = r.matchType === 'exact'
        ? normalize(r.pattern) === norm
        : norm.includes(normalize(r.pattern));
      if (descMatch && amountMatch(r)) lastMatch = r;
    }
    if (!lastMatch) continue;

    if (lastMatch.markTransfer) {
      txn.isTransfer = true;
      continue;
    }
    if (lastMatch.splits && lastMatch.splits.length >= 2) {
      splitActions.push({ txnIndex: i, splits: resolveSplits(lastMatch.splits, txn.amount) });
    } else {
      txn.categoryId = lastMatch.categoryId;
    }
  }

  return splitActions;
}

export async function recategorizeAll(): Promise<number> {
  return withUndo('Re-run category rules', async () => {
    const { transactions, categoryRules } = getData();
    const hasSplits = splitTxnIds();

    let count = 0;
    const splitEntries: { transactionId: number; splits: Array<{ categoryId: number; amount: number }> }[] = [];
    const amountMatch = (r: CategoryRule, txn: Transaction) =>
      r.amountMatch == null || Math.abs((r.amountMatch ?? 0) - txn.amount) < 0.01;
    for (const txn of transactions) {
      if (txn.categoryId !== null || txn.isTransfer || hasSplits.has(txn.id)) continue;
      const norm = normalize(txn.descriptor);
      // Last rule wins
      let matched: CategoryRule | undefined;
      for (const r of categoryRules) {
        const descMatch = r.matchType === 'exact'
          ? normalize(r.pattern) === norm
          : norm.includes(normalize(r.pattern));
        if (descMatch && amountMatch(r, txn)) matched = r;
      }
      if (matched) {
        if (matched.markTransfer) {
          txn.isTransfer = true;
        } else if (matched.splits && matched.splits.length >= 2) {
          splitEntries.push({ transactionId: txn.id, splits: resolveSplits(matched.splits, txn.amount) });
        } else {
          txn.categoryId = matched.categoryId;
        }
        count++;
      }
    }
    if (splitEntries.length > 0) await setSplitsBulk(splitEntries);
    if (count > 0) await persistData();
    return count;
  });
}

export async function bulkCategorizeByDescriptor(
  pattern: string,
  categoryId: number,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  return withUndo('Categorize by descriptor', async () => {
    const { transactions } = getData();
    const norm = normalize(pattern);
    let count = 0;
    for (const txn of transactions) {
      const txnNorm = normalize(txn.descriptor);
      const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
      const isMatch = descMatch && amountOk;
      if (isMatch) {
        txn.categoryId = categoryId;
        count++;
      }
    }
    if (count > 0) await persistData();
    return count;
  });
}

export async function bulkMarkTransferByDescriptor(
  pattern: string,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  return withUndo('Mark as transfer', async () => {
    const { transactions } = getData();
    const norm = normalize(pattern);
    let count = 0;
    for (const txn of transactions) {
      const txnNorm = normalize(txn.descriptor);
      const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
      if (descMatch && amountOk && !txn.isTransfer) { txn.isTransfer = true; count++; }
    }
    if (count > 0) await persistData();
    return count;
  });
}

export async function bulkApplySplitRule(
  pattern: string,
  matchType: 'exact' | 'contains',
  amount: number | null,
  splits: SplitRuleItem[],
): Promise<number> {
  return withUndo('Apply split rule', async () => {
    const { transactions } = getData();
    const norm = normalize(pattern);
    const entries: { transactionId: number; splits: Array<{ categoryId: number; amount: number }> }[] = [];
    for (const txn of transactions) {
      const txnNorm = normalize(txn.descriptor);
      const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
      if (!descMatch || !amountOk) continue;
      entries.push({ transactionId: txn.id, splits: resolveSplits(splits, txn.amount) });
    }
    await setSplitsBulk(entries);
    return entries.length;
  });
}

export async function runRuleOnHistory(opts: RunRuleOptions): Promise<number> {
  return withUndo('Run rule on history', async () => {
    const { transactions, categoryRules } = getData();
    const rule = categoryRules.find((r) => r.id === opts.ruleId);
    if (!rule) return 0;
    const hasSplits = splitTxnIds();

    const norm = normalize(rule.pattern);
    const amountMatch = (txn: Transaction) =>
      rule.amountMatch == null || Math.abs((rule.amountMatch ?? 0) - txn.amount) < 0.01;

    let count = 0;
    const splitEntries: { transactionId: number; splits: Array<{ categoryId: number; amount: number }> }[] = [];
    for (const txn of transactions) {
      if (!opts.includeAlreadyCategorized && (txn.categoryId !== null || txn.isTransfer || hasSplits.has(txn.id))) continue;
      if (opts.startDate && txn.txnDate < opts.startDate) continue;
      if (opts.endDate && txn.txnDate > opts.endDate) continue;

      const txnNorm = normalize(txn.descriptor);
      const descMatch = rule.matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      if (!descMatch || !amountMatch(txn)) continue;

      if (rule.markTransfer) {
        txn.isTransfer = true;
      } else if (rule.splits && rule.splits.length >= 2) {
        splitEntries.push({ transactionId: txn.id, splits: resolveSplits(rule.splits, txn.amount) });
      } else {
        txn.categoryId = rule.categoryId;
      }
      count++;
    }
    if (splitEntries.length > 0) await setSplitsBulk(splitEntries);
    if (count > 0) await persistData();
    return count;
  });
}

export async function createRuleAndApply(
  pattern: string,
  categoryId: number,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  return withUndo('Create rule', async () => {
    await addCategoryRule({ matchType, pattern: pattern.toLowerCase(), categoryId, amountMatch: amount ?? null });
    return bulkCategorizeByDescriptor(pattern, categoryId, matchType, amount);
  });
}
