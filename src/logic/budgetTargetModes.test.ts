import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __setDataForTests, getData, type ExperimentalBudget } from '../db';
import { buildRows, buildSandboxRows } from './budgetRows';
import { richFixture } from '../test/fixtures';

describe('target modes and sandbox rows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00'));
    __setDataForTests(richFixture());
  });
  afterEach(() => vi.useRealTimers());

  it("'current' compares every tracked past month against this month's target", () => {
    const d = getData();
    const atTime = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd', 'atTime').rows;
    const current = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd', 'current').rows;
    const tracked = new Set(d.transactions.map((t) => t.txnDate.slice(0, 7)));
    const trackedPrior = ['2026-01', '2026-02'].filter((m) => tracked.has(m)).length;
    for (const r of current) {
      expect(r.ytdTarget).toBeCloseTo(r.target * trackedPrior);
      expect(r.ytdDiff).toBeCloseTo(r.ytd - r.ytdTarget);
      // Spending itself doesn't depend on the mode
      const same = atTime.find((a) => a.categoryId === r.categoryId)!;
      expect(r.ytd).toBeCloseTo(same.ytd);
      expect(r.spent).toBeCloseTo(same.spent);
    }
  });

  it('sandbox lines count spending from tagged categories', () => {
    const d = getData();
    const groceries = d.categories.find((c) => c.name === 'Groceries')!;
    const fun = d.categories.find((c) => c.name === 'Fun')!;
    const sandbox = (sourceCategoryIds?: number[]): ExperimentalBudget => ({
      id: 1, name: 'Test', createdAt: '2026-01-01',
      items: [{ categoryId: groceries.id, categoryName: 'Food', groupId: null, groupName: null, targetAmount: 500, sourceCategoryIds }],
      groups: [],
    });
    const live = buildRows('2026-03', d.categories, d.budgetGroups, 'ytd').rows.find((r) => r.categoryId === groceries.id)!;
    const plain = buildSandboxRows(sandbox(), '2026-03', d.categories, 'ytd');
    const tagged = buildSandboxRows(sandbox([fun.id]), '2026-03', d.categories, 'ytd');

    expect(plain.rows[0].categoryName).toBe('Food');
    expect(plain.rows[0].spent).toBeCloseTo(live.spent);
    expect(tagged.rows[0].spent).toBeCloseTo(live.spent + 35); // Fun spent $35 in March
    // Once tagged, Fun's spending is no longer "outside the sandbox"
    expect(tagged.offBudgetTotal).toBeCloseTo(plain.offBudgetTotal - 35);
  });
});
