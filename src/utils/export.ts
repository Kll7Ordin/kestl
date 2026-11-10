import * as XLSX from 'xlsx';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { AppData, Transaction, TransactionSplit } from '../db';
import { getBucketBalance } from '../logic/savings';
import { INCOME_CATEGORY_NAMES } from '../seed';
import { isCredit } from '../logic/txnKind';

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
      if (t.txnDate.startsWith(month) && !isCredit(t) && t.categoryId) {
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
        isCredit(t) ? 'yes' : '',
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
        if (isCredit(t)) income += t.amount;
      } else if (budgetedExpenseCatIds.has(t.categoryId)) {
        if (occasionalCatIds.has(t.categoryId)) {
          if (!isCredit(t)) savings += t.amount;
        } else {
          if (!isCredit(t)) actual += t.amount;
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

// ── Transactions CSV (whatever the Transactions view is currently showing) ──

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Build a CSV of the given transactions: Date, Descriptor, Instrument, Amount, Category, Note.
 * Amount uses the sign shown in the app (spending negative, credits positive). Split transactions
 * list each portion in Category; Note holds the comment and star note, if any.
 */
const TXN_HEADER = ['Date', 'Descriptor', 'Instrument', 'Amount', 'Category', 'Note'];

/** The exported columns for each transaction: date, descriptor, instrument, signed amount, category, note. */
export function transactionRows(
  txns: Transaction[],
  catName: (id: number) => string | undefined,
  splitsFor: (txnId: number) => TransactionSplit[] | undefined,
): string[][] {
  return txns.map((t) => {
    const credit = isCredit(t) || t.amount < 0;
    const amount = (credit ? Math.abs(t.amount) : -Math.abs(t.amount)).toFixed(2);
    const splits = splitsFor(t.id);
    const category = splits && splits.length > 0
      ? splits.map((s) => `${catName(s.categoryId) ?? '?'} ${Math.abs(s.amount).toFixed(2)}`).join('; ')
      : t.categoryId != null ? catName(t.categoryId) ?? '' : '';
    const note = [t.comment, t.starNote].filter(Boolean).join(' | ');
    return [t.txnDate, t.descriptor, t.instrument ?? '', amount, category, note];
  });
}

export function transactionsToCsv(
  txns: Transaction[],
  catName: (id: number) => string | undefined,
  splitsFor: (txnId: number) => TransactionSplit[] | undefined,
): string {
  const lines = [TXN_HEADER.join(',')];
  for (const row of transactionRows(txns, catName, splitsFor)) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The same columns as the CSV, as an HTML table (pastes as a real table into Word, Docs, email)
 * plus tab-separated text (pastes into spreadsheets and plain-text fields).
 */
export function transactionsToClipboardTable(
  txns: Transaction[],
  catName: (id: number) => string | undefined,
  splitsFor: (txnId: number) => TransactionSplit[] | undefined,
): { html: string; text: string } {
  const rows = transactionRows(txns, catName, splitsFor);
  const cell = 'border:1px solid #999;padding:2px 6px';
  const html = '<table style="border-collapse:collapse">'
    + `<thead><tr>${TXN_HEADER.map((h) => `<th style="${cell};text-align:left">${h}</th>`).join('')}</tr></thead><tbody>`
    + rows.map((r) => `<tr>${r.map((v, i) => `<td style="${cell}${i === 3 ? ';text-align:right' : ''}">${escHtml(v)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';
  const text = [TXN_HEADER, ...rows].map((r) => r.map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  return { html, text };
}

/** Put HTML + plain text on the clipboard. Uses a copy event, which carries both formats in every webview. */
export function copyRichText(html: string, text: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/html', html);
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}

/** Ask where to save, then write the CSV. Returns the saved path, or null if cancelled. */
export async function saveTransactionsCsv(csv: string, defaultName: string): Promise<string | null> {
  const picked = await save({ defaultPath: defaultName, filters: [{ name: 'CSV File', extensions: ['csv'] }] });
  if (!picked) return null;
  // The Linux dialog doesn't always add the extension, and the backend only writes known extensions.
  const path = /\.csv$/i.test(picked) ? picked : `${picked}.csv`;
  await invoke('save_data', { path, data: csv });
  return path;
}
