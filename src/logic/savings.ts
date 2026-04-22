import { getData, addSavingsEntry } from '../db';
import { monthRange } from './dateUtils';

/**
 * Generate savings auto-contributions from each schedule's startMonth
 * through the current month, backfilling any gaps.
 * Skips months where the entry already exists.
 */
export async function processSchedules(): Promise<number> {
  const { savingsSchedules, savingsEntries, transactions, categories } = getData();
  const months = monthRange(transactions);
  let created = 0;

  // Buckets that have linked categories are fed by real transactions — skip scheduler for those
  const txnFedBucketIds = new Set(
    categories.filter((c) => c.savingsBucketId != null).map((c) => c.savingsBucketId!)
  );

  for (const month of months) {
    for (const sched of savingsSchedules) {
      if (!sched.active) continue;
      if (sched.startMonth > month) continue;
      // Skip buckets that are fed by real transactions to avoid double-counting
      if (txnFedBucketIds.has(sched.bucketId)) continue;

      const alreadyExists = savingsEntries.some(
        (e) => e.scheduleId === sched.id && e.entryDate.startsWith(month),
      );
      if (alreadyExists) continue;

      const day = Math.min(sched.dayOfMonth, 28);
      const entryDate = `${month}-${String(day).padStart(2, '0')}`;

      await addSavingsEntry({
        entryDate,
        bucketId: sched.bucketId,
        amount: sched.amount,
        notes: 'Auto-contribution (schedule)',
        source: 'auto_schedule',
        scheduleId: sched.id,
      });
      created++;
    }
  }

  return created;
}

export function getBucketBalance(bucketId: number): number {
  const { savingsEntries, categories, transactions, transactionSplits } = getData();

  // All manual/scheduled entries always count toward the balance
  const entryBalance = savingsEntries
    .filter((e) => e.bucketId === bucketId)
    .reduce((sum, e) => sum + e.amount, 0);

  // Transaction-based contributions: categories linked to this bucket
  const linkedCatIds = new Set(
    categories.filter((c) => c.savingsBucketId === bucketId).map((c) => c.id)
  );

  if (linkedCatIds.size === 0) return entryBalance;

  const splitsByTxn = new Map<number, typeof transactionSplits>();
  for (const s of transactionSplits) {
    const arr = splitsByTxn.get(s.transactionId) ?? [];
    arr.push(s);
    splitsByTxn.set(s.transactionId, arr);
  }

  let txnBalance = 0;
  for (const t of transactions) {
    if (t.ignoreInBudget) continue;
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
