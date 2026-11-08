import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { projectCurrentMonth, forecastMonths } from './forecast';
import { richFixture, makeTxn } from '../test/fixtures';

describe('forecast', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-15T12:00:00')); });
  afterEach(() => vi.useRealTimers());

  it('projects the current month', () => {
    const d = richFixture();
    const p = projectCurrentMonth(d, '2026-03');
    expect(p.received).toBe(4000);
    expect(p.expectedIncomeRemaining).toBe(0);
    // spent: rent 1500 + groceries (100+80-30=150) + fun 35 + hydro 120 + uncategorized 22.5 ; airline (Vacation) excluded
    expect(p.spent).toBe(1827.5);
    // planned remaining: groceries 500-150=350, rent 0, utilities 150-120=30
    expect(p.plannedRemaining).toBe(380);
    expect(p.projectedNet).toBe(4000 - 1827.5 - 380);
  });

  it('forecasts future months from the latest budgeted month', () => {
    const f = forecastMonths(richFixture(), 3);
    expect(f.map((x) => x.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    // March budget: income 4000, expenses 500+1500+150 (Vacation is from-savings and excluded)
    expect(f[0]).toEqual({ month: '2026-04', income: 4000, expense: 2150, net: 1850 });
  });

  it('adds recurring templates whose category has no budget; negative amounts are income', () => {
    const d = richFixture();
    d.recurringTemplates = [
      { id: 1, descriptor: 'Netflix', amount: 20, instrument: '', categoryId: 4, dayOfMonth: 1, active: true },
      { id: 2, descriptor: 'Side gig', amount: -300, instrument: '', categoryId: null, dayOfMonth: 1, active: true },
      { id: 3, descriptor: 'Rent dup', amount: 1500, instrument: '', categoryId: 2, dayOfMonth: 1, active: true },
    ];
    d.transactions.push(makeTxn({ id: 9999, txnDate: '2026-03-02' }));
    const f = forecastMonths(d, 1);
    expect(f[0]).toEqual({ month: '2026-04', income: 4300, expense: 2170, net: 2130 });
  });
});
