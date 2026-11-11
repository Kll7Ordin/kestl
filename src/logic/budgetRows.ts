import { getData, type Category, type BudgetGroup } from '../db';
import { INCOME_CATEGORY_NAMES } from '../seed';
import { getMonthAggregates, getRolloverCarry } from './spend';

export interface BudgetRow {
  categoryId: number;
  categoryName: string;
  note?: string;
  budgetNote?: string;
  target: number;
  spent: number;
  ytd: number;
  ytdTarget: number;
  ytdDiff: number;
  /** Avg monthly spend over the last 12 tracked months (current excluded) minus this month's target. */
  avgDiff12: number;
  avgMonthCount12: number;
  /** Same over the last 3 months. */
  avgDiff3: number;
  avgMonthCount3: number;
  /** Rollover carried in from previous months (0 when rollover is off). Available = target + carry. */
  carry: number;
  relevantMonthCount: number;
  isIncome?: boolean;
  groupId?: number | null;
  sortOrder?: number;
}

export interface BuildRowsResult {
  rows: BudgetRow[];
  priorMonthCount: number;
  allIncomeReceived: number;
  /** Non-credit, non-split, uncategorized debits this month. */
  uncatTotal: number;
  /** Spending in expense categories that have no budget this month. */
  offBudgetTotal: number;
}

export function buildRows(month: string, categories: Category[], _budgetGroups: BudgetGroup[], ytdMode: 'ytd' | 'rolling12'): BuildRowsResult {
  const d = getData();
  const budgets = d.budgets.filter((b) => b.month === month);
  const catById = new Map(categories.map((c) => [c.id, c]));

  const [yearNum, monthNum] = month.split('-').map(Number);

  const priorMonths: string[] = [];
  if (ytdMode === 'rolling12') {
    for (let i = 12; i >= 1; i--) {
      const pd = new Date(yearNum, monthNum - 1 - i, 1);
      priorMonths.push(`${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`);
    }
  } else {
    for (let m = 1; m < monthNum; m++) {
      priorMonths.push(`${yearNum}-${String(m).padStart(2, '0')}`);
    }
  }

  const incomplete = new Set(d.incompleteMonths ?? []);
  for (let i = priorMonths.length - 1; i >= 0; i--) if (incomplete.has(priorMonths[i])) priorMonths.splice(i, 1);

  // The N calendar months before this one (ignores the YTD/rolling setting)
  const lastMonths = (n: number) => {
    const out: string[] = [];
    for (let i = n; i >= 1; i--) {
      const pd = new Date(yearNum, monthNum - 1 - i, 1);
      const key = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;
      if (!incomplete.has(key)) out.push(key);
    }
    return out;
  };
  const avgWindow12 = lastMonths(12);
  const avgWindow3 = lastMonths(3);

  const aggs = getMonthAggregates(d);
  const cur = aggs.get(month);
  const spendByCategory = cur?.debitByCat ?? new Map<number, number>();
  const incomeByCategory = cur?.creditByCat ?? new Map<number, number>();
  const sumPrior = (field: 'debitByCat' | 'creditByCat', catId: number) => {
    let sum = 0;
    for (const pm of priorMonths) sum += aggs.get(pm)?.[field].get(catId) ?? 0;
    return sum;
  };

  // Months that had at least one transaction globally (user was actively tracking)
  const monthsWithTxns = new Set<string>();
  for (const t of d.transactions) monthsWithTxns.add(t.txnDate.slice(0, 7));

  // categoryId → (month → target), built once
  const budgetsByCat = new Map<number, Map<string, number>>();
  for (const b2 of d.budgets) {
    let m = budgetsByCat.get(b2.categoryId);
    if (!m) { m = new Map(); budgetsByCat.set(b2.categoryId, m); }
    m.set(b2.month, b2.targetAmount);
  }

  const rows = budgets.map((b) => {
    const cat = catById.get(b.categoryId);
    const isIncome = cat?.isIncome === true || (cat != null && INCOME_CATEGORY_NAMES.has(cat.name));
    const grossSpent = spendByCategory.get(b.categoryId) ?? 0;
    const credits = incomeByCategory.get(b.categoryId) ?? 0;
    const ytdGross = sumPrior('debitByCat', b.categoryId);
    const ytdCredits = sumPrior('creditByCat', b.categoryId);
    const ytd = isIncome ? ytdCredits : ytdGross - ytdCredits;

    // Relevant prior months: this category had a budget AND the month had any transactions
    const catBudgetByMonth = budgetsByCat.get(b.categoryId) ?? new Map<string, number>();
    const relevantPriorMonths = priorMonths.filter((pm) => monthsWithTxns.has(pm) && catBudgetByMonth.has(pm));
    const ytdTarget = relevantPriorMonths.reduce((s, pm) => s + (catBudgetByMonth.get(pm) ?? 0), 0);
    const ytdDiff = ytd - ytdTarget;
    const relevantMonthCount = relevantPriorMonths.length;

    // Avg ±/mo: average net spend over the last N tracked months (current month excluded),
    // measured against THIS month's target so editing the target moves it right away.
    const avgDiff = (window: string[]) => {
      const used = window.filter((pm) => monthsWithTxns.has(pm) && catBudgetByMonth.has(pm));
      let spent = 0;
      for (const pm of used) {
        const a = aggs.get(pm);
        const debit = a?.debitByCat.get(b.categoryId) ?? 0;
        const credit = a?.creditByCat.get(b.categoryId) ?? 0;
        spent += isIncome ? credit : debit - credit;
      }
      return { diff: used.length > 0 ? spent / used.length - b.targetAmount : 0, count: used.length };
    };
    const a12 = avgDiff(avgWindow12);
    const a3 = avgDiff(avgWindow3);

    return {
      categoryId: b.categoryId,
      categoryName: cat?.name ?? '?',
      note: cat?.note,
      budgetNote: b.note,
      target: b.targetAmount,
      spent: isIncome ? credits : grossSpent - credits,
      carry: isIncome ? 0 : getRolloverCarry(d, b.categoryId, month),
      ytd, ytdTarget, ytdDiff, relevantMonthCount, isIncome,
      avgDiff12: a12.diff, avgMonthCount12: a12.count,
      avgDiff3: a3.diff, avgMonthCount3: a3.count,
      groupId: b.groupId ?? null,
      sortOrder: (b as { sortOrder?: number }).sortOrder ?? 0,
    };
  });
  // Sum income received from ALL income categories, regardless of whether a budget entry exists
  const allIncomeCatIds = new Set(
    categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id)
  );
  let allIncomeReceived = 0;
  for (const [catId, amount] of incomeByCategory) {
    if (allIncomeCatIds.has(catId)) allIncomeReceived += amount;
  }


  // Off-budget: expense spending in categories without a budget this month
  const budgetCatIds = new Set(budgets.map((b) => b.categoryId));
  const excludedCatIds = new Set(categories.filter((c) => c.excludeFromOffBudget).map((c) => c.id));
  let offBudgetTotal = 0;
  for (const [catId, amount] of spendByCategory) {
    if (!budgetCatIds.has(catId) && !allIncomeCatIds.has(catId) && !excludedCatIds.has(catId)) offBudgetTotal += amount;
  }

  return { rows, priorMonthCount: priorMonths.length, allIncomeReceived, uncatTotal: cur?.uncategorizedDebit ?? 0, offBudgetTotal };
}

