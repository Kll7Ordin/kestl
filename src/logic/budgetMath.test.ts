import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __setDataForTests, getData } from '../db';
import { buildRows } from './budgetRows';
import { computeYearData } from './yearData';
import { richFixture } from '../test/fixtures';

describe('budget math characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00'));
    __setDataForTests(richFixture());
  });
  afterEach(() => vi.useRealTimers());

  for (const month of ['2026-01', '2026-03', '2026-04']) {
    for (const mode of ['ytd', 'rolling12'] as const) {
      it(`buildRows ${month} ${mode}`, () => {
        const d = getData();
        const { rows, priorMonthCount, allIncomeReceived } = buildRows(month, d.categories, d.budgetGroups, mode);
        expect({ rows, priorMonthCount, allIncomeReceived }).toMatchSnapshot();
      });
    }
  }

  it('Avg ±/mo uses this month as the baseline, so editing its target moves it', () => {
    const d = getData();
    const before = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd').rows.find((r) => r.categoryName === 'Groceries')!;
    const budgets = d.budgets.map((b) => (b.month === '2026-03' && b.categoryId === before.categoryId ? { ...b, targetAmount: b.targetAmount + 100 } : b));
    __setDataForTests({ ...d, budgets });
    const after = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd').rows.find((r) => r.categoryName === 'Groceries')!;
    expect(after.avgDiff12).toBeCloseTo(before.avgDiff12 - 100);
    expect(after.avgDiff3).toBeCloseTo(before.avgDiff3 - 100);
    expect(after.avgMonthCount12).toBe(before.avgMonthCount12);
  });

  it('Avg ±/mo windows cover at most 12 and 3 prior months', () => {
    const d = getData();
    for (const r of buildRows('2026-04', d.categories, d.budgetGroups, 'ytd').rows) {
      expect(r.avgMonthCount12).toBeLessThanOrEqual(12);
      expect(r.avgMonthCount3).toBeLessThanOrEqual(3);
    }
  });

  it('uncategorized and off-budget totals', () => {
    const d = getData();
    const r = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd');
    expect(r.uncatTotal).toBeCloseTo(22.5);
    expect(r.offBudgetTotal).toBeCloseTo(35); // Fun has no March budget
  });

  it('categories flagged excludeFromOffBudget are left out of the off-budget total', () => {
    const d = getData();
    const cats = d.categories.map((c) => (c.name === 'Fun' ? { ...c, excludeFromOffBudget: true } : c));
    expect(buildRows('2026-03', cats, d.budgetGroups, 'ytd').offBudgetTotal).toBeCloseTo(0);
  });

  it('computeYearData 2026 overall', () => {
    expect(computeYearData(getData(), { year: 2026, scope: 'overall', selectedCats: [], selectedGroups: [], ytdMode: 'ytd' })).toMatchSnapshot();
  });
  it('computeYearData rolling12', () => {
    expect(computeYearData(getData(), { year: 2026, scope: 'overall', selectedCats: [], selectedGroups: [], ytdMode: 'rolling12' })).toMatchSnapshot();
  });
  it('computeYearData by category', () => {
    expect(computeYearData(getData(), { year: 2026, scope: 'categories', selectedCats: [1], selectedGroups: [], ytdMode: 'ytd' })).toMatchSnapshot();
  });
});
