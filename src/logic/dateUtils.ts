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

export function currentMonthStr(): string {
  return getCurrentMonth();
}

/** Inclusive list of YYYY-MM from `start` to `end`. Empty if start > end. */
export function monthsBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [endY, endM] = end.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    result.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return result;
}

/** Month immediately before `month` (YYYY-MM). */
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * "2026-09" → "September 2026". Built from local year/month parts:
 * `new Date('2026-09-01')` parses as UTC and shows the previous month west of UTC.
 */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
