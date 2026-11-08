import { getData, bulkAddTransactions, type Transaction } from '../db';
import { currentMonthStr, monthsBetween } from './dateUtils';

/**
 * Generate recurring template transactions from each template's startMonth through
 * the current month. Skips months that already have an occurrence or were deleted
 * (skippedMonths tombstones). All new transactions are written with ONE save.
 */
export async function processRecurringTemplates(): Promise<number> {
  const { recurringTemplates, transactions } = getData();
  const current = currentMonthStr();

  const existing = new Set<string>();
  for (const t of transactions) {
    if (t.source === 'recurring') existing.add(`${t.sourceRef}|${t.txnDate.slice(0, 7)}`);
  }

  const toAdd: Omit<Transaction, 'id'>[] = [];
  for (const tmpl of recurringTemplates) {
    if (!tmpl.active) continue;
    const skipped = new Set(tmpl.skippedMonths ?? []);
    const day = Math.min(tmpl.dayOfMonth, 28);
    for (const month of monthsBetween(tmpl.startMonth ?? current, current)) {
      if (skipped.has(month) || existing.has(`${tmpl.id}|${month}`)) continue;
      toAdd.push({
        source: 'recurring',
        sourceRef: String(tmpl.id),
        txnDate: `${month}-${String(day).padStart(2, '0')}`,
        amount: tmpl.amount,
        instrument: tmpl.instrument || 'Recurring',
        descriptor: tmpl.descriptor,
        categoryId: tmpl.categoryId,
        linkedTransactionId: null,
        ignoreInBudget: tmpl.ignoreInBudget ?? false,
        comment: null,
      });
    }
  }
  if (toAdd.length > 0) await bulkAddTransactions(toAdd);
  return toAdd.length;
}
