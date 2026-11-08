import type { AppData, Budget } from '../db';
import { INCOME_CATEGORY_NAMES } from '../seed';
import { currentMonthStr } from './dateUtils';
import { monthAgg } from './spend';

export interface MonthProjection {
  received: number;
  expectedIncomeRemaining: number;
  spent: number;
  plannedRemaining: number;
  projectedNet: number;
}

export interface ForecastMonth { month: string; income: number; expense: number; net: number }

function incomeCatIds(d: AppData): Set<number> {
  return new Set(d.categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id));
}

function savingsCatIds(d: AppData, budgets: Budget[]): Set<number> {
  const groups = new Set((d.budgetGroups ?? []).filter((g) => g.spendFromSavings || g.name === 'Occasional').map((g) => g.id));
  return new Set(budgets.filter((b) => b.groupId != null && groups.has(b.groupId)).map((b) => b.categoryId));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Month-end projection from what has been received/spent so far plus what is still planned. */
export function projectCurrentMonth(d: AppData, month: string): MonthProjection {
  const agg = monthAgg(d, month);
  const income = incomeCatIds(d);
  const budgets = d.budgets.filter((b) => b.month === month);
  const fromSavings = savingsCatIds(d, budgets);

  let received = 0;
  for (const [cat, amt] of agg.creditByCat) if (income.has(cat)) received += amt;

  let expectedIncomeRemaining = 0;
  let plannedRemaining = 0;
  for (const b of budgets) {
    if (income.has(b.categoryId)) {
      expectedIncomeRemaining += Math.max(0, b.targetAmount - (agg.creditByCat.get(b.categoryId) ?? 0));
    } else if (!fromSavings.has(b.categoryId)) {
      const net = (agg.debitByCat.get(b.categoryId) ?? 0) - (agg.creditByCat.get(b.categoryId) ?? 0);
      plannedRemaining += Math.max(0, b.targetAmount - net);
    }
  }

  // Everything actually spent this month (budgeted or not), excluding spend-from-savings categories
  let spent = agg.uncategorizedDebit;
  const cats = new Set([...agg.debitByCat.keys(), ...agg.creditByCat.keys()]);
  for (const cat of cats) {
    if (income.has(cat) || fromSavings.has(cat)) continue;
    spent += (agg.debitByCat.get(cat) ?? 0) - (agg.creditByCat.get(cat) ?? 0);
  }

  return {
    received: round2(received),
    expectedIncomeRemaining: round2(expectedIncomeRemaining),
    spent: round2(spent),
    plannedRemaining: round2(plannedRemaining),
    projectedNet: round2(received + expectedIncomeRemaining - spent - plannedRemaining),
  };
}

/** Next `n` months from planned budgets (or the most recent month that has budgets) plus recurring templates. */
export function forecastMonths(d: AppData, n = 3): ForecastMonth[] {
  const cur = currentMonthStr();
  const income = incomeCatIds(d);
  const budgetMonths = [...new Set(d.budgets.map((b) => b.month))].sort();

  const out: ForecastMonth[] = [];
  let m = cur;
  for (let i = 0; i < n; i++) {
    m = nextOf(m);
    const source = budgetMonths.includes(m) ? m : [...budgetMonths].reverse().find((x) => x < m);
    const budgets = source ? d.budgets.filter((b) => b.month === source) : [];
    const fromSavings = savingsCatIds(d, budgets);
    let inc = 0;
    let exp = 0;
    for (const b of budgets) {
      if (income.has(b.categoryId)) inc += b.targetAmount;
      else if (!fromSavings.has(b.categoryId)) exp += b.targetAmount;
    }
    const budgeted = new Set(budgets.map((b) => b.categoryId));
    for (const t of d.recurringTemplates) {
      if (!t.active) continue;
      if (t.categoryId != null && budgeted.has(t.categoryId)) continue; // already in the budget
      if (t.startMonth && t.startMonth > m) continue;
      if ((t.skippedMonths ?? []).includes(m)) continue;
      if (t.amount < 0 || t.ignoreInBudget) inc += Math.abs(t.amount);
      else exp += t.amount;
    }
    out.push({ month: m, income: round2(inc), expense: round2(exp), net: round2(inc - exp) });
  }
  return out;
}

function nextOf(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
