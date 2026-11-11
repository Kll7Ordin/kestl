import { type AppData } from '../db';
import { INCOME_CATEGORY_NAMES } from '../seed';
import { getMonthAggregates } from './spend';

export function mostRecentCompletedMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, '0')}`
  );
}

export function rollingTwelveMonths(): string[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 12 + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

export interface MonthData {
  month: string;
  planned: number;
  actual: number;
  income: number;
  savings: number; // Occasional group spending
  /** User marked this month incomplete; it is left out of charts and totals. */
  incomplete?: boolean;
}


export interface YearDataOpts {
  year: number;
  scope: 'overall' | 'categories' | 'groups';
  selectedCats: number[];
  selectedGroups: number[];
  ytdMode: 'ytd' | 'rolling12';
}

export function computeYearData(appData: AppData, opts: YearDataOpts): MonthData[] {
  const { year, scope, selectedCats, selectedGroups, ytdMode } = opts;
  const categories = appData.categories;
    const { budgets: allBudgets } = appData;
    const months = ytdMode === 'rolling12' ? rollingTwelveMonths() : monthsOfYear(year);

    const aggs = getMonthAggregates(appData);

    const filterCats =
      scope === 'categories' && selectedCats.length > 0 ? new Set(selectedCats) :
      scope === 'groups' && selectedGroups.length > 0 ? new Set(allBudgets.filter((b) => selectedGroups.includes(b.groupId ?? -1)).map((b) => b.categoryId)) :
      null;

    // Income categories
    const incomeCatIds = new Set(
      categories
        .filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name))
        .map((c) => c.id),
    );

    // Occasional group categories (Savings spending — excluded from regular Actual)
    const spendFromSavingsGroupIds = new Set(
      (appData.budgetGroups ?? [])
        .filter((g) => g.spendFromSavings || g.name === 'Occasional')
        .map((g) => g.id)
    );
    const occasionalCatIds = new Set(
      allBudgets.filter((b) => b.groupId != null && spendFromSavingsGroupIds.has(b.groupId)).map((b) => b.categoryId)
    );

    const incompleteSet = new Set(appData.incompleteMonths ?? []);
    return months.map((m) => {
      if (incompleteSet.has(m)) return { month: m, planned: 0, actual: 0, income: 0, savings: 0, incomplete: true };
      const mBudgets = allBudgets.filter((b) =>
        b.month === m && (!filterCats || filterCats.has(b.categoryId))
      );
      const budgetedExpenseCatIds = new Set(
        mBudgets.filter((b) => !incomeCatIds.has(b.categoryId)).map((b) => b.categoryId)
      );
      // Planned excludes Occasional (savings spending) so variance reflects regular budget
      const planned = mBudgets
        .filter((b) => !incomeCatIds.has(b.categoryId) && !occasionalCatIds.has(b.categoryId))
        .reduce((s, b) => s + b.targetAmount, 0);

      const agg = aggs.get(m);
      let actual = 0;
      let income = 0;
      let savings = 0;
      if (agg) {
        for (const [catId, amt] of agg.creditByCat) {
          if (incomeCatIds.has(catId)) income += amt;
        }
        for (const [catId, amt] of agg.debitByCat) {
          if (incomeCatIds.has(catId) || !budgetedExpenseCatIds.has(catId)) continue;
          if (occasionalCatIds.has(catId)) savings += amt;
          else actual += amt;
        }
      }

      return { month: m, planned, actual, income, savings };
    });
}
