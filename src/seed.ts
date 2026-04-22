import type { AppData, Category, Budget, BudgetGroup, SavingsBucket, SavingsEntry, SavingsSchedule, SplitTemplate } from './db';

/** Income category names (shown in separate section, excluded from expense remaining). */
export const INCOME_CATEGORY_NAMES = new Set(['Salary']);

/** Default budget groups for new files. */
export const DEFAULT_BUDGET_GROUPS: { name: string; sortOrder: number }[] = [
  { name: 'High Variable',              sortOrder: 0 },
  { name: 'Low Variable',               sortOrder: 1 },
  { name: 'Fixed Bills',                sortOrder: 2 },
  { name: 'Subscriptions',              sortOrder: 3 },
  { name: 'Joint Utilities',            sortOrder: 4 },
  { name: 'Short Term Savings Account', sortOrder: 5 },
  { name: 'Long Term Savings',          sortOrder: 6 },
  { name: 'Occasional',                 sortOrder: 7 },
];

/** Default categories and budget amounts for new files. */
export const DEFAULT_BUDGET_ITEMS: { name: string; group: string | null; amount: number }[] = [
  { name: 'Groceries',        group: 'High Variable',              amount: 0 },
  { name: 'Home Improvement', group: 'High Variable',              amount: 0 },
  { name: 'Household Items',  group: 'High Variable',              amount: 0 },
  { name: 'Drugstore etc.',   group: 'High Variable',              amount: 0 },
  { name: 'Family Spending',  group: 'High Variable',              amount: 0 },
  { name: 'Gas',              group: 'Low Variable',               amount: 0 },
  { name: 'Charity',          group: 'Fixed Bills',                amount: 0 },
  { name: 'Media',            group: 'Fixed Bills',                amount: 0 },
  { name: 'Mortgage',         group: 'Fixed Bills',                amount: 0 },
  { name: 'Phones',           group: 'Fixed Bills',                amount: 0 },
  { name: 'Streaming',        group: 'Subscriptions',              amount: 0 },
  { name: 'Hydro',            group: 'Joint Utilities',            amount: 0 },
  { name: 'Internet',         group: 'Joint Utilities',            amount: 0 },
  { name: 'Utilities Savings',group: 'Joint Utilities',            amount: 0 },
  { name: 'Short Term Savings',group: 'Short Term Savings Account',amount: 0 },
  { name: 'RRSP',             group: 'Long Term Savings',          amount: 0 },
  { name: 'Misc.',            group: 'Occasional',                 amount: 0 },
  { name: 'Incidentals',      group: 'Occasional',                 amount: 0 },
  { name: 'Salary',           group: null,                         amount: 0 },
];

/** Default savings buckets with monthly contribution schedules. */
export const DEFAULT_SAVINGS: { bucket: string; amount: number }[] = [];

/** Current balances for each savings bucket (opening balances for new files). */
export const DEFAULT_SAVINGS_BALANCES: { bucket: string; amount: number }[] = [];

export const DEFAULT_SPLIT_TEMPLATES: Omit<SplitTemplate, 'id'>[] = [];

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function buildDemoData(): AppData {
  const month = currentMonth();
  let nextId = 1;

  const DEMO_ITEMS: { name: string; group: string | null; amount: number }[] = [
    { name: 'Groceries',          group: 'High Variable',              amount: 700 },
    { name: 'Home Improvement',   group: 'High Variable',              amount: 200 },
    { name: 'Household Items',    group: 'High Variable',              amount: 120 },
    { name: 'Drugstore etc.',     group: 'High Variable',              amount: 80 },
    { name: 'Family Spending',    group: 'High Variable',              amount: 200 },
    { name: 'Gas',                group: 'Low Variable',               amount: 180 },
    { name: 'Charity',            group: 'Fixed Bills',                amount: 50 },
    { name: 'Media',              group: 'Fixed Bills',                amount: 30 },
    { name: 'Mortgage',           group: 'Fixed Bills',                amount: 1850 },
    { name: 'Phones',             group: 'Fixed Bills',                amount: 120 },
    { name: 'Streaming',          group: 'Subscriptions',              amount: 35 },
    { name: 'Hydro',              group: 'Joint Utilities',            amount: 130 },
    { name: 'Internet',           group: 'Joint Utilities',            amount: 75 },
    { name: 'Utilities Savings',  group: 'Joint Utilities',            amount: 100 },
    { name: 'Short Term Savings', group: 'Short Term Savings Account', amount: 300 },
    { name: 'RRSP',               group: 'Long Term Savings',          amount: 400 },
    { name: 'Misc.',              group: 'Occasional',                 amount: 100 },
    { name: 'Incidentals',        group: 'Occasional',                 amount: 80 },
    { name: 'Salary',             group: null,                         amount: 5500 },
  ];

  const categories: Category[] = DEMO_ITEMS.map(({ name }) => ({
    id: nextId++,
    name,
    isIncome: INCOME_CATEGORY_NAMES.has(name),
  }));

  const catByName = new Map(categories.map((c) => [c.name, c.id]));

  const budgetGroups: BudgetGroup[] = DEFAULT_BUDGET_GROUPS.map(({ name, sortOrder }) => ({
    id: nextId++,
    name,
    sortOrder,
  }));
  const groupIdByName = new Map(budgetGroups.map((g) => [g.name, g.id]));

  const budgets: Budget[] = DEMO_ITEMS.map(({ name, amount, group }) => ({
    id: nextId++,
    month,
    categoryId: catByName.get(name)!,
    targetAmount: amount,
    groupId: group != null ? (groupIdByName.get(group) ?? null) : null,
  }));

  const savingsBuckets: SavingsBucket[] = [
    { id: nextId++, name: 'Emergency Fund' },
    { id: nextId++, name: 'Vacation' },
  ];

  return {
    nextId,
    categories,
    categoryRules: [],
    budgetGroups,
    budgets,
    transactions: [],
    transactionSplits: [],
    savingsBuckets,
    savingsEntries: [],
    savingsSchedules: [],
    recurringTemplates: [],
    splitTemplates: [],
    experimentalBudgets: [],
  };
}

export function buildSeedData(): AppData {
  const month = currentMonth();
  let nextId = 1;

  const categories: Category[] = DEFAULT_BUDGET_ITEMS.map(({ name }) => ({
    id: nextId++,
    name,
    isIncome: INCOME_CATEGORY_NAMES.has(name),
  }));

  const catByName = new Map(categories.map((c) => [c.name, c.id]));

  const budgetGroups: BudgetGroup[] = DEFAULT_BUDGET_GROUPS.map(({ name, sortOrder }) => ({
    id: nextId++,
    name,
    sortOrder,
  }));
  const groupIdByName = new Map(budgetGroups.map((g) => [g.name, g.id]));

  const budgetMonths = [month];
  const budgets: Budget[] = [];
  for (const m of budgetMonths) {
    for (const { name, amount, group } of DEFAULT_BUDGET_ITEMS) {
      const categoryId = catByName.get(name)!;
      const groupId = group != null ? (groupIdByName.get(group) ?? null) : null;
      budgets.push({ id: nextId++, month: m, categoryId, targetAmount: amount, groupId });
    }
  }

  const savingsBuckets: SavingsBucket[] = [];
  const savingsSchedules: SavingsSchedule[] = [];
  const savingsEntries: SavingsEntry[] = [];
  const bucketIdByName = new Map<string, number>();

  for (const { bucket, amount } of DEFAULT_SAVINGS) {
    const bucketId = nextId++;
    savingsBuckets.push({ id: bucketId, name: bucket });
    bucketIdByName.set(bucket, bucketId);
    savingsSchedules.push({
      id: nextId++,
      bucketId,
      dayOfMonth: 1,
      amount,
      startMonth: nextMonth(),
      active: true,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const { bucket, amount } of DEFAULT_SAVINGS_BALANCES) {
    const bucketId = bucketIdByName.get(bucket);
    if (bucketId != null && amount !== 0) {
      savingsEntries.push({
        id: nextId++,
        entryDate: today,
        bucketId,
        amount,
        notes: 'Opening balance (first schedule contribution is next month)',
        source: 'manual',
        scheduleId: null,
      });
    }
  }

  const splitTemplates: SplitTemplate[] = DEFAULT_SPLIT_TEMPLATES.map((t) => ({
    id: nextId++,
    name: t.name,
    items: t.items,
  }));

  return {
    nextId,
    categories,
    categoryRules: [],
    budgetGroups,
    budgets,
    transactions: [],
    transactionSplits: [],
    savingsBuckets,
    savingsEntries,
    savingsSchedules,
    recurringTemplates: [],
    splitTemplates,
  };
}
