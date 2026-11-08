import { describe, it, expect } from 'vitest';
import { __setDataForTests } from '../db';
import { categorizeTransactionsInPlace, guessCategory, getGuessScores } from './categorize';
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

describe('guessCategory tiers', () => {
  const corpus = [
    makeTxn({ descriptor: 'SAVE ON FOODS #123', categoryId: 1 }),
    makeTxn({ descriptor: 'SAVE ON FOODS #456', categoryId: 1 }),
    makeTxn({ descriptor: 'PETRO CANADA', categoryId: 2 }),
  ];
  it('exact match scores 40', () => {
    expect(getGuessScores('PETRO CANADA', corpus).get(2)).toBe(40);
  });
  it('id-stripped match scores 25 each', () => {
    expect(getGuessScores('SAVE ON FOODS #999', corpus).get(1)).toBe(50);
  });
  it('guess returns best category', () => {
    expect(guessCategory('SAVE ON FOODS #999', corpus)).toBe(1);
  });
  it('returns null with no signal', () => {
    expect(guessCategory('ZZZZ QQQQ', corpus)).toBeNull();
  });
});

describe('batchGetGuessScores equals per-query scoring', () => {
  it('produces identical scores on the rich fixture plus extras', async () => {
    const { richFixture } = await import('../test/fixtures');
    const { batchGetGuessScores } = await import('./categorize');
    const d = richFixture();
    __setDataForTests(d);
    const extra = ['SAVE ON FOODS #123456', 'save  on foods', 'CINEMA 99', 'PAYROLL DEPOSIT', 'RENT MARCH', 'HYDRO BC', 'ZZ UNKNOWN'];
    const queries = [...d.transactions.map((t) => ({ id: t.id, descriptor: t.descriptor })), ...extra.map((e, i) => ({ id: 9000 + i, descriptor: e }))];
    const batch = batchGetGuessScores(queries, d.transactions);
    for (const q of queries) {
      const single = getGuessScores(q.descriptor, d.transactions);
      const b = batch.get(q.id) ?? new Map();
      expect([...b.entries()].sort()).toEqual([...single.entries()].sort());
    }
  });
});
