import { getData, bulkAddSavingsEntries, type SavingsEntry } from '../db';
import { monthRange } from './dateUtils';
import { getSplitsIndex } from './spend';
import { isCredit } from './txnKind';

/**
 * Generate savings auto-contributions from each schedule's startMonth
 * through the current month, backfilling any gaps.
 * Skips months where the entry already exists.
 */
export async function processSchedules(): Promise<number> {
  const { savingsSchedules, savingsEntries, transactions, categories } = getData();
  const months = monthRange(transactions);

  // Buckets that have linked categories are fed by real transactions — skip scheduler for those
  const txnFedBucketIds = new Set(
    categories.filter((c) => c.savingsBucketId != null).map((c) => c.savingsBucketId!)
  );

  const existing = new Set<string>();
  for (const e of savingsEntries) {
    if (e.scheduleId != null) existing.add(`${e.scheduleId}|${e.entryDate.slice(0, 7)}`);
  }

  const toAdd: Omit<SavingsEntry, 'id'>[] = [];
  for (const month of months) {
    for (const sched of savingsSchedules) {
      if (!sched.active) continue;
      if (sched.startMonth > month) continue;
      if (txnFedBucketIds.has(sched.bucketId)) continue;
      if (existing.has(`${sched.id}|${month}`)) continue;

      const day = Math.min(sched.dayOfMonth, 28);
      toAdd.push({
        entryDate: `${month}-${String(day).padStart(2, '0')}`,
        bucketId: sched.bucketId,
        amount: sched.amount,
        notes: 'Auto-contribution (schedule)',
        source: 'auto_schedule',
        scheduleId: sched.id,
      });
    }
  }
  await bulkAddSavingsEntries(toAdd);
  return toAdd.length;
}

export function getBucketBalance(bucketId: number): number {
  const { savingsEntries, categories, transactions, transactionSplits } = getData();

  // All manual/scheduled entries always count toward the balance
  const bucketEntries = savingsEntries.filter((e) => e.bucketId === bucketId);
  const entryBalance = bucketEntries.reduce((sum, e) => sum + e.amount, 0);

  // Transaction-based contributions: categories linked to this bucket
  const linkedCatIds = new Set(
    categories.filter((c) => c.savingsBucketId === bucketId).map((c) => c.id)
  );

  if (linkedCatIds.size === 0) return entryBalance;

  // Only count transactions on or after the bucket's opening date (earliest entry).
  // Transactions pre-dating the opening balance are historical and should not
  // affect the balance — the opening balance already accounts for that period.
  const openDate = bucketEntries.length > 0
    ? bucketEntries.reduce((min, e) => e.entryDate < min ? e.entryDate : min, bucketEntries[0].entryDate)
    : null;

  const splitsByTxn = getSplitsIndex({ transactionSplits });

  let txnBalance = 0;
  for (const t of transactions) {
    if (isCredit(t) || t.isTransfer) continue;
    if (openDate && t.txnDate < openDate) continue;
    const splits = splitsByTxn.get(t.id);
    if (splits && splits.length > 0) {
      for (const s of splits) {
        if (linkedCatIds.has(s.categoryId)) txnBalance += s.amount;
      }
    } else if (t.categoryId && linkedCatIds.has(t.categoryId)) {
      txnBalance += t.amount;
    }
  }

  return entryBalance + txnBalance;
}
