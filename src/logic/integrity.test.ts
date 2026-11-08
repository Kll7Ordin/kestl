import { describe, it, expect, beforeEach } from 'vitest';
import {
  __setDataForTests, getData, deleteCategory, mergeCategories, getCategoryUsage, setCategoryArchived,
  getSelectableCategories, startupCleanup, setSplits,
} from '../db';
import { resolveSplits, recategorizeAll, runRuleOnHistory, batchGetGuessScores } from './categorize';
import { getMonthAggregates, getRolloverCarry } from './spend';
import { emptyFixture, makeTxn, richFixture } from '../test/fixtures';

describe('resolveSplits', () => {
  it('rounds to cents and puts stray cents on the last split', () => {
    const r = resolveSplits([{ categoryId: 1, percent: 33.33 }, { categoryId: 2, percent: 33.33 }, { categoryId: 3, percent: 33.34 }], 100.01);
    expect(r.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(100.01, 10);
  });
  it('fixed amounts on a different-sized txn: remainder to last', () => {
    const r = resolveSplits([{ categoryId: 1, amount: 30 }, { categoryId: 2, amount: 20 }], 60);
    expect(r).toEqual([{ categoryId: 1, amount: 30 }, { categoryId: 2, amount: 30 }]);
  });
});

describe('split transactions are not re-split', () => {
  it('recategorizeAll skips transactions that already have splits', async () => {
    const d = emptyFixture();
    d.categories = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    d.categoryRules = [{ id: 1, matchType: 'contains', pattern: 'costco', categoryId: 1, splits: [{ categoryId: 1, percent: 50 }, { categoryId: 2, percent: 50 }] }];
    d.transactions = [makeTxn({ id: 1, descriptor: 'COSTCO', amount: 100 }), makeTxn({ id: 2, descriptor: 'COSTCO', amount: 80 })];
    d.transactionSplits = [{ id: 1, transactionId: 2, categoryId: 1, amount: 80 }];
    __setDataForTests(d);
    expect(await recategorizeAll()).toBe(1);
    const sp = getData().transactionSplits;
    expect(sp.filter((s) => s.transactionId === 1)).toHaveLength(2);
    expect(sp.filter((s) => s.transactionId === 2)).toHaveLength(1);
  });

  it('runRuleOnHistory without includeAlreadyCategorized skips split parents', async () => {
    const d = emptyFixture();
    d.categories = [{ id: 1, name: 'A' }];
    d.categoryRules = [{ id: 1, matchType: 'contains', pattern: 'x', categoryId: 1 }];
    d.transactions = [makeTxn({ id: 1, descriptor: 'X' })];
    d.transactionSplits = [{ id: 1, transactionId: 1, categoryId: 1, amount: 10 }];
    __setDataForTests(d);
    expect(await runRuleOnHistory({ ruleId: 1, includeAlreadyCategorized: false })).toBe(0);
  });
});

describe('category integrity', () => {
  beforeEach(() => __setDataForTests(richFixture()));

  it('refuses to delete a category in use', async () => {
    expect(getCategoryUsage(1).total).toBeGreaterThan(0);
    await expect(deleteCategory(1)).rejects.toThrow();
    await setCategoryArchived(1, true);
    expect(getSelectableCategories().find((c) => c.id === 1)).toBeUndefined();
    expect(getData().categories.find((c) => c.id === 1)).toBeDefined();
  });

  it('merge adds budgets for the same month and repoints references', async () => {
    const before = getData().budgets.filter((b) => b.month === '2026-03' && (b.categoryId === 1 || b.categoryId === 6)).reduce((s, b) => s + b.targetAmount, 0);
    await mergeCategories([6], 1);
    const after = getData().budgets.filter((b) => b.month === '2026-03' && b.categoryId === 1);
    expect(after).toHaveLength(1);
    expect(after[0].targetAmount).toBe(before);
    expect(getData().transactionSplits.every((s) => s.categoryId !== 6)).toBe(true);
    expect(getData().categories.find((c) => c.id === 6)).toBeUndefined();
  });

  it('merge re-points the budget when the target had none that month', async () => {
    await mergeCategories([4], 6); // Fun had budgets Dec-Feb, Utilities had them too except none missing
    expect(getData().budgets.some((b) => b.categoryId === 4)).toBe(false);
  });

  it('orphan-ref repair migration', async () => {
    const d = richFixture();
    d.transactions.push(makeTxn({ id: 900, categoryId: 99 }));
    d.budgets.push({ id: 900, month: '2026-03', categoryId: 99, targetAmount: 5 });
    d.recurringTemplates = [{ id: 5, descriptor: 'r', amount: 1, instrument: '', categoryId: 99, dayOfMonth: 1, active: true }];
    __setDataForTests(d);
    await startupCleanup();
    expect(getData().transactions.find((t) => t.id === 900)?.categoryId).toBeNull();
    expect(getData().budgets.find((b) => b.id === 900)).toBeUndefined();
    expect(getData().recurringTemplates[0].categoryId).toBeNull();
  });
});

describe('spend aggregates', () => {
  it('matches the split-date override rule and caches by array identity', () => {
    const d = richFixture();
    const a = getMonthAggregates(d);
    expect(a.get('2026-03')!.debitByCat.get(6)).toBe(120);
    expect(a.get('2026-04')!.debitByCat.get(6)).toBe(80);
    expect(getMonthAggregates(d)).toBe(a);
    expect(a.get('2026-03')!.uncategorizedDebit).toBeCloseTo(22.5);
  });
  it('excludes transfers', () => {
    const d = richFixture();
    d.transactions.find((t) => t.descriptor === 'MYSTERY SHOP')!.isTransfer = true;
    expect(getMonthAggregates(d).get('2026-03')!.uncategorizedDebit).toBe(0);
  });
});

describe('suggestions', () => {
  it('batch matches single scoring and skips archived categories', () => {
    const d = emptyFixture();
    d.categories = [{ id: 1, name: 'A' }, { id: 2, name: 'B', archived: true }];
    d.transactions = [makeTxn({ descriptor: 'SHOP ONE', categoryId: 1 }), makeTxn({ descriptor: 'SHOP TWO', categoryId: 2 })];
    __setDataForTests(d);
    const r = batchGetGuessScores([{ id: 1, descriptor: 'SHOP ONE' }, { id: 2, descriptor: 'SHOP TWO' }], getData().transactions);
    expect(r.get(1)?.get(1)).toBe(40);
    expect(r.get(2)?.has(2)).toBeFalsy();
  });
});

describe('rollover', () => {
  it('carry builds up, goes negative on overspend, starts at rolloverStartMonth', () => {
    const d = emptyFixture();
    d.categories = [{ id: 1, name: 'Fun', rollover: true, rolloverStartMonth: '2026-01' }];
    d.budgets = ['2025-12', '2026-01', '2026-02', '2026-03'].map((m, i) => ({ id: i + 1, month: m, categoryId: 1, targetAmount: 100 }));
    d.transactions = [
      makeTxn({ id: 1, txnDate: '2025-12-05', amount: 500, categoryId: 1 }), // before start: ignored
      makeTxn({ id: 2, txnDate: '2026-01-05', amount: 40, categoryId: 1 }),
      makeTxn({ id: 3, txnDate: '2026-02-05', amount: 160, categoryId: 1 }),
    ];
    expect(getRolloverCarry(d, 1, '2026-01')).toBe(0);
    expect(getRolloverCarry(d, 1, '2026-02')).toBe(60);
    expect(getRolloverCarry(d, 1, '2026-03')).toBe(0); // 60 + (100-160)
    expect(getRolloverCarry(d, 1, '2026-04')).toBe(100);
  });
});

describe('setSplits keeps array identity semantic', () => {
  it('replaces existing splits', async () => {
    __setDataForTests(richFixture());
    const id = getData().transactionSplits[0].transactionId;
    await setSplits(id, [{ categoryId: 1, amount: 200 }]);
    expect(getData().transactionSplits.filter((s) => s.transactionId === id)).toHaveLength(1);
  });
});
