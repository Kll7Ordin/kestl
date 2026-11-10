import { describe, it, expect } from 'vitest';
import { __setDataForTests } from '../db';
import { categorizeTransactionsInPlace } from './categorize';
import { emptyFixture, makeTxn } from '../test/fixtures';

function setRules(rules: unknown[]) {
  const d = emptyFixture();
  d.categoryRules = rules as never;
  __setDataForTests(d);
}
const row = (descriptor: string, amount = 10) => {
  const { id: _i, ...t } = makeTxn({ descriptor, amount });
  return t;
};

describe('categorizeTransactionsInPlace', () => {
  it('exact vs contains', () => {
    setRules([
      { id: 1, matchType: 'exact', pattern: 'costco', categoryId: 1 },
      { id: 2, matchType: 'contains', pattern: 'shell', categoryId: 2 },
    ]);
    const rows = [row('COSTCO'), row('COSTCO WHOLESALE'), row('SHELL 1234')];
    categorizeTransactionsInPlace(rows);
    expect(rows.map((r) => r.categoryId)).toEqual([1, null, 2]);
  });

  it('last match wins', () => {
    setRules([
      { id: 1, matchType: 'contains', pattern: 'amazon', categoryId: 1 },
      { id: 2, matchType: 'contains', pattern: 'amazon prime', categoryId: 2 },
    ]);
    const rows = [row('AMAZON PRIME VIDEO')];
    categorizeTransactionsInPlace(rows);
    expect(rows[0].categoryId).toBe(2);
  });

  it('amountMatch tolerance', () => {
    setRules([{ id: 1, matchType: 'contains', pattern: 'gym', categoryId: 1, amountMatch: 40 }]);
    const rows = [row('GYM', 40.005), row('GYM', 41)];
    categorizeTransactionsInPlace(rows);
    expect(rows.map((r) => r.categoryId)).toEqual([1, null]);
  });

  it('split rules return a SplitAction instead of setting category', () => {
    setRules([{ id: 1, matchType: 'contains', pattern: 'costco', categoryId: 1, splits: [{ categoryId: 1, percent: 60 }, { categoryId: 2, percent: 40 }] }]);
    const rows = [row('COSTCO', 100)];
    const actions = categorizeTransactionsInPlace(rows);
    expect(rows[0].categoryId).toBeNull();
    expect(actions).toHaveLength(1);
    expect(actions[0].splits).toEqual([{ categoryId: 1, amount: 60 }, { categoryId: 2, amount: 40 }]);
  });
});
