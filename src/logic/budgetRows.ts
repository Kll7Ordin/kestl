import { getData, type Category, type BudgetGroup, type ExperimentalBudget } from '../db';
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
  /** Sandbox only: extra historical categories counted in this line's spending. */
  sourceCategoryIds?: number[];
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

export type TargetMode = 'atTime' | 'current';

function monthKey(y: number, m0: number): string {
  const d = new Date(y, m0, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Everything about the month being viewed that every line's stats share. */
function buildContext(month: string, categories: Category[], ytdMode: 'ytd' | 'rolling12') {
  const d = getData();
  const [yearNum, monthNum] = month.split('-').map(Number);
  const incomplete = new Set(d.incompleteMonths ?? []);

  const priorMonths: string[] = [];
  if (ytdMode === 'rolling12') {
    for (let i = 12; i >= 1; i--) priorMonths.push(monthKey(yearNum, monthNum - 1 - i));
  } else {
    for (let m = 1; m < monthNum; m++) priorMonths.push(`${yearNum}-${String(m).padStart(2, '0')}`);
  }
  for (let i = priorMonths.length - 1; i >= 0; i--) if (incomplete.has(priorMonths[i])) priorMonths.splice(i, 1);

  // The N calendar months before this one (ignores the YTD/rolling setting)
  const lastMonths = (n: number) => {
    const out: string[] = [];
    for (let i = n; i >= 1; i--) {
      const key = monthKey(yearNum, monthNum - 1 - i);
      if (!incomplete.has(key)) out.push(key);
    }
    return out;
  };

  // Months that had at least one transaction globally (user was actively tracking)
  const monthsWithTxns = new Set<string>();
  for (const t of d.transactions) monthsWithTxns.add(t.txnDate.slice(0, 7));

  const incomeCatIds = new Set(
    categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id),
  );

  return {
    d,
    month,
    priorMonths,
    avgWindow12: lastMonths(12),
    avgWindow3: lastMonths(3),
    monthsWithTxns,
    aggs: getMonthAggregates(d),
    incomeCatIds,
  };
}
type StatsContext = ReturnType<typeof buildContext>;

/**
 * Spending stats for one budget line.
 * `catIds` are the categories whose spending counts toward it.
 * `targetInMonth(pm)` is the target that applied in a past month, or undefined when the line had no budget then.
 */
function lineStats(
  ctx: StatsContext,
  catIds: number[],
  isIncome: boolean,
  target: number,
  targetInMonth: (pm: string) => number | undefined,
) {
  const net = (pm: string) => {
    const a = ctx.aggs.get(pm);
    let debit = 0, credit = 0;
    for (const id of catIds) {
      debit += a?.debitByCat.get(id) ?? 0;
      credit += a?.creditByCat.get(id) ?? 0;
    }
    return isIncome ? credit : debit - credit;
  };

  const ytd = ctx.priorMonths.reduce((s, pm) => s + net(pm), 0);

  // Relevant prior months: the line had a target AND the month had any transactions
  const relevant = (pm: string) => ctx.monthsWithTxns.has(pm) && targetInMonth(pm) !== undefined;
  const relevantPriorMonths = ctx.priorMonths.filter(relevant);
  const ytdTarget = relevantPriorMonths.reduce((s, pm) => s + (targetInMonth(pm) ?? 0), 0);

  // Avg ±/mo: average net spend over the last N tracked months (current month excluded),
  // measured against THIS month's target so editing the target moves it right away.
  const avgDiff = (window: string[]) => {
    const used = window.filter(relevant);
    const spent = used.reduce((s, pm) => s + net(pm), 0);
    return { diff: used.length > 0 ? spent / used.length - target : 0, count: used.length };
  };
  const a12 = avgDiff(ctx.avgWindow12);
  const a3 = avgDiff(ctx.avgWindow3);

  return {
    spent: net(ctx.month),
    ytd, ytdTarget, ytdDiff: ytd - ytdTarget,
    relevantMonthCount: relevantPriorMonths.length,
    avgDiff12: a12.diff, avgMonthCount12: a12.count,
    avgDiff3: a3.diff, avgMonthCount3: a3.count,
  };
}

/** Expense spending this month in categories none of the lines cover. */
function offBudgetSpend(ctx: StatsContext, categories: Category[], coveredCatIds: Set<number>, month: string): number {
  const excluded = new Set(categories.filter((c) => c.excludeFromOffBudget).map((c) => c.id));
  let total = 0;
  for (const [catId, amount] of ctx.aggs.get(month)?.debitByCat ?? []) {
    if (!coveredCatIds.has(catId) && !ctx.incomeCatIds.has(catId) && !excluded.has(catId)) total += amount;
  }
  return total;
}

function incomeReceived(ctx: StatsContext): number {
  let total = 0;
  for (const [catId, amount] of ctx.aggs.get(ctx.month)?.creditByCat ?? []) {
    if (ctx.incomeCatIds.has(catId)) total += amount;
  }
  return total;
}

export function buildRows(
  month: string,
  categories: Category[],
  _budgetGroups: BudgetGroup[],
  ytdMode: 'ytd' | 'rolling12',
  targetMode: TargetMode = 'atTime',
): BuildRowsResult {
  const ctx = buildContext(month, categories, ytdMode);
  const { d } = ctx;
  const budgets = d.budgets.filter((b) => b.month === month);
  const catById = new Map(categories.map((c) => [c.id, c]));

  // categoryId → (month → target), built once
  const budgetsByCat = new Map<number, Map<string, number>>();
  for (const b2 of d.budgets) {
    let m = budgetsByCat.get(b2.categoryId);
    if (!m) { m = new Map(); budgetsByCat.set(b2.categoryId, m); }
    m.set(b2.month, b2.targetAmount);
  }

  const rows = budgets.map((b): BudgetRow => {
    const cat = catById.get(b.categoryId);
    const isIncome = cat?.isIncome === true || (cat != null && INCOME_CATEGORY_NAMES.has(cat.name));
    const catBudgetByMonth = budgetsByCat.get(b.categoryId) ?? new Map<string, number>();
    const targetInMonth = targetMode === 'current'
      ? () => b.targetAmount
      : (pm: string) => catBudgetByMonth.get(pm);
    return {
      categoryId: b.categoryId,
      categoryName: cat?.name ?? '?',
      note: cat?.note,
      budgetNote: b.note,
      target: b.targetAmount,
      carry: isIncome ? 0 : getRolloverCarry(d, b.categoryId, month),
      isIncome,
      ...lineStats(ctx, [b.categoryId], isIncome, b.targetAmount, targetInMonth),
      groupId: b.groupId ?? null,
      sortOrder: (b as { sortOrder?: number }).sortOrder ?? 0,
    };
  });

  return {
    rows,
    priorMonthCount: ctx.priorMonths.length,
    allIncomeReceived: incomeReceived(ctx),
    uncatTotal: ctx.aggs.get(month)?.uncategorizedDebit ?? 0,
    offBudgetTotal: offBudgetSpend(ctx, categories, new Set(budgets.map((b) => b.categoryId)), month),
  };
}

export interface SandboxRowsResult extends BuildRowsResult {
  /** Avg monthly spending over the last 12 tracked months in categories the sandbox doesn't cover. */
  offBudgetAvg12: number;
}

/**
 * Rows for a sandbox, measured against `month`. A sandbox has one target per line,
 * so past months are always compared as if that target applied all along.
 */
export function buildSandboxRows(
  sandbox: ExperimentalBudget,
  month: string,
  categories: Category[],
  ytdMode: 'ytd' | 'rolling12',
): SandboxRowsResult {
  const ctx = buildContext(month, categories, ytdMode);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const covered = new Set<number>();

  const rows = sandbox.items.map((item): BudgetRow => {
    const catIds = [item.categoryId, ...(item.sourceCategoryIds ?? [])];
    for (const id of catIds) covered.add(id);
    const isIncome = item.isIncome === true;
    return {
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      note: catById.get(item.categoryId)?.note,
      budgetNote: item.note,
      target: item.targetAmount,
      carry: 0,
      isIncome,
      ...lineStats(ctx, catIds, isIncome, item.targetAmount, () => item.targetAmount),
      groupId: item.groupId ?? null,
      sortOrder: item.sortOrder ?? 0,
      sourceCategoryIds: item.sourceCategoryIds,
    };
  });

  const trackedMonths = ctx.avgWindow12.filter((pm) => ctx.monthsWithTxns.has(pm));
  const offBudgetAvg12 = trackedMonths.length > 0
    ? trackedMonths.reduce((s, pm) => s + offBudgetSpend(ctx, categories, covered, pm), 0) / trackedMonths.length
    : 0;

  return {
    rows,
    priorMonthCount: ctx.priorMonths.length,
    allIncomeReceived: incomeReceived(ctx),
    uncatTotal: ctx.aggs.get(month)?.uncategorizedDebit ?? 0,
    offBudgetTotal: offBudgetSpend(ctx, categories, covered, month),
    offBudgetAvg12,
  };
}
