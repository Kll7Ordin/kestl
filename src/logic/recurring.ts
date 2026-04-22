import { getData, addTransaction } from '../db';
import { monthRange } from './dateUtils';

/**
 * Generate recurring template transactions from the earliest existing data
 * through the current month, backfilling any gaps.
 * Skips months where the template transaction already exists.
 */
export async function processRecurringTemplates(): Promise<number> {
  const { recurringTemplates, transactions } = getData();
  const months = monthRange(transactions);
  let created = 0;

  for (const month of months) {
    for (const tmpl of recurringTemplates) {
      if (!tmpl.active) continue;

      const alreadyExists = transactions.some(
        (t) => t.source === 'recurring' && t.sourceRef === String(tmpl.id) && t.txnDate.startsWith(month),
      );
      if (alreadyExists) continue;

      const day = Math.min(tmpl.dayOfMonth, 28);
      const txnDate = `${month}-${String(day).padStart(2, '0')}`;

      await addTransaction({
        source: 'recurring',
        sourceRef: String(tmpl.id),
        txnDate,
        amount: tmpl.amount,
        instrument: tmpl.instrument || 'Recurring',
        descriptor: tmpl.descriptor,
        categoryId: tmpl.categoryId,
        linkedTransactionId: null,
        ignoreInBudget: tmpl.ignoreInBudget ?? false,
        comment: null,
      });
      created++;
    }
  }

  return created;
}
