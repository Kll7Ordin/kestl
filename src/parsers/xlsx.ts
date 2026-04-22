import * as XLSX from 'xlsx';
import type { Budget, CategoryRule } from '../db';

interface BudgetLine {
  categoryName: string;
  targetAmount: number;
}

interface RuleLine {
  pattern: string;
  categoryName: string;
}

export function parseWorkbook(data: ArrayBuffer): {
  budgetLines: BudgetLine[];
  ruleLines: RuleLine[];
} {
  const wb = XLSX.read(data, { type: 'array' });

  const budgetLines: BudgetLine[] = [];
  if (wb.SheetNames.length >= 1) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    for (const row of rows) {
      if (!row || row.length < 2) continue;
      const name = String(row[0] ?? '').trim();
      const amt = parseFloat(String(row[1] ?? ''));
      if (!name || isNaN(amt)) continue;
      if (/total/i.test(name)) continue;
      budgetLines.push({ categoryName: name, targetAmount: amt });
    }
  }

  const ruleLines: RuleLine[] = [];
  if (wb.SheetNames.length >= 2) {
    const sheet = wb.Sheets[wb.SheetNames[1]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    for (const row of rows) {
      if (!row || row.length < 2) continue;
      const pattern = String(row[0] ?? '').trim();
      const cat = String(row[1] ?? '').trim();
      if (!pattern || !cat) continue;
      ruleLines.push({ pattern, categoryName: cat });
    }
  }

  return { budgetLines, ruleLines };
}

export function toBudgets(
  lines: { categoryName: string; targetAmount: number }[],
  month: string,
  categoryMap: Map<string, number>,
): Omit<Budget, 'id'>[] {
  return lines
    .filter((l) => categoryMap.has(l.categoryName.toLowerCase()))
    .map((l) => ({
      month,
      categoryId: categoryMap.get(l.categoryName.toLowerCase())!,
      targetAmount: l.targetAmount,
    }));
}

export function toRules(
  lines: { pattern: string; categoryName: string }[],
  categoryMap: Map<string, number>,
): Omit<CategoryRule, 'id'>[] {
  return lines
    .filter((l) => categoryMap.has(l.categoryName.toLowerCase()))
    .map((l) => ({
      matchType: 'contains' as const,
      pattern: l.pattern.toLowerCase(),
      categoryId: categoryMap.get(l.categoryName.toLowerCase())!,
    }));
}
