import type { AppData, Transaction, Category, Budget, TransactionSplit } from '../db';

let _id = 1000;
const nid = () => _id++;

export function makeTxn(p: Partial<Transaction> = {}): Transaction {
  return {
    id: nid(), source: 'bank_csv', sourceRef: '', txnDate: '2026-03-01', amount: 10,
    instrument: 'Scotiabank Credit Card CSV', descriptor: 'TEST', categoryId: null,
    linkedTransactionId: null, ignoreInBudget: false, comment: null, ...p,
  };
}
export function makeCategory(p: Partial<Category> & { id: number; name: string }): Category {
  return { ...p };
}
export function makeBudget(p: Partial<Budget> & { month: string; categoryId: number; targetAmount: number }): Budget {
  return { id: nid(), ...p };
}
export function makeSplit(p: Partial<TransactionSplit> & { transactionId: number; categoryId: number; amount: number }): TransactionSplit {
  return { id: nid(), ...p };
}

export function emptyFixture(): AppData {
  return {
    nextId: 5000, categories: [], categoryRules: [], budgetGroups: [], budgets: [], transactions: [],
    transactionSplits: [], savingsBuckets: [], savingsEntries: [], savingsSchedules: [],
    recurringTemplates: [], splitTemplates: [], experimentalBudgets: [],
  };
}

/**
 * Canonical fixture. Category ids: 1 Groceries, 2 Rent, 3 Salary (income), 4 Fun (no budget in March),
 * 5 Vacation (spend-from-savings group), 6 Utilities.
 */
export function richFixture(): AppData {
  const d = emptyFixture();
  d.categories = [
    makeCategory({ id: 1, name: 'Groceries' }),
    makeCategory({ id: 2, name: 'Rent' }),
    makeCategory({ id: 3, name: 'Salary', isIncome: true }),
    makeCategory({ id: 4, name: 'Fun' }),
    makeCategory({ id: 5, name: 'Vacation' }),
    makeCategory({ id: 6, name: 'Utilities' }),
  ];
  d.budgetGroups = [
    { id: 1, name: 'Essentials', sortOrder: 0 },
    { id: 2, name: 'Occasional', sortOrder: 1, spendFromSavings: true },
  ];
  const months = ['2025-12', '2026-01', '2026-02', '2026-03'];
  let b = 1;
  for (const m of months) {
    d.budgets.push({ id: b++, month: m, categoryId: 1, targetAmount: 500, groupId: 1 });
    d.budgets.push({ id: b++, month: m, categoryId: 2, targetAmount: 1500, groupId: 1 });
    d.budgets.push({ id: b++, month: m, categoryId: 3, targetAmount: 4000 });
    d.budgets.push({ id: b++, month: m, categoryId: 5, targetAmount: 200, groupId: 2 });
    d.budgets.push({ id: b++, month: m, categoryId: 6, targetAmount: 150, groupId: 1 });
    if (m !== '2026-03') d.budgets.push({ id: b++, month: m, categoryId: 4, targetAmount: 100 });
  }
  let t = 1;
  const T = (p: Partial<Transaction>) => d.transactions.push(makeTxnId(t++, p));
  // Dec -> Jan boundary
  T({ txnDate: '2025-12-28', amount: 120, descriptor: 'SAVE ON FOODS', categoryId: 1 });
  T({ txnDate: '2025-12-31', amount: 1500, descriptor: 'RENT', categoryId: 2 });
  T({ txnDate: '2025-12-15', amount: -4000, descriptor: 'PAYROLL', categoryId: 3, ignoreInBudget: true });
  T({ txnDate: '2026-01-02', amount: 90, descriptor: 'SAVE ON FOODS', categoryId: 1 });
  T({ txnDate: '2026-01-15', amount: -4000, descriptor: 'PAYROLL', categoryId: 3, ignoreInBudget: true });
  T({ txnDate: '2026-02-01', amount: 1500, descriptor: 'RENT', categoryId: 2 });
  T({ txnDate: '2026-02-10', amount: 60, descriptor: 'SAVE ON FOODS', categoryId: 1 });
  T({ txnDate: '2026-02-12', amount: 40, descriptor: 'CINEMA', categoryId: 4 });
  // March
  T({ txnDate: '2026-03-01', amount: 1500, descriptor: 'RENT', categoryId: 2 });
  T({ txnDate: '2026-03-05', amount: 100, descriptor: 'SAVE ON FOODS', categoryId: 1 });
  T({ txnDate: '2026-03-06', amount: -4000, descriptor: 'PAYROLL', categoryId: 3, ignoreInBudget: true });
  T({ txnDate: '2026-03-08', amount: 35, descriptor: 'CINEMA', categoryId: 4 }); // off-budget in March
  T({ txnDate: '2026-03-09', amount: 22.5, descriptor: 'MYSTERY SHOP', categoryId: null }); // uncategorized
  T({ txnDate: '2026-03-10', amount: 300, descriptor: 'AIRLINE', categoryId: 5 }); // spend from savings
  // refund linked to original
  const orig = makeTxnId(t++, { txnDate: '2026-03-11', amount: 80, descriptor: 'SAVE ON FOODS BIG', categoryId: 1 });
  const refund = makeTxnId(t++, { txnDate: '2026-03-12', amount: -30, descriptor: 'SAVE ON FOODS REFUND', categoryId: 1, linkedTransactionId: orig.id });
  orig.linkedTransactionId = refund.id;
  d.transactions.push(orig, refund);
  // split with next-month override: 200 hydro split Utilities 120 now, 80 into April
  const split = makeTxnId(t++, { txnDate: '2026-03-20', amount: 200, descriptor: 'HYDRO', categoryId: null });
  d.transactions.push(split);
  d.transactionSplits.push(
    { id: 1, transactionId: split.id, categoryId: 6, amount: 120 },
    { id: 2, transactionId: split.id, categoryId: 6, amount: 80, txnDate: '2026-04-01' },
  );
  d.nextId = 5000;
  return d;
}

function makeTxnId(id: number, p: Partial<Transaction>): Transaction {
  return { ...makeTxn(p), id };
}
