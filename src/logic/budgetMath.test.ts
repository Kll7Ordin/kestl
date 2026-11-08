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

  it('uncategorized and off-budget totals', () => {
    const d = getData();
    const r = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd');
    expect(r.uncatTotal).toBeCloseTo(22.5);
    expect(r.offBudgetTotal).toBeCloseTo(35); // Fun has no March budget
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
