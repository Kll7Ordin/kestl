import type { Transaction } from '../db';

function getCurrentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Return every YYYY-MM from the earliest transaction through the current month,
 * with no gaps. If there are no transactions, returns just the current month.
 */
export function monthRange(transactions: Transaction[]): string[] {
  const current = getCurrentMonth();

  let earliest = current;
  for (const t of transactions) {
    const m = t.txnDate.slice(0, 7);
    if (m < earliest) earliest = m;
  }

  const result: string[] = [];
  let [y, m] = earliest.split('-').map(Number);
  const [endY, endM] = current.split('-').map(Number);

  while (y < endY || (y === endY && m <= endM)) {
    result.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  return result;
}
