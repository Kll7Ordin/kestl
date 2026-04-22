import * as XLSX from 'xlsx';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { AppData } from '../db';
import { getBucketBalance } from '../logic/savings';
import { INCOME_CATEGORY_NAMES } from '../seed';

function sheetMonthLabel(month: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

function fullMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  return new Date(Number(y), Number(m) - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

export async function createReadableArchive(appData: AppData): Promise<string> {
  const wb = XLSX.utils.book_new();

  const {
    budgets, transactions, categories, budgetGroups,
    savingsBuckets, savingsEntries, savingsSchedules,
  } = appData;

  const catMap = new Map(categories.map((c) => [c.id, c]));
  const groupMap = new Map((budgetGroups ?? []).map((g) => [g.id, g]));

  const incomeCatIds = new Set(
    categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id),
  );
  const occasionalGroupId = (budgetGroups ?? []).find((g) => g.name === 'Occasional')?.id;
  const occasionalCatIds = new Set(
    occasionalGroupId != null
      ? budgets.filter((b) => b.groupId === occasionalGroupId).map((b) => b.categoryId)
      : [],
  );

  // All months with data, oldest first
  const monthSet = new Set([
    ...budgets.map((b) => b.month),
    ...transactions.map((t) => t.txnDate.slice(0, 7)),
  ]);
  const months = [...monthSet].sort();

  // ── Per-month sheets ──
  for (const month of months) {
    const label = sheetMonthLabel(month);

    // Spending map (credits are negative and reduce spent, matching BudgetView logic)
    const spending = new Map<number, number>();
    for (const t of transactions) {
      if (t.txnDate.startsWith(month) && !t.ignoreInBudget && t.categoryId) {
        spending.set(t.categoryId, (spending.get(t.categoryId) ?? 0) + t.amount);
      }
    }

    // Budget sheet
    const monthBudgets = budgets
      .filter((b) => b.month === month)
      .sort((a, b) => {
        const gOrdA = groupMap.get(a.groupId ?? -1)?.sortOrder ?? 999;
        const gOrdB = groupMap.get(b.groupId ?? -1)?.sortOrder ?? 999;
        if (gOrdA !== gOrdB) return gOrdA - gOrdB;
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      });

    const budgetRows: (string | number)[][] = [
      ['Group', 'Category', 'Target', 'Spent', 'Remaining'],
      ...monthBudgets.map((b) => {
        const spent = spending.get(b.categoryId) ?? 0;
        return [
          groupMap.get(b.groupId ?? -1)?.name ?? '',
          catMap.get(b.categoryId)?.name ?? '?',
          b.targetAmount,
          +spent.toFixed(2),
          +(b.targetAmount - spent).toFixed(2),
        ];
      }),
    ];

    const budgetSheet = XLSX.utils.aoa_to_sheet(budgetRows);
    budgetSheet['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, budgetSheet, `${label} Budget`);

    // Transactions sheet
    const monthTxns = transactions
      .filter((t) => t.txnDate.startsWith(month))
      .sort((a, b) => a.txnDate.localeCompare(b.txnDate));

    const txnRows: (string | number)[][] = [
      ['Date', 'Amount', 'Descriptor', 'Category', 'Instrument', 'Note', 'Ignored'],
      ...monthTxns.map((t) => [
        t.txnDate,
        t.amount,
        t.descriptor,
        t.categoryId ? (catMap.get(t.categoryId)?.name ?? '?') : '',
        t.instrument,
        t.comment ?? '',
        t.ignoreInBudget ? 'yes' : '',
      ]),
    ];

    const txnSheet = XLSX.utils.aoa_to_sheet(txnRows);
    txnSheet['!cols'] = [
      { wch: 12 }, { wch: 10 }, { wch: 42 }, { wch: 22 }, { wch: 12 }, { wch: 22 }, { wch: 8 },
    ];
    XLSX.utils.book_append_sheet(wb, txnSheet, `${label} Txns`);
  }

  // ── Year Summary sheet ──
  const yearRows: (string | number)[][] = [
    ['Month', 'Planned', 'Actual', 'Income', 'Spent from Savings'],
  ];

  for (const month of months) {
    const mBudgets = budgets.filter((b) => b.month === month);
    const budgetedExpenseCatIds = new Set(
      mBudgets.filter((b) => !incomeCatIds.has(b.categoryId)).map((b) => b.categoryId),
    );
    const planned = mBudgets
      .filter((b) => !incomeCatIds.has(b.categoryId) && !occasionalCatIds.has(b.categoryId))
      .reduce((s, b) => s + b.targetAmount, 0);

    let actual = 0, income = 0, savings = 0;
    for (const t of transactions) {
      if (!t.txnDate.startsWith(month) || !t.categoryId) continue;
      if (incomeCatIds.has(t.categoryId)) {
        if (t.ignoreInBudget) income += t.amount;
      } else if (budgetedExpenseCatIds.has(t.categoryId)) {
        if (occasionalCatIds.has(t.categoryId)) {
          if (!t.ignoreInBudget) savings += t.amount;
        } else {
          if (!t.ignoreInBudget) actual += t.amount;
        }
      }
    }

    yearRows.push([
      fullMonthLabel(month),
      +planned.toFixed(2),
      +actual.toFixed(2),
      +income.toFixed(2),
      +savings.toFixed(2),
    ]);
  }

  const yearSheet = XLSX.utils.aoa_to_sheet(yearRows);
  yearSheet['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, yearSheet, 'Year Summary');

  // ── Savings sheet ──
  const savRows: (string | number)[][] = [];

  savRows.push(['BUCKETS', '']);
  savRows.push(['Bucket', 'Balance']);
  for (const bucket of savingsBuckets) {
    savRows.push([bucket.name, +getBucketBalance(bucket.id).toFixed(2)]);
  }

  savRows.push(['', '']);
  savRows.push(['SCHEDULES', '', '', '', '']);
  savRows.push(['Bucket', 'Day of Month', 'Amount', 'Start Month', 'Active']);
  for (const s of savingsSchedules) {
    const bkt = savingsBuckets.find((b) => b.id === s.bucketId);
    savRows.push([bkt?.name ?? '?', s.dayOfMonth, s.amount, s.startMonth, s.active ? 'Yes' : 'No']);
  }

  savRows.push(['', '', '', '', '']);
  savRows.push(['ENTRIES', '', '', '', '']);
  savRows.push(['Date', 'Bucket', 'Amount', 'Notes', 'Source']);
  const sortedEntries = [...savingsEntries].sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  for (const e of sortedEntries) {
    const bkt = savingsBuckets.find((b) => b.id === e.bucketId);
    savRows.push([e.entryDate, bkt?.name ?? '?', e.amount, e.notes, e.source]);
  }

  const savSheet = XLSX.utils.aoa_to_sheet(savRows);
  savSheet['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 28 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, savSheet, 'Savings');

  // ── Write & save ──
  // Use base64 to safely pass binary data through Tauri IPC
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string;

  // Try native save dialog; fall back to home dir if unavailable
  let savePath: string | null = null;
  try {
    savePath = await save({
      defaultPath: 'budget-archive.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
  } catch (_e) {
    // Dialog not available — will use default path
  }

  if (!savePath) {
    const home = await invoke<string>('get_home_dir');
    const date = new Date().toISOString().slice(0, 10);
    savePath = `${home}/budget-archive-${date}.xlsx`;
  }

  await invoke('save_base64', { path: savePath, data: base64 });
  return savePath;
}
